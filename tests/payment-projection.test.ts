import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store, type RecordRow } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentKey, paymentSchema } from '../src/payment.ts';

// These are local SQLite/projection checks, not signature or on-chain integrity
// validation. All credential-like markers are synthetic fixture strings.
const privateMarker = 'PRIVATE_PROJECTION_SENTINEL';
const integrityError = 'Stored payment data is invalid; verify the original authorization';
const publicFields = ['id', 'status', 'tx_hash', 'block_number', 'block_hash', 'error', 'created_at', 'updated_at'];
const payment = paymentSchema.parse({ paymentId: '0x' + 'ab'.repeat(32),
  payer: getAddress('0x' + 'ab'.repeat(20)), payee: getAddress('0x' + 'cd'.repeat(20)),
  token: getAddress('0x' + 'ef'.repeat(20)), amount: '125000000', nonce: '0', deadline: '2000000000' });
let store: Store;
let service: PaymentService;
let paymentId: string;
let rpcCalls: number;
beforeEach(() => {
  store = new Store(); rpcCalls = 0;
  const unexpected = async () => { rpcCalls++; throw new Error('Projection must not invoke RPC'); };
  const provider = { getBlock: unexpected, getTransactionReceipt: unexpected, getBlockNumber: unexpected };
  service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    { connect() { return this; } }, 31337, '0x' + '44'.repeat(20));
  paymentId = store.accept(payment, privateMarker + '-fingerprint', privateMarker + '-signature').row.id;
  store.broadcast(paymentId, privateMarker + '-raw-transaction', '0x' + '55'.repeat(32));
  store.finalize(paymentId, 17, '0x' + '66'.repeat(32));
});
afterEach(() => { store.close(); });

function snapshot() {
  return JSON.stringify({ payments: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: store.db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all() });
}
function projectWithoutWrites(row: RecordRow) {
  const before = snapshot();
  const changes = store.db.prepare('SELECT total_changes() AS count').get()!.count;
  const result = service.publicRow(row);
  assert.ok(snapshot() === before, 'Projection changed persisted payment, journal or audit evidence');
  assert.equal(store.db.prepare('SELECT total_changes() AS count').get()!.count, changes);
  assert.equal(rpcCalls, 0);
  for (const field of publicFields)
    assert.deepEqual((result as Record<string, unknown>)[field], (row as unknown as Record<string, unknown>)[field]);
  for (const field of ['payload', 'raw_tx', 'signature', 'fingerprint', 'private_notes', 'unexpectedPrivate'])
    assert.equal(Object.hasOwn(result, field), false);
  assert.ok(!JSON.stringify(result).includes(privateMarker), 'Projection exposed private fixture contents');
  return result;
}
function invalid(row = store.get(paymentId)!) {
  const result = projectWithoutWrites(row);
  assert.equal(result.payment, null);
  assert.equal(result.integrityError, integrityError);
  assert.deepEqual(Object.keys(result).sort(), [...publicFields, 'payment', 'integrityError'].sort());
  return result;
}
function payload(value: string) {
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(value, paymentId);
  return store.get(paymentId)!;
}

test('a valid stored payment retains the existing public fields without an integrity warning', () => {
  const result = projectWithoutWrites(store.get(paymentId)!);
  assert.deepEqual(result.payment, payment);
  assert.equal(Object.hasOwn(result, 'integrityError'), false);
  assert.deepEqual(Object.keys(result).sort(), [...publicFields, 'payment'].sort());
});

test('valid stored address and ID variants are normalized in an output copy without rewriting payload bytes', () => {
  const original = JSON.stringify({ ...payment, paymentId: '0x' + 'AB'.repeat(32),
    payer: payment.payer.toLowerCase(), payee: payment.payee.toLowerCase(), token: payment.token.toLowerCase() });
  const result = projectWithoutWrites(payload(original));
  assert.deepEqual(result.payment, payment);
  assert.equal(Object.hasOwn(result, 'integrityError'), false);
  assert.equal(store.get(paymentId)!.payload, original);
});

