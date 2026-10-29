import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { getAddress, Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { emptyTotals, reduceTotals, totalsCounts } from '../web/totals.ts';

// Authenticated HTTP and real SQLite with synthetic canonical receipt evidence.
// These tests do not execute EVM transfers, mount React, or establish browser UI.
const apiKey = 'totals-relations-api-' + 'a'.repeat(32);
const privateMarker = 'PRIVATE_TOTALS_RELATION_EVIDENCE';
const unavailable = { assets: null, integrityError: 'Stored journal data is invalid; totals are unavailable' } as const;
const tokenA = getAddress('0x' + 'ab'.repeat(20)), tokenB = getAddress('0x' + 'cd'.repeat(20));
const blockHash = '0x' + 'ee'.repeat(32), routerAddress = '0x' + '44'.repeat(20);
const iface = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const expected = { assets: [
  { token: tokenA.toLowerCase(), settledPayments: 1, settledBaseUnits: '125000000', reviewPayments: 0, reviewBaseUnits: '0' },
  { token: tokenB.toLowerCase(), settledPayments: 1, settledBaseUnits: '7000000', reviewPayments: 0, reviewBaseUnits: '0' }
] };
let store: Store, server: ReturnType<typeof makeServer>, url: string, rpcCalls: number;
let receipts: Map<string, unknown>;
beforeEach(async () => {
  store = new Store(); receipts = new Map(); rpcCalls = 0;
  const provider = {
    getTransactionReceipt: async (hash: string) => { rpcCalls++; return receipts.get(hash) ?? null; },
    getBlock: async (number: number) => { rpcCalls++; return { number, hash: blockHash }; }
  };
  const router = { interface: iface, connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    router, 31337, routerAddress);
  server = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  await server.drainRequests(); server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  store.close();
});
function seed(n: number, asset = tokenA, amount = '125000000') {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: asset, amount, nonce: String(n - 1), deadline: '2000000000' };
  const row = store.accept(payment, privateMarker + '_fingerprint', privateMarker + '_signature').row;
  const hash = '0x' + (1000 + n).toString(16).padStart(64, '0');
  store.broadcast(row.id, privateMarker + '_raw', hash); store.finalize(row.id, n, blockHash);
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
  receipts.set(hash, { hash, blockNumber: n, blockHash, status: 1,
    logs: [{ address: routerAddress, transactionHash: hash, blockNumber: n, blockHash, ...log }] });
  return store.get(row.id)!;
}
function baseline() { return { first: seed(1), second: seed(2, tokenB, '7000000') }; }
function restoreJournal(journal: NonNullable<ReturnType<Store['journal']>>) {
  store.db.prepare('INSERT INTO journals VALUES(?,?,?,?,?,?,?,?)').run(journal.payment_id, journal.token,
    journal.debit_account, journal.credit_account, journal.amount, journal.tx_hash, journal.block_number, journal.block_hash);
}
function snapshot() {
  return JSON.stringify({ schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    rows: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: store.db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    changes: store.db.prepare('SELECT total_changes() AS n').get()!.n });
}
async function request(path: string, body?: unknown, auth = true) {
  const response = await fetch(url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  assert.ok(!text.includes(privateMarker), 'Totals API exposed private persisted relation evidence');
  return { status: response.status, body: JSON.parse(text) as any };
}
async function readUnchanged(auth = true) {
  const before = snapshot(), calls = rpcCalls, result = await request('totals', undefined, auth);
  assert.ok(snapshot() === before, 'A totals GET changed schema, private rows, journals, audit or total_changes');
  assert.equal(rpcCalls, calls, 'Totals must remain a local read without RPC repair or reconstruction');
  return result;
}

test('missing settled journal invalidates the whole HTTP report and cached client totals until controlled repair', async t => {
  const { first } = baseline(), journal = store.journal(first.id)!;
  // Totals must inspect relationships without parsing or reconstructing private
  // payment JSON. A different asset remains otherwise valid throughout.
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(privateMarker + '{', first.id);
  const good = await readUnchanged(); assert.deepEqual(good, { status: 200, body: expected });
  let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
  assert.deepEqual(totalsCounts(model), { assets: 2, completed: 2, review: 0 });
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(first.id);
  const denied = await readUnchanged(false);
  assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'Bearer token required' });
  const invalid = await readUnchanged();
  t.diagnostic(JSON.stringify({ missingSettledJournals: 1, httpStatus: invalid.status,
    returnedAssetCount: Array.isArray(invalid.body.assets) ? invalid.body.assets.length : null, rpcCalls }));
  assert.deepEqual(invalid, { status: 200, body: unavailable });
  model = reduceTotals(model, { type: 'report', report: invalid.body });
  assert.equal(model.assets, null); assert.equal(model.integrityError, unavailable.integrityError);
  assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
  restoreJournal(journal); // Test-only restoration from saved projection evidence.
  const recovered = await readUnchanged(); assert.deepEqual(recovered, { status: 200, body: expected });
  model = reduceTotals(model, { type: 'report', report: recovered.body });
  assert.deepEqual(totalsCounts(model), { assets: 2, completed: 2, review: 0 });
  assert.equal(model.integrityError, ''); assert.equal(rpcCalls, 0);
});

