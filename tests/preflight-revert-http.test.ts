import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { Wallet, id, keccak256, Transaction } from 'ethers';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { makeServer } from '../src/http.ts';
import { paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

async function within<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Preflight HTTP fixture checkpoint timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function failure(operation: () => Promise<unknown>) {
  try { await operation(); }
  catch (error: any) {
    // Never retain the full ethers message/info/transaction, which may contain
    // authorization calldata. These normalized scalar fields are enough here.
    return { code: error.code, data: error.data, action: error.action,
      shortMessage: error.shortMessage, revertName: error.revert?.name };
  }
  return undefined;
}
async function preflightProxy(upstream: string, router: string, selector: string) {
  let malformed = false, injected = 0, forwardedPreflights = 0;
  const nativeSends: string[] = [], active = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk);
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const calls = Array.isArray(payload) ? payload : [payload];
        const replies = await Promise.all(calls.map(async (call: any) => {
          const transaction = call.params?.[0];
          const preflight = call.method === 'eth_call' && transaction?.to?.toLowerCase() === router.toLowerCase() &&
            typeof transaction.data === 'string' && transaction.data.startsWith(selector);
          if (preflight && malformed) {
            injected++;
            return { id: call.id, jsonrpc: '2.0', error: {
              code: 3, message: 'execution reverted: controlled malformed data', data: '0xzz'
            } };
          }
          if (preflight) forwardedPreflights++;
          if (call.method === 'eth_sendRawTransaction') nativeSends.push(keccak256(call.params[0]));
          const result = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call), signal: AbortSignal.timeout(3000) });
          return result.json();
        }));
        if (!response.destroyed) {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
        }
      } catch {
        if (!response.destroyed) { response.writeHead(502); response.end('Preflight fixture upstream unavailable'); }
      }
    })();
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    nativeSends, malform() { malformed = true; }, heal() { malformed = false; },
    counts: () => ({ injected, forwardedPreflights }),
    async close() {
      server.closeAllConnections();
      await within(new Promise<void>((resolveClose, rejectClose) =>
        server.close(error => error ? rejectClose(error) : resolveClose())));
      await within(Promise.allSettled([...active]));
    }
  };
}

