import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { JournalIntegrityError, Store } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

// Real file-backed SQLite caller transactions and an independent read-only
// observer cover existing behavior on one process. No EVM/durability is claimed.
const token = '0x' + 'ab'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const blockHash = '0x' + 'ee'.repeat(32), originalAmount = '125000000';
const fixed = 'Stored journal data is invalid; totals are unavailable';
let store: Store, firstId: string, secondId: string;
let observer: DatabaseSync, directory: string, committedProjection: ReturnType<typeof projection>;
const workRoot = resolve('../../work');

function seed(n: number, asset: string, amount: string, review = false) {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'),
    payer: '0x' + '11'.repeat(20), payee: '0x' + '22'.repeat(20), token: asset,
    amount, nonce: String(n - 1), deadline: '2000000000' };
  const id = store.accept(payment, 'synthetic-fingerprint-' + n, 'synthetic-signature').row.id;
  store.broadcast(id, 'synthetic-signed-bytes', '0x' + (1000 + n).toString(16).padStart(64, '0'));
  store.finalize(id, n, blockHash);
  if (review) store.setStatus(id, 'review', 'Controlled review fixture');
  return id;
}
function rows(sql: string, connection = store.db) {
  const query = connection.prepare(sql); query.setReadBigInts(true); return query.all();
}
function projection(connection = store.db) {
  return { schema: rows('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name', connection),
    payments: rows('SELECT rowid,* FROM payments ORDER BY rowid', connection),
    journals: rows('SELECT rowid,* FROM journals ORDER BY rowid', connection),
    audit: rows('SELECT * FROM audit ORDER BY sequence', connection), sequence: rows('SELECT * FROM sqlite_sequence ORDER BY name', connection) };
}
function readSnapshot() { return { projection: projection(), changes: rows('SELECT total_changes() AS changes') }; }
function expected(amount = originalAmount, reviewAmount = '7') {
  return [
    { token, settledPayments: 1, settledBaseUnits: amount, reviewPayments: 0, reviewBaseUnits: '0' },
    { token: otherToken, settledPayments: 0, settledBaseUnits: '0', reviewPayments: 1, reviewBaseUnits: reviewAmount }
  ];
}
function readsWithinCallerTransaction(report: ReturnType<typeof expected>) {
  const before = readSnapshot();
  assert.equal(store.db.isTransaction, true);
  assert.deepEqual(store.assetTotals(), report);
  assert.equal(store.db.isTransaction, true, 'Totals must not commit or end the caller transaction');
  assert.deepEqual(readSnapshot(), before, 'The read must add no rows, audit events, sequence or total_changes');
  assert.deepEqual(projection(observer), committedProjection, 'Other connections must still see only committed data');
}
function rejectsWithinCallerTransaction() {
  const before = readSnapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => store.assetTotals(), error => error instanceof JournalIntegrityError && error.message === fixed);
    assert.equal(store.db.isTransaction, true, 'Rejected iteration must not end the caller transaction');
    assert.deepEqual(readSnapshot(), before, 'Rejected reads must not repair or mutate the fixture');
    assert.deepEqual(projection(observer), committedProjection, 'Rejected reads must not publish caller writes');
  }
}
function callerRollback() {
  assert.equal(store.db.isTransaction, true);
  store.db.exec('ROLLBACK');
  assert.equal(store.db.isTransaction, false);
}
beforeEach(() => {
  mkdirSync(workRoot, { recursive: true });
  directory = mkdtempSync(join(workRoot, 'totals-transactions-'));
  const file = join(directory, 'ledger.sqlite');
  store = new Store(file);
  firstId = seed(1, token, originalAmount);
  secondId = seed(2, otherToken, '7', true);
  observer = new DatabaseSync(file, { readOnly: true });
  committedProjection = projection(observer);
  assert.deepEqual(projection(), committedProjection);
  assert.equal(store.db.isTransaction, false);
});
afterEach(() => {
  const failures: unknown[] = [];
  function cleanup(action: () => void) { try { action(); } catch (error) { failures.push(error); } }
  cleanup(() => { if (store?.db.isOpen && store.db.isTransaction) store.db.exec('ROLLBACK'); });
  cleanup(() => { if (observer?.isOpen) observer.close(); });
  cleanup(() => { if (store?.db.isOpen) store.close(); });
  if (!failures.length && directory) cleanup(() => {
    assert.equal(dirname(resolve(directory)), workRoot);
    assert.ok(directory.startsWith(join(workRoot, 'totals-transactions-')));
    rmSync(directory, { recursive: true, force: true });
  });
  if (failures.length) throw new AggregateError(failures, 'Caller transaction fixture cleanup failed');
});

test('successful totals see a caller uncommitted amount edit without committing it', () => {
  const original = projection(), amount = '90071992547409931234567890';
  store.db.exec('BEGIN IMMEDIATE');
  store.audit(firstId, 'caller-test-marker', 'Uncommitted caller audit entry');
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run(amount, firstId);
  assert.equal(store.journal(firstId)!.amount, amount);
  readsWithinCallerTransaction(expected(amount));
  readsWithinCallerTransaction(expected(amount));
  callerRollback();
  assert.deepEqual(projection(), original, 'Caller rollback must restore the original persisted projection');
  assert.deepEqual(projection(observer), original);
  const restored = readSnapshot();
  assert.deepEqual(store.assetTotals(), expected());
  assert.equal(store.db.isTransaction, false); assert.deepEqual(readSnapshot(), restored);
});

test('missing-journal rejection preserves the caller transaction and its ability to roll back', () => {
  const original = projection();
  store.db.exec('BEGIN IMMEDIATE');
  store.audit(firstId, 'caller-test-marker', 'Uncommitted caller audit entry');
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(firstId);
  assert.equal(store.journal(firstId), undefined);
  rejectsWithinCallerTransaction();
  assert.equal(rows('SELECT * FROM journals').length, 1, 'Further caller reads remain usable after iterator rejection');
  callerRollback();
  assert.deepEqual(projection(), original, 'The caller must still be able to restore its deleted posting');
  assert.deepEqual(projection(observer), original);
  const restored = readSnapshot();
  assert.deepEqual(store.assetTotals(), expected());
  assert.equal(store.db.isTransaction, false); assert.deepEqual(readSnapshot(), restored);
});

test('malformed-value rejection permits caller savepoint recovery and further totals reads', () => {
  const original = projection();
  store.db.exec('BEGIN IMMEDIATE');
  store.audit(firstId, 'caller-test-marker', 'Uncommitted caller audit entry');
  const callerProjection = projection();
  store.db.exec('SAVEPOINT before_corruption');
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('PRIVATE_INVALID_AMOUNT', firstId);
  rejectsWithinCallerTransaction();
  store.db.exec('ROLLBACK TO before_corruption');
  store.db.exec('RELEASE before_corruption');
  assert.equal(store.db.isTransaction, true, 'Releasing a nested savepoint must retain caller ownership');
  assert.deepEqual(projection(), callerProjection);
  readsWithinCallerTransaction(expected());
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('23', secondId);
  readsWithinCallerTransaction(expected(originalAmount, '23'));
  callerRollback();
  assert.deepEqual(projection(), original);
  assert.deepEqual(projection(observer), original);
  const restored = readSnapshot();
  assert.deepEqual(store.assetTotals(), expected());
  assert.equal(store.db.isTransaction, false); assert.deepEqual(readSnapshot(), restored);
});
