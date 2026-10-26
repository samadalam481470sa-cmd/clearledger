import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssetMetadataRegistry, AssetVolumes } from '../web/views.tsx';
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

test('rendered configured assets keep addresses, sources, precision and review volumes distinct', () => {
  const overview = { mode: 'rpc', chainId: 31337, assetMetadata: [
    { chainId: 31337, token: tokenA, symbol: 'TEST', decimals: 6, source: 'configured' },
    { chainId: 31337, token: tokenB, symbol: 'TEST', decimals: 0, source: 'demo' }
  ] } as Overview;
  const html = renderToStaticMarkup(React.createElement(AssetVolumes, {
    assets: [{ ...assets[0], settledBaseUnits: '125000000' }, assets[1]], overview
  }));
  for (const value of [tokenA, tokenB, '125.00', '1.234567', '8000000', '9000000',
    'Configured metadata · 6 decimals', 'Demo metadata · 0 decimals']) assert.ok(html.includes(value), value);
  assert.equal((html.match(/class="asset-address"/g) ?? []).length, 2);
  assert.equal((html.match(/class="asset-symbol"/g) ?? []).length, 2);
});

test('registry presentation shows only the current chain and identifies display metadata as configuration', () => {
  const html = renderToStaticMarkup(React.createElement(AssetMetadataRegistry, { overview: {
    mode: 'rpc', chainId: 31337, assetMetadata: [
      { chainId: 31337, token: tokenA, symbol: 'TEST', decimals: 255, source: 'configured' },
      { chainId: 1, token: tokenB, symbol: 'ELSEWHERE', decimals: 18, source: 'configured' }
    ]
  } }));
  for (const value of [tokenA, '255', 'Configured', 'CHAIN 31337']) assert.ok(html.includes(value), value);
  assert.ok(!html.includes(tokenB));
  assert.ok(!html.includes('ELSEWHERE'));
});

test('invalid registry and empty current-chain registry present clear base-unit fallbacks', () => {
  const malformed = { mode: 'demo', token: tokenA, chainId: 31337,
    assetMetadata: [{ chainId: 31337, token: tokenA, symbol: '<script>', decimals: 6, source: 'configured' }] } as Overview;
  const registry = renderToStaticMarkup(React.createElement(AssetMetadataRegistry, { overview: malformed }));
  assert.match(registry, /role="alert"/);
  assert.match(registry, /invalid.*exact base units/);
  assert.ok(!registry.includes('<script>'));
  const volume = renderToStaticMarkup(React.createElement(AssetVolumes, { assets, overview: malformed }));
  assert.ok(volume.includes(huge));
  assert.ok(!volume.includes('dUSD'));
  const empty = renderToStaticMarkup(React.createElement(AssetMetadataRegistry, {
    overview: { mode: 'rpc', chainId: 31337, assetMetadata: [] }
  }));
  assert.match(empty, /No display metadata configured for this chain/);
});

test('zero-token and unknown-field registries hide all configured precision and retain exact volume', () => {
  const valid = { chainId: 31337, token: tokenA, symbol: 'TEST', decimals: 6, source: 'configured' };
  for (const assetMetadata of [[valid, { ...valid, token: '0x' + '0'.repeat(40) }], [{ ...valid, rpcDecimals: 18 }]]) {
    const overview = { mode: 'demo', token: tokenA, chainId: 31337, assetMetadata } as Overview;
    const registry = renderToStaticMarkup(React.createElement(AssetMetadataRegistry, { overview }));
    assert.match(registry, /role="alert"/);
    assert.ok(!registry.includes('class="asset-symbol"'));
    const volumes = renderToStaticMarkup(React.createElement(AssetVolumes, { assets, overview }));
    assert.ok(volumes.includes(huge));
    assert.ok(volumes.includes('base units'));
    assert.ok(!volumes.includes('class="asset-symbol"'));
    assert.ok(!volumes.includes('dUSD'));
  }
});
