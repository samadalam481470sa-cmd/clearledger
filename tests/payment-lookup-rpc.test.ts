import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(paymentId: string) {
    return this.db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow | undefined;
  }
  journals() { return this.db.prepare('SELECT * FROM journals').all(); }
  events() { return this.db.prepare('SELECT * FROM audit ORDER BY sequence').all(); }
  snapshot() {
    return JSON.stringify({ schema: this.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      payments: this.db.prepare('SELECT * FROM payments ORDER BY rowid').all(), journals: this.journals(), audit: this.events(),
      context: this.db.prepare('SELECT * FROM deployment_context ORDER BY singleton').all(),
      sequence: this.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all() });
  }
  close() { this.db.close(); }
}
async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(message + ' timed out');
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

// The actual CLI owns every write and worker tick. Parent SQLite connections
// are read-only; the proxy serves genuine HTTP503s rather than mocking ethers.
test('the actual CLI serves exact local payment history while replay and overview RPC calls are unavailable', {
  timeout: 45000
}, async t => {
  const workRoot = resolve('../../work'), children: CliHandle[] = [];
  let directory: string | undefined, reader: Projection | undefined, completed = false;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  try {
    compile();
    const live = chain = await localChain();
    const gateway = proxy = await rpcProxy(live.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'payment-lookup-rpc-test-'));
    const db = join(directory, 'journal.sqlite'), routerAddress = await live.router.getAddress();
    const cli = await startCli({ db, rpc: gateway.url, key: live.relayer.privateKey, router: routerAddress,
      onSpawn: (handle: CliHandle) => { children.push(handle); } });
    reader = new Projection(db);
    const block = await live.provider.getBlock('latest'); assert.ok(block);
    const initialTokens = await live.token.balanceOf(live.payer.address);
    const initialRelayerNonce = await live.provider.getTransactionCount(live.relayer.address, 'pending');
    const initialPayerNativeNonce = await live.provider.getTransactionCount(live.payer.address, 'pending');
    const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live.payer.address,
      payee: live.payee.address, token: await live.token.getAddress(), amount: '125000000', nonce: '0',
      deadline: String(block.timestamp + 3600) };
    const input = { payment, signature: await live.payer.signTypedData(domain(31337, routerAddress), paymentTypes, payment) };
    const paymentId = paymentKey(payment);
    const accepted = await api(cli, 'payments', input);
    assert.equal(accepted.status, 202); assert.equal(accepted.body.replay, false);
    assert.equal(accepted.body.payment.id, paymentId);
    await until(() => reader!.get(paymentId)?.status === 'settled', 'Autonomous CLI settlement before local lookup');
    const settled = reader.get(paymentId)!;
    assert.ok(settled.raw_tx && settled.tx_hash);
    const originalRaw = settled.raw_tx, originalHash = settled.tx_hash;
    assert.equal(keccak256(originalRaw), originalHash);
    assert.equal(Transaction.from(originalRaw).nonce, initialRelayerNonce);
    assert.equal(reader.journals().length, 1); assert.equal(reader.events().length, 3);
    assert.deepEqual(reader.events().map(event => event.action), ['accepted', 'broadcast-prepared', 'settled']);
    const originalProjection = reader.snapshot();
    const sends = () => gateway.calls.filter(call => call.method === 'eth_sendRawTransaction');
    assert.equal(sends().length, 1);
    let localReads = 0;
    async function lookup(id: string) {
      const before = reader!.snapshot(), calls = gateway.calls.length;
      const response = await api(cli, 'payments/' + encodeURIComponent(id));
      assert.equal(gateway.calls.length, calls, 'Exact local lookup made an RPC request');
      assert.ok(reader!.snapshot() === before, 'Exact local lookup changed private ledger/context/schema/audit evidence');
      localReads++;
      return response;
    }
    function assertPublic(row: any) {
      assert.equal(row.id, paymentId); assert.equal(row.status, 'settled'); assert.equal(row.tx_hash, originalHash);
      assert.equal(row.block_number, settled.block_number); assert.equal(row.block_hash, settled.block_hash);
      assert.deepEqual(row.payment, payment);
      for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload', 'items', 'replay'])
        assert.equal(Object.hasOwn(row, field), false, 'Exact lookup must return the direct public row DTO');
    }
    const healthyLookup = await lookup(paymentId);
    assert.equal(healthyLookup.status, 200); assertPublic(healthyLookup.body);
    const faultMethods = ['eth_call', 'eth_blockNumber', 'eth_getBlockByNumber'];
    for (const method of faultMethods) gateway.fail(method, 'http-503');
    const faultBaseline = gateway.calls.length;
    const overview = await api(cli, 'overview');
    assert.equal(overview.status, 503);
    assert.deepEqual(overview.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    const unavailableReplay = await api(cli, 'payments', input);
    assert.equal(unavailableReplay.status, 503);
    assert.deepEqual(unavailableReplay.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    const observedFaultMethods = new Set(gateway.calls.slice(faultBaseline).map(call => call.method));
    assert.ok(observedFaultMethods.has('eth_getBlockByNumber') && observedFaultMethods.has('eth_call'),
      'RPC-dependent operations must actually reach the faulting HTTP proxy');
    assert.ok(reader.snapshot() === originalProjection, 'RPC failure changed a previously settled payment');
    const faultLookup = await lookup(paymentId);
    assert.equal(faultLookup.status, 200); assertPublic(faultLookup.body);
    assert.deepEqual(faultLookup.body, healthyLookup.body);
    const unknownId = live.payer.address.toLowerCase() + ':' + id(randomBytes(16).toString('hex'));
    assert.notEqual(unknownId, paymentId);
    const missing = await lookup(unknownId);
    assert.equal(missing.status, 404);
    for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload']) assert.equal(Object.hasOwn(missing.body, field), false);
    assert.equal(reader.journals().length, 1); assert.equal(reader.events().length, 3); assert.equal(sends().length, 1);
    assert.equal(await live.token.balanceOf(live.payee.address), 125000000n);
    assert.equal(await live.token.balanceOf(live.payer.address), initialTokens - 125000000n);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 1);
    gateway.heal();
    const replay = await api(cli, 'payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true); assertPublic(replay.body.payment);
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1);
    assert.deepEqual(reconciliation.body.exceptions, []);
    const healedLookup = await lookup(paymentId);
    assert.equal(healedLookup.status, 200); assert.deepEqual(healedLookup.body, healthyLookup.body);
    assert.ok(reader.snapshot() === originalProjection, 'Read/replay/reconciliation replaced settled private evidence');
    assert.ok(reader.get(paymentId)!.raw_tx === originalRaw); assert.equal(reader.get(paymentId)!.tx_hash, originalHash);
    assert.equal(reader.journals().length, 1); assert.equal(reader.events().length, 3); assert.equal(sends().length, 1);
    assert.equal(reader.journals()[0].tx_hash, originalHash); assert.equal(reader.journals()[0].amount, '125000000');
    assert.equal((await live.provider.getTransactionReceipt(originalHash))!.status, 1);
    assert.equal(await live.token.balanceOf(live.payee.address), 125000000n);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialPayerNativeNonce);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 1);
    t.diagnostic(JSON.stringify({ automaticSettlements: 1, rpcDependent503Responses: 2, localReads,
      rpcCallsDuringExactReads: 0, nativeSends: sends().length, journalRows: reader.journals().length,
      lifecycleEvents: reader.events().length, reconciled: reconciliation.body.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove lookup evidence beneath a live registered CLI child');
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'payment-lookup-rpc-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Payment lookup RPC cleanup failed');
  }
});