test('an orphan journal invalidates all assets without RPC or GET mutation and controlled deletion restores totals', async () => {
  baseline(); assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  const orphan = { ...store.journals()[0], payment_id: privateMarker };
  store.db.exec('PRAGMA foreign_keys=OFF');
  try { restoreJournal(orphan); } finally { store.db.exec('PRAGMA foreign_keys=ON'); }
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.deepEqual(await readUnchanged(), { status: 200, body: unavailable });
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(privateMarker);
  assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  assert.equal(rpcCalls, 0);
});

for (const status of ['queued', 'broadcast', 'failed']) test('a journal attached to ' + status +
  ' invalidates the whole HTTP report until its fixture relationship is restored', async () => {
  const { first } = baseline(); assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  // Deliberate relationship corruption, not an allowed lifecycle transition.
  store.db.prepare('UPDATE payments SET status=? WHERE id=?').run(status, first.id);
  assert.deepEqual(await readUnchanged(), { status: 200, body: unavailable });
  store.db.prepare("UPDATE payments SET status='settled' WHERE id=?").run(first.id);
  assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  assert.equal(rpcCalls, 0);
});

for (const [description, number, hash] of [
  ['block number', 1, null], ['block hash', null, blockHash], ['both block fields', 1, blockHash]
] as const) test('an unjournaled review with ' + description + ' cannot silently disappear from totals', async () => {
  const { first } = baseline(), journal = store.journal(first.id)!;
  assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(first.id);
  store.db.prepare("UPDATE payments SET status='review',block_number=?,block_hash=? WHERE id=?").run(number, hash, first.id);
  assert.deepEqual(await readUnchanged(), { status: 200, body: unavailable });
  // Controlled fixture repair is separate from any production repair endpoint.
  store.db.prepare("UPDATE payments SET status='settled',block_number=?,block_hash=? WHERE id=?")
    .run(first.block_number, first.block_hash, first.id);
  restoreJournal(journal);
  assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  assert.equal(rpcCalls, 0);
});

test('an unjournaled review without either block field remains excluded from valid local totals', async () => {
  baseline();
  const payment: Payment = { paymentId: '0x' + '99'.repeat(32), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: tokenA, amount: '9000000', nonce: '2', deadline: '2000000000' };
  const row = store.accept(payment, privateMarker, privateMarker).row;
  store.broadcast(row.id, privateMarker, '0x' + '99'.repeat(32));
  store.setStatus(row.id, 'review', 'Synthetic receipt lacked expected settlement event');
  assert.equal(store.get(row.id)!.block_number, null); assert.equal(store.get(row.id)!.block_hash, null);
  assert.equal(store.journal(row.id), undefined);
  assert.deepEqual(await readUnchanged(), { status: 200, body: expected });
  assert.equal(rpcCalls, 0);
});

test('reconciliation of a missing settled journal retains block evidence and keeps HTTP totals unavailable', async () => {
  const { first, second } = baseline();
  const good = await readUnchanged(); assert.deepEqual(good, { status: 200, body: expected });
  let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
  const retainedJournal = store.journal(second.id);
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(first.id);
  const invalid = await readUnchanged(); assert.deepEqual(invalid, { status: 200, body: unavailable });
  model = reduceTotals(model, { type: 'report', report: invalid.body });
  assert.equal(model.assets, null);
  const reconciliation = await request('reconcile', {});
  assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 2);
  assert.deepEqual(reconciliation.body.exceptions, [first.id]);
  const reviewed = store.get(first.id)!;
  assert.equal(reviewed.status, 'review'); assert.equal(reviewed.block_number, first.block_number);
  assert.equal(reviewed.block_hash, first.block_hash); assert.equal(reviewed.tx_hash, first.tx_hash);
  assert.ok(reviewed.raw_tx === first.raw_tx && reviewed.payload === first.payload);
  assert.equal(store.journal(first.id), undefined); assert.deepEqual(store.journal(second.id), retainedJournal);
  assert.equal(store.events().filter(event => event.payment_id === first.id && event.action === 'review').length, 1);
  assert.equal(rpcCalls, 4, 'Only the explicit synthetic reconciliation may query receipt/canonical evidence');
  const afterReview = await readUnchanged();
  assert.deepEqual(afterReview, { status: 200, body: unavailable });
  model = reduceTotals(model, { type: 'report', report: afterReview.body });
  assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
  assert.equal(model.integrityError, unavailable.integrityError);
  assert.equal(store.get(second.id)!.status, 'settled'); assert.equal(store.journals().length, 1);
});
