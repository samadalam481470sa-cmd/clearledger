import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { type Payment } from '../src/payment.ts';

// Controlled SQLite/provider evidence, not executed EVM transfers.
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const iface = new Interface(['event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)']);
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
let store: Store, payments: Map<string, Payment>, reads: number, blockReads: number, pages: number;
beforeEach(() => {
  store = new Store(); payments = new Map(); reads = 0; blockReads = 0; pages = 0;
  const original = store.pagePayments.bind(store);
  store.pagePayments = options => { pages++; return original(options); };
});
afterEach(() => { store.close(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function seed(n: number) {
  const p: Payment = { paymentId: hash(n), payer: '0x' + '11'.repeat(20), payee: '0x' + '22'.repeat(20),
    token: '0x' + '33'.repeat(20), amount: '125000000', nonce: String(n - 1), deadline: '2000000000' };
  const id = store.accept(p, 'synthetic-fingerprint-' + n, 'synthetic-signature').row.id;
  const tx = hash(1000 + n); payments.set(tx, p);
  store.broadcast(id, 'synthetic-raw', tx); store.finalize(id, 17, blockHash);
  return id;
}
function receipt(tx: string) {
  const p = payments.get(tx)!;
  const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
    [p.paymentId, p.payer, p.payee, p.token, p.amount, p.nonce]);
  return { hash: tx, status: 1, blockNumber: 17, blockHash,
    logs: [{ address: routerAddress, ...log, transactionHash: tx, blockHash, blockNumber: 17 }] };
}
function service(read: (tx: string) => Promise<unknown>) {
  const provider = { getTransactionReceipt: async (tx: string) => { reads++; return read(tx); },
    getBlock: async () => { blockReads++; return { number: 17, hash: blockHash }; } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    { interface: iface, connect() { return this; } }, 31337, routerAddress);
}
function snapshot() {
  return JSON.stringify({ rows: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    audit: store.events(), journals: store.journals() });
}

test('concurrent callers share one traversal but receive independent result objects and exception arrays', async () => {
  seed(1); const entered = deferred<void>(), gate = deferred<void>();
  const worker = service(async tx => { entered.resolve(); await gate.promise; return receipt(tx); });
  const before = snapshot(), pending = [worker.reconcile(), worker.reconcile(), worker.reconcile()];
  try {
    await entered.promise; assert.equal(reads, 1); assert.equal(pages, 1); gate.resolve();
    const [first, second, third] = await Promise.all(pending);
    assert.deepEqual(first, second); assert.deepEqual(second, third);
    assert.notEqual(first, second); assert.notEqual(first.exceptions, second.exceptions);
    first.exceptions.push('caller-local edit'); first.checked = 999;
    assert.equal(second.checked, 1); assert.deepEqual(second.exceptions, []); assert.deepEqual(third.exceptions, []);
    assert.equal(reads, 1); assert.equal(blockReads, 1); assert.equal(snapshot(), before);
    const next = await worker.reconcile();
    assert.equal(next.checked, 1); assert.deepEqual(next.exceptions, []); assert.equal(reads, 2); assert.equal(pages, 2);
  } finally { gate.resolve(); await Promise.allSettled(pending); }
});

test('shared RPC failure reaches every waiter without false review and the next call retries fresh', async () => {
  seed(1); const entered = deferred<void>(), gate = deferred<void>(), fault = new Error('Controlled RPC failure');
  let failing = true;
  const worker = service(async tx => { if (failing) { entered.resolve(); await gate.promise; throw fault; } return receipt(tx); });
  const before = snapshot(), pending = [worker.reconcile(), worker.reconcile()];
  const outcomes = Promise.allSettled(pending);
  try {
    await entered.promise; assert.equal(reads, 1); gate.resolve();
    for (const result of await outcomes) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, fault); }
    assert.equal(snapshot(), before); assert.equal(blockReads, 0);
    failing = false; const result = await worker.reconcile();
    assert.equal(result.checked, 1); assert.deepEqual(result.exceptions, []); assert.equal(reads, 2);
  } finally { gate.resolve(); await outcomes; }
});

