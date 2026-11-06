import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { JournalIntegrityError, Store } from '../src/store.ts';
import type { Payment } from '../src/payment.ts';

// Native SQLite projection checks with synthetic authorization/transaction
// evidence. Matching retained values are not signature or chain attestation.
const token = '0x' + 'ab'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const blockHash = '0x' + 'ef'.repeat(32), fixed = 'Stored journal data is invalid; totals are unavailable';
const fields = ['tx_hash', 'block_number', 'block_hash'] as const;
type Field = typeof fields[number];
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });
function posted(n: number, status: 'settled' | 'review' = 'settled', asset = token, amount = '125000000', upperCase = false) {
  const payment: Payment = { paymentId: '0x' + n.toString(16).padStart(64, '0'), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: asset, amount, nonce: String(n - 1), deadline: '2000000000' };
  const row = store.accept(payment, 'PRIVATE_PROVENANCE_FINGERPRINT', 'PRIVATE_PROVENANCE_SIGNATURE').row;
  let hash = '0x' + 'ab'.repeat(31) + n.toString(16).padStart(2, '0'), inclusion = blockHash;
  if (upperCase) { hash = '0x' + hash.slice(2).toUpperCase(); inclusion = '0x' + inclusion.slice(2).toUpperCase(); }
  store.broadcast(row.id, 'PRIVATE_PROVENANCE_RAW', hash); store.finalize(row.id, n, inclusion);
  if (status === 'review') store.setStatus(row.id, 'review', 'Controlled posted review');
  return store.get(row.id)!;
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
function corrupt(table: 'payments' | 'journals', field: Field, value: string | number | bigint | Buffer | null, key: string) {
  store.db.prepare('UPDATE ' + table + ' SET ' + field + '=? WHERE ' + (table === 'payments' ? 'id' : 'payment_id') + '=?').run(value, key);
}
function replaceInclusion(field: Field, value: string | number | bigint | Buffer, key: string) {
  corrupt('payments', field, value, key);
  corrupt('journals', field, value, key);
}
function refuse() {
  const before = snapshot();
  for (let retry = 0; retry < 2; retry++) {
    assert.throws(() => store.assetTotals(), error => error instanceof JournalIntegrityError && error.message === fixed);
    assert.equal(snapshot(), before, 'Unavailable totals must not modify schema, private rows, journal, audit, sequence or write count');
  }
}
function expected(status: 'settled' | 'review', amount = '125000000') {
  return [
    { token, settledPayments: status === 'settled' ? 1 : 0, settledBaseUnits: status === 'settled' ? amount : '0',
      reviewPayments: status === 'review' ? 1 : 0, reviewBaseUnits: status === 'review' ? amount : '0' },
    { token: otherToken, settledPayments: 1, settledBaseUnits: '7', reviewPayments: 0, reviewBaseUnits: '0' }
  ];
}

for (const status of ['settled', 'review'] as const) for (const table of ['payments', 'journals'] as const)
  for (const field of fields) test(status + ' ' + table + ' ' + field + ' disagreement invalidates every asset', t => {
    const row = posted(1, status); posted(2, 'settled', otherToken, '7');
    assert.deepEqual(store.assetTotals(), expected(status));
    const changed = field === 'block_number' ? 999 : '0x' + '99'.repeat(32);
    corrupt(table, field, changed, row.id);
    if (status === 'settled' && table === 'payments' && field === 'tx_hash') {
      // Emit only public counts if the old implementation misleadingly returns
      // ordinary totals. No retained transaction or private payload is printed.
      let misleading: ReturnType<Store['assetTotals']> | undefined;
      try { misleading = store.assetTotals(); } catch (error) { if (!(error instanceof JournalIntegrityError)) throw error; }
      if (misleading) t.diagnostic(JSON.stringify({ mismatchedRetainedTxHash: true, reportedAssets: misleading.length,
        reportedSettledPayments: misleading.reduce((sum, asset) => sum + asset.settledPayments, 0) }));
    }
    refuse();
  });

for (const status of ['settled', 'review'] as const) for (const field of fields)
  test(status + ' linked payment missing ' + field + ' invalidates its posted journal', () => {
    const row = posted(1, status); posted(2, 'settled', otherToken, '7');
    corrupt('payments', field, null, row.id); refuse();
  });

for (const status of ['settled', 'review'] as const) for (const field of ['tx_hash', 'block_hash'] as const) {
  test(status + ' one-sided letter case in ' + field + ' is an exact stored disagreement', () => {
    const row = posted(1, status); posted(2, 'settled', otherToken, '7');
    corrupt('payments', field, '0x' + row[field]!.slice(2).toUpperCase(), row.id); refuse();
  });
  test(status + ' identical hash bytes as BLOB versus TEXT disagree for ' + field, () => {
    const row = posted(1, status); posted(2, 'settled', otherToken, '7');
    corrupt('journals', field, Buffer.from(row[field]!), row.id); refuse();
  });
}

for (const field of ['tx_hash', 'block_hash'] as const) for (const [label, value] of [
  ['short', '0x12'],
  ['nonhex', '0x' + 'z'.repeat(64)],
  ['newline-suffixed', blockHash + '\n'],
  ['NUL-suffixed', blockHash + '\0ignored'],
  ['BLOB', Buffer.from(blockHash)]
] as const) test('coherent ' + label + ' ' + field + ' invalidates every asset', () => {
  const row = posted(1, field === 'tx_hash' ? 'settled' : 'review');
  posted(2, 'settled', otherToken, '7');
  replaceInclusion(field, value, row.id);
  refuse();
});

for (const [label, height] of [
  ['negative', -1n], ['fractional REAL', 1.5], ['above the safe integer range', 9007199254740992n],
  ['nonnumeric TEXT', 'invalid-height'], ['BLOB', Buffer.from('1')]
] as const) test('coherent block number ' + label + ' invalidates every asset', () => {
  const row = posted(1); posted(2, 'settled', otherToken, '7');
  replaceInclusion('block_number', height, row.id);
  refuse();
});

for (const height of [0n, BigInt(Number.MAX_SAFE_INTEGER)])
  test('coherent block number ' + height + ' preserves exact totals', () => {
    const row = posted(1); posted(2, 'settled', otherToken, '7');
    replaceInclusion('block_number', height, row.id);
    const before = snapshot();
    assert.deepEqual(store.assetTotals(), expected('settled'));
    assert.equal(snapshot(), before);
  });

for (const status of ['settled', 'review'] as const)
  test('coherent ' + status + ' Store finalization retains case-preserving metadata and exact volume', () => {
    const amount = (2n ** 256n - 1n).toString();
    const row = posted(1, status, token, amount, true); posted(2, 'settled', otherToken, '7');
    assert.equal(row.tx_hash, store.journal(row.id)!.tx_hash); assert.equal(row.block_hash, store.journal(row.id)!.block_hash);
    assert.notEqual(row.block_hash, row.block_hash!.toLowerCase());
    const before = snapshot(); assert.deepEqual(store.assetTotals(), expected(status, amount)); assert.equal(snapshot(), before);
  });

const businessMismatches = [
  ['amount', '125000001'], ['token', '0x' + 'cc'.repeat(20)],
  ['debit_account', '0x' + '33'.repeat(20)], ['credit_account', '0x' + '44'.repeat(20)]
] as const;
for (const status of ['settled', 'review'] as const) for (const [field, value] of businessMismatches)
  test(status + ' journal business field ' + field + ' disagreement invalidates every asset', () => {
    const row = posted(1, status); posted(2, 'settled', otherToken, '7');
    assert.deepEqual(store.assetTotals(), expected(status));
    store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?').run(value, row.id);
    refuse();
  });

const unreadableBusinessFields: [string, (payment: Payment) => string | Buffer][] = [
  ['malformed JSON', () => 'PRIVATE_INVALID_JSON{'],
  ['null JSON', () => 'null'],
  ['array JSON', payment => JSON.stringify([payment])],
  ['missing amount', payment => JSON.stringify({ ...payment, amount: undefined })],
  ['numeric amount', payment => JSON.stringify({ ...payment, amount: Number(payment.amount) })],
  ['BLOB JSON', payment => Buffer.from(JSON.stringify(payment))]
];
for (const [label, payload] of unreadableBusinessFields)
  test('posted payment with ' + label + ' makes every asset unavailable', () => {
    const row = posted(1, 'review'); posted(2, 'settled', otherToken, '7');
    store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(payload(JSON.parse(row.payload)), row.id);
    refuse();
  });

const invalidAccounts = [
  ['zero debit account', '0x' + '00'.repeat(20), '0x' + '22'.repeat(20)],
  ['nonhex credit account', '0x' + '11'.repeat(20), '0x' + 'gg'.repeat(20)],
  ['same account with different case', '0x' + 'ab'.repeat(20), '0x' + 'AB'.repeat(20)]
] as const;
for (const [label, payer, payee] of invalidAccounts)
  test('matching journal and payment with ' + label + ' make every asset unavailable', () => {
    const row = posted(1); posted(2, 'settled', otherToken, '7');
    const payment = JSON.parse(row.payload) as Payment;
    store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(JSON.stringify({ ...payment, payer, payee }), row.id);
    store.db.prepare('UPDATE journals SET debit_account=?,credit_account=? WHERE payment_id=?').run(payer, payee, row.id);
    refuse();
  });

test('matching retained fields do not revalidate unrelated authorization fields or attest chain truth', () => {
  const row = posted(1); posted(2, 'settled', otherToken, '7');
  const payment = JSON.parse(row.payload) as Payment;
  store.db.prepare('UPDATE payments SET payload=?,signature=?,fingerprint=? WHERE id=?')
    .run(JSON.stringify({ ...payment, deadline: 'PRIVATE_INVALID_DEADLINE' }),
      'PRIVATE_INVALID_SIGNATURE', 'PRIVATE_INVALID_FINGERPRINT', row.id);
  // Coherent well-formed rewrites are outside the local reporting check.
  replaceInclusion('block_hash', '0x' + '99'.repeat(32), row.id);
  const before = snapshot(); assert.deepEqual(store.assetTotals(), expected('settled')); assert.equal(snapshot(), before);
});

test('an unposted review without recorded inclusion still contributes no journal volume', () => {
  const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token, amount: '7', nonce: '0', deadline: '2000000000' };
  const row = store.accept(payment, 'synthetic-fingerprint', 'synthetic-signature').row;
  store.broadcast(row.id, 'synthetic-raw', '0x' + '77'.repeat(32)); store.setStatus(row.id, 'review', 'Unposted fixture');
  const before = snapshot(); assert.deepEqual(store.assetTotals(), []); assert.equal(snapshot(), before);
});
