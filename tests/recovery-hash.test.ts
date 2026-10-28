import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, Wallet, type JsonRpcProvider } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { digest, domain, type Payment } from '../src/payment.ts';

// Offline-signed bytes keep hash-binding controls compatible with envelope
// validation. Synthetic receipts still do not claim an executed EVM transfer.
const blockHash = '0x' + 'cd'.repeat(32);
const routerAddress = '0x' + '44'.repeat(20);
const iface = new Interface([
  'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)',
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const payment: Payment = { paymentId: '0x' + '12'.repeat(32), payer: '0x' + '11'.repeat(20),
  payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000000000' };
const offlineRelayer = new Wallet('0x' + '01'.repeat(32));
const raw = await offlineRelayer.signTransaction({ type: 2, chainId: 31337, nonce: 7,
  to: routerAddress, value: 0, data: iface.encodeFunctionData('settle', [payment, '0x1234']),
  gasLimit: 200000, maxFeePerGas: 2, maxPriorityFeePerGas: 1 });
const txHash = keccak256(raw);
const unavailable = new Error('Controlled RPC unavailable');
let store: Store, service: PaymentService, firstId: string, secondId: string;
let sent: string[], receiptReads: number, preflights: number, signed: number, receipt: any;
let publishReceipt: boolean;
beforeEach(() => {
  store = new Store(); sent = []; receiptReads = 0; preflights = 0; signed = 0; receipt = null; publishReceipt = false;
  const signingDomain = domain(31337, routerAddress);
  firstId = store.accept(payment, digest(payment, signingDomain), '0x1234').row.id;
  store.broadcast(firstId, raw, txHash);
  const next = { ...payment, paymentId: '0x' + '34'.repeat(32), nonce: '1' };
  secondId = store.accept(next, digest(next, signingDomain), '0x1234').row.id;
  const provider = {
    getTransactionReceipt: async () => { receiptReads++; return receipt; },
    broadcastTransaction: async (bytes: string) => {
      sent.push(bytes);
      if (publishReceipt) receipt = coherentReceipt();
      else throw unavailable;
    },
    getBlockNumber: async () => 17,
    getBlock: async () => ({ number: 17, hash: blockHash })
  };
  const router = { interface: iface, connect() { return this; }, settle: {
    staticCall: async () => { preflights++; throw unavailable; }
  } };
  const relayer = { address: offlineRelayer.address,
    signTransaction: async () => { signed++; throw new Error('Unexpected signing'); } };
  service = new PaymentService(store, provider as unknown as JsonRpcProvider,
    relayer as unknown as Wallet, router, 31337, routerAddress);
});
afterEach(() => { store.close(); });
function coherentReceipt() {
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!, Object.values({
    paymentId: payment.paymentId, payer: payment.payer, payee: payment.payee,
    token: payment.token, amount: payment.amount, nonce: payment.nonce }));
  return { hash: txHash, blockNumber: 17, blockHash, status: 1,
    logs: [{ address: routerAddress, ...log, transactionHash: txHash, blockNumber: 17, blockHash }] };
}
function snapshot() {
  return { rows: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    audit: store.events(), journals: store.journals() };
}

for (const [label, value] of [
  ['null', null], ['empty', ''], ['empty hex', '0x'], ['odd hex', '0x123'],
  ['nonhex', '0xgg'], ['missing prefix', '1234abcd'], ['uppercase prefix', '0X1234abcd'],
  ['private malformed bytes', 'PRIVATE_RECOVERY_BYTES'], ['different valid bytes', '0x5678'],
  ['SQLite blob', Buffer.from([0x12, 0x34])]
] as const) test(label + ' cannot be retransmitted under a different stored hash or release nonce priority', async () => {
  store.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run(value, firstId);
  const before = snapshot();
  await service.tick(); await service.tick();
  assert.equal(sent.length, 0); assert.equal(receiptReads, 2);
  assert.deepEqual(snapshot(), before);
  assert.equal(store.get(firstId)!.status, 'broadcast'); assert.equal(store.get(secondId)!.status, 'queued');
  assert.equal(store.get(secondId)!.raw_tx, null); assert.equal(preflights, 0); assert.equal(signed, 0);
});

for (const uppercase of [false, true]) test('hash-coherent bytes retain exact retransmission under RPC uncertainty: uppercase=' + uppercase, async () => {
  const bytes = uppercase ? '0x' + raw.slice(2).toUpperCase() : raw;
  const hash = uppercase ? '0x' + txHash.slice(2).toUpperCase() : txHash;
  store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(bytes, hash, firstId);
  const before = snapshot();
  await service.tick(); await service.tick();
  assert.deepEqual(sent, [bytes, bytes]); assert.equal(receiptReads, 4);
  assert.deepEqual(snapshot(), before); assert.equal(preflights, 0); assert.equal(signed, 0);
});

test('restoring the original bytes recovers its stored hash once without replacing authorization or reservation', async () => {
  store.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run('0x5678', firstId);
  const privateEvidence = store.get(firstId)!;
  await service.tick(); assert.equal(sent.length, 0);
  store.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run(raw, firstId);
  publishReceipt = true;
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.deepEqual(sent, [raw]);
  const settled = store.get(firstId)!;
  assert.equal(settled.status, 'settled'); assert.equal(settled.tx_hash, txHash);
  assert.ok(settled.payload === privateEvidence.payload && settled.signature === privateEvidence.signature &&
    settled.fingerprint === privateEvidence.fingerprint);
  assert.equal(store.journals().length, 1); assert.equal(store.journal(firstId)!.tx_hash, txHash);
  assert.equal(store.events().filter(event => event.action === 'broadcast-prepared').length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  assert.equal(store.get(secondId)!.status, 'queued'); assert.equal(preflights, 1); assert.equal(signed, 0);
});

test('an already available coherent receipt retains existing confirmation behavior without retransmission', async () => {
  store.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run('PRIVATE_RECOVERY_BYTES', firstId);
  receipt = coherentReceipt();
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.equal(sent.length, 0); assert.equal(receiptReads, 1);
  assert.equal(store.get(firstId)!.status, 'settled'); assert.equal(store.journal(firstId)!.tx_hash, txHash);
  assert.equal(store.journals().length, 1); assert.equal(preflights, 1); assert.equal(signed, 0);
  assert.ok(store.get(firstId)!.raw_tx === 'PRIVATE_RECOVERY_BYTES');
});
