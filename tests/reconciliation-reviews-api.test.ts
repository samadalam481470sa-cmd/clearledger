import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Interface, type JsonRpcProvider } from 'ethers';
import { makeServer } from '../src/http.ts';
import { digest, domain, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { fixtureRelayer, settleAbi, signedSettlement } from './fixtures/signed-settlement.ts';

// Real authenticated HTTP and SQLite with synthetic receipt/canonical evidence.
// The signed envelopes are real; these fixtures do not execute an EVM transaction.
const apiKey = 'reconciliation-reviews-' + 'a'.repeat(32);
const payer = '0x' + '11'.repeat(20), payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20), routerAddress = '0x' + '44'.repeat(20);
const blockHash = '0x' + '55'.repeat(32), replacementHash = '0x' + '66'.repeat(32);
const signingDomain = domain(31337, routerAddress);
const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer, payee, token,
  amount: '125000000', nonce: '0', deadline: '2000000000' };
const { raw, hash: txHash } = signedSettlement(payment, '0x01', routerAddress, 0);
const iface = new Interface([
  settleAbi,
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const receipt = { hash: txHash, from: fixtureRelayer.address, to: routerAddress,
  index: 0, status: 1, blockNumber: 17, blockHash, logs: [
    { address: routerAddress, transactionHash: txHash, transactionIndex: 0, blockNumber: 17, blockHash,
      ...iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
        [payment.paymentId, payer, payee, token, payment.amount, payment.nonce]) }
  ] };
const countQuery = /SELECT\s+COUNT\s*\(\s*\*\s*\).*\bpayments\b/i;

async function within<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Review-count HTTP operation timed out')), 4000);
    })]);
  } finally { clearTimeout(timer); }
}
async function fixture(reviews: number, settled: boolean,
  run: (context: Awaited<ReturnType<typeof createContext>>) => Promise<void>) {
  const context = await createContext(reviews, settled);
  try { await run(context); }
  finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    let drained = false;
    await cleanup(() => within(context.server.drainRequests().then(() => { drained = true; })));
    await cleanup(() => within(Promise.allSettled(context.requests)));
    await cleanup(() => context.server.closeAllConnections());
    if (context.server.listening) await cleanup(() => within(new Promise<void>((resolveClose, rejectClose) =>
      context.server.close(error => error ? rejectClose(error) : resolveClose()))));
    if (drained) await cleanup(() => context.store.close());
    else failures.push(new Error('SQLite retained because review-count handlers did not finish'));
    if (failures.length) throw new AggregateError(failures, 'Review-count HTTP cleanup failed');
  }
}
async function createContext(reviewRows: number, withSettled: boolean) {
  const store = new Store();
  let paymentId: string | undefined;
  if (withSettled) {
    paymentId = store.accept(payment, digest(payment, signingDomain), '0x01').row.id;
    store.broadcast(paymentId, raw, txHash);
    store.finalize(paymentId, 17, blockHash);
  }
  const previousReviewIds: string[] = [];
  for (let index = 1; index <= reviewRows; index++) {
    const prior = { ...payment, paymentId: '0x' + index.toString(16).padStart(64, '0'), nonce: String(index) };
    const reservation = signedSettlement(prior, '0x01', routerAddress, index);
    const key = store.accept(prior, digest(prior, signingDomain), '0x01').row.id;
    store.broadcast(key, reservation.raw, reservation.hash);
    if (index % 2 === 0) store.finalize(key, 17, blockHash);
    store.setStatus(key, 'review', 'Prior synthetic integrity review');
    previousReviewIds.push(key);
  }
  const queries: string[] = [];
  const prepare = store.db.prepare.bind(store.db);
  let failCount = false, failedCountQueries = 0;
  store.db.prepare = sql => {
    queries.push(sql);
    if (failCount && countQuery.test(sql)) {
      failedCountQueries++;
      throw Object.assign(new Error('PRIVATE_REVIEW_COUNT_DATABASE_SENTINEL'), {
        code: 'ERR_SQLITE_ERROR', shortMessage: 'PRIVATE_SIGNED_TRANSACTION_SENTINEL',
        sql: 'SELECT PRIVATE_REVIEW_COUNT_SQL_SENTINEL'
      });
    }
    return prepare(sql);
  };
  let contradictory = false, receiptReads = 0, blockReads = 0;
  const provider = {
    getTransactionReceipt: async (hash: string) => {
      receiptReads++;
      assert.equal(hash, txHash, 'Existing review rows must not reach receipt RPC');
      return receipt;
    },
    getBlock: async (height: number) => {
      blockReads++;
      assert.equal(height, 17);
      return { number: 17, hash: contradictory ? replacementHash : blockHash,
        transactions: contradictory ? [] : [txHash] };
    }
  };
  const router = { interface: iface, connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, fixtureRelayer,
    router, 31337, routerAddress);
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
    void pending.catch(() => {});
    requests.push(pending);
    return pending;
  }
  function snapshot() {
    return {
      schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
      payments: store.db.prepare('SELECT rowid,* FROM payments ORDER BY rowid').all(),
      journals: store.db.prepare('SELECT rowid,* FROM journals ORDER BY rowid').all(),
      audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
      sequence: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
      // HTTP handlers and this observer use the same native connection.
      changes: store.db.prepare('SELECT total_changes() AS count').get()!.count
    };
  }
  return { store, paymentId, previousReviewIds, server, requests, post, snapshot, queries,
    counts: () => ({ receiptReads, blockReads, failedCountQueries }),
    contradict() { contradictory = true; },
    heal() { contradictory = false; failCount = false; },
    failFinalCount() { failCount = true; } };
}
function report(body: any, checked: number, exceptions: string[], outstandingReviews: number) {
  assert.equal(body.checked, checked);
  assert.deepEqual(body.exceptions, exceptions);
  assert.equal(body.outstandingReviews, outstandingReviews);
  assert.equal(typeof body.at, 'string');
  assert.ok(Number.isFinite(Date.parse(body.at)));
}

