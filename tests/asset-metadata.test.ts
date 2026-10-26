import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { getAddress, ZeroAddress, type JsonRpcProvider, type Wallet } from 'ethers';
import { parseAssetMetadata, activeAssetMetadata } from '../src/assets.ts';
import { type AssetMetadata } from '../shared/asset-metadata.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';

const chainId = 31337;
const token = getAddress('0x' + 'ab'.repeat(20));
const otherToken = getAddress('0x' + 'cd'.repeat(20));
const config = { chainId, token, symbol: 'USDC.demo', decimals: 6 };
const configured = { ...config, source: 'configured' as const };
const failure = 'Invalid ASSET_METADATA configuration';
const activeFailure = 'Invalid asset metadata for this server';
const hash = (value: number) => '0x' + value.toString(16).padStart(64, '0');
const address = (value: number) => getAddress('0x' + value.toString(16).padStart(40, '0'));

function invalid(json: string) {
  assert.throws(() => parseAssetMetadata(json), error => error instanceof Error && error.message === failure);
}

test('asset metadata is opt-in and parser assigns provenance while normalizing valid addresses', () => {
  assert.deepEqual(parseAssetMetadata(undefined), []);
  assert.deepEqual(parseAssetMetadata('[]'), []);
  assert.deepEqual(parseAssetMetadata(JSON.stringify([{ ...config, token: token.toLowerCase() }])), [configured]);
  assert.deepEqual(parseAssetMetadata(JSON.stringify([
    { ...config, decimals: 0, symbol: 'A' },
    { ...config, chainId: Number.MAX_SAFE_INTEGER, decimals: 255, symbol: 'A1234567890._-ab' }
  ])), [
    { ...configured, decimals: 0, symbol: 'A' },
    { ...configured, chainId: Number.MAX_SAFE_INTEGER, decimals: 255, symbol: 'A1234567890._-ab' }
  ]);
});

for (const [description, json] of [
  ['empty input', ''], ['invalid JSON', '{private-secret-value'], ['null', 'null'],
  ['an object', JSON.stringify(config)], ['a string', '"private-secret-value"'],
  ['null array member', '[null]'], ['an array member', '[[]]'], ['numeric member', '[5]'],
  ['nonfinite chain ID', '[{"chainId":1e309,"token":"' + token + '","symbol":"A","decimals":6}]']
] as const) {
  test('metadata rejects ' + description + ' with a fixed error that contains no input', () => invalid(json));
}

for (const key of ['chainId', 'token', 'symbol', 'decimals'] as const) {
  test('metadata requires ' + key, () => {
    const missing: Partial<typeof config> = { ...config };
    delete missing[key];
    invalid(JSON.stringify([missing]));
  });
}

for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '31337', null, true]) {
  test('metadata rejects invalid chain ID ' + String(value), () => invalid(JSON.stringify([{ ...config, chainId: value }])));
}
for (const value of [-1, 256, 6.5, '6', null, false]) {
  test('metadata rejects invalid decimal count ' + String(value), () => invalid(JSON.stringify([{ ...config, decimals: value }])));
}
for (const value of ['', '1USD', ' USD', 'USD ', 'US D', 'US/D', '<script>', 'ＵＳＤ', 'USD\n', 'A'.repeat(17), null]) {
  test('metadata rejects invalid symbol ' + JSON.stringify(value), () => invalid(JSON.stringify([{ ...config, symbol: value }])));
}
for (const value of [ZeroAddress, '0x1234', 'not-an-address', null,
  '0x52908400098527886e0F7030069857D2E4169EE7']) {
  test('metadata rejects zero, malformed or invalid-checksum token ' + String(value), () => invalid(JSON.stringify([{ ...config, token: value }])));
}

test('metadata rejects unknown properties and caller-supplied provenance without leaking their values', () => {
  for (const extra of [{ source: 'configured' }, { source: 'demo' }, { privateKey: 'private-secret-value' },
    { apiKey: 'private-secret-value' }, { extra: 'private-secret-value' }]) {
    invalid(JSON.stringify([{ ...config, ...extra }]));
  }
});

