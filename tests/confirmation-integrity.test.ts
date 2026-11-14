import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { digest, domain, type Payment } from '../src/payment.ts';
import { fixtureRelayer, settleAbi, signedSettlement } from './fixtures/signed-settlement.ts';

// Synthetic provider evidence isolates initial-confirmation decisions. No EVM
// transfer is claimed by these fixtures; separate integration tests cover that.
const payer = '0x' + '11'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const routerAddress = getAddress('0x' + 'ab'.repeat(20));
const otherTxHash = '0x' + 'ef'.repeat(32);
const blockHash = '0x' + 'cd'.repeat(32);
const emptyLogsBloom = '0x' + '0'.repeat(512);
const nonzeroLogsBloom = '0x' + '0'.repeat(511) + '1';
const iface = new Interface([
  settleAbi,
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const payment: Payment = { paymentId: '0x' + '12'.repeat(32), payer, payee, token,
  amount: '125000000', nonce: '0', deadline: '2000000000' };
const signingDomain = domain(31337, routerAddress);
const signature = '0x1234';
const { raw, hash: txHash } = signedSettlement(payment, signature, routerAddress, 7);
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
  firstId = store.accept(payment, digest(payment, signingDomain), signature).row.id;
  store.broadcast(firstId, raw, txHash);
  secondId = undefined;
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
  receipt = { hash: txHash, index: 0, blockNumber: 17, blockHash, status: 1,
    from: fixtureRelayer.address, to: routerAddress,
    logs: [{ address: routerAddress, transactionHash: txHash, transactionIndex: 0, blockNumber: 17, blockHash, ...log }] };
  canonical = { number: 17, hash: blockHash, transactions: [txHash] };
  latest = 18;
  preflights = 0; signing = 0; blockReads = 0;
});
afterEach(() => { store.close(); });

function setReceiptStatus(status: number) {
  receipt.status = status;
  if (status === 0) {
    receipt.logs = [];
    receipt.logsBloom = emptyLogsBloom;
  }
}
function queueAnother() {
  const second = { ...payment, paymentId: '0x' + '34'.repeat(32), amount: '7000000', nonce: '1' };
  secondId = store.accept(second, digest(second, signingDomain), signature).row.id;
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
  const relayer = { address: fixtureRelayer.address, populateTransaction: async () => { signing++; throw new Error('Unexpected queued signing'); } };
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
  return worker;
}

for (const field of ['transactionHash', 'blockHash'] as const) {
  for (const [description, value] of [
    ['missing', undefined], ['null', null], ['malformed', '0x1234'],
    ['nonhex', '0x' + 'zz'.repeat(32)], ['different', '0x' + 'ef'.repeat(32)]
  ] as const) {
    test(description + ' matching-log ' + field + ' preserves the broadcast and queued nonce priority', async () => {
      if (value === undefined) delete receipt.logs[0][field]; else receipt.logs[0][field] = value;
      await remainsUncertain();
    });
  }
}
for (const [description, value] of [
  ['missing', undefined], ['null', null], ['negative', -1], ['fractional', 17.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '17'], ['different', 18]
] as const) {
  test(description + ' matching-log block number preserves the broadcast and queued nonce priority', async () => {
    if (value === undefined) delete receipt.logs[0].blockNumber; else receipt.logs[0].blockNumber = value;
    await remainsUncertain();
  });
}

for (const [description, receiptIndex, logIndex] of [
  ['different', 0, 1], ['missing receipt', undefined, 0], ['missing log', 0, undefined],
  ['negative', -1, -1], ['fractional', 0.5, 0.5], ['unsafe', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1]
] as const) {
  test(description + ' transaction index preserves the broadcast and queued nonce priority', async () => {
    receipt.index = receiptIndex;
    receipt.logs[0].transactionIndex = logIndex;
    await remainsUncertain();
  });
}

