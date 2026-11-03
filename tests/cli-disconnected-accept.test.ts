import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { listenerRefused } from './fixtures/listener-probe.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

type Submission = { payment: Payment; signature: string };
type Live = Awaited<ReturnType<typeof localChain>>;
type Proxy = Awaited<ReturnType<typeof rpcProxy>>;
type Gate = ReturnType<Proxy['pauseAfterForward']>;

async function within<T>(pending: Promise<T>, label: string, timeoutMs = 10000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function until(probe: () => boolean | Promise<boolean>, label: string, timeoutMs = 12000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await within(Promise.resolve().then(probe), label, deadline - performance.now())) return;
    await sleep(50);
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
    return { payments: this.db.prepare('SELECT * FROM payments ORDER BY rowid').all(), audit: this.audit(), journals: this.journals(),
      sequence: this.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
      context: this.db.prepare('SELECT * FROM deployment_context').all() };
  }
  close() { this.db.close(); }
}
function disconnectedPost(cli: CliHandle, input: Submission) {
  let request!: ClientRequest, responses = 0, closed = false;
  const bytes = JSON.stringify(input);
  const ended = new Promise<void>(resolveClosed => {
    request = httpRequest(cli.url + '/api/payments', { method: 'POST', agent: false,
      headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }
    }, response => { responses++; response.on('error', () => {}); response.resume(); });
    // Local destruction may report ECONNRESET; keep the listener through close
    // without logging arbitrary response/error text or real generated keys.
    request.on('error', () => {});
    request.once('close', () => { closed = true; resolveClosed(); });
    request.setTimeout(7000, () => request.destroy());
    request.end(bytes);
  });
  return { request, ended, responses: () => responses, closed: () => closed,
    abort() { request.destroy(); } };
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  const response = await fetch(cli.url + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  return { status: response.status, body: await response.json() as any };
}
function alive(cli: CliHandle) {
  assert.equal(cli.child.exitCode, null); assert.equal(cli.child.signalCode, null);
}
function lifecycle(reader: Projection, key: string, status: 'queued' | 'settled') {
  const row = reader.row(key)!;
  assert.equal(row.status, status);
  const actions = reader.audit().filter(event => event.payment_id === key).map(event => event.action);
  assert.deepEqual(actions, status === 'queued' ? ['accepted'] : ['accepted', 'broadcast-prepared', 'settled']);
  return row;
}

interface Context {
  live: Live; proxy: Proxy; readonly cli: CliHandle; readonly reader: Projection;
  restart(key: string): Promise<CliHandle>; reopen(): void;
  signed(amount: string, nonce: string): Promise<Submission>;
  hold(input: Submission): Promise<{ client: ReturnType<typeof disconnectedPost>; gate: Gate; started: number; remaining(): number }>;
}
async function fixture(run: (context: Context) => Promise<void>) {
  const workRoot = resolve('../../work'), children: CliHandle[] = [];
  const clients: ReturnType<typeof disconnectedPost>[] = [], gates: Gate[] = [];
  let directory: string | undefined, live: Live | undefined, proxy: Proxy | undefined, reader: Projection | undefined;
  let completed = false;
  try {
    compile();
    live = await localChain(); proxy = await rpcProxy(live.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true }); directory = mkdtempSync(join(workRoot, 'cli-disconnected-accept-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: live.relayer.privateKey, router: String(live.router.target),
      onSpawn: (child: CliHandle) => { children.push(child); } };
    let cli = await startCli(config); reader = new Projection(db);
    const context: Context = {
      live, proxy, get cli() { return cli; }, get reader() { return reader!; },
      async restart(key) { cli = await startCli({ ...config, apiKey: key }); return cli; },
      reopen() { reader!.close(); reader = new Projection(db); },
      async signed(amount, nonce) {
        const block = await live!.provider.getBlock('latest'); assert.ok(block);
        const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live!.payer.address,
          payee: live!.payee.address, token: String(live!.token.target), amount, nonce, deadline: String(block.timestamp + 3600) };
        return { payment, signature: await live!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
      },
      async hold(input) {
        const before = proxy!.calls.length;
        let started: number | undefined;
        // The callback runs after the genuine upstream exchange and immediately
        // before its reply is held, so all held-phase work shares this deadline.
        proxy!.afterForward('eth_call', () => { started ??= performance.now(); });
        const gate = proxy!.pauseAfterForward('eth_call'); gates.push(gate);
        const client = disconnectedPost(cli, input); clients.push(client);
        await within(gate.entered, 'Genuine signature-view exchange', 3000);
        assert.notEqual(started, undefined);
        const calls = proxy!.calls.slice(before).filter(call => call.method === 'eth_call');
        assert.equal(calls.length, 1, 'Only the acceptance view may consume the held exchange');
        const call = calls[0].params?.[0] as { to?: string; data?: string };
        const expected = live!.router.interface.encodeFunctionData('isValidPaymentSignature', [input.payment, input.signature]);
        assert.equal(call.to?.toLowerCase(), config.router.toLowerCase());
        assert.equal(call.data?.slice(0, 10), live!.router.interface.getFunction('isValidPaymentSignature')!.selector);
        assert.equal(call.data?.toLowerCase(), expected.toLowerCase());
        const deadline = started! + 2000;
        function remaining() {
          const value = deadline - performance.now();
          assert.ok(value > 0, 'Held acceptance phase exceeded its two-second budget');
          return value;
        }
        remaining(); client.abort(); await within(client.ended, 'Native client close', remaining());
        assert.equal(client.closed(), true); assert.equal(client.responses(), 0);
        remaining();
        return { client, gate, started: started!, remaining };
      }
    };
    await run(context); completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const gate of gates) gate.release();
    for (const client of clients) client.abort();
    for (const child of children) await cleanup(() => child.kill());
    for (const client of clients) await cleanup(() => within(client.ended, 'Cleanup native client close', 1000));
    await cleanup(() => { if (reader?.db.isOpen) reader.close(); });
    await cleanup(() => proxy?.close()); await cleanup(() => live?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null));
      const target = resolve(directory!);
      assert.equal(dirname(target), workRoot); assert.ok(target.startsWith(workRoot + sep));
      assert.ok(target.startsWith(join(workRoot, 'cli-disconnected-accept-')));
      rmSync(target, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Disconnected acceptance CLI cleanup failed');
  }
}

