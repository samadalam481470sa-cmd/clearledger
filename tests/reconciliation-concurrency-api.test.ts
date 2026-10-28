import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

// Real authenticated HTTP and SQLite, with synthetic canonical receipt/log
// evidence. These checks do not execute EVM transactions or prove RPC transport.
const apiKey = 'reconciliation-concurrency-' + 'a'.repeat(32);
const payer = '0x' + '11'.repeat(20), payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20), routerAddress = '0x' + '44'.repeat(20);
const blockHash = '0x' + '55'.repeat(32), txHash = '0x' + '66'.repeat(32);
const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer, payee, token,
  amount: '125000000', nonce: '0', deadline: '2000000000' };
const iface = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const receipt = { hash: txHash, status: 1, blockNumber: 17, blockHash, logs: [
  { address: routerAddress, transactionHash: txHash, blockNumber: 17, blockHash,
    ...iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
      [payment.paymentId, payer, payee, token, payment.amount, payment.nonce]) }
] };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Reconciliation HTTP checkpoint timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(run: (context: Awaited<ReturnType<typeof createContext>>) => Promise<void>) {
  const context = await createContext();
  try { await run(context); }
  finally {
    // Release even after an assertion fails so no handler retains the SQLite
    // connection. Each client and checkpoint also has its own bounded deadline.
    context.gate.resolve(receipt);
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    let drained = false;
    const drain = context.server.drainRequests().then(() => { drained = true; });
    await cleanup(() => within(drain));
    await cleanup(() => within(Promise.allSettled(context.requests)));
    await cleanup(() => context.server.closeAllConnections());
    if (context.server.listening)
      await cleanup(() => within(new Promise<void>((resolveClose, rejectClose) =>
        context.server.close(error => error ? rejectClose(error) : resolveClose()))));
    if (drained) await cleanup(() => context.store.close());
    else failures.push(new Error('SQLite retained because reconciliation handlers did not finish'));
    if (failures.length) throw new AggregateError(failures, 'Reconciliation HTTP cleanup failed');
  }
}
async function createContext() {
  const store = new Store(), gate = deferred<typeof receipt>(), receiptEntered = deferred<void>();
  const paymentId = store.accept(payment, 'synthetic-fingerprint', 'synthetic-signature').row.id;
  store.broadcast(paymentId, 'synthetic-signed-bytes', txHash);
  store.finalize(paymentId, 17, blockHash);
  let hold = true, receiptReads = 0, blockReads = 0, invocations = 0;
  const callsEntered = Array.from({ length: 5 }, () => deferred<void>());
  const provider = {
    getTransactionReceipt: async () => {
      receiptReads++; receiptEntered.resolve();
      return hold ? gate.promise : receipt;
    },
    getBlock: async () => { blockReads++; return { number: 17, hash: blockHash }; }
  };
  const router = { interface: iface, connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    router, 31337, routerAddress);
  const results: Awaited<ReturnType<PaymentService['reconcile']>>[] = [];
  const reconcile = service.reconcile.bind(service);
  // Observe entry/returned values without replacing the scan, queue, or promise
  // behavior under test. This proves both HTTP handlers joined before release.
  service.reconcile = () => {
    callsEntered[invocations++]?.resolve();
    return reconcile().then(result => { results.push(result); return result; });
  };
  const server = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const requests: Promise<{ status: number; text: string; body: any }>[] = [];
  function post(authenticated = true) {
    const pending = (async () => {
      const response = await fetch(url + '/api/reconcile', {
        method: 'POST', signal: AbortSignal.timeout(5000), body: '{}',
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + apiKey } : {}) }
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    })();
    // Cleanup owns clients even if a preceding assertion fails before awaiting one.
    void pending.catch(() => {});
    requests.push(pending);
    return pending;
  }
  return { store, paymentId, gate, receiptEntered, callsEntered, server, requests, results, post,
    recover() { hold = false; }, counts: () => ({ receiptReads, blockReads, invocations }) };
}

