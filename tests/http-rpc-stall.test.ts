import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 7000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function until<T>(probe: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 7000;
  while (performance.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise<void>(resolvePause => setTimeout(resolvePause, 10));
  }
  throw new Error(label + ' did not become ready');
}

// Real HTTP and Ganache transport integration. The test drives service ticks
// explicitly; it does not claim automatic scheduling or a production network.
test('a shared receipt/network RPC stall returns a fixed 503 and preserves payment evidence', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined;
  let server: ReturnType<typeof makeServer> | undefined;
  let activeTick: Promise<void> | undefined;
  const unsettledTicks = new Set<Promise<void>>();
  function trackTick(tick: Promise<void>) {
    unsettledTicks.add(tick);
    void tick.then(() => unsettledTicks.delete(tick), () => unsettledTicks.delete(tick));
    return tick;
  }
  let receiptGate: ReturnType<Awaited<ReturnType<typeof rpcProxy>>['pauseAfterForward']> | undefined;
  try {
    compile();
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    provider = createRpcProvider(proxy.url, 1500);
    const relayer = new Wallet(chain.relayer.privateKey, provider);
    const routerAddress = String(chain.router.target);
    store = new Store();
    const service = new PaymentService(store, provider, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    const acceptanceErrorCodes: string[] = [];
    const accept = service.accept.bind(service);
    // Observe only the top-level code reaching the HTTP boundary. Rethrow the
    // same error object, without inspecting or printing transaction details.
    service.accept = async body => {
      try { return await accept(body); }
      catch (error) {
        const code = (error as { code?: unknown })?.code;
        acceptanceErrorCodes.push(typeof code === 'string' ? code : 'unknown');
        throw error;
      }
    };
    const apiKey = randomBytes(24).toString('hex');
    server = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    async function api(path: string, body?: unknown) {
      const response = await fetch(url + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() as any };
    }
    const block = await chain.provider.getBlock('latest');
    assert.ok(block);
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')),
        payer: chain!.payer.address, payee: chain!.payee.address, token: String(chain!.token.target),
        amount, nonce, deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0');
    const secondInput = await signed('7000000', '1');
    const firstId = paymentKey(firstInput.payment), secondId = paymentKey(secondInput.payment);
    const accepted = await api('/api/payments', firstInput);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.payment.id, firstId);
    proxy.afterForward('eth_sendRawTransaction', () => {
      receiptGate ??= proxy!.pauseAfterForward('eth_getTransactionReceipt');
    });
    activeTick = trackTick(service.tick());
    await until(() => receiptGate, 'Post-send receipt gate registration');
    await within(receiptGate!.entered, 'Real mined receipt pause');
    const batches = proxy.batches();
    const stalledBatch = batches[batches.length - 1];
    assert.ok(stalledBatch.includes('eth_getTransactionReceipt'), 'The held exchange must contain a receipt read');
    assert.ok(stalledBatch.includes('eth_chainId'), 'The observed held exchange must also contain network detection');
    const original = store.get(firstId)!;
    assert.equal(original.status, 'broadcast');
    assert.ok(original.raw_tx && original.tx_hash);
    const originalRaw = original.raw_tx, originalHash = original.tx_hash;
    const nativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(keccak256(originalRaw), originalHash);
    assert.equal((await chain.provider.getTransactionReceipt(originalHash))!.status, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(store.journals().length, 0);

    const interrupted = await api('/api/payments', secondInput);
    assert.equal(interrupted.status, 503);
    assert.deepEqual(interrupted.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    assert.deepEqual(acceptanceErrorCodes, ['TIMEOUT']);
    await within(activeTick, 'The timed-out confirmation tick'); activeTick = undefined;
    assert.equal(store.get(firstId)!.status, 'broadcast');
    assert.ok(store.get(firstId)!.raw_tx === originalRaw, 'RPC failure replaced the durable signed transaction');
    assert.equal(store.get(firstId)!.tx_hash, originalHash);
    assert.equal(store.get(secondId), undefined, 'A signature-view RPC failure must not invent accepted work');
    assert.equal(store.journals().length, 0);
    assert.equal(store.events().filter(event => event.action === 'accepted').length, 1);
    assert.equal(store.events().filter(event => event.action === 'failed').length, 0);

    // These routes read the local projection and need no upstream RPC request.
    const callsBeforeHistory = proxy.calls.length;
    const history = await api('/api/payments');
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].id, firstId);
    assert.equal(history.body.items[0].status, 'broadcast');
    for (const privateField of ['signature', 'fingerprint', 'raw_tx'])
      assert.equal(history.body.items[0][privateField], undefined);
    const journals = await api('/api/journals');
    assert.equal(journals.status, 200);
    assert.deepEqual(journals.body.items, []);
    const totals = await api('/api/totals');
    assert.equal(totals.status, 200);
    assert.deepEqual(totals.body.assets, []);
    assert.equal(proxy.calls.length, callsBeforeHistory);

    proxy.heal();
    const retried = await api('/api/payments', secondInput);
    assert.equal(retried.status, 202);
    assert.equal(retried.body.payment.id, secondId);
    activeTick = trackTick(service.tick());
    await within(activeTick, 'Healthy retry settlement'); activeTick = undefined;
    assert.equal(store.get(firstId)!.status, 'settled');
    assert.equal(store.get(secondId)!.status, 'settled');
    assert.ok(store.get(firstId)!.raw_tx === originalRaw, 'Recovery replaced the first signed transaction');
    assert.equal(store.get(firstId)!.tx_hash, originalHash);
    assert.equal(Transaction.from(store.get(secondId)!.raw_tx!).nonce, nativeNonce + 1);
    for (const input of [firstInput, secondInput]) {
      const replay = await api('/api/payments', input);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replay, true);
    }
    const reconciliation = await api('/api/reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 2);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.equal(store.journals().length, 2);
    for (const paymentId of [firstId, secondId]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(store.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 2);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), nativeNonce + 2);
    t.diagnostic(JSON.stringify({ stalledBatch, acceptanceErrorCode: acceptanceErrorCodes[0],
      responseStatus: interrupted.status, settledPayments: 2, journalRows: 2 }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    function settleTicks(label: string) {
      return within(Promise.allSettled([...unsettledTicks]).then(() => {}), label);
    }
    proxy?.heal();
    if (unsettledTicks.size) await cleanup(() => settleTicks('Final active service tick'));
    const requestDrain = server?.drainRequests();
    let requestsDrained = !requestDrain;
    if (requestDrain) {
      void requestDrain.then(() => { requestsDrained = true; }, () => {});
      await cleanup(() => within(requestDrain, 'Final HTTP request drain'));
    }
    if (server?.listening) await cleanup(() => within(new Promise<void>((resolveClose, reject) => {
      server!.close(error => error ? reject(error) : resolveClose());
      server!.closeIdleConnections();
    }), 'HTTP integration server close'));
    await cleanup(() => provider?.destroy());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    // A deadline rejects only its wrapper. Stop owned transport and then await
    // the actual operations again before deciding whether SQLite can close.
    if (unsettledTicks.size) await cleanup(() => settleTicks('Active service tick after transport shutdown'));
    if (requestDrain && !requestsDrained)
      await cleanup(() => within(requestDrain, 'HTTP request drain after transport shutdown'));
    if (unsettledTicks.size === 0 && requestsDrained) await cleanup(() => store?.close());
    else failures.push(new Error('SQLite retained because an owned service operation has not settled'));
    if (failures.length) throw new AggregateError(failures, 'HTTP RPC stall resource cleanup failed');
  }
});
