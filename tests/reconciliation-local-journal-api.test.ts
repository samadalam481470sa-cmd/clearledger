import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Interface, type JsonRpcProvider } from 'ethers';
import { makeServer } from '../src/http.ts';
import { digest, domain, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { withFixtureLogsBloom, fixtureRelayer, settleAbi, signedSettlement } from './fixtures/signed-settlement.ts';

// Real authenticated HTTP and SQLite; signed envelopes and receipt evidence are
// synthetic fixtures, without EVM execution or a deployed settlement network.
const apiKey = 'local-journal-reconcile-' + 'a'.repeat(32);
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + '55'.repeat(32);
const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer: '0x' + '11'.repeat(20),
  payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000',
  nonce: '0', deadline: '2000000000' };
const signingDomain = domain(31337, routerAddress), signature = '0x01';
const iface = new Interface([settleAbi,
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)']);
const reviewError = 'Recorded settlement no longer matches canonical receipt and journal';
async function within<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('local journal contradictions are reviewed during an RPC outage while coherent settlements remain retryable', {
  timeout: 15000
}, async t => {
  const store = new Store();
  function seed(p: Payment, nonce: number) {
    const reservation = signedSettlement(p, signature, routerAddress, nonce);
    const row = store.accept(p, digest(p, signingDomain), signature).row;
    store.broadcast(row.id, reservation.raw, reservation.hash);
    store.finalize(row.id, 17, blockHash);
    return { id: row.id, ...reservation };
  }
  function snapshot() {
    return JSON.parse(JSON.stringify({
      schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
      payments: store.db.prepare('SELECT rowid,* FROM payments ORDER BY rowid').all(),
      journals: store.db.prepare('SELECT rowid,* FROM journals ORDER BY rowid').all(),
      audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
      sequence: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
      changes: store.db.prepare('SELECT total_changes() AS n').get()!.n
    }));
  }
  const bad = seed(payment, 0);
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('125000001', bad.id);
  const healthyPayment = { ...payment, paymentId: '0x' + '78'.repeat(32), amount: '5000000', nonce: '1' };
  const healthyReservation = signedSettlement(healthyPayment, signature, routerAddress, 1);
  const healthyReceipt = withFixtureLogsBloom({ hash: healthyReservation.hash, type: 2,
    from: fixtureRelayer.address, to: routerAddress, index: 0, status: 1, blockNumber: 17, blockHash,
    gasUsed: 125_000n, gasPrice: 2n, cumulativeGasUsed: 125_000n, logs: [{ address: routerAddress,
      transactionHash: healthyReservation.hash, transactionIndex: 0, index: 0, blockNumber: 17, blockHash,
      ...iface.encodeEventLog(iface.getEvent('PaymentSettled')!, [healthyPayment.paymentId, healthyPayment.payer,
        healthyPayment.payee, healthyPayment.token, healthyPayment.amount, healthyPayment.nonce]) }] });
  let unavailable = true, receiptReads = 0, blockReads = 0;
  const provider = {
    getTransactionReceipt: async (hash: string) => {
      receiptReads++;
      if (unavailable) throw Object.assign(new Error('SYNTHETIC_PRIVATE_RPC_SENTINEL'), { code: 'NETWORK_ERROR' });
      assert.equal(hash, healthyReservation.hash);
      return healthyReceipt;
    },
    getBlock: async (height: number) => {
      blockReads++; assert.equal(height, 17);
      return { number: 17, hash: blockHash, timestamp: 1_800_000_000, baseFeePerGas: 1n,
        gasUsed: 125_000n, gasLimit: 30_000_000n, transactions: [healthyReservation.hash] };
    }
  };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, fixtureRelayer,
    { interface: iface, connect() { return this; } }, 31337, routerAddress);
  const server = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  try {
    await within(once(server, 'listening'), 'HTTP readiness');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    async function reconcile() {
      const response = await fetch(origin + '/api/reconcile', { method: 'POST',
        signal: AbortSignal.timeout(3000), headers: { Authorization: 'Bearer ' + apiKey } });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    }
    function report(body: any, checked: number, exceptions: string[]) {
      assert.deepEqual(Object.keys(body).sort(), ['at', 'checked', 'exceptions', 'outstandingReviews']);
      assert.equal(body.checked, checked); assert.deepEqual(body.exceptions, exceptions);
      assert.equal(body.outstandingReviews, 1); assert.ok(Number.isFinite(Date.parse(body.at)));
    }
    const before = snapshot(), first = await within(reconcile(), 'Local contradiction review');
    assert.equal(first.status, 200); report(first.body, 1, [bad.id]);
    assert.equal(receiptReads, 0); assert.equal(blockReads, 0);
    const after = snapshot(), reviewed = store.get(bad.id)!;
    assert.deepEqual(after.schema, before.schema); assert.deepEqual(after.journals, before.journals);
    assert.deepEqual(after.payments, [{ ...before.payments[0], status: 'review', error: reviewError,
      updated_at: reviewed.updated_at }]);
    assert.equal(after.changes - before.changes, 2);
    assert.equal(after.audit.length, before.audit.length + 1);
    assert.deepEqual(after.audit.slice(0, -1), before.audit);
    assert.equal(after.audit.at(-1).payment_id, bad.id); assert.equal(after.audit.at(-1).action, 'review');
    assert.equal(after.audit.at(-1).detail, reviewError);
    assert.deepEqual(after.sequence, before.sequence.map((row: { name: string; seq: number }) =>
      row.name === 'audit' ? { ...row, seq: row.seq + 1 } : row));
    assert.ok(!first.text.includes(bad.raw));
    const repeat = await within(reconcile(), 'Repeat local review');
    assert.equal(repeat.status, 200); report(repeat.body, 0, []);
    assert.deepEqual(snapshot(), after); assert.equal(receiptReads, 0); assert.equal(blockReads, 0);

    const healthy = seed(healthyPayment, 1), beforeOutage = snapshot();
    const uncertain = await within(reconcile(), 'Coherent settlement during outage');
    assert.equal(uncertain.status, 503);
    assert.deepEqual(uncertain.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    assert.ok(!uncertain.text.includes('SYNTHETIC_PRIVATE_RPC_SENTINEL'));
    assert.deepEqual(snapshot(), beforeOutage); assert.equal(store.get(healthy.id)!.status, 'settled');
    assert.equal(receiptReads, 1); assert.equal(blockReads, 0);
    unavailable = false;
    const healed = await within(reconcile(), 'Healed coherent settlement');
    assert.equal(healed.status, 200); report(healed.body, 1, []);
    assert.deepEqual(snapshot(), beforeOutage); assert.equal(receiptReads, 2); assert.equal(blockReads, 1);
    t.diagnostic(JSON.stringify({ localReviewRpcReads: 0, newReviewAudits: 1, localReviewWrites: 2,
      coherentOutageStatus: 503, healedChecked: 1, outstandingReviews: 1, receiptReads, blockReads }));
  } finally {
    await within(server.drainRequests(), 'HTTP drain'); server.closeAllConnections();
    if (server.listening) await within(new Promise<void>(resolve => server.close(() => resolve())), 'HTTP close');
    store.close();
  }
});
