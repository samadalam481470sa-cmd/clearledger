import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PaymentStatus } from '../web/dashboard.ts';
import { PaymentReceiptSnapshot } from '../web/payment-history.tsx';
import { demoPaymentSnapshot } from '../web/payment-lookup.ts';

const payer = '0x' + 'a1'.repeat(20);
const payee = '0x' + 'b2'.repeat(20);
const token = '0x' + 'c3'.repeat(20);
const paymentId = '0x' + 'd4'.repeat(32);
const recordId = payer + ':' + paymentId;
const context = { payer, payee, token };
const submittedAmount = '17.123456';
const timestamp = '2026-11-15T20:20:00.000Z';
const now = new Date(timestamp);

function paymentRow(status: PaymentStatus = 'settled') {
  return {
    id: recordId, status, tx_hash: status === 'queued' ? null : '0x' + 'e5'.repeat(32),
    block_number: status === 'settled' ? 42 : null,
    error: status === 'failed' ? 'Contract rejected the instruction' : null,
    created_at: '2026-11-15T20:19:00.000Z',
    payment: { payer, payee, token, paymentId, amount: '17123456', nonce: '0', deadline: '1800000000' }
  };
}

for (const status of ['queued', 'broadcast', 'settled', 'failed', 'review'] as const)
  test('demo acknowledgement carries the ' + status + ' payment as a snapshot', () => {
    const row = paymentRow(status);
    const snapshot = demoPaymentSnapshot({ payment: row }, submittedAmount, context, now);
    assert.deepEqual(snapshot, { row, capturedAt: timestamp });
    assert.notEqual(snapshot.row, row);
    assert.notEqual(snapshot.row.payment, row.payment);
  });

test('demo acknowledgement matches address bytes and exact six-decimal base units', () => {
  const row = paymentRow();
  const checksumStyle = (address: string) => '0x' + address.slice(2).toUpperCase();
  const upperContext = { payer: checksumStyle(payer), payee: checksumStyle(payee), token: checksumStyle(token) };
  assert.deepEqual(demoPaymentSnapshot({ payment: row }, '0000017.123456', upperContext, now).row, row);

  row.payment.amount = '17100000';
  assert.equal(demoPaymentSnapshot({ payment: row }, '17.1', context, now).row.payment?.amount, '17100000');
  row.payment.amount = '1';
  assert.equal(demoPaymentSnapshot({ payment: row }, '0.000001', context, now).row.payment?.amount, '1');
});

for (const [description, value] of [
  ['a missing response', undefined],
  ['an array response', [{ payment: paymentRow() }]],
  ['a null payment row', { payment: null }],
  ['an empty payment row', { payment: {} }],
  ['an unknown status', { payment: { ...paymentRow(), status: 'confirmed' } }],
  ['a missing authorization', { payment: { ...paymentRow(), payment: null } }],
  ['a noncanonical record ID', { payment: { ...paymentRow(), id: payer + ':0x' + 'D4'.repeat(32) } }],
  ['an incoherent record ID', { payment: { ...paymentRow(), id: payer + ':0x' + 'ff'.repeat(32) } }],
  ['an invalid block number', { payment: { ...paymentRow(), block_number: '42' } }]
] as const) test('demo acknowledgement rejects ' + description, () => {
  assert.throws(() => demoPaymentSnapshot(value, submittedAmount, context, now));
});

for (const field of ['payer', 'payee', 'token'] as const)
  test('demo acknowledgement rejects the wrong ' + field + ' even when the row is coherent', () => {
    const row = paymentRow();
    row.payment[field] = '0x' + 'ff'.repeat(20);
    if (field === 'payer') row.id = row.payment.payer + ':' + paymentId;
    assert.throws(() => demoPaymentSnapshot({ payment: row }, submittedAmount, context, now));
  });

test('demo acknowledgement rejects a submitted amount mismatch of one base unit', () => {
  const row = paymentRow();
  row.payment.amount = '17123457';
  assert.throws(() => demoPaymentSnapshot({ payment: row }, submittedAmount, context, now));
});

test('demo acknowledgement requires the displayed payer, payee and token', () => {
  const response = { payment: paymentRow() };
  for (const field of ['payer', 'payee', 'token'] as const)
    assert.throws(() => demoPaymentSnapshot(response, submittedAmount, { ...context, [field]: undefined }, now));
});

test('demo acknowledgement rejects amount text outside the demo endpoint grammar', () => {
  const response = { payment: paymentRow() };
  for (const amount of ['17.1234560', '1.7123456e1', ' 17.123456', '17.123456\n'])
    assert.throws(() => demoPaymentSnapshot(response, amount, context, now));
});

test('demo acknowledgement renders a timestamped public receipt and omits private fields', () => {
  const row = paymentRow();
  const raw = {
    payment: { ...row, raw_tx: 'hidden-native-transaction', fingerprint: 'hidden-fingerprint',
      payment: { ...row.payment, signature: 'hidden-authorization' } }
  };
  const snapshot = demoPaymentSnapshot(raw, submittedAmount, context, now);
  assert.deepEqual(snapshot, { row, capturedAt: timestamp });
  raw.payment.payment.amount = '1';
  assert.equal(snapshot.row.payment?.amount, '17123456');

  const markup = renderToStaticMarkup(createElement(PaymentReceiptSnapshot, {
    snapshot, overview: { mode: 'demo', token }, onClose() {}
  }));
  assert.match(markup, /17\.123456/);
  assert.match(markup, /dUSD/);
  assert.ok(markup.includes(recordId));
  assert.doesNotMatch(markup, /hidden-/);
});
