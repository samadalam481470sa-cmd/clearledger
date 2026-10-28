import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { type Payment } from '../src/payment.ts';

// Synthetic receipt/projection fixtures exercise integrity decisions, not EVM execution.
const payer = '0x' + '11'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const routerAddress = '0x' + '44'.repeat(20);
const blockHash = '0x' + '55'.repeat(32);
const txHash = '0x' + '66'.repeat(32);
const iface = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)',
  'event Unrelated(uint256 value)'
]);
const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer, payee, token,
  amount: '125000000', nonce: '0', deadline: '2000000000' };
let store: Store;
let paymentId: string;
let receipt: any;
let canonical: any;
beforeEach(() => {
  store = new Store();
  paymentId = store.accept(payment, 'synthetic-fingerprint', 'synthetic-signature').row.id;
  store.broadcast(paymentId, 'synthetic-signed-bytes', txHash);
  store.finalize(paymentId, 17, blockHash);
  receipt = { hash: txHash, blockNumber: 17, status: 1, blockHash, logs: [settlementLog()] };
  canonical = { number: 17, hash: blockHash };
});
afterEach(() => { store.close(); });

function settlementLog(overrides: Partial<Payment> = {}, address = routerAddress) {
  const p = { ...payment, ...overrides };
  return { address, transactionHash: txHash, blockNumber: 17, blockHash,
    ...iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [p.paymentId, p.payer, p.payee, p.token, p.amount, p.nonce]) };
}
function service(overrides: Record<string, unknown> = {}) {
  const provider = {
    getTransactionReceipt: async () => receipt,
    getBlock: async () => canonical,
    ...overrides
  };
  const router = { interface: iface, connect() { return this; } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    router, 31337, routerAddress);
}
async function flagged() {
  const beforeJournal = store.journal(paymentId);
  const result = await service().reconcile();
  assert.equal(result.checked, 1);
  assert.deepEqual(result.exceptions, [paymentId]);
  assert.equal(store.get(paymentId)!.status, 'review');
  assert.ok(store.get(paymentId)!.error);
  assert.deepEqual(store.journal(paymentId), beforeJournal, 'Integrity review must preserve the existing journal evidence');
  assert.equal(store.events().filter(event => event.action === 'review').length, 1);
}

test('coherent receipt, canonical block, journal and router event remain settled', async () => {
  const before = { row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() };
  const result = await service().reconcile();
  assert.equal(result.checked, 1);
  assert.deepEqual(result.exceptions, []);
  assert.deepEqual({ row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() }, before);
  assert.equal(store.journal('unknown'), undefined);
});

for (const field of ['transactionHash', 'blockHash'] as const) {
  for (const [description, value] of [
    ['missing', undefined], ['null', null], ['malformed', '0x1234'],
    ['nonhex', '0x' + 'zz'.repeat(32)], ['different', '0x' + '99'.repeat(32)]
  ] as const) {
    test(description + ' matching-log ' + field + ' triggers review while retaining the existing journal', async () => {
      if (value === undefined) delete receipt.logs[0][field]; else receipt.logs[0][field] = value;
      await flagged();
    });
  }
}
for (const [description, value] of [
  ['missing', undefined], ['null', null], ['negative', -1], ['fractional', 17.5],
  ['unsafe', Number.MAX_SAFE_INTEGER + 1], ['string', '17'], ['different', 18]
] as const) {
  test(description + ' matching-log block number triggers review while retaining the existing journal', async () => {
    if (value === undefined) delete receipt.logs[0].blockNumber; else receipt.logs[0].blockNumber = value;
    await flagged();
  });
}
for (const contradictoryFirst of [false, true]) {
  test('a contradictory matching candidate prevents reconciliation in ' +
    (contradictoryFirst ? 'first' : 'last') + ' position', async () => {
    const coherent = { ...receipt.logs[0] };
    const contradictory = { ...coherent, blockHash: '0x' + '99'.repeat(32) };
    receipt.logs = contradictoryFirst ? [contradictory, coherent] : [coherent, contradictory];
    await flagged();
  });
}

