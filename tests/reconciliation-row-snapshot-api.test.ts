import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { Wallet, id } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { makeServer } from '../src/http.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';

type RpcCall = { id: number | string; method: string; params: unknown[] };
type GateMethod = 'eth_getTransactionReceipt' | 'eth_getBlockByNumber';
type RpcReply = { id: number | string; result?: { transactionHash?: string; transactions?: string[] } | null };
const MANUAL_REASON = 'PRIVATE_SUPPORTED_REVIEW_REASON_CANARY';
const SIGNATURE_CANARY = 'PRIVATE_RECONCILIATION_SIGNATURE_CANARY';
const UNAVAILABLE = { error: 'Upstream RPC unavailable; check payment history before retrying' };

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Reconciliation snapshot fixture operation exceeded its bound')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Hold a selected genuine upstream reply; forward its bytes without alteration. */
async function gatedProxy(upstream: string) {
  const calls: RpcCall[] = [], rawSends: string[] = [];
  const active = new Set<Promise<void>>();
  let heldReplies = 0;
  let gate: { method: GateMethod; hash: string; taken: boolean; enter(): void; wait: Promise<void>; release(): void;
    result?: unknown; params?: unknown[] } | undefined;
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
        const bytes = await response.text();
        const result = JSON.parse(bytes) as RpcReply | RpcReply[];
        const current = gate;
        if (current && !current.taken) {
          for (const reply of Array.isArray(result) ? result : [result]) {
            const call = batch.find(candidate => candidate.id === reply.id);
            const matches = call?.method === current.method && (current.method === 'eth_getTransactionReceipt'
              ? call.params[0] === current.hash && reply.result?.transactionHash === current.hash
              : reply.result?.transactions?.includes(current.hash));
            if (!matches) continue;
            current.taken = true; current.result = reply.result; current.params = call!.params;
            heldReplies++; current.enter(); await current.wait; break;
          }
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Reconciliation snapshot fixture upstream unavailable'); }
      }
    })();
    active.add(pending); void pending.then(() => active.delete(pending), () => active.delete(pending));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    calls, rawSends, heldReplies: () => heldReplies,
    hold(method: GateMethod, hash: string) {
      gate?.release();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
      const wait = new Promise<void>(resolveRelease => { release = resolveRelease; });
      const selected = { method, hash, taken: false, enter, wait, release,
        result: undefined as unknown, params: undefined as unknown[] | undefined };
      gate = selected;
      return { entered, release, result: () => selected.result, params: () => selected.params };
    },
    release() { gate?.release(); },
    async close() {
      gate?.release(); const closed = new Promise<void>(resolveClose => server.close(() => resolveClose()));
      server.closeAllConnections(); await within(Promise.all([closed, Promise.allSettled([...active])]), 5000);
    }
  };
}

