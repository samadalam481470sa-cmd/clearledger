import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { digest, paymentTypes, type Payment } from '../src/payment.ts';

type RpcCall = { id: number | string; method: string; params: unknown[] };
type RpcReply = { id: number | string; result?: { hash?: string; transactions?: string[] } | null };

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Confirmation snapshot fixture operation exceeded its bound')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Hold the first reservation's genuine canonical block, without changing bytes. */
async function blockGateProxy(upstream: string) {
  const calls: RpcCall[] = [], rawSends: string[] = [];
  const active = new Set<Promise<void>>();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
  const wait = new Promise<void>(resolveRelease => { release = resolveRelease; });
  let taken = false, heldResult: RpcReply['result'], heldParams: unknown[] | undefined;
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
        const bytes = await response.text(), result = JSON.parse(bytes) as RpcReply | RpcReply[];
        if (!taken && rawSends.length) {
          const hash = keccak256(rawSends[0]);
          for (const reply of Array.isArray(result) ? result : [result]) {
            const call = batch.find(candidate => candidate.id === reply.id);
            if (call?.method !== 'eth_getBlockByNumber' || !reply.result?.transactions?.includes(hash)) continue;
            taken = true; heldResult = reply.result; heldParams = call.params;
            enter(); await wait; break;
          }
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Confirmation snapshot fixture upstream unavailable'); }
      }
    })();
    active.add(pending); void pending.then(() => active.delete(pending), () => active.delete(pending));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    calls, rawSends, entered, release, result: () => heldResult, params: () => heldParams,
    async close() {
      release(); const closed = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections(); await within(Promise.all([closed, Promise.allSettled([...active])]), 5000);
    }
  };
}