test('metadata identity includes chain ID and compares token addresses without case sensitivity', () => {
  invalid(JSON.stringify([config, { ...config, token: token.toLowerCase(), symbol: 'OTHER' }]));
  assert.deepEqual(parseAssetMetadata(JSON.stringify([config, { ...config, chainId: 1 }])),
    [configured, { ...configured, chainId: 1 }]);
});

test('metadata permits one hundred descriptors and rejects the next without silently truncating', () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({ ...config, token: address(index + 1) }));
  assert.equal(parseAssetMetadata(JSON.stringify(entries)).length, 100);
  invalid(JSON.stringify([...entries, { ...config, token: address(101) }]));
});

test('active metadata selects the current chain without inventing descriptors for another chain', () => {
  const entries = parseAssetMetadata(JSON.stringify([config, { ...config, chainId: 1, decimals: 18 },
    { ...config, token: otherToken, symbol: 'ZERO', decimals: 0 }]));
  assert.deepEqual(activeAssetMetadata(entries, chainId), [configured,
    { ...configured, token: otherToken, symbol: 'ZERO', decimals: 0 }]);
  assert.deepEqual(activeAssetMetadata(entries, 999), []);
  assert.deepEqual(activeAssetMetadata(entries, 1), [{ ...configured, chainId: 1, decimals: 18 }]);
  assert.equal(entries.length, 3, 'Selecting a chain must not mutate the configured registry');
});

test('a known demo token gets explicit dUSD metadata while a configured collision is rejected', () => {
  const entries = [{ ...configured, token: otherToken }];
  const active = activeAssetMetadata(entries, chainId, token.toLowerCase());
  assert.deepEqual(active.find(entry => entry.source === 'demo'),
    { chainId, token, symbol: 'dUSD', decimals: 6, source: 'demo' });
  assert.deepEqual(active.find(entry => entry.source === 'configured'), entries[0]);
  assert.throws(() => activeAssetMetadata([configured], chainId, token.toLowerCase()),
    error => error instanceof Error && error.message === activeFailure);
  assert.doesNotThrow(() => activeAssetMetadata([{ ...configured, chainId: 1 }], chainId, token));
});

test('active registry rejects injected demo provenance and counts a generated descriptor against the limit', () => {
  assert.throws(() => activeAssetMetadata([{ ...configured, source: 'demo' }], chainId),
    error => error instanceof Error && error.message === activeFailure);
  const entries = Array.from({ length: 100 }, (_, index) => ({ ...configured, token: address(index + 1) }));
  assert.equal(activeAssetMetadata(entries, chainId).length, 100);
  assert.throws(() => activeAssetMetadata(entries, chainId, token),
    error => error instanceof Error && error.message === activeFailure);
});

test('HTTP construction rejects invalid embedded metadata and ambiguous demo configuration', () => {
  const store = new Store();
  const service = new PaymentService(store, {} as JsonRpcProvider, {} as Wallet,
    { connect() { return this; } }, chainId, address(9));
  try {
    for (const invalidOptions of [
      { mode: 'rpc' as const, assetMetadata: [{ ...configured, source: 'demo' as const }] },
      { mode: 'rpc' as const, assetMetadata: [{ ...configured, decimals: 256 }] },
      { mode: 'demo' as const, assetMetadata: [configured], demoInfo: { token: token.toLowerCase() } }
    ]) {
      assert.throws(() => makeServer({ service, apiKey: 'asset-metadata-private-api-key', port: 0, ...invalidOptions }),
        error => error instanceof Error && error.message === activeFailure);
    }
  } finally { store.close(); }
});

async function withOverview(options: { mode?: 'demo' | 'rpc'; metadata?: AssetMetadata[];
  demoInfo?: Record<string, unknown>; seed?: (store: Store) => void },
  check: (url: string, key: string) => Promise<void>) {
  const store = new Store();
  const key = 'asset-metadata-private-api-key';
  const provider = { getBlock: async () => ({ number: 25, hash: hash(25), timestamp: 1800000000 }) };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    { connect() { return this; } }, chainId, address(9));
  options.seed?.(store);
  const server = makeServer({ service, apiKey: key, port: 0, mode: options.mode ?? 'rpc',
    assetMetadata: options.metadata, demoInfo: options.demoInfo });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await check('http://127.0.0.1:' + (server.address() as { port: number }).port, key);
  } finally {
    await server.drainRequests();
    if (server.listening) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    store.close();
  }
}