test('the actual CLI settles a disconnected acceptance once and preserves it across abrupt restart', { timeout: 45000 }, async t => {
  await fixture(async context => {
    const { live, proxy } = context, cli = context.cli;
    const input = await context.signed('125000000', '0'), key = paymentKey(input.payment);
    const [payerTokens, nativeNonce, payerNativeNonce] = await Promise.all([
      live.token.balanceOf(live.payer.address), live.provider.getTransactionCount(live.relayer.address, 'pending'),
      live.provider.getTransactionCount(live.payer.address, 'pending')
    ]);
    const empty = context.reader.snapshot(); assert.equal(empty.payments.length, 0); assert.equal(empty.audit.length, 0); assert.equal(empty.journals.length, 0);
    const held = await context.hold(input);
    alive(cli); assert.deepEqual(context.reader.snapshot(), empty);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
    const heldMs = performance.now() - held.started; held.remaining(); held.gate.release(); proxy.heal();
    await until(() => context.reader.row(key)?.status === 'settled', 'Disconnected automatic settlement');
    const first = lifecycle(context.reader, key, 'settled');
    assert.equal(first.signature, input.signature); assert.ok(first.raw_tx && first.tx_hash);
    assert.equal(keccak256(first.raw_tx), first.tx_hash); assert.equal(Transaction.from(first.raw_tx).nonce, nativeNonce);
    assert.equal((await live.provider.getTransactionReceipt(first.tx_hash))!.status, 1);
    assert.equal(await live.token.balanceOf(live.payee.address), 125000000n);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
    const settled = context.reader.snapshot();
    await cli.kill();
    const terminated = await cli.exited;
    assert.ok(terminated.signal === 'SIGKILL' || (terminated.code !== null && terminated.code !== 0));
    context.reopen(); assert.deepEqual(context.reader.snapshot(), settled);
    const restarted = await context.restart(cli.apiKey);
    const history = await api(restarted, 'payments');
    assert.equal(history.status, 200);
    const originalHistory = history.body.items.find((row: { id: string }) => row.id === key);
    assert.ok(originalHistory); assert.equal(originalHistory.status, 'settled'); assert.equal(originalHistory.tx_hash, first.tx_hash);
    for (const privateField of ['raw_tx', 'signature']) assert.equal(Object.hasOwn(originalHistory, privateField), false);
    assert.deepEqual(context.reader.snapshot(), settled);
    const replay = await api(restarted, 'payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true); assert.equal(replay.body.payment.tx_hash, first.tx_hash);
    assert.deepEqual(context.reader.snapshot(), settled);
    const next = await context.signed('7000000', '1'), nextKey = paymentKey(next.payment);
    assert.equal((await api(restarted, 'payments', next)).status, 202);
    await until(() => context.reader.row(nextKey)?.status === 'settled', 'Fresh instruction after abrupt restart');
    const second = lifecycle(context.reader, nextKey, 'settled');
    assert.ok(second.raw_tx && second.tx_hash); assert.equal(keccak256(second.raw_tx), second.tx_hash);
    assert.equal(Transaction.from(second.raw_tx).nonce, nativeNonce + 1);
    assert.equal(context.reader.journals().length, 2); assert.equal(context.reader.audit().length, 6);
    const beforeReplay = context.reader.snapshot(), replaySecond = await api(restarted, 'payments', next);
    assert.equal(replaySecond.status, 200); assert.equal(replaySecond.body.replay, true);
    assert.deepEqual(context.reader.snapshot(), beforeReplay);
    const reconciliation = await api(restarted, 'reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 2); assert.deepEqual(reconciliation.body.exceptions, []);
    const [payee, payer, routerNonce, relayerNonce, payerNonce] = await Promise.all([
      live.token.balanceOf(live.payee.address), live.token.balanceOf(live.payer.address), live.router.nonces(live.payer.address),
      live.provider.getTransactionCount(live.relayer.address, 'pending'), live.provider.getTransactionCount(live.payer.address, 'pending')
    ]);
    assert.equal(payee, 132000000n); assert.equal(payer, payerTokens - 132000000n); assert.equal(routerNonce, 2n);
    assert.equal(relayerNonce, nativeNonce + 2); assert.equal(payerNonce, payerNativeNonce);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 2);
    assert.deepEqual(context.reader.snapshot(), beforeReplay);
    assert.equal(held.client.responses(), 0);
    t.diagnostic(JSON.stringify({ disconnectedResponses: 0, heldAcceptanceMs: Math.floor(heldMs),
      settledPayments: 2, journals: 2, nativeSends: 2, reconciled: 2, exceptions: 0, crashRestarts: 1 }));
  });
});

test('the actual POSIX CLI drains a disconnected acceptance on SIGTERM before restart dispatch', {
  timeout: 60000,
  skip: process.platform === 'win32' ? 'Catchable POSIX SIGTERM is required; Windows child.kill(SIGTERM) terminates immediately.' : false
}, async t => {
  await fixture(async context => {
    const { live, proxy } = context, cli = context.cli;
    const input = await context.signed('125000000', '0'), key = paymentKey(input.payment);
    const [payerTokens, nativeNonce, payerNativeNonce] = await Promise.all([
      live.token.balanceOf(live.payer.address), live.provider.getTransactionCount(live.relayer.address, 'pending'),
      live.provider.getTransactionCount(live.payer.address, 'pending')
    ]);
    const empty = context.reader.snapshot(); assert.equal(empty.payments.length, 0); assert.equal(empty.audit.length, 0); assert.equal(empty.journals.length, 0);
    const held = await context.hold(input);
    assert.ok(cli.child.kill('SIGTERM'));
    await until(() => listenerRefused(cli.url), 'Fresh TCP listener refusal', held.remaining());
    const observedAt = performance.now(); let observations = 0;
    do {
      held.remaining(); alive(cli); assert.deepEqual(context.reader.snapshot(), empty);
      assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
      observations++; await sleep(25);
    } while (performance.now() - observedAt < 250);
    held.remaining(); alive(cli); assert.deepEqual(context.reader.snapshot(), empty);
    const observedMs = performance.now() - observedAt, heldMs = performance.now() - held.started;
    held.gate.release(); proxy.heal();
    assert.deepEqual(await within(cli.exited, 'Disconnected acceptance graceful exit'), { code: 0, signal: null });
    context.reopen();
    const queued = lifecycle(context.reader, key, 'queued');
    assert.equal(queued.signature, input.signature); assert.equal(queued.raw_tx, null); assert.equal(queued.tx_hash, null);
    assert.equal(context.reader.journals().length, 0); assert.equal(context.reader.audit().length, 1);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
    assert.equal(await live.token.balanceOf(live.payee.address), 0n); assert.equal(await live.router.nonces(live.payer.address), 0n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), nativeNonce);
    const restarted = await context.restart(cli.apiKey);
    await until(() => context.reader.row(key)?.status === 'settled', 'Restart dispatch of drained acceptance');
    const settled = lifecycle(context.reader, key, 'settled');
    assert.ok(settled.raw_tx && settled.tx_hash); assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.equal(Transaction.from(settled.raw_tx).nonce, nativeNonce);
    const beforeReplay = context.reader.snapshot();
    const history = await api(restarted, 'payments');
    assert.equal(history.status, 200);
    const originalHistory = history.body.items.find((row: { id: string }) => row.id === key);
    assert.ok(originalHistory); assert.equal(originalHistory.status, 'settled'); assert.equal(originalHistory.tx_hash, settled.tx_hash);
    for (const privateField of ['raw_tx', 'signature']) assert.equal(Object.hasOwn(originalHistory, privateField), false);
    assert.deepEqual(context.reader.snapshot(), beforeReplay);
    const replay = await api(restarted, 'payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true); assert.equal(replay.body.payment.tx_hash, settled.tx_hash);
    assert.deepEqual(context.reader.snapshot(), beforeReplay);
    const reconciliation = await api(restarted, 'reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1); assert.deepEqual(reconciliation.body.exceptions, []);
    assert.equal(context.reader.journals().length, 1); assert.equal(context.reader.audit().length, 3);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
    assert.equal(await live.token.balanceOf(live.payee.address), 125000000n);
    assert.equal(await live.token.balanceOf(live.payer.address), payerTokens - 125000000n);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), nativeNonce + 1);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), payerNativeNonce);
    assert.deepEqual(context.reader.snapshot(), beforeReplay); assert.equal(held.client.responses(), 0);
    t.diagnostic(JSON.stringify({ disconnectedResponses: 0, listenerRefused: true, heldAcceptanceMs: Math.floor(heldMs),
      unchangedObservationMs: Math.floor(observedMs), observations, gracefulExits: 1, queuedAtExit: 1,
      sendsBeforeRestart: 0, settledPayments: 1, journals: 1, reconciled: 1, exceptions: 0 }));
  });
});
