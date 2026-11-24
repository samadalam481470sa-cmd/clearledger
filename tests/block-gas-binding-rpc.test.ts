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
import { paymentTypes, type Payment } from '../src/payment.ts';

type RpcCall = { id: number | string; method: string; params: string[] };
type RpcReply = { id: number | string; result?: { transactions?: string[]; gasUsed?: string } | null };

/** Present a block total below even the conservative two-dimension receipt ceiling. */
async function blockGasProxy(upstream: string) {
  let fault = true;
  let altered = 0;
  const rawSends: string[] = [];
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body) as RpcCall | RpcCall[];
        const calls = Array.isArray(payload) ? payload : [payload];
        for (const call of calls) if (call.method === 'eth_sendRawTransaction') rawSends.push(call.params[0]);
        const response = await fetch(upstream, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          signal: AbortSignal.timeout(3000)
        });
        const result = await response.json() as RpcReply | RpcReply[];
        for (const reply of Array.isArray(result) ? result : [result]) {
          const call = calls.find(request => request.id === reply.id);
          const block = reply.result;
          if (!fault || !rawSends.length || call?.method !== 'eth_getBlockByNumber' ||
            !block?.transactions?.includes(keccak256(rawSends[0])) || typeof block.gasUsed !== 'string') continue;
          block.gasUsed = '0x' + ((BigInt(block.gasUsed) - 1n) / 2n).toString(16);
          altered++;
        }
        if (!res.destroyed) {
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Gas binding fixture upstream unavailable'); }
      }
    })();
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    rawSends,
    altered: () => altered,
    corrupt() { fault = true; },
    heal() { fault = false; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...active]);
    }
  };
}

