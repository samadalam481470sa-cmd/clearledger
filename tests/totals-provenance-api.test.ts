import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import type { Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { emptyTotals, reduceTotals, totalsCounts } from '../web/totals.ts';

// Real authenticated HTTP and native SQLite, with synthetic settled/review
// records. Client reducer assertions do not mount React or execute transfers.
const apiKey = 'totals-provenance-api-' + 'a'.repeat(32), privateMarker = 'PRIVATE_TOTALS_PROVENANCE';
const unavailable = { assets: null, integrityError: 'Stored journal data is invalid; totals are unavailable' } as const;
const token = '0x' + 'ab'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const blockHash = '0x' + 'ef'.repeat(32), routerAddress = '0x' + '44'.repeat(20);
let store: Store, server: ReturnType<typeof makeServer>, url: string, rpcCalls: number;
async function within<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
beforeEach(async () => {
  store = new Store(); rpcCalls = 0;
  const unexpected = async () => { rpcCalls++; throw new Error('Totals must not request upstream reconstruction'); };
  const provider = { getBlock: unexpected, getBlockNumber: unexpected, getTransactionReceipt: unexpected };
  const router = { connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet, router, 31337, routerAddress);
  server = makeServer({ service, apiKey, mode: 'rpc', port: 0 });
  server.listen(0, '127.0.0.1'); await within(once(server, 'listening'), 'Totals listener readiness');
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  const failures: unknown[] = [];
  const cleanup = async (action: () => unknown) => { try { await action(); } catch (error) { failures.push(error); } };
  let drained = false;
  await cleanup(() => within(server.drainRequests().then(() => { drained = true; }), 'Totals request drain'));
  await cleanup(() => server.closeAllConnections());
  if (server.listening) await cleanup(() => within(new Promise<void>((done, fail) =>
    server.close(error => error ? fail(error) : done())), 'Totals listener close'));
  if (drained) await cleanup(() => store.close());
  else failures.push(new Error('SQLite retained because totals handlers did not drain'));
  if (failures.length) throw new AggregateError(failures, 'Totals provenance HTTP cleanup failed');
});
function posted(n: number, status: 'settled' | 'review', asset: string, amount: string) {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: asset, amount, nonce: String(n - 1), deadline: '2000000000' };
  const row = store.accept(payment, privateMarker + '_fingerprint', privateMarker + '_signature').row;
  store.broadcast(row.id, privateMarker + '_raw', '0x' + 'ab'.repeat(31) + n.toString(16).padStart(2, '0'));
  store.finalize(row.id, n, blockHash);
  if (status === 'review') store.setStatus(row.id, 'review', 'Controlled posted review');
  return store.get(row.id)!;
}
function baseline(status: 'settled' | 'review') {
  const first = posted(1, status, token, '125000000'); posted(2, 'settled', otherToken, '7');
  // The four retained business fields remain readable despite unrelated authorization corruption.
  const payload = JSON.stringify({ ...JSON.parse(first.payload), deadline: privateMarker + '_deadline' });
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(payload, first.id);
  const report = { assets: [
    { token, settledPayments: status === 'settled' ? 1 : 0, settledBaseUnits: status === 'settled' ? '125000000' : '0',
      reviewPayments: status === 'review' ? 1 : 0, reviewBaseUnits: status === 'review' ? '125000000' : '0' },
    { token: otherToken, settledPayments: 1, settledBaseUnits: '7', reviewPayments: 0, reviewBaseUnits: '0' }
  ] };
  return { first: store.get(first.id)!, report };
}
function snapshot() {
  const sql = { schema: 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name',
    payments: 'SELECT rowid,* FROM payments ORDER BY rowid', journals: 'SELECT rowid,* FROM journals ORDER BY rowid',
    audit: 'SELECT * FROM audit ORDER BY sequence', sequence: 'SELECT * FROM sqlite_sequence ORDER BY name',
    changes: 'SELECT total_changes() AS changes' };
  const rows = Object.fromEntries(Object.entries(sql).map(([key, text]) => {
    const query = store.db.prepare(text); query.setReadBigInts(true); return [key, query.all()];
  }));
  return createHash('sha256').update(JSON.stringify(rows, (_, value) => typeof value === 'bigint' ? { sqliteInteger: value.toString() } : value)).digest('hex');
}
async function read(auth = true) {
  const before = snapshot(), calls = rpcCalls;
  const response = await fetch(url + '/api/totals', { signal: AbortSignal.timeout(3000),
    headers: auth ? { Authorization: 'Bearer ' + apiKey } : {} });
  const text = await response.text();
  assert.ok(!text.includes(privateMarker), 'Totals response exposed private persisted evidence');
  assert.equal(snapshot(), before, 'A totals GET changed schema, private rows, journal, audit, sequence or write count');
  assert.equal(rpcCalls, calls, 'Totals must not use RPC for repair or validation');
  return { status: response.status, body: JSON.parse(text) as any };
}

