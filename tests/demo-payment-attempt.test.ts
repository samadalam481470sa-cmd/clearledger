import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { getAddress, verifyTypedData, Wallet, type JsonRpcProvider } from 'ethers';
import { createDemoPaymentSubmitter } from '../scripts/demo-payment.ts';
import { makeServer } from '../src/http.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { demoPaymentSnapshot, newDemoPaymentAttempt, paymentLookupPath, requestDemoPayment } from '../web/payment-lookup.ts';

const payerAddress = '0x' + 'a1'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const routerAddress = '0x' + '44'.repeat(20);
const amount = '0000001.250000';
const fillRandom = (bytes: Uint8Array) => {
  assert.equal(bytes.length, 32);
  bytes.forEach((_, index) => { bytes[index] = index; });
};

test('a new demo attempt retains the original amount and its canonical payment identity', () => {
  const attempt = newDemoPaymentAttempt(amount, getAddress(payerAddress), fillRandom);
  const paymentId = '0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
  assert.deepEqual(attempt, { request: { amount, paymentId }, recordId: payerAddress + ':' + paymentId });
  const next = newDemoPaymentAttempt(amount, payerAddress, bytes => { bytes.fill(255); });
  assert.equal(next.request.paymentId, '0x' + 'ff'.repeat(32));
  assert.notEqual(next.recordId, attempt.recordId);
});

test('a demo attempt requires a valid payer, decimal amount and nonzero payment ID', () => {
  for (const payer of [undefined, '', '0x' + 'ab'.repeat(19), '0x' + 'xz'.repeat(20), '0x' + '00'.repeat(20)])
    assert.throws(() => newDemoPaymentAttempt(amount, payer, fillRandom));
  for (const value of ['0.000000', '1e2', '1.2500000', '12345678', ' 1.25', '1.25\n'])
    assert.throws(() => newDemoPaymentAttempt(value, payerAddress, fillRandom));
  assert.throws(() => newDemoPaymentAttempt(amount, payerAddress, bytes => { bytes.fill(0); }));
});

test('a demo acknowledgement must name the original attempt even when every transfer field agrees', () => {
  const attempt = newDemoPaymentAttempt(amount, payerAddress, fillRandom);
  const context = { payer: payerAddress, payee, token, recordId: attempt.recordId };
  const now = new Date('2026-11-15T21:16:00.000Z');
  const row = {
    id: attempt.recordId, status: 'queued', tx_hash: null, block_number: null, error: null,
    created_at: now.toISOString(),
    payment: { payer: payerAddress, payee, token, paymentId: attempt.request.paymentId,
      amount: '1250000', nonce: '0', deadline: '1800000000' }
  };
  assert.deepEqual(demoPaymentSnapshot({ payment: row }, attempt.request.amount, context, now),
    { row, capturedAt: now.toISOString() });
  const otherId = '0x' + 'ff'.repeat(32);
  const wrong = { ...row, id: payerAddress + ':' + otherId, payment: { ...row.payment, paymentId: otherId } };
  assert.throws(() => demoPaymentSnapshot({ payment: wrong }, attempt.request.amount, context, now));
});

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

test('a demo response deadline bounds a transport that ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = newDemoPaymentAttempt(amount, payerAddress, fillRandom);
  const parent = new AbortController();
  const lateReply = gate();
  let childSignal: AbortSignal | undefined;
  const pending = requestDemoPayment(attempt, async (body, signal) => {
    assert.equal(body, attempt.request);
    childSignal = signal;
    await lateReply.waiting;
    return { payment: 'late response' };
  }, parent.signal, 20);
  const rejected = assert.rejects(pending, { message: 'Payment response timed out' });
  try {
    await Promise.resolve();
    t.mock.timers.tick(20);
    await rejected;
    assert.equal(childSignal?.aborted, true);
    assert.equal(parent.signal.aborted, false);
  } finally { lateReply.release(); }
});

test('a pending demo request propagates its parent cancellation reason', async () => {
  const attempt = newDemoPaymentAttempt(amount, payerAddress, fillRandom);
  const parent = new AbortController();
  const cancelled = new Error('Connection changed');
  const lateReply = gate();
  let childSignal: AbortSignal | undefined;
  const pending = requestDemoPayment(attempt, async (_body, signal) => {
    childSignal = signal;
    await lateReply.waiting;
  }, parent.signal);
  const rejected = assert.rejects(pending, reason => reason === cancelled);
  try {
    await Promise.resolve();
    parent.abort(cancelled);
    await rejected;
    assert.equal(childSignal?.reason, cancelled);
  } finally { lateReply.release(); }
});