test('actual RPC conservative two-dimension gas ceiling preserves confirmation and reviewed evidence', { timeout: 30000 }, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof blockGasProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>) {
    operations.add(pending);
    void pending.then(() => operations.delete(pending), () => operations.delete(pending));
    return pending;
  }
  t.after(async () => {
    const failures: unknown[] = [];
    for (const cleanup of [
      () => provider?.destroy(), () => proxy?.close(), () => Promise.allSettled([...operations]),
      () => store?.close(), () => chain?.close()
    ]) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Block gas binding integration cleanup failed');
  });

  compile();
  const local = chain = await localChain();
  const relay = proxy = await blockGasProxy(local.provider._getConnection().url);
  const rpc = provider = createRpcProvider(relay.url, 2000);
  const ledger = store = new Store();
  const routerAddress = String(local.router.target);
  const relayer = new Wallet(local.relayer.privateKey, rpc);
  const service = new PaymentService(ledger, rpc, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
  const latest = await local.provider.getBlock('latest');
  assert.ok(latest);
  const initialNativeNonce = await local.provider.getTransactionCount(relayer.address, 'pending');
  async function accept(amount: string, nonce: string) {
    const payment: Payment = {
      paymentId: id('block gas binding payment ' + nonce), payer: local.payer.address,
      payee: local.payee.address, token: String(local.token.target), amount, nonce,
      deadline: String(latest!.timestamp + 3600)
    };
    return (await operation(service.accept({ payment,
      signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) }))).row;
  }
  const first = await accept('125000000', '0'), second = await accept('7000000', '1');
  await operation(service.tick());
  const reserved = ledger.get(first.id)!;
  assert.ok(reserved.raw_tx && reserved.tx_hash);
  const raw = reserved.raw_tx, hash = reserved.tx_hash;
  const receipt = await local.provider.getTransactionReceipt(hash);
  const block = receipt && await local.provider.getBlock(receipt.blockNumber);
  assert.ok(receipt?.status === 1 && block);
  assert.equal(receipt.index, 0);
  assert.deepEqual(block.transactions, [hash], 'The genuine transaction must be the only and final block member');
  assert.equal(receipt.cumulativeGasUsed, receipt.gasUsed);
  assert.equal(block.gasUsed, receipt.cumulativeGasUsed);
  const alteredGasUsed = (receipt.cumulativeGasUsed - 1n) / 2n;
  assert.ok(alteredGasUsed > 0n && alteredGasUsed <= block.gasLimit &&
    2n * alteredGasUsed < receipt.cumulativeGasUsed,
    'The altered total must retain the old budget checks but contradict the conservative two-dimension ceiling');
  assert.equal(reserved.status, 'broadcast');
  assert.ok(isDeepStrictEqual(ledger.get(second.id), second));
  const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
    changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
  const held = snapshot();
  {
    relay.corrupt();
    const presentedReceipt = await operation(rpc.getTransactionReceipt(hash));
    const presentedBlock = await operation(rpc.getBlock(receipt.blockNumber));
    assert.ok(presentedReceipt && presentedBlock);
    assert.deepEqual(presentedReceipt.toJSON(), receipt.toJSON(), 'The receipt must remain genuine');
    assert.equal(presentedBlock.gasUsed, alteredGasUsed);
    assert.deepEqual({ ...presentedBlock.toJSON(), gasUsed: block.gasUsed.toString() }, block.toJSON(),
      'Only the block gas total may change');
    const before = relay.altered();
    for (let retry = 0; retry < 2; retry++) await operation(service.tick());
    assert.equal(relay.altered(), before + 2);
    assert.ok(snapshot() === held, 'A receipt above twice the block total changed the original reservation, queue or private projection');
    assert.equal(relay.rawSends.length, 1);
    assert.ok(relay.rawSends[0] === raw, 'The first send must use the retained signed bytes');
    assert.equal(await local.provider.getTransactionCount(relayer.address, 'pending'), initialNativeNonce + 1);
    assert.equal(await local.token.balanceOf(local.payee.address), 125000000n);
    assert.equal(await local.router.nonces(local.payer.address), 1n);
  }
  const confirmationContradictions = relay.altered();
  relay.heal();
  for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
  const settled = ledger.get(first.id)!, successor = ledger.get(second.id)!;
  assert.equal(settled.status, 'settled');
  assert.ok(settled.raw_tx === raw && settled.tx_hash === hash, 'Healing replaced the original signed reservation');
  assert.equal(successor.status, 'settled');
  assert.equal(Transaction.from(successor.raw_tx!).nonce, Transaction.from(raw).nonce + 1);
  assert.equal(await local.provider.getTransactionCount(relayer.address, 'pending'), initialNativeNonce + 2);
  assert.equal(await local.token.balanceOf(local.payee.address), 132000000n);
  assert.equal(await local.router.nonces(local.payer.address), 2n);
  assert.equal(relay.rawSends.length, 2);
  const journals = ledger.journals(), audit = ledger.events();
  assert.deepEqual(journals.map(row => row.tx_hash), [successor.tx_hash, hash]);
  assert.equal(audit.length, 6);
  const healthy = await operation(service.reconcile());
  assert.equal(healthy.checked, 2); assert.deepEqual(healthy.exceptions, []);

  relay.corrupt();
  const beforeReview = relay.altered();
  const result = await operation(service.reconcile());
  assert.equal(relay.altered(), beforeReview + 1, 'Only the first recorded settlement block may be contradicted');
  assert.equal(result.checked, 2); assert.deepEqual(result.exceptions, [first.id]);
  assert.equal(result.outstandingReviews, 1);
  const reviewed = ledger.get(first.id)!;
  assert.equal(reviewed.status, 'review');
  assert.ok(isDeepStrictEqual(reviewed, { ...settled, status: 'review', error: reviewed.error, updated_at: reviewed.updated_at }),
    'Review replaced original settlement evidence');
  assert.ok(isDeepStrictEqual(ledger.get(second.id), successor), 'Review changed the unaffected settlement');
  assert.deepEqual(ledger.journals(), journals);
  const [reviewEvent, ...earlier] = ledger.events();
  assert.equal(reviewEvent.payment_id, first.id); assert.equal(reviewEvent.action, 'review');
  assert.deepEqual(earlier, audit);
  const repeated = await operation(service.reconcile());
  assert.equal(repeated.checked, 1); assert.deepEqual(repeated.exceptions, []);
  assert.equal(repeated.outstandingReviews, 1);
  assert.ok(isDeepStrictEqual(ledger.get(first.id), reviewed));
  assert.ok(isDeepStrictEqual(ledger.get(second.id), successor));
  assert.deepEqual(ledger.journals(), journals); assert.deepEqual(ledger.events(), [reviewEvent, ...audit]);
  assert.equal(relay.rawSends.length, 2);
  t.diagnostic(JSON.stringify({ ceilingMultiplier: 2, presentedBlockGasUsed: alteredGasUsed.toString(),
    receiptCumulativeGasUsed: receipt.cumulativeGasUsed.toString(), alteredBlockReplies: confirmationContradictions,
    receiptUnchanged: true, heldNativeSends: 1, settledAfterHealing: 2, consumedNativeNonces: 2,
    reviewedSettlements: 1, retainedJournals: journals.length, totalNativeSends: relay.rawSends.length }));
});
