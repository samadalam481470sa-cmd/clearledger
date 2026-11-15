import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { compile } from '../scripts/compile.ts';
import { createDemoPaymentSubmitter } from '../scripts/demo-payment.ts';
import { localChain } from '../scripts/local-chain.ts';
import { makeServer } from '../src/http.ts';
import { paymentKey } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const apiKey = 'demo-replay-test-' + 'a'.repeat(32);
const paymentId = '0x' + 'ab'.repeat(32);

async function withDemoServer(
  service: PaymentService, demoPayment: NonNullable<Parameters<typeof makeServer>[0]['demoPayment']>,
  run: (url: string) => Promise<void>
) {
  const server = makeServer({ service, apiKey, port: 0, mode: 'demo', demoPayment });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await run('http://127.0.0.1:' + (server.address() as { port: number }).port);
  } finally {
    await server.drainRequests();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
  }
}

async function request(url: string, path: string, body?: unknown) {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('demo HTTP forwards a normalized caller ID and returns the callback replay status', { timeout: 10000 }, async t => {
  const calls: [string, string | undefined][] = [];
  const demoPayment = async (amount: string, key?: string) => {
    calls.push([amount, key]);
    return { payment: { marker: 'demo fixture' }, replay: key !== undefined };
  };
  await withDemoServer({ chainId: 31337 } as PaymentService, demoPayment, async url => {
    const replay = await request(url, '/api/demo/payment', { amount: '1.250', paymentId: '0x' + 'AB'.repeat(32) });
    t.diagnostic(JSON.stringify({ status: replay.status, forwardedId: calls[0]?.[1] ?? null }));
    assert.deepEqual(replay, { status: 200, body: { payment: { marker: 'demo fixture' }, replay: true } });
    assert.deepEqual(calls, [['1.250', paymentId]]);

    for (const badId of [null, 3, '0x' + 'ab'.repeat(31), '0x' + 'xz'.repeat(32), '0x' + '00'.repeat(32)]) {
      const refused = await request(url, '/api/demo/payment', { amount: '1.25', paymentId: badId });
      assert.equal(refused.status, 400);
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(await request(url, '/api/demo/payment', { amount: '1.25' }),
      { status: 202, body: { payment: { marker: 'demo fixture' }, replay: false } });
    assert.deepEqual(calls[1], ['1.25', undefined]);
  });
});

test('demo payment replay preserves an accepted intent through a failed reservation and genuine settlement', {
  timeout: 45000
}, async t => {
  compile();
  const chain = await localChain();
  const store = new Store();
  try {
    const token = await chain.token.getAddress();
    const router = await chain.router.getAddress();
    const service = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, router);
    const submitDemo = createDemoPaymentSubmitter(service, chain.payer, chain.payee.address, token);
    const initialNonce = await chain.provider.getTransactionCount(chain.relayer.address);
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    const initialPayeeBalance = await chain.token.balanceOf(chain.payee.address);
    const key = paymentKey({ payer: chain.payer.address, paymentId });
    let rpcCalls = 0, nativeSends = 0, signatures = 0;
    const send = chain.provider.send.bind(chain.provider);
    chain.provider.send = async (method, params) => {
      rpcCalls++;
      if (method === 'eth_sendRawTransaction') nativeSends++;
      return send(method, params);
    };
    const sign = chain.payer.signTypedData.bind(chain.payer);
    chain.payer.signTypedData = async (...args) => { signatures++; return sign(...args); };
    const snapshot = () => ({ payments: store.list(), audit: store.events(), journals: store.journals(),
      changes: store.db.prepare('SELECT total_changes() AS count').get() });
    const post = (url: string, amount: string, id = paymentId) =>
      request(url, '/api/demo/payment', { amount, paymentId: id });

    // The accept commits before settlement preparation. Simulate a local
    // write failure that rolls back reservation and audit, keeping that intent.
    store.db.exec("CREATE TRIGGER fail_demo_reservation BEFORE INSERT ON audit WHEN NEW.action='broadcast-prepared' BEGIN SELECT RAISE(ABORT,'fixture reservation fault'); END");
    await withDemoServer(service, submitDemo, async url => {
      const first = await post(url, '1.25');
      assert.deepEqual(first, { status: 500, body: { error: 'Storage operation failed; check payment history before retrying' } });
      const queued = store.get(key);
      assert.ok(queued);
      assert.equal(queued.status, 'queued');
      assert.equal(queued.raw_tx, null);
      assert.equal(queued.tx_hash, null);
      assert.equal(signatures, 1);
      assert.equal(nativeSends, 0);
      const accepted = snapshot();
      assert.deepEqual(accepted.payments, [queued]);
      assert.deepEqual(accepted.audit.map(event => event.action), ['accepted']);
      assert.deepEqual(accepted.journals, []);

      const callsAtReplay = rpcCalls;
      const replay = await post(url, '0000001.250000', '0x' + 'AB'.repeat(32));
      assert.deepEqual(replay, { status: 200, body: { replay: true, payment: service.publicRow(queued) } });
      const exact = await request(url, '/api/payments/' + encodeURIComponent(key));
      assert.deepEqual(exact, { status: 200, body: service.publicRow(queued) });
      assert.deepEqual(await post(url, '1.250001'), {
        status: 409, body: { error: 'Payment ID already has different instructions' }
      });
      assert.equal(rpcCalls, callsAtReplay);
      assert.equal(signatures, 1);
      assert.equal(nativeSends, 0);
      assert.deepEqual(snapshot(), accepted);

      store.db.exec('DROP TRIGGER fail_demo_reservation');
      await service.tick();
      const settled = store.get(key);
      assert.ok(settled);
      assert.equal(settled.status, 'settled');
      assert.equal(settled.signature, queued.signature);
      assert.equal(settled.fingerprint, queued.fingerprint);
      assert.equal(settled.payload, queued.payload);
      assert.equal(signatures, 1);
      assert.equal(nativeSends, 1);
      assert.equal(await chain.provider.getTransactionCount(chain.relayer.address), initialNonce + 1);
      assert.equal(await chain.router.nonces(chain.payer.address), 1n);
      assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - 1250000n);
      assert.equal(await chain.token.balanceOf(chain.payee.address), initialPayeeBalance + 1250000n);
      const completed = snapshot();
      assert.deepEqual(completed.audit.map(event => event.action).sort(), ['accepted', 'broadcast-prepared', 'settled']);
      assert.equal(completed.journals.length, 1);
      assert.equal(completed.journals[0].payment_id, key);
      assert.equal(completed.journals[0].amount, '1250000');
      assert.equal(completed.journals[0].tx_hash, settled.tx_hash);

      const callsAfterSettlement = rpcCalls;
      assert.deepEqual(await post(url, '1.250'), { status: 200, body: { replay: true, payment: service.publicRow(settled) } });
      assert.equal(rpcCalls, callsAfterSettlement);
      assert.equal(signatures, 1);
      assert.equal(nativeSends, 1);
      assert.deepEqual(snapshot(), completed);
      const reconciliation = await service.reconcile();
      assert.equal(reconciliation.checked, 1);
      assert.deepEqual(reconciliation.exceptions, []);

      const legacy = await request(url, '/api/demo/payment', { amount: '0.50' });
      assert.equal(legacy.status, 202);
      assert.equal(legacy.body.replay, false);
      assert.notEqual(legacy.body.payment.id, key);
      assert.equal(legacy.body.payment.payment.amount, '500000');
      assert.equal(legacy.body.payment.status, 'settled');
      assert.equal(signatures, 2);
      assert.equal(nativeSends, 2);
      assert.equal(store.journals().length, 2);
      t.diagnostic(JSON.stringify({ firstStatus: first.status, replayStatus: replay.status,
        conflicts: 1, postReplayRpcCalls: 0, retainedSettlements: completed.journals.length, legacyStatus: legacy.status }));
    });
  } finally {
    try { store.close(); } finally { await chain.close(); }
  }
});
