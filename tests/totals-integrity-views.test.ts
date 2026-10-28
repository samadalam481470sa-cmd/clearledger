import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type AssetTotal } from '../web/dashboard.ts';
import { AssetTotalsPanel } from '../web/views.tsx';
import { emptyTotals, reduceTotals, totalsCounts, TOTALS_INTEGRITY_ERROR,
  type TotalsReport, type TotalsState } from '../web/totals.ts';

// Pure state transitions and static React markup; these do not mount App or
// establish browser layout, effects, focus, or interaction behavior.
const token = '0x' + 'ab'.repeat(20);
const huge = (2n ** 256n - 1n).toString();
const assets: AssetTotal[] = [{ token, settledPayments: 7, settledBaseUnits: huge,
  reviewPayments: 3, reviewBaseUnits: '918273645' }];
const badReport: TotalsReport = { assets: null, integrityError: TOTALS_INTEGRITY_ERROR };
const render = (state: TotalsState) => renderToStaticMarkup(React.createElement(AssetTotalsPanel,
  { state, overview: { mode: 'rpc', chainId: 31337, assetMetadata: [] } }));

test('cached success is invalidated by an integrity report and only a later valid report restores counts', () => {
  const initial = emptyTotals();
  assert.deepEqual(totalsCounts(initial), { assets: null, completed: null, review: null });
  const success = reduceTotals(initial, { type: 'report', report: { assets } });
  assert.deepEqual(totalsCounts(success), { assets: 1, completed: 7, review: 3 });
  assert.equal(success.assets![0].settledBaseUnits, huge);
  const invalid = reduceTotals(success, { type: 'report', report: badReport });
  assert.equal(invalid.assets, null); assert.equal(invalid.integrityError, TOTALS_INTEGRITY_ERROR);
  assert.deepEqual(totalsCounts(invalid), { assets: null, completed: null, review: null });
  const unavailable = reduceTotals(invalid, { type: 'transport-error', error: new Error('HTTP request unavailable') });
  assert.equal(unavailable.assets, null); assert.equal(unavailable.integrityError, TOTALS_INTEGRITY_ERROR);
  assert.deepEqual(totalsCounts(unavailable), { assets: null, completed: null, review: null });
  const next = [{ ...assets[0], settledPayments: 8, settledBaseUnits: '123456789', reviewPayments: 0, reviewBaseUnits: '0' }];
  const recovered = reduceTotals(unavailable, { type: 'report', report: { assets: next } });
  assert.deepEqual(totalsCounts(recovered), { assets: 1, completed: 8, review: 0 });
  assert.equal(recovered.integrityError, ''); assert.equal(recovered.transportError, '');
  assert.deepEqual(initial, emptyTotals());
  assert.equal(success.assets, assets, 'Later results must not mutate the previous successful state');
});

test('a transport error alone preserves exact last-good volumes and counts', () => {
  const success = reduceTotals(emptyTotals(), { type: 'report', report: { assets } });
  const state = reduceTotals(success, { type: 'transport-error', error: new Error('Connection interrupted') });
  assert.equal(state.assets, assets); assert.equal(state.integrityError, '');
  assert.deepEqual(totalsCounts(state), { assets: 1, completed: 7, review: 3 });
  const html = render(state);
  assert.ok(html.includes(huge)); assert.ok(html.includes('918273645'));
  assert.ok(html.includes('Connection interrupted')); assert.ok(html.includes('Showing the last received totals.'));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
});

test('known integrity renders one fixed warning and unavailable volumes instead of cached or empty figures', () => {
  const success = reduceTotals(emptyTotals(), { type: 'report', report: { assets } });
  const state = reduceTotals(success, { type: 'report', report: badReport });
  const html = render(state);
  assert.ok(html.includes(TOTALS_INTEGRITY_ERROR));
  assert.ok(html.includes('Asset totals are unavailable.'));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
  for (const previous of [huge, '918273645', token, 'No journaled assets yet.', 'SETTLED VOLUME', 'Showing the last received totals.'])
    assert.ok(!html.includes(previous), 'Known integrity must not display an old or invented aggregate');
  assert.deepEqual(totalsCounts(state), { assets: null, completed: null, review: null });
});

test('a later transport failure cannot hide the known integrity warning or resurrect its old cache', () => {
  let state = reduceTotals(emptyTotals(), { type: 'report', report: { assets } });
  state = reduceTotals(state, { type: 'report', report: badReport });
  state = reduceTotals(state, { type: 'transport-error', error: new Error('Later transport failure') });
  const html = render(state);
  assert.ok(html.includes(TOTALS_INTEGRITY_ERROR));
  assert.ok(!html.includes('Later transport failure'));
  assert.ok(!html.includes(huge)); assert.ok(!html.includes('Showing the last received totals.'));
  assert.equal((html.match(/role="alert"/g) ?? []).length, 1);
});

test('a valid empty report means zero assets and remains distinct from unavailable totals', () => {
  const invalid = reduceTotals(emptyTotals(), { type: 'report', report: badReport });
  const empty = reduceTotals(invalid, { type: 'report', report: { assets: [] } });
  assert.deepEqual(totalsCounts(empty), { assets: 0, completed: 0, review: 0 });
  const html = render(empty);
  assert.ok(html.includes('No journaled assets yet.'));
  assert.ok(!html.includes('totals are unavailable')); assert.ok(!html.includes('role="alert"'));
});

test('valid recovery removes the warning and renders the new exact values', () => {
  const invalid = reduceTotals(emptyTotals(), { type: 'report', report: badReport });
  const recovered = reduceTotals(invalid, { type: 'report', report: { assets: [{ ...assets[0], settledBaseUnits: '123456789' }] } });
  const html = render(recovered);
  assert.ok(html.includes('123456789')); assert.ok(html.includes('918273645'));
  assert.ok(!html.includes(TOTALS_INTEGRITY_ERROR)); assert.ok(!html.includes('role="alert"'));
});

test('context reset removes cached values and previous integrity state before a new report', () => {
  for (const prior of [reduceTotals(emptyTotals(), { type: 'report', report: { assets } }),
    reduceTotals(emptyTotals(), { type: 'report', report: badReport })]) {
    const reset = reduceTotals(prior, { type: 'reset' });
    assert.deepEqual(reset, emptyTotals());
    assert.deepEqual(totalsCounts(reset), { assets: null, completed: null, review: null });
    const html = render(reset);
    assert.ok(html.includes('Loading asset volumes…'));
    assert.ok(!html.includes(huge)); assert.ok(!html.includes(TOTALS_INTEGRITY_ERROR));
  }
});

test('unavailable reports use the fixed integrity text rather than arbitrary diagnostic contents', () => {
  const unexpected = { assets: null, integrityError: '<script>private-journal-sentinel</script>' } as unknown as TotalsReport;
  const state = reduceTotals(emptyTotals(), { type: 'report', report: unexpected });
  assert.equal(state.integrityError, TOTALS_INTEGRITY_ERROR);
  assert.ok(!render(state).includes('private-journal-sentinel'));
});