// A supported Store review and a separate direct-SQL fault are controlled local
// mutations during genuine RPC awaits. No user API permits evidence rewriting;
// manual PaymentService ticks do not establish autonomous CLI or Besu behavior.
test('authenticated reconciliation retains newer payment rows across held genuine receipt and block replies', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof gatedProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined, api: ReturnType<typeof makeServer> | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>): Promise<T> {
    const safe = pending.catch(() => { throw new Error('Reconciliation row snapshot fixture operation failed'); });
    operations.add(safe); void safe.then(() => operations.delete(safe), () => operations.delete(safe)); return safe;
  }
  try {
    compile();
    const local = chain = await operation(localChain());
    const relay = proxy = await gatedProxy(local.provider._getConnection().url);
    const rpc = provider = createRpcProvider(relay.url, 5000), ledger = store = new Store();
    // Count successful factory returns, not merely proxy forwarding. A held
    // exchange that times out must never satisfy a changed-row 503 assertion.
    const resolvedReceipts = new Map<string, number>(), resolvedBlocks = new Map<string, number>();
    const getReceipt = rpc.getTransactionReceipt.bind(rpc), getBlock = rpc.getBlock.bind(rpc);
    rpc.getTransactionReceipt = async transactionHash => {
      const receipt = await getReceipt(transactionHash);
      if (receipt) resolvedReceipts.set(receipt.hash, (resolvedReceipts.get(receipt.hash) ?? 0) + 1);
      return receipt;
    };
    rpc.getBlock = async (blockHashOrBlockTag, prefetchTxs) => {
      const block = await getBlock(blockHashOrBlockTag, prefetchTxs);
      if (block?.hash) resolvedBlocks.set(block.hash, (resolvedBlocks.get(block.hash) ?? 0) + 1);
      return block;
    };
    const routerAddress = await local.router.getAddress(), relayer = new Wallet(local.relayer.privateKey, rpc);
    const service = new PaymentService(ledger, rpc, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    const latest = await operation(local.provider.getBlock('latest')); assert.ok(latest);
    const nativeNonce = await operation(local.provider.getTransactionCount(relayer.address, 'pending'));
    const initialPayerTokens = await operation<bigint>(local.token.balanceOf(local.payer.address));
    async function accept(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id('reconciliation row snapshot ' + nonce), payer: local.payer.address,
        payee: local.payee.address, token: await local.token.getAddress(), amount, nonce,
        deadline: String(latest!.timestamp + 3600) };
      return (await operation(service.accept({ payment,
        signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) }))).row;
    }
    const first = await accept('125000000', '0'), second = await accept('7000000', '1');
    for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
    const originalFirst = ledger.get(first.id)!, originalSecond = ledger.get(second.id)!;
    assert.equal(originalFirst.status, 'settled'); assert.equal(originalSecond.status, 'settled');
    assert.ok(originalFirst.tx_hash && originalSecond.tx_hash);
    assert.equal(ledger.journals().length, 2); assert.equal(ledger.events().length, 6); assert.equal(relay.rawSends.length, 2);
    const journals = ledger.journals();
    const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
      changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
    const apiKey = 'reconciliation-row-snapshot-api-' + 'a'.repeat(32);
    api = makeServer({ service, apiKey, port: 0, mode: 'rpc' });
    api.listen(0, '127.0.0.1'); await once(api, 'listening');
    const apiUrl = 'http://127.0.0.1:' + (api.address() as { port: number }).port;
    async function reconcile() {
      const response = await fetch(apiUrl + '/api/reconcile', { method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(10000) });
      return { status: response.status, text: await response.text() };
    }
    function assertUnavailable(result: { status: number; text: string }) {
      assert.equal(result.status, 503); assert.deepEqual(JSON.parse(result.text), UNAVAILABLE);
      for (const marker of [MANUAL_REASON, SIGNATURE_CANARY, originalFirst.signature, originalSecond.signature,
        originalFirst.raw_tx!, originalSecond.raw_tx!, relay.url])
        assert.ok(!result.text.includes(marker), 'Reconciliation exposed private row or upstream details');
    }
    async function assertFreshScan() {
      const held = snapshot(), result = await operation(reconcile()); assert.equal(result.status, 200);
      const report = JSON.parse(result.text) as { checked: number; exceptions: string[]; outstandingReviews: number };
      assert.equal(report.checked, 1); assert.deepEqual(report.exceptions, []); assert.equal(report.outstandingReviews, 1);
      assert.ok(snapshot() === held, 'A fresh scan changed retained review, settlement or audit evidence');
      return report;
    }
    const receiptReads = (hash: string) => relay.calls.filter(call =>
      call.method === 'eth_getTransactionReceipt' && call.params[0] === hash).length;
    const blockReads = (number: number) => relay.calls.filter(call =>
      call.method === 'eth_getBlockByNumber' && call.params[0] === '0x' + number.toString(16)).length;

    const receiptGate = relay.hold('eth_getTransactionReceipt', originalFirst.tx_hash);
    const firstReceiptBaseline = receiptReads(originalFirst.tx_hash), firstBlockBaseline = blockReads(originalFirst.block_number!);
    const firstReceiptReturnBaseline = resolvedReceipts.get(originalFirst.tx_hash) ?? 0;
    const firstRequest = operation(reconcile()); await operation(within(receiptGate.entered, 5000));
    const genuineReceipt = await operation(local.provider.send('eth_getTransactionReceipt', receiptGate.params()!));
    assert.deepEqual(receiptGate.result(), genuineReceipt, 'The held receipt must remain genuine and unaltered');
    ledger.setStatus(first.id, 'review', MANUAL_REASON);
    const reviewed = ledger.get(first.id)!, afterReview = snapshot();
    assert.equal(reviewed.status, 'review'); assert.ok(reviewed.error === MANUAL_REASON);
    assert.ok(isDeepStrictEqual(ledger.get(second.id), originalSecond));
    assert.equal(resolvedReceipts.get(originalFirst.tx_hash) ?? 0, firstReceiptReturnBaseline,
      'The selected factory receipt must remain unresolved while its reply is gated');
    receiptGate.release(); const reviewedResponse = await firstRequest;
    const receiptRaceSuccessfulReturns = (resolvedReceipts.get(originalFirst.tx_hash) ?? 0) - firstReceiptReturnBaseline;
    assert.equal(receiptRaceSuccessfulReturns, 1, 'Receipt-race 503 must follow successful target factory resolution');
    assertUnavailable(reviewedResponse);
    const receiptRaceReads = receiptReads(originalFirst.tx_hash) - firstReceiptBaseline;
    const receiptRaceBlockReads = blockReads(originalFirst.block_number!) - firstBlockBaseline;
    assert.equal(receiptRaceReads, 1); assert.equal(receiptRaceBlockReads, 0);
    assert.equal(relay.rawSends.length, 2);
    assert.ok(snapshot() === afterReview, 'Stale receipt processing changed the newer supported review state');
    assert.ok(isDeepStrictEqual(ledger.get(first.id), reviewed), 'Stale reconciliation replaced the manual review reason');
    assert.deepEqual(ledger.journals(), journals);
    assert.equal(ledger.events().filter(event => event.payment_id === first.id && event.action === 'review').length, 1);
    await assertFreshScan();

    const blockGate = relay.hold('eth_getBlockByNumber', originalSecond.tx_hash);
    const secondReceiptBaseline = receiptReads(originalSecond.tx_hash), secondBlockBaseline = blockReads(originalSecond.block_number!);
    const secondBlockReturnBaseline = resolvedBlocks.get(originalSecond.block_hash!) ?? 0;
    const secondRequest = operation(reconcile()); await operation(within(blockGate.entered, 5000));
    const genuineBlock = await operation(local.provider.send('eth_getBlockByNumber', blockGate.params()!));
    assert.deepEqual(blockGate.result(), genuineBlock, 'The held containing block must remain genuine and unaltered');
    // Fixture-only SQL mutation simulates changed local evidence, not a supported
    // user repair endpoint or a chain-side signature/transaction change.
    ledger.db.prepare('UPDATE payments SET signature=? WHERE id=?').run(SIGNATURE_CANARY, second.id);
    const changed = ledger.get(second.id)!, afterSignatureChange = snapshot();
    assert.ok(changed.signature === SIGNATURE_CANARY); assert.equal(changed.status, 'settled');
    assert.equal(resolvedBlocks.get(originalSecond.block_hash!) ?? 0, secondBlockReturnBaseline,
      'The selected factory block must remain unresolved while its reply is gated');
    blockGate.release(); const changedResponse = await secondRequest;
    const blockRaceSuccessfulReturns = (resolvedBlocks.get(originalSecond.block_hash!) ?? 0) - secondBlockReturnBaseline;
    assert.equal(blockRaceSuccessfulReturns, 1, 'Block-race 503 must follow successful target factory resolution');
    assertUnavailable(changedResponse);
    const blockRaceReceiptReads = receiptReads(originalSecond.tx_hash) - secondReceiptBaseline;
    const blockRaceReads = blockReads(originalSecond.block_number!) - secondBlockBaseline;
    assert.equal(blockRaceReceiptReads, 1); assert.equal(blockRaceReads, 1); assert.equal(relay.rawSends.length, 2);
    assert.ok(snapshot() === afterSignatureChange, 'Stale block processing changed the newer local evidence');
    assert.ok(isDeepStrictEqual(ledger.get(first.id), reviewed)); assert.deepEqual(ledger.journals(), journals);
    assert.equal(ledger.events().length, 7);
    ledger.db.prepare('UPDATE payments SET signature=? WHERE id=?').run(originalSecond.signature, second.id);
    assert.ok(isDeepStrictEqual(ledger.get(second.id), originalSecond), 'Fixture restoration must restore the exact saved row');
    const finalReport = await assertFreshScan();
    assert.equal(relay.heldReplies(), 2); assert.equal(relay.rawSends.length, 2);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), nativeNonce + 2);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 2n);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 132000000n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens - 132000000n);
    t.diagnostic(JSON.stringify({ fixture: 'manual-payment-service-native-http-api', genuineHeldReplies: 2,
      supportedReviewReceiptRace: true, syntheticSignatureBlockRace: true, changedRowResponses: [reviewedResponse.status, changedResponse.status],
      receiptRaceReads, receiptRaceBlockReads, blockRaceReceiptReads, blockRaceReads,
      receiptRaceSuccessfulReturns, blockRaceSuccessfulReturns,
      paymentRows: ledger.list().length, retainedJournals: ledger.journals().length, auditEvents: ledger.events().length,
      nativeSends: relay.rawSends.length, consumedNativeNonces: 2, recipientBaseUnits: '132000000',
      freshScanChecked: finalReport.checked, freshScanExceptions: finalReport.exceptions.length,
      outstandingReviews: finalReport.outstandingReviews, manualReviewReasonRetained: true,
      fixtureSignatureRestored: true, genuineChainRepliesUnchanged: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch { failures.push(true); } }
    proxy?.release();
    if (api) await cleanup(async () => {
      const closed = new Promise<void>(resolveClose => api!.close(() => resolveClose()));
      api!.closeAllConnections(); await within(Promise.all([closed, api!.drainRequests()]), 5000);
    });
    await cleanup(() => within(Promise.allSettled([...operations]), 5000));
    await cleanup(() => provider?.destroy()); await cleanup(() => proxy?.close()); await cleanup(() => store?.close());
    if (chain) await cleanup(() => within(chain!.close(), 5000));
    if (failures.length) throw new Error('Reconciliation row snapshot fixture cleanup failed');
  }
});
