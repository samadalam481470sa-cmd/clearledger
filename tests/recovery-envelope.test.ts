import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, Transaction, Wallet, type JsonRpcProvider, type TransactionRequest } from 'ethers';
import { digest, domain, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

// Offline native signatures plus synthetic provider evidence isolate the
// retransmission gate. No EVM execution or wallet policy validation is claimed.
const chainId = 31337, routerAddress = '0x' + '44'.repeat(20);
const blockHash = '0x' + 'cd'.repeat(32), authorization = '0x1234';
const relayer = new Wallet('0x' + '01'.repeat(32));
const otherSigner = new Wallet('0x' + '02'.repeat(32));
const payer = new Wallet('0x' + '03'.repeat(32));
const iface = new Interface([
  'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)',
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const payment: Payment = { paymentId: '0x' + '12'.repeat(32), payer: payer.address,
  payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000',
  nonce: '0', deadline: '2000000000' };
const signingDomain = domain(chainId, routerAddress);
const unavailable = new Error('Controlled queued RPC unavailable');
let store: Store, service: PaymentService, firstId: string, secondId: string;
let originalRaw: string, originalHash: string, sent: string[], receiptReads: string[];
let preflights: number, populated: number, signed: number, publishReceipt: boolean, receipt: any;

function request(type = 2, p = payment, signature = authorization) {
  return { type, chainId, nonce: 7, to: routerAddress, value: 0,
    data: iface.encodeFunctionData('settle', [p, signature]), gasLimit: 200000,
    ...(type === 0 || type === 1 ? { gasPrice: 2 } : { maxFeePerGas: 2, maxPriorityFeePerGas: 1 }) };
}
async function sign(overrides: TransactionRequest = {}, signer = relayer) {
  return signer.signTransaction({ ...request(overrides.type ?? 2), ...overrides });
}
function replaceEnvelope(raw: string) {
  store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(raw, keccak256(raw), firstId);
}
function update(field: 'payload' | 'signature' | 'fingerprint', value: string | Buffer) {
  store.db.prepare('UPDATE payments SET ' + field + '=? WHERE id=?').run(value, firstId);
}
function snapshot() {
  return { payments: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    journals: store.journals(), changes: store.db.prepare('SELECT total_changes() AS changes').get() };
}
function coherentReceipt(status = 1) {
  const hash = store.get(firstId)!.tx_hash!;
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
  return { hash, blockNumber: 17, blockHash, status,
    logs: status === 1 ? [{ address: routerAddress, ...log, transactionHash: hash, blockNumber: 17, blockHash }] : [] };
}
function makeService(configuredChainId = chainId) {
  const provider = {
    getTransactionReceipt: async (hash: string) => { receiptReads.push(hash); return receipt; },
    broadcastTransaction: async (raw: string) => {
      sent.push(raw);
      if (publishReceipt) { receipt = coherentReceipt(); return { hash: keccak256(raw) }; }
      throw new Error('Controlled send uncertainty');
    },
    getBlockNumber: async () => 17,
    getBlock: async () => ({ number: 17, hash: blockHash })
  };
  const router = { interface: iface, connect() { return this; }, settle: {
    staticCall: async () => { preflights++; throw unavailable; },
    populateTransaction: async () => { populated++; throw new Error('Unexpected calldata preparation'); }
  } };
  const signer = { address: relayer.address,
    populateTransaction: async () => { populated++; throw new Error('Unexpected native preparation'); },
    signTransaction: async () => { signed++; throw new Error('Unexpected native signing'); } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider,
    signer as unknown as Wallet, router, configuredChainId, routerAddress);
}
beforeEach(async () => {
  store = new Store(); sent = []; receiptReads = []; preflights = 0; populated = 0; signed = 0;
  publishReceipt = false; receipt = null;
  originalRaw = await sign(); originalHash = keccak256(originalRaw);
  firstId = store.accept(payment, digest(payment, signingDomain), authorization).row.id;
  store.broadcast(firstId, originalRaw, originalHash);
  // A distinct payer/nonce proves that an unresolved first reservation also
  // blocks independent work, rather than only another use of its payer nonce.
  const independent = { ...payment, payer: otherSigner.address, paymentId: '0x' + '34'.repeat(32),
    amount: '7000000', nonce: '0' };
  secondId = store.accept(independent, digest(independent, signingDomain), '0xbeef').row.id;
  service = makeService();
});
afterEach(() => { store.close(); });

async function remainsReserved() {
  const before = snapshot();
  await service.tick(); await service.tick();
  assert.deepEqual(sent, []); assert.equal(receiptReads.length, 2);
  assert.deepEqual(snapshot(), before);
  assert.equal(store.get(firstId)!.status, 'broadcast');
  assert.equal(store.get(secondId)!.status, 'queued');
  assert.equal(store.get(secondId)!.raw_tx, null); assert.equal(store.get(secondId)!.tx_hash, null);
  assert.equal(preflights, 0); assert.equal(populated, 0); assert.equal(signed, 0);
}

for (const type of [0, 1, 2]) test('offline signed type ' + type + ' preserves exact retry bytes without re-signing', async () => {
  const raw = await sign({ type, ...(type === 1 ? { accessList: [{ address: routerAddress, storageKeys: [] }] } : {}) });
  assert.equal(Transaction.from(raw).from, relayer.address); replaceEnvelope(raw);
  const before = snapshot();
  await service.tick(); await service.tick();
  assert.deepEqual(sent, [raw, raw]); assert.equal(receiptReads.length, 4);
  assert.deepEqual(snapshot(), before); assert.equal(preflights, 0); assert.equal(populated, 0); assert.equal(signed, 0);
});

for (const signature of ['0x', '0xdeadbeef', '0x' + 'ab'.repeat(4096)])
  test('opaque wallet authorization calldata is structural, bytes=' + (signature.length - 2) / 2, async () => {
    update('signature', signature);
    const raw = await sign({ data: iface.encodeFunctionData('settle', [payment, signature]) });
    replaceEnvelope(raw); const before = snapshot();
    await service.tick();
    assert.deepEqual(sent, [raw]); assert.deepEqual(snapshot(), before); assert.equal(preflights, 0);
  });

test('hex case and JSON layout preserve byte-equivalent signed authorization', async () => {
  const raw = '0x' + originalRaw.slice(2).toUpperCase();
  update('signature', '0x' + authorization.slice(2).toUpperCase());
  update('fingerprint', '0x' + digest(payment, signingDomain).slice(2).toUpperCase());
  update('payload', JSON.stringify(Object.fromEntries(Object.entries(payment).reverse()), null, 2));
  store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?')
    .run(raw, '0x' + originalHash.slice(2).toUpperCase(), firstId);
  const before = snapshot(); await service.tick();
  assert.deepEqual(sent, [raw]); assert.deepEqual(snapshot(), before);
});

test('no independent stored native nonce, fee or gas-limit binding is invented', async () => {
  const raw = await sign({ nonce: 99, gasLimit: 1, maxFeePerGas: 100, maxPriorityFeePerGas: 3 });
  replaceEnvelope(raw); await service.tick(); assert.deepEqual(sent, [raw]);
});

const envelopeFaults: [string, () => Promise<string> | string][] = [
  ['malformed RLP', () => '0x1234abcd'],
  ['RLP list without transaction fields', () => '0xc0'],
  ['unsigned legacy transaction', () => Transaction.from(request(0)).unsignedSerialized],
  ['unsigned type-2 transaction', () => Transaction.from(request()).unsignedSerialized],
  ['different chain', () => sign({ chainId: chainId + 1 })],
  ['unprotected chain-zero legacy transaction', () => sign({ type: 0, chainId: 0 })],
  ['different signer', () => sign({}, otherSigner)],
  ['different destination', () => sign({ to: otherSigner.address })],
  ['contract creation', () => sign({ to: null })],
  ['nonzero native value', () => sign({ value: 1 })],
  ['different selector', () => sign({ data: '0x12345678' })],
  ['truncated settle calldata', () => sign({ data: String(request().data).slice(0, -2) })],
  ['trailing settle calldata', () => sign({ data: request().data + '00' })],
  ['different encoded payment amount', () => sign({ data: iface.encodeFunctionData('settle', [{ ...payment, amount: '125000001' }, authorization]) })],
  ['different encoded authorization bytes', () => sign({ data: iface.encodeFunctionData('settle', [payment, '0xbeef']) })],
  ['blob type-3 transaction', () => sign({ type: 3, maxFeePerBlobGas: 1,
    blobVersionedHashes: ['0x01' + '00'.repeat(31)] })],
  ['authorization-list type-4 transaction', async () => sign({ type: 4,
    authorizationList: [await otherSigner.authorize({ address: routerAddress, chainId, nonce: 0 })] })]
];
for (const [label, build] of envelopeFaults)
  test('hash-coherent ' + label + ' is not retransmitted and retains independent queue priority', async () => {
    const raw = await build(); replaceEnvelope(raw);
    assert.equal(keccak256(store.get(firstId)!.raw_tx!), store.get(firstId)!.tx_hash);
    await remainsReserved();
  });

const storedFaults: [string, () => void][] = [
  ['invalid JSON', () => update('payload', 'PRIVATE_INVALID_STORED_JSON')],
  ['non-object JSON', () => update('payload', 'null')],
  ['unknown payment field', () => update('payload', JSON.stringify({ ...payment, privateExtra: 'PRIVATE_EXTRA' }))],
  ['noncanonical logical address', () => update('payload', JSON.stringify({ ...payment, payer: payment.payer.toLowerCase() }))],
  ['noncanonical amount', () => update('payload', JSON.stringify({ ...payment, amount: '0125000000' }))],
  ['wrong payment key', () => {
    const changed = firstId + ':wrong';
    store.db.prepare('UPDATE payments SET id=? WHERE id=?').run(changed, firstId); firstId = changed;
  }],
  ['malformed fingerprint', () => update('fingerprint', 'PRIVATE_FINGERPRINT')],
  ['different fingerprint', () => update('fingerprint', '0x' + 'ef'.repeat(32))],
  ['blob fingerprint', () => update('fingerprint', Buffer.from('PRIVATE_FINGERPRINT'))],
  ['odd signature', () => update('signature', '0x123')],
  ['malformed signature', () => update('signature', 'PRIVATE_SIGNATURE')],
  ['oversized signature', () => update('signature', '0x' + 'ab'.repeat(4097))],
  ['different persisted signature', () => update('signature', '0xbeef')],
  ['coherent changed stored amount but old native calldata', () => {
    const changed = { ...payment, amount: '7000000' };
    update('payload', JSON.stringify(changed)); update('fingerprint', digest(changed, signingDomain));
  }]
];
for (const [label, corrupt] of storedFaults)
  test('invalid stored recovery authorization: ' + label, async () => { corrupt(); await remainsReserved(); });

for (const invalidChain of [0, -1, 31337.5, Number.MAX_SAFE_INTEGER + 1, NaN])
  test('invalid configured chain ' + invalidChain + ' cannot permit retransmission', async () => {
    service = makeService(invalidChain); await remainsReserved();
  });

test('restoring the original envelope recovers once without changing authorization or reservation', async () => {
  replaceEnvelope(await sign({ to: otherSigner.address }));
  await remainsReserved();
  store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(originalRaw, originalHash, firstId);
  const before = store.get(firstId)!; publishReceipt = true;
  await assert.rejects(service.tick(), error => error === unavailable);
  const settled = store.get(firstId)!;
  assert.deepEqual(sent, [originalRaw]); assert.equal(settled.status, 'settled');
  for (const field of ['payload', 'signature', 'fingerprint', 'raw_tx', 'tx_hash'] as const)
    assert.equal(settled[field], before[field]);
  assert.equal(store.journals().length, 1); assert.equal(store.journal(firstId)!.tx_hash, originalHash);
  assert.equal(store.events().filter(event => event.action === 'broadcast-prepared').length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.deepEqual(sent, [originalRaw]); assert.equal(store.journals().length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  assert.equal(store.get(secondId)!.status, 'queued'); assert.equal(store.get(secondId)!.raw_tx, null);
  assert.equal(preflights, 2); assert.equal(populated, 0); assert.equal(signed, 0);
});

for (const status of [0, 1]) test('receipt-present status ' + status + ' retains prior confirmation without an envelope retry', async () => {
  // A synthetic coherent receipt isolates branch selection; it is not proof
  // that an unrelated transaction can actually emit this event on chain.
  replaceEnvelope(await sign({ chainId: 1, to: otherSigner.address, data: '0x12345678' }));
  const raw = store.get(firstId)!.raw_tx;
  receipt = coherentReceipt(status);
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.deepEqual(sent, []); assert.equal(receiptReads.length, 1);
  assert.equal(store.get(firstId)!.raw_tx, raw);
  assert.equal(store.get(firstId)!.status, status === 1 ? 'settled' : 'failed');
  assert.equal(store.journals().length, status === 1 ? 1 : 0);
  assert.equal(preflights, 1); assert.equal(signed, 0);
});
