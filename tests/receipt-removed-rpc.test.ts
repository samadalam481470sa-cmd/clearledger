import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { JsonRpcProvider, Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { makeServer } from '../src/http.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';

type RpcCall = { id: number | string; method: string; params: unknown[] };
type WireReceipt = { transactionHash: string; logs: Record<string, unknown>[]; [key: string]: unknown };
type RpcReply = { id: number | string; result?: WireReceipt | null };
const CANARY = 'PRIVATE_REMOVED_RPC_VALUE_CANARY';

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Receipt removed fixture operation exceeded its bound')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Inject contradictory wire evidence without reorganizing the development EVM. */
async function removedProxy(upstream: string, router: string, token: string) {
  let fault: { address: string; removed: unknown } | undefined = { address: router, removed: true };
  let altered = 0;
  const calls: RpcCall[] = [], rawSends: string[] = [];
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const pending = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body) as RpcCall | RpcCall[];
        const batch = Array.isArray(payload) ? payload : [payload];
        calls.push(...batch);
        for (const call of batch) if (call.method === 'eth_sendRawTransaction' && typeof call.params[0] === 'string')
          rawSends.push(call.params[0]);
        const response = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(3000) });
        const result = await response.json() as RpcReply | RpcReply[];
        for (const reply of Array.isArray(result) ? result : [result]) {
          const call = batch.find(candidate => candidate.id === reply.id), receipt = reply.result;
          if (!fault || !rawSends.length || call?.method !== 'eth_getTransactionReceipt' ||
            receipt?.transactionHash !== keccak256(rawSends[0])) continue;
          const log = receipt.logs.find(item => String(item.address).toLowerCase() === fault!.address.toLowerCase());
          assert.ok(log, 'Target receipt must contain the selected genuine log');
          log.removed = fault.removed;
          altered++;
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Receipt removed fixture upstream unavailable'); }
      }
    })();
    active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    calls, rawSends, altered: () => altered,
    corrupt(kind: 'router' | 'transfer' | 'canary') {
      fault = { address: kind === 'transfer' ? token : router, removed: kind === 'canary' ? CANARY : true };
    },
    heal() { fault = undefined; },
    async close() {
      const closed = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections(); await within(Promise.all([closed, Promise.allSettled([...active])]), 5000);
    }
  };
}

