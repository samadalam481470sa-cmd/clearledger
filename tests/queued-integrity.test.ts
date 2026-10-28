import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { digest, domain, paymentSchema, type Payment } from '../src/payment.ts';

// Synthetic RPC controls isolate local queue checks, not cryptographic authorization.
const routerAddress = '0x' + '44'.repeat(20), hash = '0x' + 'aa'.repeat(32), blockHash = '0x' + 'bb'.repeat(32);
const signingDomain = domain(31337, routerAddress);
const invalidError = 'Stored queued authorization is invalid; verify the original authorization and chain history';
const blockedError = 'Queued payment contains transaction reservation data; inspect durable state';
const privateMarker = 'PRIVATE_QUEUED_EVIDENCE';
const unavailable = new Error('Controlled RPC unavailable');
const iface = new Interface(['event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)']);
let store: Store, service: PaymentService;
let preflights: Payment[], populated: number, signed: number, receipt: any;
beforeEach(() => {
  store = new Store(); preflights = []; populated = 0; signed = 0; receipt = null;
  const router = { interface: iface, connect() { return this; }, settle: {
    staticCall: async (p: Payment) => { preflights.push(p); throw unavailable; },
    populateTransaction: async () => { populated++; throw new Error('Unexpected population'); }
  } };
  const provider = { getTransactionReceipt: async () => receipt, getBlockNumber: async () => 17,
    getBlock: async () => ({ number: 17, hash: blockHash }), broadcastTransaction: async () => { throw unavailable; } };
  const relayer = { populateTransaction: async () => { populated++; throw new Error('Unexpected population'); },
    signTransaction: async () => { signed++; throw new Error('Unexpected signing'); } };
  service = new PaymentService(store, provider as unknown as JsonRpcProvider, relayer as unknown as Wallet,
    router, 31337, routerAddress);
});
afterEach(() => { store.close(); });
function payment(n = 1) {
  return paymentSchema.parse({ paymentId: n === 1 ? '0x' + 'ab'.repeat(32) : '0x' + n.toString(16).padStart(64, '0'),
    payer: '0x' + (n === 1 ? 'ab' : 'cd').repeat(20), payee: '0x' + '22'.repeat(20),
    token: '0x' + 'ef'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000000000' });
}
function queue(n = 1, signature = '0x1234') {
  const p = payment(n);
  return store.accept(p, digest(p, signingDomain), signature).row.id;
}
function snapshot() {
  return { rows: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    events: store.events(), journals: store.journals() };
}
function change(id: string, column: 'payload' | 'fingerprint' | 'signature', value: unknown) {
  store.db.prepare('UPDATE payments SET ' + column + '=? WHERE id=?').run(value as string, id);
}

const corruptions: [string, (id: string) => void][] = [
  ['invalid JSON', id => change(id, 'payload', privateMarker + '{')],
  ['null JSON', id => change(id, 'payload', 'null')],
  ['array JSON', id => change(id, 'payload', '[]')],
  ['invalid amount', id => change(id, 'payload', JSON.stringify({ ...payment(), amount: '1.5' }))],
  ['unknown payload field', id => change(id, 'payload', JSON.stringify({ ...payment(), secret: privateMarker }))],
  ['different payment ID', id => change(id, 'payload', JSON.stringify({ ...payment(), paymentId: payment(9).paymentId }))],
  ['different payer', id => change(id, 'payload', JSON.stringify(payment(2)))],
  ['noncanonical address', id => change(id, 'payload', JSON.stringify({ ...payment(), token: payment().token.toLowerCase() }))],
  ['noncanonical ID', id => change(id, 'payload', JSON.stringify({ ...payment(), paymentId: '0x' + 'AB'.repeat(32) }))],
  ['invalid fingerprint', id => change(id, 'fingerprint', privateMarker)],
  ['different fingerprint', id => change(id, 'fingerprint', hash)],
  ['different domain fingerprint', id => change(id, 'fingerprint', digest(payment(), domain(1, routerAddress)))],
  ['nonhex signature', id => change(id, 'signature', privateMarker)],
  ['odd signature', id => change(id, 'signature', '0x123')],
  ['oversized signature', id => change(id, 'signature', '0x' + '11'.repeat(4097))]
];
for (const [label, corrupt] of corruptions) test(label + ' unsent row fails locally and permits the next independent preflight', async () => {
  const first = queue(), second = queue(2); corrupt(first);
  const evidence = store.get(first)!;
  await assert.rejects(service.tick(), error => error === unavailable);
  const failed = store.get(first)!;
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, invalidError);
  for (const field of ['payload', 'signature', 'fingerprint', 'raw_tx', 'tx_hash'] as const)
    assert.ok(failed[field] === evidence[field], 'Isolation changed retained authorization evidence');
  assert.equal(preflights.length, 1); assert.deepEqual(preflights[0], payment(2));
  assert.equal(store.get(second)!.status, 'queued'); assert.equal(store.get(second)!.raw_tx, null);
  assert.equal(populated, 0); assert.equal(signed, 0); assert.equal(store.journals().length, 0);
  const failedEvents = store.events().filter(event => event.action === 'failed');
  assert.equal(failedEvents.length, 1); assert.equal(failedEvents[0].detail, invalidError);
  assert.ok(!JSON.stringify(failedEvents).includes(privateMarker));
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});

for (const signature of ['0x', '0xAB12', '0x' + '11'.repeat(4096)]) test('opaque signature length ' + (signature.length - 2) / 2 + ' still reaches router policy', async () => {
  const id = queue(1, signature);
  const before = snapshot();
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.deepEqual(snapshot(), before); assert.equal(preflights.length, 1);
  assert.equal(store.get(id)!.status, 'queued'); assert.equal(populated, 0); assert.equal(signed, 0);
});
test('JSON whitespace/key order and fingerprint hexadecimal case do not repair or reject canonical logical fields', async () => {
  const id = queue();
  change(id, 'payload', JSON.stringify(Object.fromEntries(Object.entries(payment()).reverse()), null, 2));
  change(id, 'fingerprint', '0x' + digest(payment(), signingDomain).slice(2).toUpperCase());
  const before = snapshot();
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.deepEqual(snapshot(), before); assert.deepEqual(preflights, [payment()]);
});
test('failed audit storage rolls back isolation and prevents any later preparation', async () => {
  const id = queue(); queue(2); change(id, 'payload', privateMarker);
  store.db.exec("CREATE TRIGGER deny_queue_failure BEFORE INSERT ON audit WHEN NEW.action='failed' BEGIN SELECT RAISE(ABORT,'controlled audit failure'); END");
  const before = snapshot();
  await assert.rejects(service.tick(), /controlled audit failure/);
  assert.deepEqual(snapshot(), before); assert.equal(preflights.length, 0); assert.equal(signed, 0);
  store.db.exec('DROP TRIGGER deny_queue_failure');
  await assert.rejects(service.tick(), error => error === unavailable);
  assert.equal(store.get(id)!.status, 'failed'); assert.equal(preflights.length, 1);
});
test('an unexpected domain hashing failure remains retryable without mislabeling stored data', async () => {
  queue();
  const before = snapshot();
  (service.signingDomain as { chainId: unknown }).chainId = NaN;
  await assert.rejects(service.tick());
  assert.deepEqual(snapshot(), before); assert.equal(preflights.length, 0);
});

for (const [raw, tx] of [[privateMarker, null], [null, hash], [privateMarker, hash], ['', null], [null, '']] as const) {
  for (const later of [false, true]) test('queued reservation fields block every new allocation, including ' + (later ? 'later' : 'first') + ' position: ' + String(raw !== null) + '/' + String(tx !== null), async () => {
    const first = queue(), second = queue(2), anomaly = later ? second : first;
    store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(raw, tx, anomaly);
    const before = snapshot();
    await assert.rejects(service.tick(), error => error instanceof Error && error.message === blockedError);
    await assert.rejects(service.tick(), error => error instanceof Error && error.message === blockedError);
    assert.deepEqual(snapshot(), before); assert.equal(preflights.length, 0);
    assert.equal(populated, 0); assert.equal(signed, 0);
  });
}
test('an older canonical broadcast can settle before queued reservation anomalies stop new allocation', async () => {
  const old = queue(); store.broadcast(old, 'synthetic-reserved-bytes', hash);
  const second = queue(2);
  store.db.prepare('UPDATE payments SET tx_hash=? WHERE id=?').run(hash, second);
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!, Object.values({
    paymentId: payment().paymentId, payer: payment().payer, payee: payment().payee,
    token: payment().token, amount: payment().amount, nonce: payment().nonce }));
  receipt = { hash, blockHash, blockNumber: 17, status: 1,
    logs: [{ address: routerAddress, ...log, transactionHash: hash, blockHash, blockNumber: 17 }] };
  await assert.rejects(service.tick(), error => error instanceof Error && error.message === blockedError);
  assert.equal(store.get(old)!.status, 'settled'); assert.equal(store.journals().length, 1);
  assert.equal(store.get(second)!.status, 'queued'); assert.equal(preflights.length, 0); assert.equal(signed, 0);
});
