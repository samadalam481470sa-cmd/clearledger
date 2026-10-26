import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { type Payment } from '../src/payment.ts';

// Synthetic provider evidence isolates initial-confirmation decisions. No EVM
// transfer is claimed by these fixtures; separate integration tests cover that.
const payer = '0x' + '11'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const routerAddress = '0x' + '44'.repeat(20);
const txHash = '0x' + 'ab'.repeat(32);
const blockHash = '0x' + 'cd'.repeat(32);
const iface = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const payment: Payment = { paymentId: '0x' + '12'.repeat(32), payer, payee, token,
  amount: '125000000', nonce: '0', deadline: '2000000000' };
let store: Store;
let firstId: string;
let secondId: string | undefined;
let receipt: any;
let canonical: any;
let latest: any;
let preflights: number;
let signing: number;
let blockReads: number;
beforeEach(() => {
  store = new Store();
  firstId = store.accept(payment, 'synthetic-fingerprint', 'synthetic-signature').row.id;
  store.broadcast(firstId, 'synthetic-stored-signed-transaction', txHash);
  secondId = undefined;
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
  receipt = { hash: txHash, blockNumber: 17, blockHash, status: 1,
    logs: [{ address: routerAddress, ...log }] };
  canonical = { number: 17, hash: blockHash };
  latest = 18;
  preflights = 0; signing = 0; blockReads = 0;
});
afterEach(() => { store.close(); });

function queueAnother() {
  const second = { ...payment, paymentId: '0x' + '34'.repeat(32), amount: '7000000', nonce: '1' };
  secondId = store.accept(second, 'second-fingerprint', 'second-signature').row.id;
}
function service(overrides: Record<string, unknown> = {}, confirmations = 2) {
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlockNumber: async () => latest,
    getBlock: async () => { blockReads++; return canonical; },
    broadcastTransaction: async () => { throw new Error('Synthetic receipt unexpectedly missing'); },
    ...overrides
  };
  const router = { interface: iface, connect() { return this; },
    settle: { staticCall: async () => { preflights++; throw new Error('Queued nonce was allocated too early'); } } };
  const relayer = { populateTransaction: async () => { signing++; throw new Error('Unexpected queued signing'); } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider, relayer as unknown as Wallet,
    router, 31337, routerAddress, confirmations);
}
async function remainsUncertain(overrides: Record<string, unknown> = {}) {
  queueAnother();
  const before = { row: store.get(firstId), audit: store.events() };
  const worker = service(overrides);
  await worker.tick();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  assert.deepEqual({ row: store.get(firstId), audit: store.events() }, before);
  assert.equal(store.get(secondId!)!.status, 'queued');
  assert.equal(store.get(secondId!)!.raw_tx, null);
  assert.equal(store.get(secondId!)!.tx_hash, null);
  assert.equal(store.journals().length, 0);
  assert.equal(preflights, 0);
  assert.equal(signing, 0);
}

for (const status of [0, 1]) {
  for (const [description, hash] of [
    ['wrong transaction', '0x' + 'ef'.repeat(32)],
    ['missing transaction', undefined],
    ['malformed transaction', '0x1234']
  ] as const) {
    test(description + ' hash on status ' + status + ' cannot fail or settle the persisted broadcast', async () => {
      receipt.hash = hash; receipt.status = status;
      await remainsUncertain();
    });
  }
}

for (const [description, value] of [
  ['missing', undefined], ['null', null], ['negative', -1], ['fractional', 17.5],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1], ['string', '17']
] as const) {
  test(description + ' receipt block number cannot become journal provenance', async () => {
    receipt.blockNumber = value;
    await remainsUncertain();
    assert.equal(blockReads, 0);
  });
}

for (const [description, hash] of [
  ['missing', undefined], ['malformed', '0x1234'], ['nonhex', '0x' + 'zz'.repeat(32)]
] as const) {
  test(description + ' receipt block hash remains retryable without journaling', async () => {
    receipt.blockHash = hash;
    await remainsUncertain();
  });
}

for (const [description, height] of [
  ['behind receipt', 16], ['missing', undefined], ['negative', -1], ['fractional', 18.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['NaN', NaN], ['string', '18']
] as const) {
  test(description + ' latest head cannot provide confirmation depth', async () => {
    latest = height;
    await remainsUncertain();
  });
}

for (const status of [0, 1]) {
  for (const [description, block] of [
    ['missing canonical block', null],
    ['wrong canonical height', { number: 18, hash: blockHash }],
    ['wrong canonical hash', { number: 17, hash: '0x' + 'ef'.repeat(32) }],
    ['malformed canonical hash', { number: 17, hash: 'not-a-block-hash' }]
  ] as const) {
    test(description + ' keeps status ' + status + ' broadcast unresolved', async () => {
      receipt.status = status; canonical = block;
      await remainsUncertain();
    });
  }
}

for (const status of [undefined, null, 2, -1, '0', '1']) {
  test('unknown receipt status ' + String(status) + ' is not a proven revert', async () => {
    receipt.status = status;
    await remainsUncertain();
  });
}

for (const method of ['getTransactionReceipt', 'getBlockNumber', 'getBlock']) {
  test(method + ' RPC failure preserves signed evidence and blocks subsequent nonce preparation', async () => {
    await remainsUncertain({ [method]: async () => { throw new Error('Synthetic upstream RPC outage'); } });
  });
}

for (const [description, logs] of [['missing', undefined], ['null', null], ['non-array', {}]] as const) {
  test(description + ' success logs remain uncertain provider evidence', async () => {
    receipt.logs = logs;
    await remainsUncertain();
  });
}

test('a canonical success with an explicit empty log array enters review once', async () => {
  receipt.logs = [];
  const worker = service();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'review');
  assert.equal(store.journals().length, 0);
  assert.equal(store.events().filter(event => event.action === 'review').length, 1);
  await worker.tick();
  assert.equal(store.events().filter(event => event.action === 'review').length, 1);
});

test('unsafe or nonpositive confirmation policies are rejected before receipt processing', () => {
  for (const confirmations of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => service({}, confirmations), /Invalid confirmation count/);
});

test('a matching revert is failed only after both confirmation depth and canonical evidence', async () => {
  receipt.status = 0; receipt.logs = [];
  latest = 17;
  const worker = service();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  assert.equal(store.events().filter(event => event.action === 'failed').length, 0);
  latest = 18;
  canonical = null;
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  canonical = { number: 17, hash: blockHash };
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'failed');
  assert.equal(store.get(firstId)!.tx_hash, txHash);
  assert.equal(store.journals().length, 0);
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
  await worker.tick();
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});

test('successful receipt waits for confirmation depth and then journals once', async () => {
  latest = 17;
  const worker = service();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  assert.equal(store.journals().length, 0);
  latest = 18;
  await worker.tick();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'settled');
  assert.equal(store.journals().length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
});

test('matching hash bytes with mixed-case hexadecimal receipt and canonical forms remain valid', async () => {
  receipt.hash = '0x' + 'AB'.repeat(32);
  receipt.blockHash = '0x' + 'Cd'.repeat(32);
  canonical.hash = '0x' + 'cD'.repeat(32);
  await service().tick();
  assert.equal(store.get(firstId)!.status, 'settled');
  assert.equal(store.get(firstId)!.tx_hash, txHash);
  assert.equal(store.get(firstId)!.block_hash!.toLowerCase(), blockHash);
  assert.equal(store.journals().length, 1);
});
