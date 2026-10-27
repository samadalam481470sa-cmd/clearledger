import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentHistoryRow, PaymentReceiptSnapshot } from '../web/payment-history.tsx';
import { type AssetContext, type Overview, type PaymentRow } from '../web/dashboard.ts';

// Pure presentation checks; these do not establish browser layout or interaction.
const payer = '0x' + '11'.repeat(20), payee = '0x' + '22'.repeat(20), token = '0x' + '33'.repeat(20);
const paymentId = '0x' + '44'.repeat(32), txHash = '0x' + '55'.repeat(32);
const capturedAt = '2026-10-27T12:34:56.000Z';
const warning = 'Stored payment data is invalid; verify the original authorization';
const good: PaymentRow = {
  id: payer + ':' + paymentId, status: 'settled', tx_hash: txHash, block_number: 42,
  error: null, created_at: '2026-10-27T12:00:00.000Z',
  payment: { paymentId, payer, payee, token, amount: '125000000', nonce: '0', deadline: '2000000000' }
};
const secrets = ['private-raw-transaction', 'private-signature', 'private-fingerprint', 'private-payload'];
const invalid = {
  ...good, status: 'review' as const, payment: null, integrityError: warning,
  raw_tx: secrets[0], signature: secrets[1], fingerprint: secrets[2], payload: secrets[3]
};
const demo = { mode: 'demo', chainId: 31337, token, payer, payee } as Overview;
const noop = () => {};
function rowMarkup(row: PaymentRow, overview = demo) {
  return renderToStaticMarkup(React.createElement('table', null, React.createElement('tbody', null,
    React.createElement(PaymentHistoryRow, { row, overview, onOpen: noop }))));
}
function receiptMarkup(row: PaymentRow, overview?: AssetContext) {
  return renderToStaticMarkup(React.createElement(PaymentReceiptSnapshot, {
    snapshot: { row, capturedAt }, overview, onClose: noop
  }));
}
function assertNoPrivateFields(html: string) {
  for (const secret of secrets) assert.ok(!html.includes(secret), secret);
}

test('an invalid authorization row remains visible beside a valid payment without inventing its amount or route', () => {
  const html = renderToStaticMarkup(React.createElement('table', null, React.createElement('tbody', null,
    [invalid, good].map((row, index) => React.createElement(PaymentHistoryRow, {
      key: index, row, overview: demo, onOpen: noop
    })))));
  for (const text of [warning, 'Authorization unavailable', 'Amount unavailable', 'Token unavailable',
    'Route unavailable', invalid.id, txHash, 'review', '42', new Date(invalid.created_at).toLocaleString(),
    '125.00', 'dUSD', 'Treasury', 'Merchant'])
    assert.ok(html.includes(text), text);
  assert.equal((html.match(/<tr>/g) ?? []).length, 2);
  assert.equal((html.match(/Receipt ↗/g) ?? []).length, 2);
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  assertNoPrivateFields(html);
});

test('an invalid receipt preserves record provenance and snapshot time without reconstructing authorization fields from its ID', () => {
  const html = receiptMarkup(invalid, demo);
  for (const text of [warning, invalid.id, txHash, 'Amount unavailable', 'Token unavailable',
    'Authorization unavailable', 'Route unavailable', 'review', '42', new Date(capturedAt).toLocaleString()])
    assert.ok(html.includes(text), text);
  assert.match(html, /<dt>Payer<\/dt><dd class="mono">Route unavailable<\/dd>/);
  assert.match(html, /<dt>Payee<\/dt><dd class="mono">Route unavailable<\/dd>/);
  assert.ok(!html.includes('125.00'));
  assert.ok(!html.includes('dUSD'));
  assertNoPrivateFields(html);
});

test('a null payment without an integrityError still shows the fixed warning and pending transaction metadata', () => {
  const row: PaymentRow = { ...good, payment: null, status: 'queued', tx_hash: null, block_number: null };
  const table = rowMarkup(row), receipt = receiptMarkup(row);
  for (const html of [table, receipt]) {
    assert.ok(html.includes(warning));
    assert.ok(html.includes('Amount unavailable'));
    assert.ok(html.includes('Not broadcast'));
    assert.ok(!html.includes('125.00'));
  }
  assert.match(receipt, /<dt>Block<\/dt><dd class="mono">Pending<\/dd>/);
});

test('valid demo history and receipt keep the existing six-decimal amount, route and authorization fields', () => {
  for (const html of [rowMarkup(good), receiptMarkup(good, demo)]) {
    assert.ok(html.includes('125.00'));
    assert.ok(html.includes('dUSD'));
    assert.ok(!html.includes(warning));
    assert.ok(!html.includes('unavailable'));
  }
  const receipt = receiptMarkup(good, demo);
  for (const text of [paymentId, payer, payee, token, txHash]) assert.ok(receipt.includes(text), text);
  assert.match(receipt, /<dt>Authorization nonce<\/dt><dd class="mono">0<\/dd>/);
});

test('valid configured RPC amounts use the matching asset registry and unknown assets retain exact base units', () => {
  const overview = { mode: 'rpc', chainId: 31337, assetMetadata: [
    { chainId: 31337, token, symbol: 'TEST', decimals: 6, source: 'configured' }
  ] } as Overview;
  for (const html of [rowMarkup(good, overview), receiptMarkup(good, overview)]) {
    assert.ok(html.includes('125.00'));
    assert.ok(html.includes('TEST'));
    assert.ok(!html.includes('dUSD'));
  }
  const huge = (2n ** 256n - 1n).toString();
  const other: PaymentRow = { ...good, payment: { ...good.payment!, token: '0x' + '66'.repeat(20), amount: huge } };
  for (const html of [rowMarkup(other, overview), receiptMarkup(other, overview)]) {
    assert.ok(html.includes(huge));
    assert.ok(html.includes('base units'));
    assert.ok(!html.includes('TEST'));
  }
});
