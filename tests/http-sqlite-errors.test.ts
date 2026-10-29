import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Interface, Wallet, keccak256, type JsonRpcProvider } from 'ethers';
import { makeServer } from '../src/http.ts';
import { paymentKey, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

// Actual HTTP, SQLite triggers/transactions and offline envelope signing. Router
// authorization and execution evidence are synthetic: no EVM transfer is claimed.
const apiKey = 'http-sqlite-error-token-' + 'a'.repeat(32);
const privateMarker = 'PRIVATE_SQLITE_TRIGGER_DIAGNOSTIC_SENTINEL';
const fixed = { error: 'Storage operation failed; check payment history before retrying' };
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + '55'.repeat(32);
const payment: Payment = { paymentId: '0x' + '77'.repeat(32), payer: '0x' + '11'.repeat(20),
  payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000003600' };
const input = { payment, signature: '0x1234' };
const iface = new Interface([
  'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)',
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);

function fixture() {
  const store = new Store(), signer = Wallet.createRandom();
  const calls = { signatureViews: 0, preflights: 0, populations: 0, signings: 0, receiptReads: 0, sends: 0, demo: 0 };
  const nativeCodes: unknown[] = [];
  let receipt: any = null;
  const provider = {
    getBlock: async () => ({ number: 17, hash: blockHash, timestamp: 2000000000 }),
    getBlockNumber: async () => 17,
    getTransactionReceipt: async (hash: string) => { calls.receiptReads++; return receipt?.hash === hash ? receipt : null; },
    broadcastTransaction: async (raw: string) => {
      calls.sends++;
      const hash = keccak256(raw);
      const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
        [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
      receipt = { hash, blockNumber: 17, blockHash, status: 1,
        logs: [{ address: routerAddress, ...log, transactionHash: hash, blockNumber: 17, blockHash }] };
      return { hash };
    }
  };
  const router = { interface: iface, connect() { return this; },
    isValidPaymentSignature: { staticCall: async () => { calls.signatureViews++; return true; } },
    settle: {
      staticCall: async () => { calls.preflights++; },
      populateTransaction: async (p: Payment, signature: string) =>
        ({ to: routerAddress, value: 0n, data: iface.encodeFunctionData('settle', [p, signature]) })
    }
  };
  const relayer = { address: signer.address,
    populateTransaction: async (request: any) => {
      calls.populations++;
      return { ...request, type: 2, chainId: 31337, nonce: 0, gasLimit: 250000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n };
    },
    signTransaction: async (request: any) => { calls.signings++; return signer.signTransaction(request); }
  };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, relayer as unknown as Wallet,
    router, 31337, routerAddress);
  const accept = service.accept.bind(service), tick = service.tick.bind(service);
  function observe(error: unknown): never {
    nativeCodes.push((error as { code?: unknown } | null)?.code);
    throw error;
  }
  service.accept = body => accept(body).catch(observe);
  service.tick = () => tick().catch(observe);
  async function demoPayment() {
    calls.demo++;
    const accepted = await service.accept(input);
    await service.tick();
    return { payment: service.publicRow(store.get(accepted.row.id)!) };
  }
  return { store, service, calls, nativeCodes, demoPayment };
}
function snapshot(store: Store) {
  return JSON.stringify({ rows: store.list(), audit: store.events(), journals: store.journals(),
    sequence: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all() });
}
async function withHttp(context: ReturnType<typeof fixture>, run: (request: (path: string, body?: unknown) =>
  Promise<{ status: number; text: string; body: any }>) => Promise<void>, demo = false) {
  const server = makeServer({ service: context.service, apiKey, port: 0, mode: demo ? 'demo' : 'rpc',
    demoPayment: demo ? context.demoPayment : undefined });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    await run(async (path, body) => {
      const response = await fetch(url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    });
  } finally {
    await server.drainRequests(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    context.store.close();
  }
}

test('native audit failure before acceptance returns redacted storage 500, rolls back and permits one healed intent', {
  timeout: 5000
}, async t => {
  const context = fixture();
  context.store.db.exec("CREATE TRIGGER fail_accept_audit BEFORE INSERT ON audit WHEN NEW.action='accepted' BEGIN SELECT RAISE(ABORT,'" + privateMarker + "'); END");
  const before = snapshot(context.store);
  await withHttp(context, async request => {
    const failed = await request('payments', input);
    t.diagnostic(JSON.stringify({ nativeCode: context.nativeCodes[0], httpStatus: failed.status,
      privateDiagnosticExposed: failed.text.includes(privateMarker) }));
    assert.deepEqual(context.nativeCodes, ['ERR_SQLITE_ERROR']);
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, fixed);
    for (const marker of [privateMarker, 'ERR_SQLITE_ERROR', 'fail_accept_audit', input.signature])
      assert.ok(!failed.text.includes(marker), 'Storage response exposed private or internal evidence');
    assert.ok(snapshot(context.store) === before, 'Failed acceptance must roll back the payment and audit transaction');
    assert.equal(context.calls.signatureViews, 1, 'HTTP must not automatically rerun a failed storage operation');
    assert.equal(context.calls.signings, 0); assert.equal(context.calls.sends, 0);
    context.store.db.exec('DROP TRIGGER fail_accept_audit');
    const accepted = await request('payments', input);
    assert.equal(accepted.status, 202); assert.equal(accepted.body.replay, false);
    const replay = await request('payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    assert.equal(accepted.body.payment.id, paymentKey(payment));
    assert.equal(replay.body.payment.id, accepted.body.payment.id);
    assert.equal(context.store.list().length, 1); assert.equal(context.store.events().length, 1);
    assert.equal(context.store.events()[0].action, 'accepted'); assert.equal(context.store.journals().length, 0);
    assert.equal(context.store.get(paymentKey(payment))!.status, 'queued');
    assert.equal(context.calls.signings, 0); assert.equal(context.calls.sends, 0);
  });
});

test('native broadcast audit failure after demo acceptance preserves a partial outcome and recovers that same queued intent', {
  timeout: 5000
}, async t => {
  const context = fixture(), paymentId = paymentKey(payment);
  context.store.db.exec("CREATE TRIGGER fail_broadcast_audit BEFORE INSERT ON audit WHEN NEW.action='broadcast-prepared' BEGIN SELECT RAISE(ABORT,'" + privateMarker + "'); END");
  await withHttp(context, async request => {
    const failed = await request('demo/payment', { amount: '125.00' });
    t.diagnostic(JSON.stringify({ nativeCode: context.nativeCodes[0], httpStatus: failed.status,
      privateDiagnosticExposed: failed.text.includes(privateMarker), acceptedRows: context.store.list().length }));
    assert.deepEqual(context.nativeCodes, ['ERR_SQLITE_ERROR']);
    assert.equal(failed.status, 500); assert.deepEqual(failed.body, fixed);
    assert.ok(!failed.text.includes(privateMarker));
    assert.equal(context.calls.demo, 1); assert.equal(context.calls.signatureViews, 1);
    assert.equal(context.calls.preflights, 1); assert.equal(context.calls.signings, 1);
    assert.equal(context.calls.receiptReads, 0); assert.equal(context.calls.sends, 0);
    const queued = context.store.get(paymentId)!;
    assert.equal(context.store.list().length, 1); assert.equal(queued.status, 'queued');
    assert.equal(queued.raw_tx, null); assert.equal(queued.tx_hash, null);
    assert.ok(queued.signature === input.signature && queued.payload === JSON.stringify(payment));
    assert.equal(context.store.events().length, 1); assert.equal(context.store.events()[0].action, 'accepted');
    assert.equal(context.store.journals().length, 0);
    const history = await request('payments');
    assert.equal(history.status, 200); assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].id, paymentId); assert.equal(history.body.items[0].status, 'queued');
    for (const field of ['raw_tx', 'signature', 'payload', 'fingerprint'])
      assert.equal(Object.hasOwn(history.body.items[0], field), false);
    const replay = await request('payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.id, paymentId); assert.equal(replay.body.payment.status, 'queued');
    assert.equal(context.calls.demo, 1); assert.equal(context.calls.signings, 1); assert.equal(context.calls.sends, 0);
    context.store.db.exec('DROP TRIGGER fail_broadcast_audit');
    // Resume the original queued work; do not automatically retry the demo
    // endpoint, whose real implementation creates a fresh payment ID per call.
    await context.service.tick();
    const settled = context.store.get(paymentId)!;
    assert.equal(settled.status, 'settled'); assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    const finalReplay = await request('payments', input);
    assert.equal(finalReplay.status, 200); assert.equal(finalReplay.body.replay, true);
    assert.equal(finalReplay.body.payment.id, paymentId); assert.equal(finalReplay.body.payment.tx_hash, settled.tx_hash);
    assert.equal(context.store.list().length, 1); assert.equal(context.store.journals().length, 1);
    assert.deepEqual(context.store.events().map(event => event.action).reverse(), ['accepted', 'broadcast-prepared', 'settled']);
    assert.equal(context.calls.demo, 1); assert.equal(context.calls.sends, 1);
    assert.equal(context.nativeCodes.length, 1);
  }, true);
});