// Manual PaymentService ticks cover native HTTP formatting, not CLI scheduling,
// a real chain reorganization, or Besu consensus behavior.
test('actual RPC removed receipt logs retain confirmation priority and return redacted reconciliation outages', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof removedProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined, stock: JsonRpcProvider | undefined;
  let store: Store | undefined, api: ReturnType<typeof makeServer> | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>): Promise<T> {
    const safe = pending.catch(() => { throw new Error('Receipt removed RPC fixture operation failed'); });
    operations.add(safe); void safe.then(() => operations.delete(safe), () => operations.delete(safe)); return safe;
  }
  try {
    compile();
    const local = chain = await operation(localChain());
    const routerAddress = await local.router.getAddress(), tokenAddress = await local.token.getAddress();
    const relay = proxy = await removedProxy(local.provider._getConnection().url, routerAddress, tokenAddress);
    const rpc = provider = createRpcProvider(relay.url, 2000);
    const ordinary = stock = new JsonRpcProvider(relay.url, undefined, { cacheTimeout: -1 });
    const ledger = store = new Store(), relayer = new Wallet(local.relayer.privateKey, rpc);
    const service = new PaymentService(ledger, rpc, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    const latest = await operation(local.provider.getBlock('latest')); assert.ok(latest);
    const initialPayerTokens = await operation<bigint>(local.token.balanceOf(local.payer.address));
    const initialNativeNonce = await operation(local.provider.getTransactionCount(relayer.address, 'pending'));
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id('receipt removed native ' + nonce), payer: local.payer.address,
        payee: local.payee.address, token: tokenAddress, amount, nonce, deadline: String(latest!.timestamp + 3600) };
      return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const first = (await operation(service.accept(firstInput))).row, second = (await operation(service.accept(secondInput))).row;
    const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
      changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
    await operation(service.tick());
    const reserved = ledger.get(first.id)!; assert.ok(reserved.raw_tx && reserved.tx_hash);
    const raw = reserved.raw_tx, hash = reserved.tx_hash, held = snapshot();
    await operation(service.tick());
    const genuine = await operation(local.provider.getTransactionReceipt(hash)); assert.ok(genuine?.status === 1);
    const wire = await operation(rpc.send('eth_getTransactionReceipt', [hash])) as WireReceipt;
    const genuineWire = await operation(local.provider.send('eth_getTransactionReceipt', [hash])) as WireReceipt;
    const index = wire.logs.findIndex(log => String(log.address).toLowerCase() === routerAddress.toLowerCase());
    assert.ok(index >= 0); assert.equal(wire.logs[index].removed, true);
    const repaired = structuredClone(wire);
    if (Object.hasOwn(genuineWire.logs[index], 'removed')) repaired.logs[index].removed = genuineWire.logs[index].removed;
    else delete repaired.logs[index].removed;
    assert.deepEqual(repaired, genuineWire, 'Only the matching receipt log removed flag may change');
    const formatted = await operation(ordinary.getTransactionReceipt(hash)); assert.ok(formatted);
    assert.deepEqual(formatted.toJSON(), genuine.toJSON(), 'Stock ethers drops the altered receipt-log field');
    assert.equal((formatted.logs[index] as unknown as { removed?: unknown }).removed, undefined);
    t.diagnostic(JSON.stringify({ control: 'raw-true-stock-formatter-omits-field', rawRemoved: true,
      stockFormattedRemoved: 'undefined', firstStatusAfterTwoTicks: ledger.get(first.id)!.status,
      secondStatusAfterTwoTicks: ledger.get(second.id)!.status, journalRowsAfterTwoTicks: ledger.journals().length,
      nativeSendsAfterTwoTicks: relay.rawSends.length, actualChainReorganization: false }));
    assert.equal(ledger.get(first.id)!.status, 'broadcast', 'Raw removed evidence must preserve the original reservation');
    assert.equal(ledger.get(second.id)!.status, 'queued', 'Raw removed evidence must retain successor nonce priority');
    assert.ok(snapshot() === held, 'Repeated removed receipt evidence changed the private projection');
    assert.equal(ledger.get(second.id)!.raw_tx, null); assert.equal(ledger.get(second.id)!.tx_hash, null);
    assert.ok(ledger.get(first.id)!.raw_tx === raw && ledger.get(first.id)!.tx_hash === hash);
    assert.equal(Transaction.from(raw).nonce, initialNativeNonce);
    const nonceReads = relay.calls.filter(call => call.method === 'eth_getTransactionCount').length;
    for (let retry = 0; retry < 2; retry++) await operation(service.tick());
    assert.ok(snapshot() === held, 'Malformed receipt retries changed the reservation, journal or audit');
    assert.equal(relay.calls.filter(call => call.method === 'eth_getTransactionCount').length, nonceReads);
    assert.equal(relay.rawSends.length, 1); assert.ok(relay.rawSends[0] === raw);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), initialNativeNonce + 1);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 125000000n);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 1n);
    async function assertRejectedReceipt() {
      const failure = await operation(rpc.getTransactionReceipt(hash).then(() => undefined, error => error as unknown));
      assert.ok(failure && typeof failure === 'object', 'Factory must reject contradictory raw receipt evidence');
      const error = failure as { code?: unknown; shortMessage?: unknown; value?: unknown; info?: unknown; cause?: unknown };
      assert.ok(error.code === 'BAD_DATA', 'Factory must classify rejected raw receipt evidence as BAD_DATA');
      assert.ok(error.shortMessage === 'Receipt contains removed or invalid log evidence', 'Factory error message must stay fixed');
      assert.ok(error.value === '[redacted receipt log evidence]', 'Factory error value must stay redacted');
      assert.ok(error.info === undefined && error.cause === undefined, 'Factory must not retain raw receipt error context');
      const serialized = String(failure) + JSON.stringify(failure);
      for (const marker of [CANARY, raw, hash, firstInput.signature, relay.url])
        assert.ok(!serialized.includes(marker), 'Factory error exposed private/raw RPC details');
    }
    await assertRejectedReceipt();

    relay.heal();
    for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
    const settled = ledger.get(first.id)!, successor = ledger.get(second.id)!;
    assert.equal(settled.status, 'settled'); assert.equal(successor.status, 'settled');
    assert.ok(settled.raw_tx === raw && settled.tx_hash === hash); assert.ok(successor.raw_tx && successor.tx_hash);
    assert.equal(Transaction.from(successor.raw_tx).nonce, initialNativeNonce + 1);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), initialNativeNonce + 2);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 132000000n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens - 132000000n);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 2n);
    assert.equal(ledger.journals().length, 2); assert.equal(ledger.events().length, 6);
    assert.equal(relay.rawSends.length, 2); assert.ok(relay.rawSends[1] === successor.raw_tx);
    for (const input of [firstInput, secondInput]) assert.equal((await operation(service.accept(input))).replay, true);
    const reconciliation = await operation(service.reconcile());
    assert.equal(reconciliation.checked, 2); assert.deepEqual(reconciliation.exceptions, []);
    const healed = snapshot();
    const apiKey = 'receipt-removed-native-api-' + 'a'.repeat(32);
    api = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const apiUrl = 'http://127.0.0.1:' + (api.address() as { port: number }).port;
    for (const kind of ['router', 'transfer', 'canary'] as const) {
      relay.corrupt(kind);
      await assertRejectedReceipt();
      const response = await operation(fetch(apiUrl + '/api/reconcile', { method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(5000) }));
      const body = await operation(response.text());
      assert.equal(response.status, 503);
      assert.deepEqual(JSON.parse(body), { error: 'Upstream RPC unavailable; check payment history before retrying' });
      for (const marker of [CANARY, raw, firstInput.signature, 'BAD_DATA', relay.url])
        assert.ok(!body.includes(marker), 'Reconciliation response exposed private/raw RPC details');
      assert.ok(snapshot() === healed, 'Rejected removed evidence must preserve settled rows, journals and audit');
    }
    relay.heal();
    const recoveredResponse = await operation(fetch(apiUrl + '/api/reconcile', { method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(5000) }));
    assert.equal(recoveredResponse.status, 200);
    const recovered = await operation(recoveredResponse.json()) as { checked: number; exceptions: unknown[] };
    assert.equal(recovered.checked, 2); assert.deepEqual(recovered.exceptions, []);
    assert.ok(snapshot() === healed, 'Healed reconciliation changed the original settled projection');
    assert.equal(relay.rawSends.length, 2);
    t.diagnostic(JSON.stringify({ fixture: 'manual-payment-service-over-http', heldReceiptTicks: 4,
      heldNativeSends: 1, settledAfterHealing: 2, nativeSends: 2, journalRows: 2, auditEvents: 6,
      recipientBaseUnits: '132000000', rejectedReconciliationCases: 3, reconciliationStatus: 503,
      reconciledAfterHealing: recovered.checked, reconciliationExceptions: recovered.exceptions.length,
      actualChainReorganization: false, rawProviderSendIsWireControl: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch { failures.push(true); } }
    if (api) await cleanup(async () => {
      const closed = new Promise<void>(resolveClose => api!.close(() => resolveClose()));
      api!.closeAllConnections(); await within(Promise.all([closed, api!.drainRequests()]), 5000);
    });
    await cleanup(() => within(Promise.allSettled([...operations]), 5000));
    await cleanup(() => provider?.destroy()); await cleanup(() => stock?.destroy());
    await cleanup(() => proxy?.close()); await cleanup(() => store?.close());
    if (chain) await cleanup(() => within(chain!.close(), 5000));
    if (failures.length) throw new Error('Removed receipt RPC fixture cleanup failed');
  }
});
