import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetRegistry, formatAssetAmount, type AssetContext } from '../web/dashboard.ts';
import { type AssetMetadata } from '../shared/asset-metadata.ts';

const token = '0x' + 'ab'.repeat(20), otherToken = '0x' + 'cd'.repeat(20);
const metadata: AssetMetadata = { chainId: 31337, token, symbol: 'TEST', decimals: 6, source: 'configured' };
const context = (items: unknown, chainId = 31337): AssetContext =>
  ({ mode: 'rpc', chainId, assetMetadata: items } as AssetContext);
const exact = (amount: string) => ({ value: amount, unit: 'base units' });

test('configured RPC assets use their own exact decimal scale without summing different assets', () => {
  const overview = context([metadata, { ...metadata, token: otherToken, symbol: 'GAS', decimals: 18 }]);
  assert.deepEqual(formatAssetAmount('125000000', token, overview), { value: '125.00', unit: 'TEST' });
  assert.deepEqual(formatAssetAmount('125000000', otherToken, overview), { value: '0.000000000125', unit: 'GAS' });
  assert.deepEqual(formatAssetAmount('1', '0x' + 'ef'.repeat(20), overview), exact('1'));
});

test('configured formatting preserves every uint256 digit beyond JavaScript and SQLite integer precision', () => {
  const amount = 2n ** 256n - 1n;
  const expected = '115792089237316195423570985008687907853269984665640564039457584007913129.639935';
  assert.deepEqual(formatAssetAmount(amount.toString(), token, context([metadata])), { value: expected, unit: 'TEST' });
});

test('zero-decimal assets keep exact integer amounts including zero and uint256 maximum', () => {
  const overview = context([{ ...metadata, decimals: 0 }]);
  for (const amount of ['0', '1', '9007199254740993', (2n ** 256n - 1n).toString()])
    assert.deepEqual(formatAssetAmount(amount, token, overview), { value: amount, unit: 'TEST' });
});

test('255-decimal assets format tiny units and whole amounts without floating point', () => {
  const overview = context([{ ...metadata, decimals: 255 }]);
  assert.deepEqual(formatAssetAmount('1', token, overview), { value: '0.' + '0'.repeat(254) + '1', unit: 'TEST' });
  assert.deepEqual(formatAssetAmount('0', token, overview), { value: '0.00', unit: 'TEST' });
  assert.deepEqual(formatAssetAmount('1' + '0'.repeat(255), token, overview), { value: '1.00', unit: 'TEST' });
});

test('metadata lookup is case-insensitive for address bytes and binds the current chain', () => {
  const upper = token.toUpperCase().replace('0X', '0x');
  const overview = context([{ ...metadata, token: upper }, { ...metadata, chainId: 31338, decimals: 0, symbol: 'OTHER' }]);
  assert.deepEqual(formatAssetAmount('1000000', token, overview), { value: '1.00', unit: 'TEST' });
  assert.deepEqual(formatAssetAmount('1000000', upper, context(overview.assetMetadata, 31338)), { value: '1000000', unit: 'OTHER' });
  assert.deepEqual(formatAssetAmount('1000000', token, context(overview.assetMetadata, 1)), exact('1000000'));
  assert.equal(assetRegistry(overview).entries.length, 1);
});

test('an explicit empty or wrong-chain registry never activates legacy demo decimals', () => {
  for (const assetMetadata of [[], [{ ...metadata, chainId: 1 }]]) {
    const overview = { ...context(assetMetadata), mode: 'demo', token };
    assert.deepEqual(formatAssetAmount('125000000', token, overview), exact('125000000'));
  }
  assert.deepEqual(formatAssetAmount('125000000', token, { mode: 'demo', token }), { value: '125.00', unit: 'dUSD' });
});

test('duplicate chain/address metadata rejects the whole registry rather than choosing conflicting precision', () => {
  const duplicate = { ...metadata, token: token.toUpperCase().replace('0X', '0x'), decimals: 18 };
  const overview = context([metadata, duplicate]);
  assert.equal(assetRegistry(overview).status, 'invalid');
  assert.deepEqual(formatAssetAmount('125000000', token, overview), exact('125000000'));
});

const malformed: Record<string, unknown> = {
  'null registry': null,
  'object registry': { items: [metadata] },
  'null entry': [null],
  'wrong source': [{ ...metadata, source: 'rpc' }],
  'empty symbol': [{ ...metadata, symbol: '' }],
  'oversized symbol': [{ ...metadata, symbol: 'A'.repeat(17) }],
  'non-ASCII symbol': [{ ...metadata, symbol: '€USD' }],
  'HTML symbol': [{ ...metadata, symbol: '<script>' }],
  'symbol trailing newline': [{ ...metadata, symbol: 'TEST\n' }],
  'token trailing whitespace': [{ ...metadata, token: token + ' ' }],
  'token trailing newline': [{ ...metadata, token: token + '\n' }],
  'short token': [{ ...metadata, token: token.slice(0, -1) }],
  'zero token alongside a valid entry': [metadata, { ...metadata, token: '0x' + '0'.repeat(40) }],
  'unknown entry field': [{ ...metadata, rpcDecimals: 18 }],
  'missing decimals': [{ ...metadata, decimals: undefined }],
  'negative decimals': [{ ...metadata, decimals: -1 }],
  'fractional decimals': [{ ...metadata, decimals: 1.5 }],
  'oversized decimals': [{ ...metadata, decimals: 256 }],
  'numeric-string decimals': [{ ...metadata, decimals: '6' }],
  'unsafe chain': [{ ...metadata, chainId: Number.MAX_SAFE_INTEGER + 1 }],
  'zero chain': [{ ...metadata, chainId: 0 }],
  'fractional chain': [{ ...metadata, chainId: 1.5 }],
  'over 100 entries': Array.from({ length: 101 }, (_, index) => ({ ...metadata, chainId: index + 1 }))
};
for (const [name, registry] of Object.entries(malformed)) {
  test('malformed ' + name + ' retains base units even in demo mode', () => {
    const overview = { ...context(registry), mode: 'demo', token };
    assert.equal(assetRegistry(overview).status, 'invalid');
    assert.deepEqual(formatAssetAmount('125000000', token, overview), exact('125000000'));
  });
}

test('exactly 100 valid entries are supported without mixing chains', () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ ...metadata, chainId: index + 1 }));
  const overview = context(items, 100);
  assert.equal(assetRegistry(overview).status, 'ready');
  assert.equal(assetRegistry(overview).entries.length, 1);
  assert.deepEqual(formatAssetAmount('1000000', token, overview), { value: '1.00', unit: 'TEST' });
});

test('invalid current chain and malformed amount/token cannot gain metadata formatting', () => {
  for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.deepEqual(formatAssetAmount('1000000', token, context([metadata], chainId)), exact('1000000'));
  const overview = context([metadata]);
  for (const amount of ['', '-1', '1.5', '1e6', '1000000\n', ' 1000000'])
    assert.deepEqual(formatAssetAmount(amount, token, overview), exact(amount));
  assert.deepEqual(formatAssetAmount('1000000', token + '\n', overview), exact('1000000'));
  const zero = '0x' + '0'.repeat(40);
  assert.deepEqual(formatAssetAmount('1000000', zero, { mode: 'demo', token: zero }), exact('1000000'));
});