test('two authorized HTTP callers share one held scan while authentication and fresh scans remain independent', {
  timeout: 10000
}, async () => fixture(async context => {
  const before = { row: context.store.get(context.paymentId), journal: context.store.journal(context.paymentId),
    audit: context.store.events() };
  const first = context.post();
  await within(context.receiptEntered.promise);
  const second = context.post();
  await within(context.callsEntered[1].promise);
  const denied = await within(context.post(false));
  assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'Bearer token required' });
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 0, invocations: 2 });
  context.gate.resolve(receipt);
  const [a, b] = await within(Promise.all([first, second]));
  for (const response of [a, b]) {
    assert.equal(response.status, 200); assert.equal(response.body.checked, 1);
    assert.deepEqual(response.body.exceptions, []);
  }
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 1, invocations: 2 });
  assert.equal(context.results.length, 2);
  assert.notEqual(context.results[0], context.results[1]);
  assert.notEqual(context.results[0].exceptions, context.results[1].exceptions);
  context.results[0].exceptions.push('caller-local-edit');
  assert.deepEqual(context.results[1].exceptions, []);
  assert.deepEqual({ row: context.store.get(context.paymentId), journal: context.store.journal(context.paymentId),
    audit: context.store.events() }, before);

  // A later completed request must inspect new evidence rather than reuse its
  // preceding result. Corrupt only the synthetic projection after both finish.
  context.store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('1', context.paymentId);
  context.recover();
  const fresh = await within(context.post());
  assert.equal(fresh.status, 200); assert.equal(fresh.body.checked, 1);
  assert.deepEqual(fresh.body.exceptions, [context.paymentId]);
  assert.deepEqual(context.counts(), { receiptReads: 2, blockReads: 2, invocations: 3 });
  assert.equal(context.store.get(context.paymentId)!.status, 'review');
  assert.equal(context.store.journal(context.paymentId)!.amount, '1');
  assert.equal(context.store.events().filter(event => event.action === 'review').length, 1);
}));

test('a shared RPC failure returns fixed 503 to every caller without review and permits a fresh successful scan', {
  timeout: 10000
}, async () => fixture(async context => {
  const before = { row: context.store.get(context.paymentId), journal: context.store.journal(context.paymentId),
    audit: context.store.events() };
  const first = context.post();
  await within(context.receiptEntered.promise);
  const second = context.post();
  await within(context.callsEntered[1].promise);
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 0, invocations: 2 });
  context.gate.reject(Object.assign(new Error('PRIVATE_RPC_CREDENTIAL_SENTINEL'), {
    code: 'TIMEOUT', shortMessage: 'PRIVATE_SIGNED_TRANSACTION_SENTINEL',
    info: { url: 'https://synthetic-secret@rpc.invalid', body: 'PRIVATE_RPC_INFO_SENTINEL' }
  }));
  const responses = await within(Promise.all([first, second]));
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    for (const marker of ['PRIVATE_', 'synthetic-secret', 'rpc.invalid', 'TIMEOUT'])
      assert.ok(!response.text.includes(marker), 'Shared failure leaked synthetic internal RPC evidence');
  }
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 0, invocations: 2 });
  assert.equal(context.results.length, 0);
  assert.deepEqual({ row: context.store.get(context.paymentId), journal: context.store.journal(context.paymentId),
    audit: context.store.events() }, before);
  context.recover();
  const retried = await within(context.post());
  assert.equal(retried.status, 200); assert.equal(retried.body.checked, 1);
  assert.deepEqual(retried.body.exceptions, []);
  assert.deepEqual(context.counts(), { receiptReads: 2, blockReads: 1, invocations: 3 });
  assert.deepEqual({ row: context.store.get(context.paymentId), journal: context.store.journal(context.paymentId),
    audit: context.store.events() }, before);
}));

test('HTTP drain waits for both callers sharing a paused reconciliation and refuses new work', {
  timeout: 10000
}, async () => fixture(async context => {
  const first = context.post();
  await within(context.receiptEntered.promise);
  const second = context.post();
  await within(context.callsEntered[1].promise);
  let drained = false;
  const draining = context.server.drainRequests().then(() => { drained = true; });
  const denied = await within(context.post());
  assert.equal(denied.status, 503); assert.deepEqual(denied.body, { error: 'Service is shutting down' });
  assert.equal(drained, false, 'Refusing a new request must not finish existing RPC-dependent handlers');
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 0, invocations: 2 });
  context.gate.resolve(receipt);
  const responses = await within(Promise.all([first, second]));
  await within(draining);
  assert.equal(drained, true);
  for (const response of responses) {
    assert.equal(response.status, 200); assert.equal(response.body.checked, 1);
    assert.deepEqual(response.body.exceptions, []);
  }
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 1, invocations: 2 });
  assert.equal(context.store.get(context.paymentId)!.status, 'settled');
  assert.equal(context.store.events().filter(event => event.action === 'review').length, 0);
}));
