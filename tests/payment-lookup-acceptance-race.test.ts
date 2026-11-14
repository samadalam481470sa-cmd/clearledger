import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { digest, domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import type { RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

interface Response { status: number; body: any }
async function within<T>(pending: Promise<T>, label: string, timeoutMs = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean, label: string, timeoutMs = 15000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise<void>(done => setTimeout(done, 50));
  }
  throw new Error(label + ' did not become ready');
}
class Projection {
  readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  row(key: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(key) as unknown as RecordRow | undefined; }
  audit() { return this.db.prepare('SELECT * FROM audit ORDER BY sequence').all(); }
  journals() { return this.db.prepare('SELECT * FROM journals ORDER BY rowid').all(); }
  snapshot() {
    return JSON.stringify({ schema: this.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      payments: this.db.prepare('SELECT rowid,* FROM payments ORDER BY rowid').all(), audit: this.audit(), journals: this.journals(),
      context: this.db.prepare('SELECT * FROM deployment_context ORDER BY singleton').all(),
      sequence: this.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all() });
  }
  close() { this.db.close(); }
}
function pendingPost(cli: CliHandle, input: unknown) {
  const bytes = JSON.stringify(input);
  let responses = 0, closed = false;
  let end!: () => void;
  const ended = new Promise<void>(done => { end = done; });
  let request!: ReturnType<typeof httpRequest>;
  const result = new Promise<Response>((done, fail) => {
    request = httpRequest(cli.url + '/api/payments', { method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }
    }, response => {
      responses++;
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', () => fail(new Error('Native acceptance response failed')));
      response.once('end', () => {
        try { done({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
        catch { fail(new Error('Native acceptance returned an invalid response')); }
      });
    });
    request.on('error', () => fail(new Error('Native acceptance request failed')));
    request.once('close', () => { closed = true; end(); });
    request.setTimeout(7000, () => request.destroy());
    request.end(bytes);
  });
  void result.catch(() => {});
  return { result, ended, responses: () => responses, closed: () => closed, abort() { request.destroy(); } };
}
async function api(cli: CliHandle, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(cli.url + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(7000), body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' } });
  return { status: response.status, body: await response.json() };
}
function publicRow(row: any, key: string, payment: Payment) {
  assert.equal(row.id, key); assert.deepEqual(row.payment, payment);
  assert.ok(['queued', 'broadcast', 'settled'].includes(row.status));
  for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload', 'items', 'replay'])
    assert.equal(Object.hasOwn(row, field), false);
}

// The real RPC CLI owns writes and autonomous ticks. The parent only reads
// SQLite and the development EVM; the gate holds genuine forwarded RPC bytes.
for (const mode of ['identical', 'conflicting'] as const) test(
  'exact lookup can return 404 before overlapping ' + mode + ' submissions settle once', { timeout: 45000 }, async t => {
  const workRoot = resolve('../../work'), children: CliHandle[] = [];
  const requests: ReturnType<typeof pendingPost>[] = [], operations: Promise<unknown>[] = [];
  const gates: ReturnType<Awaited<ReturnType<typeof rpcProxy>>['pauseAfterForward']>[] = [];
  let directory: string | undefined, reader: Projection | undefined, completed = false;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined, proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  const track = <T>(pending: Promise<T>) => { void pending.catch(() => {}); operations.push(pending); return pending; };
  try {
    compile();
    const live = chain = await localChain(), gateway = proxy = await rpcProxy(live.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true }); directory = mkdtempSync(join(workRoot, 'payment-lookup-acceptance-race-'));
    const db = join(directory, 'journal.sqlite'), routerAddress = await live.router.getAddress();
    const cli = await startCli({ db, rpc: gateway.url, key: live.relayer.privateKey, router: routerAddress,
      onSpawn: child => { children.push(child); } });
    reader = new Projection(db);
    const block = await live.provider.getBlock('latest'); assert.ok(block);
    const [payerTokens, payeeTokens, relayerNonce, payerNativeNonce] = await Promise.all([
      live.token.balanceOf(live.payer.address), live.token.balanceOf(live.payee.address),
      live.provider.getTransactionCount(live.relayer.address, 'pending'),
      live.provider.getTransactionCount(live.payer.address, 'pending')
    ]);
    const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live.payer.address,
      payee: live.payee.address, token: await live.token.getAddress(), amount: '125000000', nonce: '0', deadline: String(block.timestamp + 3600) };
    const signingDomain = domain(31337, routerAddress);
    const conflictingPayment = { ...payment, amount: '7000000' };
    const sign = async (intent: Payment) => ({ payment: intent,
      signature: await live.payer.signTypedData(signingDomain, paymentTypes, intent) });
    const input = await sign(payment), conflictingInput = await sign(conflictingPayment);
    const inputs = [input, mode === 'conflicting' ? conflictingInput : input];
    const key = paymentKey(payment);
    assert.equal(paymentKey(conflictingPayment), key);
    const expectedViews = inputs.map(candidate => live.router.interface
      .encodeFunctionData('isValidPaymentSignature', [candidate.payment, candidate.signature]).toLowerCase());
    const empty = reader.snapshot(); assert.equal(reader.row(key), undefined);
    assert.equal(reader.audit().length, 0); assert.equal(reader.journals().length, 0);
    let heldStarted: number | undefined, forwardedCalls = 0;
    gateway.afterForward('eth_call', () => { heldStarted ??= performance.now(); forwardedCalls++; });
    const gate = gateway.pauseAfterForward('eth_call'); gates.push(gate);
    const rpcBaseline = gateway.calls.length, batchBaseline = gateway.batches().length;
    const first = pendingPost(cli, input); requests.push(first);
    await within(gate.entered, 'Forwarded signature-view response', 3000);
    assert.notEqual(heldStarted, undefined);
    const deadline = heldStarted! + 3000;
    const remaining = () => {
      const ms = deadline - performance.now(); assert.ok(ms > 0, 'Held acceptance exceeded its three-second budget'); return ms;
    };
    const viewCalls = gateway.calls.slice(rpcBaseline).filter(call => call.method === 'eth_call');
    assert.equal(viewCalls.length, 1);
    const call = viewCalls[0].params?.[0] as { to?: string; data?: string };
    assert.equal(call.to?.toLowerCase(), routerAddress.toLowerCase());
    assert.ok(call.data?.toLowerCase() === expectedViews[0], 'First signature view did not use the first submitted intent');
    assert.equal(first.responses(), 0); assert.equal(first.closed(), false);
    const beforeLookupRpc = gateway.calls.length;
    const missing = await within(track(api(cli, 'payments/' + encodeURIComponent(key))), 'Pending acceptance lookup', remaining());
    assert.equal(missing.status, 404); assert.deepEqual(missing.body, { error: 'Payment not found' });
    assert.equal(gateway.calls.length, beforeLookupRpc, 'Exact 404 performed an upstream RPC');
    assert.ok(reader.snapshot() === empty, 'Pending acceptance or local lookup changed empty durable state');
    assert.equal(gateway.calls.filter(item => item.method === 'eth_sendRawTransaction').length, 0);
    assert.equal(first.responses(), 0); assert.equal(cli.child.exitCode, null); assert.equal(cli.child.signalCode, null);
    const second = pendingPost(cli, inputs[1]); requests.push(second);
    await until(() => forwardedCalls === 2, 'Second genuine signature-view exchange', remaining());
    const concurrentCalls = gateway.calls.slice(rpcBaseline).filter(item => item.method === 'eth_call');
    assert.equal(concurrentCalls.length, 2);
    for (const [index, item] of concurrentCalls.entries()) {
      const view = item.params?.[0] as { to?: string; data?: string };
      assert.equal(view.to?.toLowerCase(), routerAddress.toLowerCase());
      assert.ok(view.data?.toLowerCase() === expectedViews[index], 'Signature view did not use its submitted intent');
    }
    assert.equal(first.responses(), 0); assert.equal(second.responses(), 0);
    assert.equal(first.closed(), false); assert.equal(second.closed(), false);
    assert.ok(reader.snapshot() === empty, 'A held signature exchange must not create an accepted row');
    const bothPendingRpc = gateway.calls.length;
    const stillMissing = await within(track(api(cli, 'payments/' + encodeURIComponent(key))), 'Overlapping acceptance lookup', remaining());
    assert.equal(stillMissing.status, 404); assert.deepEqual(stillMissing.body, { error: 'Payment not found' });
    assert.equal(gateway.calls.length, bothPendingRpc, 'Exact 404 while both requests are pending performed an RPC');
    assert.ok(reader.snapshot() === empty, 'Exact 404 changed empty private state during overlapping acceptances');
    assert.equal(first.responses(), 0); assert.equal(second.responses(), 0);
    const heldMethodBatches = gateway.batches().slice(batchBaseline);
    const heldMs = performance.now() - heldStarted!; remaining(); gate.release(); gateway.heal();
    const acknowledgements = await within(Promise.all([first.result, second.result]), 'Overlapping acceptance acknowledgements');
    const acknowledgementPairs = acknowledgements.map(response => [response.status, response.body.replay] as [number, boolean]);
    assert.deepEqual(acknowledgementPairs.sort((a, b) => a[0] - b[0]),
      mode === 'conflicting' ? [[202, false], [409, undefined]] : [[200, true], [202, false]]);
    const winner = acknowledgements.findIndex(response => response.status === 202);
    const acceptedInput = inputs[winner];
    const acceptedPayment = acceptedInput.payment;
    const conflictBody = { error: 'Payment ID already has different instructions' };
    if (mode === 'conflicting') assert.deepEqual(acknowledgements[1 - winner].body, conflictBody);
    for (const response of acknowledgements) {
      if (response.status !== 409) publicRow(response.body.payment, key, acceptedPayment);
    }
    const committed = await track(api(cli, 'payments/' + encodeURIComponent(key)));
    assert.equal(committed.status, 200); publicRow(committed.body, key, acceptedPayment);
    await until(() => reader!.row(key)?.status === 'settled', 'Autonomous once-only settlement');
    const settled = reader.row(key)!; assert.ok(settled.raw_tx && settled.tx_hash);
    const raw = settled.raw_tx, hash = settled.tx_hash;
    assert.deepEqual(JSON.parse(settled.payload), acceptedPayment);
    assert.ok(settled.signature === acceptedInput.signature, 'Stored signature differs from the accepted instruction');
    assert.equal(settled.fingerprint, digest(acceptedPayment, signingDomain));
    assert.equal(reader.db.prepare('SELECT COUNT(*) AS count FROM payments').get()!.count, 1);
    const transaction = Transaction.from(raw);
    assert.equal(keccak256(raw), hash); assert.equal(transaction.nonce, relayerNonce);
    assert.equal(transaction.to, routerAddress); assert.equal(transaction.value, 0n);
    assert.ok(transaction.data === live.router.interface.encodeFunctionData('settle', [acceptedPayment, acceptedInput.signature]),
      'Broadcast did not encode the accepted instruction');
    assert.deepEqual(reader.journals().map(journal => ({ ...journal })), [{ payment_id: key, token: acceptedPayment.token,
      debit_account: acceptedPayment.payer, credit_account: acceptedPayment.payee, amount: acceptedPayment.amount,
      tx_hash: hash, block_number: settled.block_number, block_hash: settled.block_hash }]);
    assert.deepEqual(reader.audit().map(event => event.action), ['accepted', 'broadcast-prepared', 'settled']);
    const settledProjection = reader.snapshot();
    const found = await track(api(cli, 'payments/' + encodeURIComponent(key)));
    assert.equal(found.status, 200); publicRow(found.body, key, acceptedPayment);
    assert.equal(found.body.status, 'settled'); assert.equal(found.body.tx_hash, hash);
    const rejectedInput = mode === 'conflicting' ? inputs[1 - winner] : conflictingInput;
    const [replay, conflict] = await Promise.all([
      track(api(cli, 'payments', acceptedInput)), track(api(cli, 'payments', rejectedInput))
    ]);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true); assert.equal(replay.body.payment.tx_hash, hash);
    publicRow(replay.body.payment, key, acceptedPayment);
    assert.equal(conflict.status, 409); assert.deepEqual(conflict.body, conflictBody);
    assert.ok(reader.snapshot() === settledProjection, 'Replay or conflict changed settled evidence');
    const reconciliation = await track(api(cli, 'reconcile', {}));
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1); assert.deepEqual(reconciliation.body.exceptions, []);
    assert.ok(reader.snapshot() === settledProjection, 'Read/replay/conflict/reconciliation changed settled evidence');
    assert.ok(reader.row(key)!.raw_tx === raw && reader.row(key)!.tx_hash === hash);
    const sends = gateway.calls.filter(item => item.method === 'eth_sendRawTransaction');
    assert.equal(sends.length, 1);
    assert.ok(sends[0].params?.[0] === raw, 'The only native send must use the saved transaction bytes');
    assert.equal((await live.provider.getTransactionReceipt(hash))!.status, 1);
    const settledAmount = BigInt(acceptedPayment.amount);
    assert.equal(await live.token.balanceOf(live.payee.address), payeeTokens + settledAmount);
    assert.equal(await live.token.balanceOf(live.payer.address), payerTokens - settledAmount);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), relayerNonce + 1);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), payerNativeNonce);
    t.diagnostic(JSON.stringify({ mode, acceptedInput: winner + 1, settledBaseUnits: acceptedPayment.amount,
      heldAcceptanceMs: Math.floor(heldMs), forwardedSignatureViews: concurrentCalls.length,
      heldMethodBatches, local404ReadsWhilePending: 2, lookupRpcCalls: 0,
      acknowledgementStatuses: acknowledgements.map(response => response.status), conflictingAcceptanceStatus: conflict.status,
      settledPayments: 1, journalRows: 1, lifecycleEvents: 3, nativeSends: 1, reconciled: 1 }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    const cleanup = async (action: () => unknown) => { try { await action(); } catch (error) { failures.push(error); } };
    for (const gate of gates) gate.release();
    for (const request of requests) request.abort();
    for (const child of children) await cleanup(() => child.kill());
    for (const request of requests) {
      await cleanup(() => within(request.ended, 'Native acceptance client close', 1000));
      await cleanup(() => within(Promise.allSettled([request.result]), 'Native acceptance result', 1000));
    }
    await cleanup(() => within(Promise.allSettled(operations), 'Acceptance fetch cleanup'));
    await cleanup(() => reader?.close()); await cleanup(() => proxy?.close()); await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null));
      const target = resolve(directory!); assert.equal(dirname(target), workRoot); assert.ok(target.startsWith(workRoot + sep));
      assert.ok(target.startsWith(join(workRoot, 'payment-lookup-acceptance-race-')));
      rmSync(target, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Acceptance lookup race cleanup failed');
  }
});
