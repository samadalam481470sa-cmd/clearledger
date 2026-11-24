import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, isError, JsonRpcProvider, Network, type TransactionReceiptParams } from 'ethers';
import { computeReceiptLogsBloom } from '../src/receipt-bloom.ts';
import { createRpcProvider } from '../src/rpc.ts';

// Synthetic raw RPC values exercise the public wrapping hook and a stubbed
// transport. These tests do not claim EVM execution or financial settlement.
const endpointMarker = 'PRIVATE_REMOVED_FLAG_RPC_ENDPOINT';
const flagMarker = 'PRIVATE_REMOVED_FLAG_RESPONSE_VALUE';
const endpoint = 'http://127.0.0.1:1/' + endpointMarker;
const errorMessage = 'Receipt contains removed or invalid log evidence';
const redactedValue = '[redacted receipt log evidence]';
const network = Network.from(31337);
const txHash = '0x' + '11'.repeat(32), blockHash = '0x' + '22'.repeat(32);
const payer = '0x' + '33'.repeat(20), payee = '0x' + '44'.repeat(20);
const router = '0x' + '55'.repeat(20), token = '0x' + '66'.repeat(20);
const settlement = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const positions = [
  { target: 'settlement', first: true }, { target: 'foreign', first: true },
  { target: 'settlement', first: false }, { target: 'foreign', first: false }
] as const;

function rawReceipt(position: typeof positions[number] = positions[0], removed: unknown = undefined) {
  const event = settlement.encodeEventLog(settlement.getEvent('PaymentSettled')!,
    ['0x' + '77'.repeat(32), payer, payee, token, 125000000n, 0]);
  const matching = { address: router, ...event };
  const foreign = { address: token, topics: ['0x' + '88'.repeat(32)], data: '0x' };
  const target = position.target === 'settlement' ? matching : foreign;
  const sibling = position.target === 'settlement' ? foreign : matching;
  const logs = (position.first ? [target, sibling] : [sibling, target]).map((log, index) => ({
    ...log, transactionHash: txHash, transactionIndex: '0x0', logIndex: '0x' + index.toString(16),
    blockHash, blockNumber: '0x11'
  }));
  const index = position.first ? 0 : 1;
  if (removed !== undefined) Object.assign(logs[index], { removed });
  return { transactionHash: txHash, transactionIndex: '0x0', blockHash, blockNumber: '0x11',
    from: payer, to: router, contractAddress: null, type: '0x2', status: '0x1',
    gasUsed: '0x1e848', cumulativeGasUsed: '0x1e848', effectiveGasPrice: '0x2',
    logsBloom: computeReceiptLogsBloom(logs), logs };
}
function wrap(provider: JsonRpcProvider, value: unknown) {
  // The exported hook type describes formatted params, but its actual caller
  // passes raw JSON-RPC fields before invoking ethers' receipt formatter.
  return provider._wrapTransactionReceipt(value as unknown as TransactionReceiptParams, network);
}
function assertRedacted(error: unknown) {
  assert.ok(isError(error, 'BAD_DATA'));
  assert.equal(error.shortMessage, errorMessage); assert.equal(error.value, redactedValue);
  for (const field of ['cause', 'info', 'request', 'response', 'receipt', 'log']) assert.ok(!(field in error));
  const serialized = String(error) + JSON.stringify(error);
  for (const privateValue of [endpointMarker, flagMarker, txHash, blockHash, router])
    assert.ok(!serialized.includes(privateValue), 'Receipt rejection exposed raw RPC details');
  return true;
}

for (const [description, removed] of [
  ['missing', undefined], ['null', null], ['false', false], ['string false', 'false']
] as const) {
  test('accepted ' + description + ' receipt flags retain byte-equivalent stock formatting at every log position', () => {
    const provider = createRpcProvider(endpoint), stock = new JsonRpcProvider(endpoint);
    try {
      for (const position of positions) {
        const value = rawReceipt(position, removed), before = JSON.stringify(value);
        const expected = wrap(stock, value), actual = wrap(provider, value);
        assert.equal(JSON.stringify(actual), JSON.stringify(expected));
        assert.equal(actual.logs.length, 2);
        assert.equal(JSON.stringify(value), before, 'Receipt formatting mutated its raw input');
      }
    } finally { provider.destroy(); stock.destroy(); }
  });
}