for (const status of ['settled', 'review'] as const) for (const field of ['tx_hash', 'block_number', 'block_hash'] as const)
  test(status + ' journal ' + field + ' disagreement clears the whole HTTP/client report until fixture repair', async t => {
    const { first, report } = baseline(status), journal = store.journal(first.id)!;
    const good = await read(); assert.deepEqual(good, { status: 200, body: report });
    let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
    const counts = { assets: 2, completed: status === 'settled' ? 2 : 1, review: status === 'review' ? 1 : 0 };
    assert.deepEqual(totalsCounts(model), counts);
    const changed = field === 'block_number' ? 999 : privateMarker + '_' + field;
    store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?').run(changed, first.id);
    const denied = await read(false); assert.deepEqual(denied, { status: 401, body: { error: 'Bearer token required' } });
    for (let retry = 0; retry < 2; retry++) {
      const invalid = await read(); assert.deepEqual(invalid, { status: 200, body: unavailable });
      model = reduceTotals(model, { type: 'report', report: invalid.body });
      assert.equal(model.assets, null); assert.equal(model.integrityError, unavailable.integrityError);
      assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
    }
    // Manual fixture restoration is not a production repair operation.
    store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?').run(journal[field], first.id);
    const repaired = await read(); assert.deepEqual(repaired, { status: 200, body: report });
    model = reduceTotals(model, { type: 'report', report: repaired.body });
    assert.deepEqual(totalsCounts(model), counts); assert.equal(model.integrityError, ''); assert.equal(rpcCalls, 0);
    t.diagnostic(JSON.stringify({ status, mismatchedField: field, unavailableReads: 2, repairedAssets: 2, rpcCalls, readWrites: 0 }));
  });

test('posted review with missing payment provenance remains wholly unavailable and null-safe to HTTP readers', async () => {
  const { first, report } = baseline('review'); assert.deepEqual(await read(), { status: 200, body: report });
  store.db.prepare('UPDATE payments SET tx_hash=NULL,block_number=NULL,block_hash=NULL WHERE id=?').run(first.id);
  assert.deepEqual(await read(), { status: 200, body: unavailable });
  store.db.prepare('UPDATE payments SET tx_hash=?,block_number=?,block_hash=? WHERE id=?')
    .run(first.tx_hash, first.block_number, first.block_hash, first.id);
  assert.deepEqual(await read(), { status: 200, body: report }); assert.equal(rpcCalls, 0);
});

test('coherent case-preserving retained hashes remain readable with unrelated authorization corruption', async () => {
  const { first, report } = baseline('settled');
  for (const table of ['payments', 'journals'] as const) {
    const key = table === 'payments' ? 'id' : 'payment_id';
    store.db.prepare('UPDATE ' + table + ' SET tx_hash=?,block_hash=? WHERE ' + key + '=?')
      .run('0x' + first.tx_hash!.slice(2).toUpperCase(), '0x' + first.block_hash!.slice(2).toUpperCase(), first.id);
  }
  assert.deepEqual(await read(), { status: 200, body: report }); assert.equal(rpcCalls, 0);
});


