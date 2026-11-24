import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Wallet, id, keccak256, Transaction, type TransactionRequest } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';

type RpcCall = { id: number | string; method: string; params: unknown[] };
type RpcReply = { id: number | string; result?: { transactions?: string[]; timestamp?: unknown } | null };

async function within<T>(pending: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Alter only reported timestamp evidence; the actual EVM block remains genuine. */
async function timestampProxy(upstream: string) {
  let affectedHash: string | undefined;
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
        for (const call of batch) if (call.method === 'eth_sendRawTransaction') {
          assert.equal(typeof call.params[0], 'string');
          rawSends.push(call.params[0] as string);
        }
        const response = await fetch(upstream, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(3000) });
        const result = await response.json() as RpcReply | RpcReply[];
        for (const reply of Array.isArray(result) ? result : [result]) {
          const call = batch.find(candidate => candidate.id === reply.id);
          if (affectedHash && call?.method === 'eth_getBlockByNumber' &&
            reply.result?.transactions?.includes(affectedHash)) {
            // ethers 6.17 formats a JSON numeric -1 as Block.timestamp === -1.
            reply.result.timestamp = -1;
            altered++;
          }
        }
        if (!res.destroyed) {
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Timestamp fixture upstream unavailable'); }
      }
    })();
    active.add(pending);
    void pending.then(() => active.delete(pending), () => active.delete(pending));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    calls, rawSends, altered: () => altered,
    corrupt(hash: string) { affectedHash = hash; },
    heal() { affectedHash = undefined; },
    async close() {
      const closed = new Promise<void>(resolveClosed => server.close(() => resolveClosed()));
      server.closeAllConnections();
      await within(Promise.all([closed, Promise.allSettled([...active])]), 5000,
        'Timestamp fixture cleanup exceeded its bound');
    }
  };
}