test('HTTP reconciliation counts all prior reviews beyond one page while exceptions remain specific to the new scan', {
  timeout: 10000
}, async () => fixture(109, true, async context => {
  const before = context.snapshot(), priorRows = context.previousReviewIds.map(key => context.store.get(key));
  assert.equal(priorRows.length, 109);
  assert.ok(priorRows.some(row => row!.block_number === null), 'Unposted reviews must contribute to the count');
  assert.ok(priorRows.some(row => row!.block_number === 17), 'Journaled reviews must contribute to the count');
  const queriesBeforeDenied = context.queries.length;
  const denied = await within(context.post(false));
  assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'Bearer token required' });
  assert.equal(context.queries.length, queriesBeforeDenied, 'Authentication must precede every SQLite query');
  assert.deepEqual(context.counts(), { receiptReads: 0, blockReads: 0, failedCountQueries: 0 });

  const healthy = await within(context.post());
  assert.equal(healthy.status, 200);
  report(healthy.body, 1, [], 109);
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 1, failedCountQueries: 0 });
  assert.deepEqual(context.snapshot(), before, 'A healthy scan and global review count must not write SQLite');

  const original = context.store.get(context.paymentId!)!, journal = context.store.journal(context.paymentId!);
  context.contradict();
  const changed = await within(context.post());
  assert.equal(changed.status, 200);
  report(changed.body, 1, [context.paymentId!], 110);
  const reviewed = context.store.get(context.paymentId!)!;
  assert.equal(reviewed.status, 'review');
  assert.deepEqual(reviewed, { ...original, status: 'review', error: reviewed.error, updated_at: reviewed.updated_at });
  assert.ok(reviewed.error);
  assert.deepEqual(context.store.journal(context.paymentId!), journal);
  assert.deepEqual(context.previousReviewIds.map(key => context.store.get(key)), priorRows);
  const afterReview = context.snapshot();
  assert.deepEqual(afterReview.journals, before.journals);
  assert.equal(afterReview.audit.length, before.audit.length + 1);
  assert.deepEqual(afterReview.audit.slice(0, -1), before.audit);
  assert.equal(afterReview.audit.at(-1)!.payment_id, context.paymentId);
  assert.equal(afterReview.audit.at(-1)!.action, 'review');
  const afterReviewReads = context.counts();
  context.heal();
  const repeated = await within(context.post());
  assert.equal(repeated.status, 200);
  report(repeated.body, 0, [], 110);
  assert.deepEqual(context.counts(), afterReviewReads, 'Review-only reconciliation must issue no RPC queries');
  assert.deepEqual(context.snapshot(), afterReview, 'Repeated review counts must preserve exact rows, journals and audit');
}));

test('empty-store HTTP reconciliation returns zero outstanding reviews without RPC or writes', {
  timeout: 10000
}, async () => fixture(0, false, async context => {
  const before = context.snapshot();
  const response = await within(context.post());
  assert.equal(response.status, 200);
  report(response.body, 0, [], 0);
  assert.deepEqual(context.counts(), { receiptReads: 0, blockReads: 0, failedCountQueries: 0 });
  assert.deepEqual(context.snapshot(), before);
}));

test('a final review-count SQLite failure returns fixed HTTP 500 after retaining the earlier review commit', {
  timeout: 10000
}, async () => fixture(0, true, async context => {
  const original = context.store.get(context.paymentId!)!, journal = context.store.journal(context.paymentId!);
  const before = context.snapshot();
  context.contradict(); context.failFinalCount();
  const failed = await within(context.post());
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: 'Storage operation failed; check payment history before retrying' });
  for (const marker of ['PRIVATE_', 'ERR_SQLITE_ERROR', 'SELECT'])
    assert.ok(!failed.text.includes(marker), 'Final-count failure leaked private storage evidence');
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 1, failedCountQueries: 1 });
  const reviewed = context.store.get(context.paymentId!)!;
  assert.equal(reviewed.status, 'review');
  assert.deepEqual(reviewed, { ...original, status: 'review', error: reviewed.error, updated_at: reviewed.updated_at });
  assert.deepEqual(context.store.journal(context.paymentId!), journal);
  const afterFailure = context.snapshot();
  assert.equal(afterFailure.audit.length, before.audit.length + 1);
  assert.deepEqual(afterFailure.audit.slice(0, -1), before.audit);
  assert.equal(afterFailure.audit.at(-1)!.action, 'review');
  assert.deepEqual(afterFailure.journals, before.journals);
  context.heal();
  const repeated = await within(context.post());
  assert.equal(repeated.status, 200);
  report(repeated.body, 0, [], 1);
  assert.deepEqual(context.counts(), { receiptReads: 1, blockReads: 1, failedCountQueries: 1 });
  assert.deepEqual(context.snapshot(), afterFailure);
}));