const malformedInclusion = [
  ['short transaction hash', 'settled', 'tx_hash', '0x1234'],
  ['nonhex block hash', 'review', 'block_hash', '0x' + privateMarker.padEnd(64, '0')],
  ['BLOB block hash', 'settled', 'block_hash', Buffer.from(blockHash)],
  ['NUL-suffixed transaction hash', 'review', 'tx_hash', '0x' + 'ab'.repeat(32) + '\0private'],
  ['negative block height', 'settled', 'block_number', -1],
  ['fractional block height', 'review', 'block_number', 1.5],
  ['unsafe block height', 'settled', 'block_number', 9007199254740993n]
] as const;

for (const [label, status, field, malformed] of malformedInclusion) {
  test('matching ' + label + ' invalidates the entire HTTP/client totals report', async t => {
    const { first, report } = baseline(status);
    const good = await read();
    assert.deepEqual(good, { status: 200, body: report });
    let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
    const counts = totalsCounts(model);
    const updates = [
      store.db.prepare('UPDATE payments SET ' + field + '=? WHERE id=?'),
      store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?')
    ];
    for (const statement of updates) statement.run(malformed, first.id);
    assert.deepEqual(await read(false), { status: 401, body: { error: 'Bearer token required' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const invalid = await read();
      assert.deepEqual(invalid, { status: 200, body: unavailable });
      model = reduceTotals(model, { type: 'report', report: invalid.body });
      assert.equal(model.assets, null);
      assert.equal(model.integrityError, unavailable.integrityError);
      assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
    }
    for (const statement of updates) statement.run(first[field], first.id);
    const restored = await read();
    assert.deepEqual(restored, { status: 200, body: report });
    model = reduceTotals(model, { type: 'report', report: restored.body });
    assert.deepEqual(totalsCounts(model), counts);
    assert.equal(model.integrityError, '');
    assert.equal(rpcCalls, 0);
    t.diagnostic(JSON.stringify({ status, field, unavailableReads: 2, restoredAssets: counts.assets, rpcCalls, readWrites: 0 }));
  });
}

const alteredBusinessEvidence = [
  ['journal amount', 'settled', 'amount', '125000001'],
  ['journal token', 'review', 'token', otherToken],
  ['journal debit account', 'settled', 'debit_account', '0x' + '33'.repeat(20)],
  ['journal credit account', 'review', 'credit_account', '0x' + '33'.repeat(20)],
  ['unreadable payment JSON', 'settled', 'payload', privateMarker + '{'],
  ['missing payment projection fields', 'review', 'payload', JSON.stringify({ token, amount: '125000000' })]
] as const;

for (const [label, status, field, changed] of alteredBusinessEvidence) {
  test(label + ' invalidates the entire HTTP/client totals report until fixture restoration', async t => {
    const { first, report } = baseline(status);
    const good = await read(); assert.deepEqual(good, { status: 200, body: report });
    let model = reduceTotals(emptyTotals(), { type: 'report', report: good.body });
    const counts = totalsCounts(model);
    assert.equal(counts.assets, 2);
    const original = field === 'payload' ? first.payload : store.journal(first.id)![field];
    const update = store.db.prepare(field === 'payload' ? 'UPDATE payments SET payload=? WHERE id=?' :
      'UPDATE journals SET ' + field + '=? WHERE payment_id=?');
    update.run(changed, first.id);
    assert.deepEqual(await read(false), { status: 401, body: { error: 'Bearer token required' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const invalid = await read();
      assert.deepEqual(invalid, { status: 200, body: unavailable });
      model = reduceTotals(model, { type: 'report', report: invalid.body });
      assert.equal(model.assets, null);
      assert.equal(model.integrityError, unavailable.integrityError);
      assert.deepEqual(totalsCounts(model), { assets: null, completed: null, review: null });
    }
    update.run(original, first.id);
    const restored = await read(); assert.deepEqual(restored, { status: 200, body: report });
    model = reduceTotals(model, { type: 'report', report: restored.body });
    assert.deepEqual(totalsCounts(model), counts);
    assert.equal(model.integrityError, '');
    assert.equal(rpcCalls, 0);
    t.diagnostic(JSON.stringify({ status, alteredField: field, unavailableReads: 2, restoredAssets: counts.assets, rpcCalls, readWrites: 0 }));
  });
}
