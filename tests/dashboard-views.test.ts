import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetVolumes } from '../web/views.tsx';
import { type AssetTotal, type Overview } from '../web/dashboard.ts';

// Server-rendered presentation assertions do not establish browser layout or interactions.
const tokenA = '0x' + 'ab'.repeat(20), tokenB = '0x' + 'cd'.repeat(20);
const huge = (2n ** 256n - 1n).toString();
const assets: AssetTotal[] = [
  { token: tokenA, settledPayments: 1, settledBaseUnits: huge, reviewPayments: 2, reviewBaseUnits: '1234567' },
  { token: tokenB, settledPayments: 3, settledBaseUnits: '8000000', reviewPayments: 4, reviewBaseUnits: '9000000' }
];
test('rendered RPC volumes identify each asset and preserve settled/review integers without a currency assumption', () => {
  const html = renderToStaticMarkup(React.createElement(AssetVolumes, { assets, overview: { mode: 'rpc', token: tokenA } as Overview }));
  for (const value of [tokenA, tokenB, huge, '1234567', '8000000', '9000000', 'base units']) assert.ok(html.includes(value), value);
  assert.ok(!html.includes('dUSD'));
  assert.match(html, /review/i);
  assert.match(html, /settled/i);
});

test('rendered mixed demo volumes apply decimals only to the configured demo token', () => {
  const html = renderToStaticMarkup(React.createElement(AssetVolumes, {
    assets: [{ ...assets[0], settledBaseUnits: '125000000' }, assets[1]],
    overview: { mode: 'demo', token: tokenA } as Overview
  }));
  for (const value of ['125.00', 'dUSD', tokenA, tokenB, '8000000', '9000000', 'base units']) assert.ok(html.includes(value), value);
});