for (const [description, value] of [
  ['invalid JSON', privateMarker + '-broken-json'], ['truncated JSON', '{"paymentId":"' + privateMarker],
  ['null', 'null'], ['array', '[]'], ['nested array', '[[1]]'], ['string', JSON.stringify(privateMarker)],
  ['number', '125'], ['boolean', 'true'], ['empty object', '{}'],
  ['missing field', JSON.stringify({ ...payment, deadline: undefined })],
  ['fractional amount', JSON.stringify({ ...payment, amount: '1.25' })],
  ['noncanonical integer', JSON.stringify({ ...payment, amount: '0125' })],
  ['numeric amount', JSON.stringify({ ...payment, amount: 125 })],
  ['overflow amount', JSON.stringify({ ...payment, amount: (2n ** 256n).toString() })],
  ['zero amount', JSON.stringify({ ...payment, amount: '0' })],
  ['negative nonce', JSON.stringify({ ...payment, nonce: '-1' })],
  ['zero payment ID', JSON.stringify({ ...payment, paymentId: '0x' + '00'.repeat(32) })],
  ['invalid token', JSON.stringify({ ...payment, token: privateMarker })],
  ['bad address checksum', JSON.stringify({ ...payment, token: '0x52908400098527886e0F7030069857D2E4169EE7' })],
  ['self payment', JSON.stringify({ ...payment, payee: payment.payer })],
  ['unknown secret field', JSON.stringify({ ...payment, privateKey: privateMarker })]
] as const) {
  test(description + ' payload returns a fixed safe marker and preserves stored evidence', () => { invalid(payload(value)); });
}

for (const [description, value] of [
  ['null', null], ['undefined', undefined], ['number', 125], ['boolean', false],
  ['array', []], ['object', { privateKey: privateMarker }]
] as const) {
  test('a non-string ' + description + ' projection input fails safely without touching the actual row', () => {
    const row = { ...store.get(paymentId)!, payload: value } as unknown as RecordRow;
    invalid(row);
  });
}

for (const [description, change] of [
  ['payment ID', { paymentId: '0x' + '99'.repeat(32) }],
  ['payer', { payer: getAddress('0x' + '98'.repeat(20)) }]
] as const) {
  test('a valid payload whose ' + description + ' disagrees with the row key is not presented as its authorization', () => {
    const changed = { ...payment, ...change };
    assert.equal(paymentSchema.safeParse(changed).success, true);
    assert.notEqual(paymentKey(changed), paymentId);
    invalid(payload(JSON.stringify(changed)));
  });
}

test('the row identity is retained when its own key does not match an otherwise valid payload', () => {
  const mismatched = { ...store.get(paymentId)!, id: 'mismatched-history-row' };
  const result = invalid(mismatched);
  assert.equal(result.id, 'mismatched-history-row');
});

test('an unexpected SQLite column and projection-only property cannot leak through either response shape', () => {
  store.db.exec('ALTER TABLE payments ADD COLUMN private_notes TEXT');
  store.db.prepare('UPDATE payments SET private_notes=? WHERE id=?').run(privateMarker, paymentId);
  const row = { ...store.get(paymentId)!, unexpectedPrivate: privateMarker };
  assert.equal((row as unknown as Record<string, unknown>).private_notes, privateMarker);
  const valid = projectWithoutWrites(row);
  assert.deepEqual(valid.payment, payment);
  const corrupt = { ...row, payload: privateMarker + '-bad-json' };
  invalid(corrupt);
});

test('existing review metadata is preserved without interpreting it as payload validation', () => {
  store.setStatus(paymentId, 'review', 'Existing review detail');
  const result = projectWithoutWrites(store.get(paymentId)!);
  assert.equal(result.status, 'review');
  assert.equal(result.error, 'Existing review detail');
  assert.deepEqual(result.payment, payment);
  assert.equal(Object.hasOwn(result, 'integrityError'), false);
});

test('an invalid queued instruction keeps nullable transaction metadata without changing accounting or audit', () => {
  const queued = store.accept({ ...payment, paymentId: '0x' + '88'.repeat(32), nonce: '1' },
    privateMarker + '-queued-fingerprint', privateMarker + '-queued-signature').row;
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(privateMarker + '-invalid-queued-json', queued.id);
  const result = invalid(store.get(queued.id)!);
  assert.equal(result.id, queued.id);
  assert.equal(result.status, 'queued');
  assert.equal(result.tx_hash, null);
  assert.equal(result.block_number, null);
  assert.equal(result.block_hash, null);
});