test('a synchronous pre-await Store failure is shared and cannot poison future reconciliation', async () => {
  seed(1); const original = store.pagePayments, fault = new Error('Controlled page failure');
  let failedPages = 0;
  store.pagePayments = () => { failedPages++; throw fault; };
  const worker = service(async tx => receipt(tx)), before = snapshot();
  const results = await Promise.allSettled([worker.reconcile(), worker.reconcile(), worker.reconcile()]);
  assert.equal(failedPages, 1); assert.equal(reads, 0); assert.equal(snapshot(), before);
  for (const result of results) { assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, fault); }
  store.pagePayments = original;
  assert.equal((await worker.reconcile()).checked, 1); assert.equal(reads, 1);
});

test('a shared failed scan retains earlier review commits and a later scan starts with remaining settled rows', async () => {
  const oldest = seed(1), reviewed = seed(2), entered = deferred<void>(), gate = deferred<void>();
  const fault = new Error('Controlled later RPC failure'); let failing = true;
  const worker = service(async tx => {
    if (failing && tx === hash(1002)) return null;
    if (failing) { entered.resolve(); await gate.promise; throw fault; }
    return receipt(tx);
  });
  const pending = [worker.reconcile(), worker.reconcile()], outcomes = Promise.allSettled(pending);
  try {
    await entered.promise; assert.equal(store.get(reviewed)!.status, 'review'); assert.equal(store.get(oldest)!.status, 'settled');
    gate.resolve(); for (const result of await outcomes) assert.equal(result.status, 'rejected');
    assert.equal(store.events().filter(event => event.action === 'review').length, 1); assert.equal(store.journals().length, 2);
    failing = false; const next = await worker.reconcile();
    assert.equal(next.checked, 1); assert.deepEqual(next.exceptions, []); assert.equal(reads, 3);
    assert.equal(store.get(reviewed)!.status, 'review'); assert.equal(store.events().filter(event => event.action === 'review').length, 1);
  } finally { gate.resolve(); await outcomes; }
});

test('mid-scan joiners inherit the original insertion boundary across pages and completion is not cached', async () => {
  for (let n = 1; n <= 102; n++) seed(n);
  const entered = deferred<void>(), gate = deferred<void>(); let held = false;
  const worker = service(async tx => { if (!held) { held = true; entered.resolve(); await gate.promise; } return receipt(tx); });
  const first = worker.reconcile(); const pending = [first];
  try {
    await entered.promise; seed(103); pending.push(worker.reconcile(), worker.reconcile()); gate.resolve();
    for (const result of await Promise.all(pending)) { assert.equal(result.checked, 102); assert.deepEqual(result.exceptions, []); }
    assert.equal(reads, 102); assert.equal(pages, 2);
    const next = await worker.reconcile(); assert.equal(next.checked, 103); assert.equal(reads, 205); assert.equal(pages, 4);
  } finally { gate.resolve(); await Promise.allSettled(pending); }
});

test('separate service instances remain separate scans rather than pretending to provide a global lease', async () => {
  seed(1); const entered = deferred<void>(), gate = deferred<void>();
  const read = async (tx: string) => { if (reads === 2) entered.resolve(); await gate.promise; return receipt(tx); };
  const first = service(read), second = service(read);
  const pending = [first.reconcile(), first.reconcile(), second.reconcile(), second.reconcile()];
  try { await entered.promise; assert.equal(reads, 2); gate.resolve();
    for (const result of await Promise.all(pending)) assert.equal(result.checked, 1);
    assert.equal(reads, 2); assert.equal(blockReads, 2);
  } finally { gate.resolve(); await Promise.allSettled(pending); }
});

test('provider reentry before its first await joins the assigned pass without starting another traversal', async () => {
  seed(1); let nested: ReturnType<PaymentService['reconcile']> | undefined;
  const worker = service(async tx => { if (!nested) nested = worker.reconcile(); return receipt(tx); });
  const outer = await worker.reconcile(); assert.ok(nested);
  const inner = await nested; assert.equal(reads, 1); assert.deepEqual(inner, outer); assert.notEqual(inner, outer);
});