test('authenticated overview exposes only active public metadata and retains exact raw journal amounts', async () => {
  const metadata = parseAssetMetadata(JSON.stringify([config, { ...config, chainId: 1, decimals: 18 },
    { ...config, token: otherToken, symbol: 'ZERO', decimals: 0 }]));
  const baseUnits = 10n ** 70n + 123456789012345678901n;
  await withOverview({ metadata, seed(store) {
    for (let index = 1; index <= 2; index++) {
      const row = store.accept({ paymentId: hash(index), payer: address(1), payee: address(2), token,
        amount: String(baseUnits + BigInt(index)), nonce: String(index - 1), deadline: '2000000000' },
      'asset-metadata-private-fingerprint', 'asset-metadata-private-signature').row;
      store.broadcast(row.id, 'asset-metadata-private-raw', hash(100 + index));
      store.finalize(row.id, index, hash(200 + index));
    }
  } }, async (url, key) => {
    for (const authorization of [undefined, 'Bearer wrong-api-key']) {
      const response = await fetch(url + '/api/overview', { headers: authorization ? { Authorization: authorization } : {} });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: 'Bearer token required' });
    }
    const headers = { Authorization: 'Bearer ' + key };
    const response = await fetch(url + '/api/overview', { headers });
    assert.equal(response.status, 200);
    const overview = await response.json() as any;
    assert.deepEqual(overview.assetMetadata, [configured, { ...configured, token: otherToken, symbol: 'ZERO', decimals: 0 }]);
    assert.equal(overview.chainId, chainId);
    assert.equal(overview.payments.length, 2);
    assert.deepEqual(overview.payments.map((row: any) => row.payment.amount).sort(),
      [String(baseUnits + 1n), String(baseUnits + 2n)].sort());
    assert.ok(overview.journals.every((row: any) => typeof row.amount === 'string'));
    assert.ok(!JSON.stringify(overview).includes('asset-metadata-private-'));
    for (const entry of overview.assetMetadata)
      assert.deepEqual(Object.keys(entry).sort(), ['chainId', 'decimals', 'source', 'symbol', 'token']);
    const totalsResponse = await fetch(url + '/api/totals', { headers });
    assert.equal(totalsResponse.status, 200);
    const totals = await totalsResponse.json() as any;
    assert.equal(totals.assets.length, 1);
    assert.equal(totals.assets[0].settledBaseUnits, String(2n * baseUnits + 3n));
    assert.equal(totals.assets[0].reviewBaseUnits, '0');
  });
});

test('RPC overview cannot infer a demo currency from an incidental demoInfo token', async () => {
  await withOverview({ mode: 'rpc', demoInfo: { token } }, async (url, key) => {
    const response = await fetch(url + '/api/overview', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).assetMetadata, []);
  });
});

test('demo overview advertises only the explicit demo token and current-chain configured assets', async () => {
  await withOverview({ mode: 'demo', demoInfo: { token }, metadata: [
    { ...configured, token: otherToken }, { ...configured, chainId: 1 }
  ] }, async (url, key) => {
    const response = await fetch(url + '/api/overview', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(response.status, 200);
    const overview = await response.json() as any;
    assert.equal(overview.assetMetadata.length, 2);
    assert.deepEqual(overview.assetMetadata.find((entry: AssetMetadata) => entry.source === 'demo'),
      { chainId, token, symbol: 'dUSD', decimals: 6, source: 'demo' });
    assert.deepEqual(overview.assetMetadata.find((entry: AssetMetadata) => entry.source === 'configured'),
      { ...configured, token: otherToken });
    assert.ok(!JSON.stringify(overview.assetMetadata).includes(key));
  });
  await withOverview({ mode: 'demo' }, async (url, key) => {
    const response = await fetch(url + '/api/overview', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as any).assetMetadata, []);
  });
});
