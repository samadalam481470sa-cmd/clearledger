import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { type Payment } from '../src/payment.ts';
import { emptyTotals, reduceTotals, totalsCounts } from '../web/totals.ts';

// Authenticated HTTP plus synthetic SQLite, not executed EVM transfers.
const key = 'totals-integrity-test-token', token = '0x' + 'ab'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const fixed = 'Stored journal data is invalid; totals are unavailable', privateValue = 'TOTALS_PRIVATE_CORRUPTION';
let store: Store, server: ReturnType<typeof makeServer>, url: string, rpcCalls: number;
beforeEach(async () => {
  store = new Store(); rpcCalls = 0;
  const provider = { getBlock: async () => { rpcCalls++; throw new Error('Totals must not depend on RPC'); } };
  const router = { connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    router, 31337, '0x' + '44'.repeat(20));
  server = makeServer({ service, apiKey: key, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  await server.drainRequests(); server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  store.close();
});
function seed(n: number, review = false, amount = '125000000', asset = token) {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: asset, amount, nonce: String(n - 1), deadline: '2000000000' };
  const id = store.accept(payment, privateValue + '_fingerprint', privateValue + '_signature').row.id;
  store.broadcast(id, privateValue + '_raw', '0x' + (1000 + n).toString(16).padStart(64, '0'));
  store.finalize(id, n, blockHash); if (review) store.setStatus(id, 'review', 'Synthetic review fixture');
  return id;
}
function snapshot() {
  const hasJournal = store.db.prepare("SELECT name FROM sqlite_master WHERE name='journals'").get();
  return JSON.stringify({ schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    rows: store.list(), journals: hasJournal ? store.journals() : null, audit: store.events(),
    changes: store.db.prepare('SELECT total_changes() AS n').get()!.n });
}
async function read(auth = true) {
  const response = await fetch(url + '/api/totals', { signal: AbortSignal.timeout(3000),
    headers: auth ? { Authorization: 'Bearer ' + key } : {} });
  const text = await response.text();
  assert.ok(!text.includes(privateValue), 'Totals response exposed a private persisted value');
  return { status: response.status, body: JSON.parse(text) as any };
}

test('HTTP reports whole-report unavailability for malformed included values without RPC, leaks, or writes', async t => {
  seed(1, false, '7', '0x' + 'cd'.repeat(20)); const id = seed(2);
  const malformed: ['amount' | 'token', string | Uint8Array][] = [
    ['amount', privateValue], ['amount', ' '], ['amount', '-1'], ['amount', '0x10'],
    ['amount', (2n ** 256n).toString()], ['amount', '1\n'], ['amount', Buffer.from('7')],
    ['token', privateValue], ['token', '0x' + '00'.repeat(20)], ['token', token + '\n'], ['token', Buffer.from(token)]
  ];
  for (const status of ['settled', 'review']) for (const [column, value] of malformed) {
    store.db.prepare('UPDATE payments SET status=? WHERE id=?').run(status, id);
    store.db.prepare('UPDATE journals SET amount=?,token=? WHERE payment_id=?').run('125000000', token, id);
    store.db.prepare('UPDATE journals SET ' + column + '=? WHERE payment_id=?').run(value, id);
    const before = snapshot(), result = await read();
    assert.equal(result.status, 200); assert.deepEqual(result.body, { assets: null, integrityError: fixed });
    assert.equal(snapshot(), before); assert.equal(rpcCalls, 0);
  }
  const denied = await read(false); assert.equal(denied.status, 401); assert.equal(denied.body.integrityError, undefined);
  t.diagnostic(JSON.stringify({ malformedReports: malformed.length * 2, returnedPartialReports: 0, rpcCalls: 0, storageWritesByReads: 0 }));
});

test('valid HTTP totals retain exact success shape and recover after controlled structural repair', async () => {
  assert.deepEqual(await read(), { status: 200, body: { assets: [] } });
  const max = 2n ** 256n - 1n, first = seed(1, false, max.toString());
  seed(2, false, '1', '0x' + token.slice(2).toUpperCase()); seed(3, true, '7');
  const expected = { assets: [{ token, settledPayments: 2, settledBaseUnits: (max + 1n).toString(), reviewPayments: 1, reviewBaseUnits: '7' }] };
  const before = snapshot(), good = await read();
  assert.deepEqual(good, { status: 200, body: expected }); assert.equal(snapshot(), before);
  let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
  assert.deepEqual(totalsCounts(model), { assets: 1, completed: 2, review: 1 });
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run(privateValue, first);
  const invalid = await read();
  assert.deepEqual(invalid, { status: 200, body: { assets: null, integrityError: fixed } } as const);
  model = reduceTotals(model, { type: 'report', report: invalid.body });
  assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
  assert.equal(model.assets, null); assert.equal(model.integrityError, fixed);
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run(max.toString(), first);
  const repaired = snapshot(), recovered = await read();
  assert.deepEqual(recovered, { status: 200, body: expected });
  model = reduceTotals(model, { type: 'report', report: recovered.body });
  assert.deepEqual(totalsCounts(model), { assets: 1, completed: 2, review: 1 });
  assert.equal(model.integrityError, ''); assert.equal(model.transportError, '');
  assert.equal(snapshot(), repaired); assert.equal(rpcCalls, 0);
});

test('unexpected SQLite errors retain existing HTTP failure handling instead of an integrity report', async () => {
  seed(1); store.db.exec('DROP TABLE journals'); const before = snapshot(), result = await read();
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Storage operation failed; check payment history before retrying' });
  assert.equal(snapshot(), before); assert.equal(rpcCalls, 0);
});