for (const [description, removed] of [
  ['true', true], ['string true', 'true'], ['zero', 0], ['one', 1],
  ['empty string', ''], ['uppercase false', 'FALSE'], ['private string', flagMarker],
  ['object', { privateMarker: flagMarker }], ['array', []]
] as const) {
  test('raw ' + description + ' receipt flags reject with redacted BAD_DATA at every log position', () => {
    const provider = createRpcProvider(endpoint);
    try {
      for (const position of positions) {
        const value = rawReceipt(position, removed), before = JSON.stringify(value);
        assert.throws(() => wrap(provider, value), assertRedacted);
        assert.equal(JSON.stringify(value), before, 'Receipt rejection mutated its raw input');
      }
    } finally { provider.destroy(); }
  });
}

test('unrelated malformed receipt log containers retain the stock formatter error', () => {
  const provider = createRpcProvider(endpoint), stock = new JsonRpcProvider(endpoint);
  try {
    for (const logs of [undefined, null, {}]) {
      const value = { ...rawReceipt(), logs }, before = JSON.stringify(value);
      let expected: unknown;
      assert.throws(() => wrap(stock, value), error => { expected = error; return isError(error, 'BAD_DATA'); });
      assert.throws(() => wrap(provider, value), error => {
        assert.ok(isError(error, 'BAD_DATA') && isError(expected, 'BAD_DATA'));
        assert.equal(error.message, expected.message);
        return true;
      });
      assert.equal(JSON.stringify(value), before);
    }
  } finally { provider.destroy(); stock.destroy(); }
});

function stubTransport(provider: JsonRpcProvider, receipt: unknown, logs: unknown[] = []) {
  const methods: string[] = [];
  provider._send = async payload => (Array.isArray(payload) ? payload : [payload]).map(request => {
    methods.push(request.method);
    let result: unknown;
    if (request.method === 'eth_chainId') result = '0x7a69';
    else if (request.method === 'eth_getTransactionReceipt') result = receipt;
    else if (request.method === 'eth_getLogs') result = logs;
    else throw new Error('Unexpected synthetic RPC transport method');
    return { jsonrpc: '2.0', id: request.id, result };
  });
  return methods;
}

test('a synthetic null receipt retains the base provider null path without invoking the wrapping hook', async () => {
  const provider = createRpcProvider(endpoint);
  try {
    const methods = stubTransport(provider, null);
    const original = provider._wrapTransactionReceipt.bind(provider);
    let wrappers = 0;
    provider._wrapTransactionReceipt = (value, currentNetwork) => {
      wrappers++; return original(value, currentNetwork);
    };
    assert.equal(await provider.getTransactionReceipt(txHash), null);
    assert.equal(wrappers, 0); assert.ok(methods.includes('eth_getTransactionReceipt'));
  } finally { provider.destroy(); }
});

test('synthetic direct send and getLogs retain their independent removed-flag behavior', async () => {
  const provider = createRpcProvider(endpoint);
  try {
    const value = rawReceipt(positions[0], true), before = JSON.stringify(value);
    const methods = stubTransport(provider, value, [value.logs[0]]);
    assert.deepEqual(await provider.send('eth_getTransactionReceipt', [txHash]), value);
    const logs = await provider.getLogs({ address: router, fromBlock: 17, toBlock: 17 });
    assert.equal(logs.length, 1); assert.equal(logs[0].removed, true);
    assert.ok(methods.includes('eth_getTransactionReceipt') && methods.includes('eth_getLogs'));
    assert.equal(JSON.stringify(value), before);
  } finally { provider.destroy(); }
});