// A controlled SQL fault and explicit restoration exercise manual PaymentService
// confirmation over genuine HTTP/EVM evidence. No user repair API, autonomous
// CLI scheduling, real chain reorganization or Besu behavior is established.
test('confirmation retains a changed payment row after a genuine canonical block resolves', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof blockGateProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>): Promise<T> {
    const safe = pending.catch(() => { throw new Error('Confirmation row snapshot fixture operation failed'); });
    operations.add(safe); void safe.then(() => operations.delete(safe), () => operations.delete(safe)); return safe;
  }
  try {
    compile();
    const local = chain = await operation(localChain());
    const relay = proxy = await blockGateProxy(local.provider._getConnection().url);
    const rpc = provider = createRpcProvider(relay.url, 5000), ledger = store = new Store();
    const successfulBlocks = new Map<string, number>(), getBlock = rpc.getBlock.bind(rpc);
    rpc.getBlock = async (blockHashOrBlockTag, prefetchTxs) => {
      const block = await getBlock(blockHashOrBlockTag, prefetchTxs);
      if (block?.hash) successfulBlocks.set(block.hash, (successfulBlocks.get(block.hash) ?? 0) + 1);
      return block;
    };
    const routerAddress = await local.router.getAddress(), relayer = new Wallet(local.relayer.privateKey, rpc);
    const service = new PaymentService(ledger, rpc, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    const latest = await operation(local.provider.getBlock('latest')); assert.ok(latest);
    const nativeNonce = await operation(local.provider.getTransactionCount(relayer.address, 'pending'));
    const initialPayerTokens = await operation<bigint>(local.token.balanceOf(local.payer.address));
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id('confirmation row snapshot ' + nonce), payer: local.payer.address,
        payee: local.payee.address, token: await local.token.getAddress(), amount, nonce,
        deadline: String(latest!.timestamp + 3600) };
      return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const first = (await operation(service.accept(firstInput))).row, second = (await operation(service.accept(secondInput))).row;
    const firstTick = operation(service.tick()); await operation(within(relay.entered, 5000));
    const reserved = ledger.get(first.id)!; assert.equal(reserved.status, 'broadcast');
    assert.ok(reserved.raw_tx && reserved.tx_hash);
    const raw = reserved.raw_tx, hash = reserved.tx_hash;
    assert.equal(keccak256(raw), hash); assert.equal(Transaction.from(raw).nonce, nativeNonce);
    assert.equal(relay.rawSends.length, 1); assert.ok(relay.rawSends[0] === raw);
    const genuineBlock = await operation(local.provider.send('eth_getBlockByNumber', relay.params()!)) as { hash: string };
    assert.deepEqual(relay.result(), genuineBlock, 'The held canonical block must remain genuine and unaltered');
    const receipt = await operation(local.provider.getTransactionReceipt(hash)); assert.ok(receipt?.status === 1);
    assert.equal(receipt.blockHash, genuineBlock.hash);
    const blockReturnBaseline = successfulBlocks.get(genuineBlock.hash) ?? 0;
    assert.equal(blockReturnBaseline, 0, 'The target factory block must remain unresolved while held');
    const changedPayment: Payment = { ...firstInput.payment, amount: '126000000' };
    const changedFingerprint = digest(changedPayment, service.signingDomain);
    // Fixture-only coherent local rewrite: saved signature and native envelope
    // still authorize the original 125 dUSD, while the current row claims 126.
    ledger.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
      .run(JSON.stringify(changedPayment), changedFingerprint, first.id);
    const changed = ledger.get(first.id)!;
    assert.ok(changed.payload === JSON.stringify(changedPayment) && changed.fingerprint === changedFingerprint);
    assert.ok(changed.signature === reserved.signature && changed.raw_tx === raw && changed.tx_hash === hash);
    const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
      changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
    const held = snapshot();
    const preflightBaseline = relay.calls.filter(call => call.method === 'eth_call').length;
    const nonceReadBaseline = relay.calls.filter(call => call.method === 'eth_getTransactionCount').length;
    relay.release(); await firstTick;
    const successfulTargetBlockReturns = (successfulBlocks.get(genuineBlock.hash) ?? 0) - blockReturnBaseline;
    assert.equal(successfulTargetBlockReturns, 1, 'Retention must follow successful factory block resolution, not a timeout');
    assert.ok(snapshot() === held, 'Stale canonical-block processing changed the newer stored payment projection');
    for (let retry = 0; retry < 2; retry++) await operation(service.tick());
    assert.ok(snapshot() === held, 'Changed evidence retries changed the reservation, journal or audit');
    assert.ok(isDeepStrictEqual(ledger.get(first.id), changed));
    assert.ok(isDeepStrictEqual(ledger.get(second.id), second), 'Changed reservation released queued successor preparation');
    assert.equal(ledger.get(second.id)!.raw_tx, null); assert.equal(ledger.get(second.id)!.tx_hash, null);
    assert.equal(ledger.journals().length, 0);
    assert.equal(ledger.events().filter(event => event.action === 'settled').length, 0);
    const earlySuccessorPreflights = relay.calls.filter(call => call.method === 'eth_call').length - preflightBaseline;
    const earlyNativeNonceReads = relay.calls.filter(call => call.method === 'eth_getTransactionCount').length - nonceReadBaseline;
    assert.equal(earlySuccessorPreflights, 0); assert.equal(earlyNativeNonceReads, 0); assert.equal(relay.rawSends.length, 1);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), nativeNonce + 1);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 1n);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 125000000n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens - 125000000n);

    // Restore only the fixture's two altered fields; no re-signing, replacement
    // business instruction or production recovery endpoint is involved.
    ledger.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?').run(reserved.payload, reserved.fingerprint, first.id);
    assert.ok(isDeepStrictEqual(ledger.get(first.id), reserved), 'Fixture restoration must restore the exact reserved row');
    for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
    const settled = ledger.get(first.id)!, successor = ledger.get(second.id)!;
    assert.equal(settled.status, 'settled'); assert.equal(successor.status, 'settled');
    assert.ok(settled.raw_tx === raw && settled.tx_hash === hash, 'Healing replaced the original native reservation');
    assert.ok(successor.raw_tx && successor.tx_hash); assert.equal(Transaction.from(successor.raw_tx).nonce, nativeNonce + 1);
    assert.equal(ledger.journal(first.id)!.amount, firstInput.payment.amount);
    assert.equal(ledger.journal(first.id)!.tx_hash, hash); assert.equal(ledger.journal(second.id)!.amount, secondInput.payment.amount);
    assert.equal(ledger.journals().length, 2); assert.equal(ledger.events().length, 6);
    for (const paymentId of [first.id, second.id])
      assert.equal(ledger.events().filter(event => event.payment_id === paymentId && event.action === 'settled').length, 1);
    assert.equal(relay.rawSends.length, 2); assert.ok(relay.rawSends[1] === successor.raw_tx);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), nativeNonce + 2);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 2n);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 132000000n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens - 132000000n);
    const settledProjection = snapshot();
    for (const input of [firstInput, secondInput]) assert.equal((await operation(service.accept(input))).replay, true);
    await operation(service.tick());
    const reconciliation = await operation(service.reconcile());
    assert.equal(reconciliation.checked, 2); assert.deepEqual(reconciliation.exceptions, []);
    assert.ok(snapshot() === settledProjection, 'Replay or reconciliation changed the original settled projection');
    t.diagnostic(JSON.stringify({ fixture: 'manual-payment-service-native-http', heldGenuineCanonicalBlocks: 1,
      successfulTargetBlockReturns, changedAmountBaseUnits: changedPayment.amount, originalAmountBaseUnits: firstInput.payment.amount,
      retainedRetryTicks: 2, heldJournalRows: 0, heldSettledAudits: 0, earlySuccessorPreflights, earlyNativeNonceReads,
      heldNativeSends: 1, totalNativeSends: relay.rawSends.length, consumedNativeNonces: 2,
      settledPayments: 2, journalRows: ledger.journals().length, auditEvents: ledger.events().length,
      originalJournalAmountBaseUnits: ledger.journal(first.id)!.amount, recipientBaseUnits: '132000000',
      reconciliationChecked: reconciliation.checked, reconciliationExceptions: reconciliation.exceptions.length,
      fixtureFieldsRestored: true, originalReservationRetained: true, genuineChainRepliesUnchanged: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch { failures.push(true); } }
    proxy?.release(); await cleanup(() => within(Promise.allSettled([...operations]), 5000));
    await cleanup(() => provider?.destroy()); await cleanup(() => proxy?.close()); await cleanup(() => store?.close());
    if (chain) await cleanup(() => within(chain!.close(), 5000));
    if (failures.length) throw new Error('Confirmation row snapshot fixture cleanup failed');
  }
});