for (const [field, value] of Object.entries({
  token: '0x' + '88'.repeat(20), debit_account: payee, credit_account: payer,
  amount: '1', tx_hash: '0x' + '99'.repeat(32), block_number: 18, block_hash: '0x' + 'aa'.repeat(32)
})) {
  test('corrupted journal ' + field + ' is flagged without being repaired or erased', async () => {
    // Fixed fixture field list only; no user-provided SQL identifiers.
    store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?').run(value, paymentId);
    await flagged();
  });
}

test('a missing local journal is an integrity exception even when the chain receipt is valid', async () => {
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(paymentId);
  await flagged();
  assert.equal(store.journals().length, 0);
});

test('an oversized integer journal block number is reviewed without changing its exact stored evidence', async () => {
  const oversized = 2n ** 53n + 1n;
  store.db.prepare('UPDATE journals SET block_number=? WHERE payment_id=?').run(oversized, paymentId);
  const raw = store.db.prepare('SELECT block_number FROM journals WHERE payment_id=?');
  raw.setReadBigInts(true);
  assert.equal(raw.get(paymentId)!.block_number, oversized);
  await flagged();
  assert.equal(raw.get(paymentId)!.block_number, oversized);
});

for (const [description, change] of [
  ['missing receipt', () => { receipt = null; }],
  ['different transaction hash', () => { receipt.hash = '0x' + '99'.repeat(32); }],
  ['missing transaction hash', () => { delete receipt.hash; }],
  ['different receipt block number', () => { receipt.blockNumber = 18; }],
  ['unsuccessful receipt', () => { receipt.status = 0; }],
  ['different receipt block hash', () => { receipt.blockHash = '0x' + '99'.repeat(32); }],
  ['missing canonical block', () => { canonical = null; }],
  ['different canonical block number', () => { canonical.number = 18; }],
  ['different canonical block hash', () => { canonical.hash = '0x' + '99'.repeat(32); }]
] as const) {
  test(description + ' cannot confirm the local settlement record', async () => { change(); await flagged(); });
}

for (const [field, value] of Object.entries({
  paymentId: '0x' + '99'.repeat(32), payer: payee, payee: payer,
  token: '0x' + '88'.repeat(20), amount: '125000001', nonce: '1'
})) {
  test('a PaymentSettled event with a different ' + field + ' is rejected', async () => {
    receipt.logs = [settlementLog({ [field]: value })];
    await flagged();
  });
}

test('matching event data from another contract cannot validate settlement', async () => {
  receipt.logs = [settlementLog({}, payee)];
  await flagged();
});

for (const [description, logs] of [
  ['no logs', []], ['missing logs', undefined], ['non-array logs', {}],
  ['null event log', [null]],
  ['missing event address', [{ ...iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]) }]],
  ['null event address', [{ ...settlementLog(), address: null }]],
  ['malformed event log', [{ address: routerAddress, topics: ['0x1234'], data: 'not-abi-data' }]],
  ['unrelated event', [{ address: routerAddress, ...iface.encodeEventLog(iface.getEvent('Unrelated')!, [125000000]) }]]
] as const) {
  test(description + ' cannot masquerade as PaymentSettled', async () => { receipt.logs = logs; await flagged(); });
}

test('a genuine matching settlement remains valid alongside unrelated or malformed logs', async () => {
  receipt.logs = [{ address: routerAddress, topics: ['0x1234'], data: 'not-abi-data' },
    { address: payee, ...iface.encodeEventLog(iface.getEvent('Unrelated')!, [1]) }, settlementLog()];
  const result = await service().reconcile();
  assert.deepEqual(result.exceptions, []);
  assert.equal(store.get(paymentId)!.status, 'settled');
});

test('valid receipt and canonical hash hex casing does not create a false integrity exception', async () => {
  const transaction = '0x' + 'ab'.repeat(32);
  const recordedBlock = '0x' + 'cd'.repeat(32);
  store.db.prepare('UPDATE payments SET tx_hash=?,block_hash=? WHERE id=?').run(transaction, recordedBlock, paymentId);
  store.db.prepare('UPDATE journals SET tx_hash=?,block_hash=? WHERE payment_id=?').run(transaction, recordedBlock, paymentId);
  receipt = { ...receipt, hash: '0x' + 'AB'.repeat(32), blockHash: '0x' + 'CD'.repeat(32) };
  receipt.logs = receipt.logs.map((log: any) => ({ ...log,
    transactionHash: '0x' + 'aB'.repeat(32), blockHash: '0x' + 'cD'.repeat(32) }));
  canonical = { ...canonical, hash: '0x' + 'CD'.repeat(32) };
  const before = { row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() };
  const result = await service().reconcile();
  assert.deepEqual(result.exceptions, []);
  assert.deepEqual({ row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() }, before);
});