test('a completed demo request detaches its parent and clears its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempt = newDemoPaymentAttempt(amount, payerAddress, fillRandom);
  const parent = new AbortController();
  const expected = { payment: 'completed response' };
  let childSignal: AbortSignal | undefined;
  const result = await requestDemoPayment(attempt, async (_body, signal) => {
    childSignal = signal;
    return expected;
  }, parent.signal, 20);
  assert.equal(result, expected);
  parent.abort();
  t.mock.timers.tick(20);
  assert.equal(childSignal?.aborted, false);
});

// Exercise the dashboard request, native HTTP and the real submitter/Store.
// The synthetic provider and no-dispatch tick isolate the admission/replay boundary.
test('the same demo attempt replays its queued record after the first response times out', {
  timeout: 10000
}, async t => {
  const apiKey = 'demo-attempt-test';
  const payer = new Wallet(Wallet.createRandom().privateKey);
  const store = new Store();
  let latestReads = 0, nonceReads = 0, signatureChecks = 0, signatures = 0, ticks = 0;
  const provider = {
    async getBlock() {
      latestReads++;
      return { timestamp: 1_800_000_000 };
    }
  } as unknown as JsonRpcProvider;
  const router = {
    connect() { return this; },
    async nonces() { nonceReads++; return 0n; },
    isValidPaymentSignature: {
      async staticCall(payment: Payment, signature: string): Promise<boolean> {
        signatureChecks++;
        return verifyTypedData(service.signingDomain, paymentTypes, payment, signature) === payer.address;
      }
    }
  };
  const service = new PaymentService(store, provider, payer, router, 31337, routerAddress);
  service.tick = async () => { ticks++; };
  const sign = payer.signTypedData.bind(payer);
  payer.signTypedData = async (...args) => { signatures++; return sign(...args); };
  const attempt = newDemoPaymentAttempt(amount, payer.address, fillRandom);
  const submit = createDemoPaymentSubmitter(service, payer, payee, token);
  const committed = gate(), releaseReply = gate();
  let requests = 0;
  const server = makeServer({ service, apiKey, port: 0, mode: 'demo',
    async demoPayment(amount, paymentId) {
      assert.deepEqual({ amount, paymentId }, attempt.request);
      const request = ++requests;
      const result = await submit(amount, paymentId);
      if (request === 1) {
        assert.equal(result.replay, false);
        committed.release();
        await releaseReply.waiting;
      }
      return result;
    }
  });
  const controller = new AbortController();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/';
    const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
    const post = (body: typeof attempt.request, signal: AbortSignal) => fetch(url + 'demo/payment', {
      method: 'POST', headers, body: JSON.stringify(body), signal
    });
    const deadlineMs = 1500;
    const first = requestDemoPayment(attempt, async (body, signal) => {
      const response = await post(body, signal);
      return response.json();
    }, controller.signal, deadlineMs);
    await Promise.race([committed.waiting,
      first.then(() => assert.fail('The first response escaped the commit gate'))]);

    const queued = store.get(attempt.recordId);
    assert.ok(queued);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.raw_tx, null);
    const audit = store.events();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'accepted');
    const writes = () => store.db.prepare('SELECT total_changes() AS count').get();
    const afterAdmission = writes();
    await assert.rejects(first, { message: 'Payment response timed out' });
    assert.equal(controller.signal.aborted, false);
    releaseReply.release();

    let retryStatus: number | undefined;
    const replay = await requestDemoPayment(attempt, async (body, signal) => {
      const response = await post(body, signal);
      retryStatus = response.status;
      return response.json();
    }, controller.signal, 5000);
    assert.equal(retryStatus, 200);
    assert.ok(replay && typeof replay === 'object' && 'replay' in replay);
    assert.equal(replay.replay, true);
    const context = { payer: payer.address, payee, token, recordId: attempt.recordId };
    const snapshot = demoPaymentSnapshot(replay, attempt.request.amount, context);
    assert.deepEqual(snapshot.row, service.publicRow(queued));

    const exact = await fetch(url + paymentLookupPath(attempt.recordId), { headers, signal: AbortSignal.timeout(5000) });
    assert.equal(exact.status, 200);
    assert.deepEqual(await exact.json(), snapshot.row);
    assert.equal(requests, 2);
    assert.deepEqual(store.list(), [queued]);
    assert.deepEqual(store.events(), audit);
    assert.deepEqual(store.journals(), []);
    assert.deepEqual(writes(), afterAdmission);
    assert.deepEqual({ latestReads, nonceReads, signatureChecks, signatures, ticks },
      { latestReads: 2, nonceReads: 1, signatureChecks: 1, signatures: 1, ticks: 1 });
    t.diagnostic(JSON.stringify({ firstResponseTimedOut: true, deadlineMs, retryStatus,
      storedRows: 1, acceptedAudits: 1, extraReads: 0, extraSignatures: 0, extraWrites: 0 }));
  } finally {
    controller.abort();
    releaseReply.release();
    await server.drainRequests();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    store.close();
  }
});