// Manual PaymentService ticks and a fixture-created reservation exercise the
// real HTTP formatter and EVM revert; this is not autonomous CLI or Besu proof.
test('actual RPC negative containing-block timestamp retains a genuine revert reservation until evidence heals', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof timestampProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>): Promise<T> {
    // Upstream exceptions can contain signed arguments; keep test failures fixed.
    const safe = pending.catch(() => { throw new Error('Timestamp RPC fixture operation failed'); });
    operations.add(safe);
    void safe.then(() => operations.delete(safe), () => operations.delete(safe));
    return safe;
  }
  try {
    compile();
    const local = chain = await operation(localChain());
    const relay = proxy = await timestampProxy(local.provider._getConnection().url);
    const rpc = provider = createRpcProvider(relay.url, 2000);
    const ledger = store = new Store();
    const routerAddress = await local.router.getAddress();
    const relayer = new Wallet(local.relayer.privateKey, rpc);
    const router = connectRouter(routerAddress, relayer);
    const service = new PaymentService(ledger, rpc, relayer, router, 31337, routerAddress);
    const latest = await operation(local.provider.getBlock('latest'));
    assert.ok(latest);
    const initialPayerTokens = await operation<bigint>(local.token.balanceOf(local.payer.address));
    const initialRelayerNonce = await operation(local.provider.getTransactionCount(relayer.address, 'pending'));
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id('reverted block timestamp ' + nonce), payer: local.payer.address,
        payee: local.payee.address, token: await local.token.getAddress(), amount, nonce,
        deadline: String(latest!.timestamp + 3600) };
      return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const first = (await operation(service.accept(firstInput))).row;
    const second = (await operation(service.accept(secondInput))).row;
    const payerRouter = connectRouter(routerAddress, local.payer);
    await operation((async () => { await (await payerRouter.invalidateNonce(1)).wait(); })());
    assert.equal(await operation(local.router.nonces(local.payer.address)), 1n);

    // The first authorization is now invalid. Fixture-only reservation bypasses
    // preflight to mine the exact saved router call as a genuine status-0 receipt.
    const request = await operation<TransactionRequest>(router.settle.populateTransaction(firstInput.payment, firstInput.signature));
    const raw = await operation(relayer.signTransaction(await operation(relayer.populateTransaction({
      ...request, gasLimit: 500000n
    }))));
    const hash = keccak256(raw), transaction = Transaction.from(raw);
    assert.equal(transaction.nonce, initialRelayerNonce); assert.equal(transaction.chainId, 31337n);
    assert.equal(transaction.to, routerAddress); assert.equal(transaction.from, relayer.address);
    assert.ok(transaction.data === router.interface.encodeFunctionData('settle', [firstInput.payment, firstInput.signature]),
      'Fixture reservation must retain the exact saved settlement call');
    ledger.broadcast(first.id, raw, hash);
    await operation(rpc.broadcastTransaction(raw));
    const receiptDeadline = performance.now() + 10000;
    let receipt = await operation(local.provider.getTransactionReceipt(hash));
    while (!receipt && performance.now() < receiptDeadline) {
      await new Promise(resolvePause => setTimeout(resolvePause, 50));
      receipt = await operation(local.provider.getTransactionReceipt(hash));
    }
    assert.ok(receipt && receipt.status === 0, 'Fixture must mine a genuine reverted router call');
    assert.equal(receipt.hash, hash); assert.equal(receipt.logs.length, 0);
    const block = await operation(local.provider.getBlock(receipt.blockNumber));
    assert.ok(block && Number.isSafeInteger(block.timestamp) && block.timestamp >= 0);
    assert.deepEqual(block.transactions, [hash]);
    assert.equal(block.transactions[receipt.index], hash);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), initialRelayerNonce + 1);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 0n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens);
    const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
      changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
    const held = snapshot();
    relay.corrupt(hash);
    const presentedReceipt = await operation(rpc.getTransactionReceipt(hash));
    const presentedBlock = await operation(rpc.getBlock(receipt.blockNumber));
    assert.ok(presentedReceipt && presentedBlock);
    assert.deepEqual(presentedReceipt.toJSON(), receipt.toJSON(), 'Receipt evidence must remain genuine');
    assert.equal(presentedBlock.timestamp, -1);
    assert.deepEqual({ ...presentedBlock.toJSON(), timestamp: block.timestamp }, block.toJSON(),
      'Only the reported containing-block timestamp may change');
    const alteredBeforeTicks = relay.altered();
    const nonceReads = relay.calls.filter(call => call.method === 'eth_getTransactionCount').length;
    const receiptReads = relay.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    const sendBaseline = relay.rawSends.length;
    for (let retry = 0; retry < 3; retry++) await operation(service.tick());
    assert.equal(relay.altered(), alteredBeforeTicks + 3);
    assert.ok(snapshot() === held, 'Malformed reverted-block evidence changed the reservation, queue or private projection');
    assert.equal(ledger.get(first.id)!.status, 'broadcast');
    assert.ok(ledger.get(first.id)!.raw_tx === raw && ledger.get(first.id)!.tx_hash === hash);
    assert.ok(isDeepStrictEqual(ledger.get(second.id), second), 'Malformed block evidence changed the queued successor');
    assert.equal(ledger.get(second.id)!.raw_tx, null); assert.equal(ledger.get(second.id)!.tx_hash, null);
    assert.equal(relay.rawSends.length, 1); assert.ok(relay.rawSends[0] === raw);
    const malformedPhaseNewNativeSends = relay.rawSends.length - sendBaseline;
    const malformedPhaseReceiptReads = relay.calls.filter(call => call.method === 'eth_getTransactionReceipt').length - receiptReads;
    assert.equal(malformedPhaseNewNativeSends, 0); assert.equal(malformedPhaseReceiptReads, 3);
    assert.equal(relay.calls.filter(call => call.method === 'eth_getTransactionCount').length, nonceReads,
      'Unresolved reverted-block evidence must retain successor nonce priority');
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), initialRelayerNonce + 1);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 0n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 1n);

    relay.heal();
    for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
    const failed = ledger.get(first.id)!, settled = ledger.get(second.id)!;
    assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Transaction reverted on chain');
    assert.ok(failed.raw_tx === raw && failed.tx_hash === hash, 'Healing replaced the reverted reservation');
    assert.equal(settled.status, 'settled'); assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(Transaction.from(settled.raw_tx).nonce, transaction.nonce + 1);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.equal(relay.rawSends.length, 2); assert.ok(relay.rawSends[1] === settled.raw_tx);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), initialRelayerNonce + 2);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 7000000n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens - 7000000n);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 2n);
    assert.equal(ledger.journals().length, 1); assert.equal(ledger.journal(first.id), undefined);
    assert.equal(ledger.journal(second.id)!.tx_hash, settled.tx_hash);
    assert.equal(ledger.events().filter(event => event.payment_id === first.id && event.action === 'failed').length, 1);
    assert.equal(ledger.events().filter(event => event.payment_id === second.id && event.action === 'settled').length, 1);
    assert.equal(ledger.events().length, 6);
    const reconciliation = await operation(service.reconcile());
    assert.equal(reconciliation.checked, 1); assert.deepEqual(reconciliation.exceptions, []);
    const healed = snapshot();
    for (const input of [firstInput, secondInput]) assert.equal((await operation(service.accept(input))).replay, true);
    await operation(service.tick());
    assert.ok(snapshot() === healed, 'Replay changed a terminal outcome or its original reservation');
    assert.equal(relay.rawSends.length, 2);
    t.diagnostic(JSON.stringify({ fixture: 'manual-payment-service-over-http', actualReceiptStatus: receipt.status,
      reportedTimestamp: -1, alteredBlockReplies: relay.altered(), retainedRetryTicks: 3,
      heldNativeSends: 1, malformedPhaseNewNativeSends, malformedPhaseReceiptReads, failedAfterHealing: 1, settledAfterHealing: 1,
      consumedNativeNonces: 2, journalRows: 1, auditEvents: ledger.events().length,
      recipientBaseUnits: '7000000', totalNativeSends: relay.rawSends.length, reconciliationChecked: reconciliation.checked,
      reconciliationExceptions: reconciliation.exceptions.length, replayRetainedOutcomes: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch { failures.push(true); } }
    await cleanup(() => within(Promise.allSettled([...operations]), 5000, 'Timestamp RPC operation drain timed out'));
    await cleanup(() => provider?.destroy());
    await cleanup(() => proxy?.close());
    await cleanup(() => store?.close());
    if (chain) await cleanup(() => within(chain!.close(), 5000, 'Timestamp chain cleanup timed out'));
    if (failures.length) throw new Error('Reverted-block timestamp RPC cleanup failed');
  }
});
