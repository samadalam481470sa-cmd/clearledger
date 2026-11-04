import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentLookupPanel, PaymentReceiptSnapshot } from '../web/payment-history.tsx';
import { PAYMENT_LOOKUP_NOT_FOUND, type PaymentLookupState } from '../web/payment-lookup.ts';
import { type PaymentRow } from '../web/dashboard.ts';

// Presentation/attribute checks only: no mounted App, browser events or layout.
const payer = '0x' + '11'.repeat(20), paymentId = '0x' + '44'.repeat(32);
const id = payer + ':' + paymentId;
const row: PaymentRow = { id, status: 'settled', tx_hash: '0x' + '55'.repeat(32), block_number: 42,
  created_at: '2026-11-03T12:00:00.000Z', error: null,
  payment: { paymentId, payer, payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20),
    amount: '125000000', nonce: '0', deadline: '2000000000' } };
const noop = () => {};
const idle = (): PaymentLookupState => ({ id, phase: 'idle', error: '', snapshot: null });
function panel(state = idle(), enabled = true) {
  return renderToStaticMarkup(React.createElement(PaymentLookupPanel, {
    state, enabled, onInput: noop, onFind: noop, onClear: noop
  }));
}
function input(html: string) { return html.match(/<input\b[^>]*>/)![0]; }
function button(html: string, label: string) {
  return [...html.matchAll(/<button\b[^>]*>[^<]*<\/button>/g)].map(match => match[0]).find(tag => tag.includes('>' + label + '<'))!;
}

test('lookup presentation is enabled with authentication and no overview/asset metadata prop', () => {
  const html = panel();
  assert.match(html, /Find a payment by ID/);
  assert.match(html, /even while chain details cannot refresh/);
  assert.match(html, /<label for="lookup-record-id">Payment record ID<\/label>/);
  assert.match(input(html), /aria-describedby="lookup-help lookup-status"/);
  assert.match(input(html), /autoCapitalize="none"/i);
  assert.match(input(html), /autoComplete="off"/i);
  assert.match(input(html), /spellCheck="false"/i);
  assert.ok(!input(html).includes('disabled'));
  assert.ok(!button(html, 'Find payment').includes('disabled'));
  assert.match(button(html, 'Find payment'), /type="submit"/);
  assert.match(button(html, 'Clear'), /type="button"/);
  assert.ok(!/maxlength=/i.test(input(html)), 'Do not truncate pasted IDs into a different accepted input');
});

test('disconnected and empty lookup controls expose disabled native attributes', () => {
  const disconnected = panel(idle(), false);
  for (const tag of [input(disconnected), button(disconnected, 'Find payment'), button(disconnected, 'Clear')])
    assert.match(tag, /disabled/);
  const empty = panel({ ...idle(), id: '' });
  assert.ok(!input(empty).includes('disabled'));
  assert.match(button(empty, 'Find payment'), /disabled/);
  assert.match(button(empty, 'Clear'), /disabled/);
});

test('a loading lookup keeps input editing and clear available while preventing duplicate submit', () => {
  const html = panel({ ...idle(), phase: 'loading' });
  assert.ok(!input(html).includes('disabled'));
  assert.match(button(html, 'Finding…'), /disabled/);
  assert.ok(!button(html, 'Clear').includes('disabled'));
  assert.match(html, /id="lookup-status"[^>]*role="status"/);
  assert.match(html, /Reading local payment history/);
});

test('not-found presentation reports a local read snapshot and retains the in-flight acceptance caveat', () => {
  const html = panel({ ...idle(), phase: 'not-found', error: PAYMENT_LOOKUP_NOT_FOUND });
  assert.ok(html.includes(PAYMENT_LOOKUP_NOT_FOUND));
  assert.match(html, /An in-flight acceptance may still commit/);
  assert.match(html, /Keep the original signed instruction and check this ID again/);
  assert.match(html, /id="lookup-status"[^>]*role="status"/);
});

test('invalid input and transport errors remain visible escaped text with an input-specific validity flag', () => {
  const invalid = panel({ ...idle(), id: '<script>bad</script>', phase: 'error', error: 'Invalid <record>' });
  assert.match(input(invalid), /aria-invalid="true"/);
  assert.match(invalid, /role="alert"/);
  assert.ok(invalid.includes('&lt;script&gt;bad&lt;/script&gt;'));
  assert.ok(invalid.includes('Invalid &lt;record&gt;'));
  assert.ok(!invalid.includes('<script>'));
  const unavailable = panel({ ...idle(), phase: 'error', error: 'Cannot read local history' });
  assert.ok(!input(unavailable).includes('aria-invalid'));
  assert.match(unavailable, /Cannot read local history/);
});

test('lookup snapshots reuse exact base-unit and unavailable-authorization presentation without overview', () => {
  const capturedAt = '2026-11-03T17:00:00.000Z';
  const good = renderToStaticMarkup(React.createElement(PaymentReceiptSnapshot, {
    snapshot: { row, capturedAt }, onClose: noop
  }));
  assert.match(good, /125000000/); assert.match(good, /base units/);
  assert.ok(!good.includes('dUSD')); assert.match(good, /find this ID again/);
  const unavailable = { ...row, payment: null, integrityError: 'Stored payment data is invalid; verify the original authorization',
    raw_tx: 'PRIVATE_LOOKUP_RAW', signature: 'PRIVATE_LOOKUP_SIGNATURE' };
  const bad = renderToStaticMarkup(React.createElement(PaymentReceiptSnapshot, {
    snapshot: { row: unavailable, capturedAt }, onClose: noop
  }));
  assert.match(bad, /Amount unavailable/); assert.match(bad, /Authorization unavailable/);
  assert.ok(bad.includes(id)); assert.ok(bad.includes(row.tx_hash!));
  assert.ok(!bad.includes('125000000')); assert.ok(!bad.includes('PRIVATE_LOOKUP_'));
});