for (const field of ['transactionHash', 'blockHash', 'blockNumber'] as const) {
  for (const missing of [false, true]) {
    test('healing ' + (missing ? 'missing' : 'different') + ' matching-log ' + field + ' settles the same reservation once', async () => {
      const coherent = { ...receipt.logs[0] };
      const before = store.get(firstId)!;
      if (missing) delete receipt.logs[0][field];
      else receipt.logs[0][field] = field === 'blockNumber' ? 18 : '0x' + 'ef'.repeat(32);
      const worker = service();
      await worker.tick(); await worker.tick();
      assert.deepEqual(store.get(firstId), before);
      assert.equal(store.journals().length, 0);
      receipt.logs = [coherent];
      await worker.tick(); await worker.tick();
      assert.equal(store.get(firstId)!.status, 'settled');
      assert.equal(store.get(firstId)!.tx_hash, before.tx_hash);
      assert.ok(store.get(firstId)!.raw_tx === before.raw_tx, 'Healing must retain the original signed transaction');
      assert.equal(store.journals().length, 1);
      assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
      assert.equal(store.events().filter(event => event.action === 'review').length, 0);
    });
  }
}

for (const contradictoryFirst of [false, true]) {
  test('a contradictory matching candidate overrides coherent evidence in ' +
    (contradictoryFirst ? 'first' : 'last') + ' position', async () => {
    const coherent = { ...receipt.logs[0] };
    const contradictory = { ...coherent, transactionHash: '0x' + 'ef'.repeat(32) };
    receipt.logs = contradictoryFirst ? [contradictory, coherent] : [coherent, contradictory];
    await remainsUncertain();
  });
}

test('a coherent matching event remains accepted alongside unrelated contracts and malformed nonmatching logs', async () => {
  const coherent = receipt.logs[0];
  receipt.logs = [{ address: routerAddress, topics: ['0x1234'], data: 'not-abi-data' },
    { ...coherent, address: payee, transactionHash: '0x' + 'ef'.repeat(32) }, coherent];
  await service().tick();
  assert.equal(store.get(firstId)!.status, 'settled');
  assert.equal(store.journals().length, 1);
});

for (const status of [0, 1]) {
  for (const field of ['from', 'to'] as const) {
    for (const [description, value] of [
      ['missing', undefined], ['null', null], ['different', payee]
    ] as const) {
      test(description + ' receipt ' + field + ' preserves the status-' + status + ' broadcast', async () => {
        setReceiptStatus(status);
        if (value === undefined) delete receipt[field];
        else receipt[field] = value;
        await remainsUncertain();
        assert.equal(blockReads, 0);
      });
    }
  }
}

for (const status of [0, 1]) {
  for (const [description, hash] of [
    ['wrong transaction', '0x' + 'ef'.repeat(32)],
    ['missing transaction', undefined],
    ['malformed transaction', '0x1234']
  ] as const) {
    test(description + ' hash on status ' + status + ' cannot fail or settle the persisted broadcast', async () => {
      setReceiptStatus(status);
      receipt.hash = hash;
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
      setReceiptStatus(status);
      canonical = block;
      await remainsUncertain();
    });
  }
}

for (const status of [0, 1]) {
  for (const [description, index, transactions] of [
    ['missing canonical transaction list', 0, undefined],
    ['non-array canonical transaction list', 0, { 0: txHash }],
    ['empty canonical transaction list', 0, []],
    ['out-of-range canonical transaction slot', 1, [txHash]],
    ['malformed hash at the canonical transaction slot', 0, ['0x1234']],
    ['reserved hash at a different canonical transaction slot', 1, [txHash, otherTxHash]]
  ] as const) {
    test(description + ' keeps status ' + status + ' broadcast unresolved', async () => {
      setReceiptStatus(status);
      receipt.index = index;
      if (status === 1) receipt.logs[0].transactionIndex = index;
      canonical.transactions = transactions;
      await remainsUncertain();
      assert.equal(blockReads, 2);
    });
  }
}

for (const status of [0, 1]) {
  test('duplicate transaction hash keeps status ' + status + ' unresolved until the block list is restored', async () => {
    setReceiptStatus(status);
    canonical.transactions = [txHash, otherTxHash, '0x' + txHash.slice(2).toUpperCase()];
    const worker = await remainsUncertain();
    assert.equal(blockReads, 2);

    canonical.transactions = [txHash, otherTxHash];
    // The stub stops when the successor reaches preflight after the reservation resolves.
    await assert.rejects(worker.tick(), /Queued nonce was allocated too early/);
    const outcome = status === 1 ? 'settled' : 'failed';
    const resolved = store.get(firstId)!;
    assert.equal(resolved.status, outcome);
    assert.ok(resolved.raw_tx === raw && resolved.tx_hash === txHash);
    assert.equal(store.events().filter(event => event.action === outcome).length, 1);
    assert.equal(store.journals().length, status);
    assert.equal(preflights, 1);
    assert.equal(signing, 0);
  });
}

