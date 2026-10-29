import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JournalIntegrityError, Store, type Status } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

// Real Store transitions establish valid projections before controlled SQL
// corruption. These are local accounting/read checks, not EVM authorization.
const token = '0x' + 'ab'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const blockHash = '0x' + 'ee'.repeat(32), max = 2n ** 256n - 1n;
const fixed = 'Stored journal data is invalid; totals are unavailable';
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

function queue(n: number, amount = '125000000', asset = token) {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'),
    payer: '0x' + '11'.repeat(20), payee: '0x' + '22'.repeat(20), token: asset,
    amount, nonce: String(n - 1), deadline: '2000000000' };
  return store.accept(payment, 'synthetic-fingerprint-' + n, 'synthetic-signature').row.id;
}
function broadcast(id: string, n: number) {
  store.broadcast(id, 'synthetic-signed-transaction', '0x' + (1000 + n).toString(16).padStart(64, '0'));
}
function posted(n: number, status: 'settled' | 'review' = 'settled', amount = '125000000', asset = token) {
  const id = queue(n, amount, asset); broadcast(id, n); store.finalize(id, n, blockHash);
  if (status === 'review') store.setStatus(id, 'review', 'Controlled posted review');
  return id;
}
function unposted(n: number, status: Exclude<Status, 'settled'>) {
  const id = queue(n);
  if (status === 'broadcast' || status === 'review') broadcast(id, n);
  if (status === 'failed' || status === 'review')
    store.setStatus(id, status, status === 'review' ? 'Receipt does not contain the expected settlement event' : 'Controlled preflight rejection');
  return id;
}
function all(sql: string) {
  const query = store.db.prepare(sql); query.setReadBigInts(true); return query.all();
}
function snapshot() {
  return { schema: all('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name'),
    payments: all('SELECT rowid,* FROM payments ORDER BY rowid'),
    journals: all('SELECT rowid,* FROM journals ORDER BY rowid'),
    audit: all('SELECT * FROM audit ORDER BY sequence'), sequence: all('SELECT * FROM sqlite_sequence ORDER BY name'),
    changes: all('SELECT total_changes() AS changes') };
}
function unavailable() {
  const before = snapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => store.assetTotals(), error => error instanceof JournalIntegrityError && error.message === fixed);
    assert.deepEqual(snapshot(), before, 'Unavailable reads must not repair or modify any projection');
  }
}

test('a settled payment missing its journal invalidates the whole report rather than returning a partial asset', () => {
  const id = posted(1); posted(2, 'settled', '7', otherToken);
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(id);
  unavailable();
});

test('moving a journal-less settlement to review retains unavailability and its recorded provenance', () => {
  const id = posted(1); posted(2, 'settled', '7', otherToken);
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(id);
  unavailable();
  const before = store.get(id)!;
  store.setStatus(id, 'review', 'Controlled missing journal review');
  assert.equal(store.get(id)!.block_number, before.block_number);
  assert.equal(store.get(id)!.block_hash, before.block_hash);
  unavailable();
});

const recordedMetadata: [string, number | string | null, string | Buffer | null][] = [
  ['both fields', 17, blockHash], ['number only', 17, null], ['hash only', null, blockHash],
  ['zero number', 0, null], ['empty number', '', null], ['empty hash', null, ''],
  ['malformed number', 'PRIVATE_RECORDED_NUMBER', null], ['malformed hash', null, 'PRIVATE_RECORDED_HASH'],
  ['blob hash', null, Buffer.from('PRIVATE_RECORDED_HASH')]
];
for (const [label, number, hash] of recordedMetadata)
  test('review without a journal is unavailable with any recorded provenance: ' + label, () => {
    const id = posted(1, 'review'); posted(2, 'settled', '7', otherToken);
    store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(id);
    store.db.prepare('UPDATE payments SET block_number=?,block_hash=? WHERE id=?').run(number, hash, id);
    unavailable();
  });

test('an orphaned journal invalidates all assets even after foreign-key enforcement is restored', () => {
  const id = posted(1); posted(2, 'settled', '7', otherToken);
  store.db.exec('PRAGMA foreign_keys=OFF');
  try { store.db.prepare('DELETE FROM payments WHERE id=?').run(id); }
  finally { store.db.exec('PRAGMA foreign_keys=ON'); }
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get()!.foreign_keys, 1);
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length, 1);
  unavailable();
});

for (const status of ['queued', 'broadcast', 'failed'] as const)
  test('a valid-valued journal attached to ' + status + ' is unavailable rather than excluded', () => {
    const id = posted(1); posted(2, 'settled', '7', otherToken);
    store.db.prepare('UPDATE payments SET status=? WHERE id=?').run(status, id);
    unavailable();
  });

test('missing journals are checked beyond the latest 100-payment overview preview', () => {
  const missing = posted(1);
  for (let n = 2; n <= 103; n++) posted(n, 'settled', '7', otherToken);
  assert.equal(store.list(100).some(row => row.id === missing), false);
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(missing);
  unavailable();
});

for (const status of ['queued', 'broadcast', 'failed', 'review'] as const)
  test('an unposted ' + status + ' with no recorded block metadata is a valid empty report', () => {
    const id = unposted(1, status), before = snapshot();
    assert.equal(store.get(id)!.block_number, null); assert.equal(store.get(id)!.block_hash, null);
    assert.deepEqual(store.assetTotals(), []); assert.deepEqual(snapshot(), before);
  });

test('valid posted settled/review journals and legitimate unposted states preserve exact per-asset totals', () => {
  posted(1, 'settled', max.toString()); posted(2, 'settled', '1', token.toUpperCase().replace('0X', '0x'));
  posted(3, 'review', max.toString()); posted(4, 'settled', '7', otherToken);
  for (const [index, status] of (['queued', 'broadcast', 'failed', 'review'] as const).entries()) unposted(index + 5, status);
  const before = snapshot();
  assert.deepEqual(store.assetTotals(), [
    { token, settledPayments: 2, settledBaseUnits: (max + 1n).toString(), reviewPayments: 1, reviewBaseUnits: max.toString() },
    { token: otherToken, settledPayments: 1, settledBaseUnits: '7', reviewPayments: 0, reviewBaseUnits: '0' }
  ]);
  assert.deepEqual(snapshot(), before);
});

test('relationship validation does not reconstruct payment payloads or authenticate stored authorizations', () => {
  const id = posted(1); posted(2, 'review', '7', otherToken);
  store.db.prepare('UPDATE payments SET payload=?,signature=?,fingerprint=? WHERE id=?')
    .run('PRIVATE_INVALID_JSON', 'PRIVATE_INVALID_SIGNATURE', 'PRIVATE_INVALID_FINGERPRINT', id);
  const before = snapshot();
  assert.deepEqual(store.assetTotals(), [
    { token, settledPayments: 1, settledBaseUnits: '125000000', reviewPayments: 0, reviewBaseUnits: '0' },
    { token: otherToken, settledPayments: 0, settledBaseUnits: '0', reviewPayments: 1, reviewBaseUnits: '7' }
  ]);
  assert.deepEqual(snapshot(), before);
});