// Uses existing contract artifacts without compiling/writing shared artifacts.
// This is real loopback JSON-RPC/API and Ganache execution with manual service
// ticks, not autonomous CLI, Besu, malformed-data exploit or production proof.
test('ethers normalizes malformed HTTP revert data for retry before genuine custom-error rejection and healthy settlement', {
  timeout: 30000
}, async t => {
  assert.ok(existsSync('artifacts/SettlementRouter.json') && existsSync('artifacts/DemoUSD.json'),
    'Prepare contract artifacts before running this focused real-EVM test');
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof preflightProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined, store: Store | undefined;
  let server: ReturnType<typeof makeServer> | undefined, drained = false;
  try {
    const live = chain = await localChain();
    const routerAddress = await live.router.getAddress();
    proxy = await preflightProxy(live.provider._getConnection().url, routerAddress,
      live.router.interface.getFunction('settle')!.selector);
    provider = createRpcProvider(proxy.url, 2000);
    const relayer = new Wallet(live.relayer.privateKey, provider);
    store = new Store();
    const router = connectRouter(routerAddress, relayer);
    const service = new PaymentService(store, provider, relayer, router, 31337, routerAddress);
    server = makeServer({ service, apiKey: 'preflight-http-test-' + 'a'.repeat(32), port: 0, mode: 'rpc' });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    async function api(path: string, body?: unknown) {
      const response = await fetch(url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer preflight-http-test-' + 'a'.repeat(32), 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      return { status: response.status, body: await response.json() as any };
    }
    const block = await live.provider.getBlock('latest'); assert.ok(block);
    const initialTokens = await live.token.balanceOf(live.payer.address);
    const initialRelayerBalance = await live.provider.getBalance(live.relayer.address);
    const initialRelayerNonce = await live.provider.getTransactionCount(live.relayer.address, 'pending');
    const initialPayerNativeNonce = await live.provider.getTransactionCount(live.payer.address, 'pending');
    async function signed(amount: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live.payer.address,
        payee: live.payee.address, token: await live.token.getAddress(), amount, nonce: '0', deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await live.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const rejectedInput = await signed('10001000000'), healthyInput = await signed('7000000');
    const rejectedId = paymentKey(rejectedInput.payment), healthyId = paymentKey(healthyInput.payment);
    for (const input of [rejectedInput, healthyInput]) {
      const accepted = await api('payments', input);
      assert.equal(accepted.status, 202); assert.equal(accepted.body.replay, false);
    }
    const snapshot = () => JSON.stringify({ rows: store!.list(), audit: store!.events(), journals: store!.journals() });
    const original = snapshot();
    proxy.malform();
    for (let attempt = 0; attempt < 3; attempt++) {
      const normalized = await failure(() => service.tick());
      assert.ok(normalized, 'Malformed preflight evidence must leave the tick retryable');
      assert.equal(normalized.code, 'CALL_EXCEPTION'); assert.equal(normalized.data, null);
      assert.equal(normalized.action, 'call'); assert.equal(normalized.shortMessage, 'missing revert data');
      if (attempt === 0) t.diagnostic(JSON.stringify({ malformedResponse: 'nonhex-data', normalized }));
      assert.ok(snapshot() === original, 'Malformed RPC evidence changed private queued authorization or audit state');
      for (const paymentId of [rejectedId, healthyId]) {
        assert.equal(store.get(paymentId)!.status, 'queued');
        assert.equal(store.get(paymentId)!.raw_tx, null); assert.equal(store.get(paymentId)!.tx_hash, null);
      }
    }
    assert.equal(proxy.counts().injected, 3); assert.equal(proxy.nativeSends.length, 0);
    assert.equal(store.journals().length, 0); assert.equal(store.events().length, 2);
    assert.equal(await live.token.balanceOf(live.payer.address), initialTokens);
    assert.equal(await live.token.balanceOf(live.payee.address), 0n);
    assert.equal(await live.router.nonces(live.payer.address), 0n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce);
    assert.equal(await live.provider.getBalance(live.relayer.address), initialRelayerBalance);
    proxy.heal();
    const genuine = await failure(() => router.settle.staticCall(rejectedInput.payment, rejectedInput.signature));
    assert.ok(genuine); assert.equal(genuine.code, 'CALL_EXCEPTION');
    assert.equal(genuine.data, live.router.interface.encodeErrorResult('LimitExceeded', []));
    assert.equal(genuine.revertName, 'LimitExceeded');
    t.diagnostic(JSON.stringify({ genuineCustomError: genuine }));
    await service.tick();
    const failed = store.get(rejectedId)!, settled = store.get(healthyId)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.raw_tx, null); assert.equal(failed.tx_hash, null);
    assert.equal(store.journal(rejectedId), undefined);
    assert.equal(store.events().filter(event => event.payment_id === rejectedId && event.action === 'failed').length, 1);
    assert.equal(settled.status, 'settled'); assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.equal(Transaction.from(settled.raw_tx).nonce, initialRelayerNonce);
    assert.deepEqual(proxy.nativeSends, [settled.tx_hash]); assert.equal(store.journals().length, 1);
    assert.equal(await live.token.balanceOf(live.payee.address), 7000000n);
    assert.equal(await live.token.balanceOf(live.payer.address), initialTokens - 7000000n);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.router.processed(live.payer.address, rejectedInput.payment.paymentId), false);
    assert.equal(await live.router.processed(live.payer.address, healthyInput.payment.paymentId), true);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 1);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialPayerNativeNonce);
    for (const input of [rejectedInput, healthyInput]) {
      const replay = await api('payments', input);
      assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
      for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload'])
        assert.equal(Object.hasOwn(replay.body.payment, field), false);
    }
    const reconciliation = await api('reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.equal(store.events().length, 5); assert.equal(store.journals().length, 1);
    assert.equal(proxy.nativeSends.length, 1);
    t.diagnostic(JSON.stringify({ malformedRetries: 3, genuinePreflightFailures: 1,
      healthySettlements: 1, nativeSends: 1, journalRows: 1, reconciled: 1 }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    if (server) {
      await cleanup(async () => { await within(server!.drainRequests()); drained = true; });
      await cleanup(() => server!.closeAllConnections());
      if (server.listening) await cleanup(() => within(new Promise<void>((resolveClose, rejectClose) =>
        server!.close(error => error ? rejectClose(error) : resolveClose()))));
    } else drained = true;
    await cleanup(() => provider?.destroy());
    await cleanup(() => proxy?.close());
    if (drained) await cleanup(() => store?.close());
    else failures.push(new Error('SQLite retained because HTTP handlers did not drain'));
    await cleanup(() => chain?.close());
    if (failures.length) throw new AggregateError(failures, 'Preflight HTTP fixture cleanup failed');
  }
});
