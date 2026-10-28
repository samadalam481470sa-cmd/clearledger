import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store, JournalIntegrityError, type Status } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

const token = '0x' + 'aB'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const blockHash = '0x' + 'ee'.repeat(32), max = 2n ** 256n - 1n;
const fixed = 'Stored journal data is invalid; totals are unavailable';
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });
function seed(n: number, status: 'settled' | 'review' = 'settled', amount = '125000000', asset = token) {
  const p: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: asset, amount, nonce: String(n - 1), deadline: '2000000000' };
  const id = store.accept(p, 'synthetic-fingerprint-' + n, 'synthetic-signature').row.id;
  store.broadcast(id, 'synthetic-signed-bytes', '0x' + (1000 + n).toString(16).padStart(64, '0'));
  store.finalize(id, n, blockHash);
  if (status === 'review') store.setStatus(id, 'review', 'Controlled review fixture');
  return id;
}
function snapshot() {
  const hasJournal = store.db.prepare("SELECT name FROM sqlite_master WHERE name='journals'").get();
  return { schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    payments: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: hasJournal ? store.db.prepare('SELECT * FROM journals ORDER BY rowid').all() : null,
    audit: store.events(), changes: store.db.prepare('SELECT total_changes() AS n').get()!.n };
}
const malformed: [string, 'amount' | 'token', string | Uint8Array][] = [
  ['empty amount', 'amount', ''], ['space amount', 'amount', ' '], ['newline amount', 'amount', '\n'],
  ['zero', 'amount', '0'], ['negative', 'amount', '-1'], ['plus sign', 'amount', '+1'],
  ['leading zero', 'amount', '01'], ['fraction', 'amount', '1.0'], ['exponent', 'amount', '1e3'],
  ['hex amount', 'amount', '0x10'], ['trailing newline amount', 'amount', '1\n'],
  ['trailing CRLF amount', 'amount', '1\r\n'], ['NUL amount', 'amount', '1\0'],
  ['Unicode digits', 'amount', '１２'], ['private malformed amount', 'amount', 'TOTALS_PRIVATE_VALUE'],
  ['uint256 overflow', 'amount', (max + 1n).toString()], ['excess length', 'amount', '9'.repeat(79)],
  ['BLOB amount', 'amount', Buffer.from('123')], ['empty token', 'token', ''],
  ['zero token', 'token', '0x' + '00'.repeat(20)], ['short token', 'token', '0x11'],
  ['missing token prefix', 'token', token.slice(2)], ['uppercase token prefix', 'token', '0X' + token.slice(2)],
  ['nonhex token', 'token', '0x' + 'gg'.repeat(20)], ['trailing newline token', 'token', token + '\n'],
  ['leading space token', 'token', ' ' + token], ['private malformed token', 'token', 'TOTALS_PRIVATE_TOKEN'],
  ['BLOB token', 'token', Buffer.from(token)]
];
for (const status of ['settled', 'review'] as const) for (const [label, column, value] of malformed) {
  test(status + ' ' + label + ' invalidates the whole totals report without changing storage', () => {
    seed(1, 'settled', '7', otherToken);
    const id = seed(2, status);
    store.db.prepare('UPDATE journals SET ' + column + '=? WHERE payment_id=?').run(value, id);
    const before = snapshot();
    assert.throws(() => store.assetTotals(), error => error instanceof JournalIntegrityError && error.message === fixed);
    assert.deepEqual(snapshot(), before);
  });
}

test('valid per-row uint256 values aggregate exactly beyond uint256 and group hex address cases', () => {
  seed(1, 'settled', max.toString()); seed(2, 'settled', '1', token.toLowerCase());
  seed(3, 'review', max.toString(), '0x' + token.slice(2).toUpperCase());
  seed(4, 'settled', '7', otherToken);
  const before = snapshot();
  assert.deepEqual(store.assetTotals(), [
    { token: token.toLowerCase(), settledPayments: 2, settledBaseUnits: (max + 1n).toString(),
      reviewPayments: 1, reviewBaseUnits: max.toString() },
    { token: otherToken, settledPayments: 1, settledBaseUnits: '7', reviewPayments: 0, reviewBaseUnits: '0' }
  ]);
  assert.deepEqual(snapshot(), before);
});

test('empty journal history remains an empty valid report without fabricated assets', () => {
  const before = snapshot(); assert.deepEqual(store.assetTotals(), []); assert.deepEqual(snapshot(), before);
});

for (const status of ['queued', 'broadcast', 'failed'] as Status[]) test('journal rows outside settled/review remain excluded: ' + status, () => {
  const id = seed(1);
  store.db.prepare('UPDATE payments SET status=? WHERE id=?').run(status, id);
  store.db.prepare('UPDATE journals SET amount=?,token=? WHERE payment_id=?').run('bad', 'bad', id);
  const before = snapshot(); assert.deepEqual(store.assetTotals(), []); assert.deepEqual(snapshot(), before);
});

test('totals validate journal structure without reconstructing or authenticating stored payment payloads', () => {
  const id = seed(1); store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run('PRIVATE_BAD_PAYLOAD', id);
  const before = snapshot(); assert.equal(store.assetTotals()[0].settledBaseUnits, '125000000');
  assert.deepEqual(snapshot(), before);
});

test('unexpected SQLite failure is not relabeled as malformed journal data', () => {
  seed(1); store.db.exec('DROP TABLE journals'); const before = snapshot();
  assert.throws(() => store.assetTotals(), error => error instanceof Error && !(error instanceof JournalIntegrityError));
  assert.deepEqual(snapshot(), before);
});