for (const [description, index] of [
  ['missing', undefined], ['negative', -1], ['fractional', 0.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '0']
] as const) {
  test(description + ' revert receipt index preserves the broadcast before block reads', async () => {
    setReceiptStatus(0);
    receipt.index = index;
    await remainsUncertain();
    assert.equal(blockReads, 0);
  });
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

for (const kind of ['matching', 'unrelated']) {
  test('a reported revert with ' + kind + ' log evidence retains the reservation', async () => {
    const log = receipt.logs[0];
    setReceiptStatus(0);
    receipt.logs = [kind === 'matching' ? log : { ...log, address: payee }];
    await remainsUncertain();
    assert.equal(blockReads, 0);
  });
}

for (const [description, logs] of [['missing', undefined], ['null', null], ['non-array', {}]] as const) {
  test(description + ' reported revert logs retain the reservation', async () => {
    setReceiptStatus(0);
    if (logs === undefined) delete receipt.logs; else receipt.logs = logs;
    await remainsUncertain();
    assert.equal(blockReads, 0);
  });
}

for (const [description, bloom] of [
  ['nonzero', nonzeroLogsBloom], ['missing', undefined], ['null', null],
  ['short', '0x00'], ['nonhex', '0x' + 'z'.repeat(512)]
] as const) {
  test(description + ' reported revert log bloom retains the reservation', async () => {
    setReceiptStatus(0);
    if (bloom === undefined) delete receipt.logsBloom; else receipt.logsBloom = bloom;
    await remainsUncertain();
    assert.equal(blockReads, 0);
  });
}

test('restoring reported revert log evidence fails the original reservation once', async () => {
  setReceiptStatus(0);
  receipt.logsBloom = nonzeroLogsBloom;
  const before = { row: store.get(firstId), audit: store.events() };
  const worker = service();
  await worker.tick(); await worker.tick();
  assert.deepEqual({ row: store.get(firstId), audit: store.events() }, before);
  receipt.logsBloom = emptyLogsBloom;
  await worker.tick(); await worker.tick();
  assert.equal(store.get(firstId)!.status, 'failed');
  assert.equal(store.get(firstId)!.raw_tx, before.row!.raw_tx);
  assert.equal(store.get(firstId)!.tx_hash, before.row!.tx_hash);
  assert.equal(store.journals().length, 0);
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});

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
  setReceiptStatus(0);
  latest = 17;
  const worker = service();
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  assert.equal(store.events().filter(event => event.action === 'failed').length, 0);
  latest = 18;
  canonical = null;
  await worker.tick();
  assert.equal(store.get(firstId)!.status, 'broadcast');
  canonical = { number: 17, hash: blockHash, transactions: [txHash] };
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

test('matching receipt addresses and hashes remain valid across hexadecimal case', async () => {
  receipt.from = fixtureRelayer.address.toLowerCase();
  receipt.to = routerAddress.toLowerCase();
  const uppercaseHash = '0x' + txHash.slice(2).toUpperCase();
  receipt.hash = uppercaseHash;
  receipt.blockHash = '0x' + 'Cd'.repeat(32);
  canonical.hash = '0x' + 'cD'.repeat(32);
  receipt.index = 1;
  receipt.logs[0].transactionIndex = 1;
  canonical.transactions = [otherTxHash, uppercaseHash];
  receipt.logs[0].transactionHash = uppercaseHash;
  receipt.logs[0].blockHash = '0x' + 'cD'.repeat(32);
  await service().tick();
  assert.equal(store.get(firstId)!.status, 'settled');
  assert.equal(store.get(firstId)!.tx_hash, txHash);
  assert.equal(store.get(firstId)!.block_hash!.toLowerCase(), blockHash);
  assert.equal(store.journals().length, 1);
});