for (const malformed of ['not JSON', 'null', '{}', JSON.stringify({ ...payment, amount: '1.5' })]) {
  test('malformed stored authorization is flagged and preserves journal evidence: ' + malformed.slice(0, 12), async () => {
    store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(malformed, paymentId);
    await flagged();
  });
}

for (const [description, corrupt] of [
  ['payment key differs from valid stored payload', () => {
    store.db.prepare('UPDATE payments SET payload=? WHERE id=?')
      .run(JSON.stringify({ ...payment, paymentId: '0x' + '99'.repeat(32) }), paymentId);
  }],
  ['missing transaction hash', () => { store.db.prepare('UPDATE payments SET tx_hash=NULL WHERE id=?').run(paymentId); }],
  ['invalid transaction hash', () => { store.db.prepare('UPDATE payments SET tx_hash=? WHERE id=?').run('not-a-hash', paymentId); }],
  ['missing recorded block hash', () => { store.db.prepare('UPDATE payments SET block_hash=NULL WHERE id=?').run(paymentId); }],
  ['invalid recorded block hash', () => { store.db.prepare('UPDATE payments SET block_hash=? WHERE id=?').run('0x1234', paymentId); }],
  ['missing recorded block number', () => { store.db.prepare('UPDATE payments SET block_number=NULL WHERE id=?').run(paymentId); }],
  ['negative recorded block number', () => { store.db.prepare('UPDATE payments SET block_number=? WHERE id=?').run(-1, paymentId); }],
  ['fractional recorded block number', () => { store.db.prepare('UPDATE payments SET block_number=? WHERE id=?').run(17.5, paymentId); }],
  ['unsafe recorded block number', () => { store.db.prepare('UPDATE payments SET block_number=? WHERE id=?').run(Number.MAX_SAFE_INTEGER + 1, paymentId); }]
] as const) {
  test(description + ' is reviewed before any RPC query', async () => {
    corrupt();
    let reads = 0;
    const unavailable = async () => { reads++; throw new Error('Invalid local metadata must not reach RPC'); };
    const journal = store.journal(paymentId);
    const result = await service({ getTransactionReceipt: unavailable, getBlock: unavailable }).reconcile();
    assert.deepEqual(result.exceptions, [paymentId]);
    assert.equal(store.get(paymentId)!.status, 'review');
    assert.deepEqual(store.journal(paymentId), journal);
    assert.equal(reads, 0);
  });
}

for (const method of ['getTransactionReceipt', 'getBlock']) {
  test(method + ' transport failure propagates without inventing a review outcome', async () => {
    const failure = new Error('Synthetic RPC unavailable');
    const before = { row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() };
    await assert.rejects(() => service({ [method]: async () => { throw failure; } }).reconcile(), error => error === failure);
    assert.deepEqual({ row: store.get(paymentId), journal: store.journal(paymentId), audit: store.events() }, before);
  });
}

test('a journal storage query failure propagates instead of being mislabeled as a corrupt settlement', async () => {
  const before = { row: store.get(paymentId), audit: store.events() };
  store.db.exec('DROP TABLE journals');
  await assert.rejects(() => service().reconcile(), /no such table: journals/);
  assert.deepEqual({ row: store.get(paymentId), audit: store.events() }, before);
});

test('concurrent reconciliation shares one scan and records one identical review transition', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let reads = 0;
  const reviewing = service({ getTransactionReceipt: async () => {
    reads++;
    enter();
    await pending;
    return { ...receipt, hash: '0x' + '99'.repeat(32) };
  } });
  const first = reviewing.reconcile();
  const second = reviewing.reconcile();
  await entered;
  assert.equal(reads, 1);
  release();
  const results = await Promise.all([first, second]);
  for (const result of results) assert.deepEqual(result.exceptions, [paymentId]);
  assert.equal(store.get(paymentId)!.status, 'review');
  assert.equal(store.events().filter(event => event.action === 'review').length, 1);
  assert.equal(store.journals().length, 1);
});
