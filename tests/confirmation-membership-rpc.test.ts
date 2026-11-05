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

const replacementHash = id('conflicting block transaction membership');
type RpcCall = { id: number | string; method: string; params: string[] };
type BlockReply = { id: number | string; result?: { transactions?: string[] } };

async function blockProxy(upstream: string) {
  let fault = true;
  let altered = 0;
  const sends: string[] = [];
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body) as RpcCall | RpcCall[];
        const calls = Array.isArray(payload) ? payload : [payload];
        for (const call of calls) {
          if (call.method === 'eth_sendRawTransaction') sends.push(keccak256(call.params[0]));
        }
        const response = await fetch(upstream, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(3000)
        });
        const result = await response.json() as BlockReply | BlockReply[];
        const replies = Array.isArray(result) ? result : [result];
        for (const reply of replies) {
          const transactions = reply.result?.transactions;
          if (!fault || !sends.length || !Array.isArray(transactions) ||
            !calls.some(call => call.id === reply.id && call.method === 'eth_getBlockByNumber')) continue;
          const index = transactions.indexOf(sends[0]);
          if (index < 0) continue;
          transactions[index] = replacementHash;
          altered++;
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Block fixture upstream unavailable'); }
      }
    })();
    active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    sends,
    altered: () => altered,
    heal() { fault = false; },
    corrupt() { fault = true; },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.allSettled([...active]);
    }
  };
}

test('actual RPC block membership guards confirmation and reviews only the affected settlement', { timeout: 30000 }, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof blockProxy>> | undefined;
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
    if (failures.length) throw new AggregateError(failures, 'Block membership integration cleanup failed');
  });

  compile();
  const local = chain = await localChain();
  const relay = proxy = await blockProxy(local.provider._getConnection().url);
  const rpc = provider = createRpcProvider(relay.url, 2000);
  const ledger = store = new Store();
  const routerAddress = String(local.router.target);
  const relayer = new Wallet(local.relayer.privateKey, rpc);
  const service = new PaymentService(ledger, rpc, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
  const latest = await local.provider.getBlock('latest');
  assert.ok(latest);
  async function signed(amount: string, nonce: string) {
    const payment: Payment = {
      paymentId: id('block membership payment ' + nonce), payer: local.payer.address, payee: local.payee.address,
      token: String(local.token.target), amount, nonce, deadline: String(latest!.timestamp + 3600)
    };
    return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
  }

  const first = (await operation(service.accept(await signed('125000000', '0')))).row;
  const second = (await operation(service.accept(await signed('7000000', '1')))).row;
  await operation(service.tick());
  const reserved = ledger.get(first.id)!;
  assert.ok(reserved.raw_tx && reserved.tx_hash);
  const raw = reserved.raw_tx, hash = reserved.tx_hash;
  const receipt = await local.provider.getTransactionReceipt(hash);
  const presentedReceipt = await rpc.getTransactionReceipt(hash);
  assert.ok(receipt?.status === 1 && presentedReceipt);
  assert.deepEqual(presentedReceipt.toJSON(), receipt.toJSON(), 'Only block membership may change');
  const block = await local.provider.getBlock(receipt.blockNumber);
  const presentedBlock = await rpc.getBlock(receipt.blockNumber);
  assert.ok(block && presentedBlock);
  assert.equal(block.transactions[receipt.index], hash);
  const restored = [...presentedBlock.transactions];
  assert.equal(restored[receipt.index], replacementHash);
  assert.notEqual(restored[receipt.index], hash);
  restored[receipt.index] = hash;
  assert.deepEqual({ ...presentedBlock.toJSON(), transactions: restored }, block.toJSON());
  assert.ok(relay.altered() >= 2, 'The worker and evidence check must both receive the contradiction');

  assert.equal(reserved.status, 'broadcast');
  for (let retry = 0; retry < 3; retry++) {
    await operation(service.tick());
    assert.ok(isDeepStrictEqual(ledger.get(first.id), reserved), 'Fault changed the persisted broadcast');
    assert.ok(isDeepStrictEqual(ledger.get(second.id), second), 'Fault changed the queued successor');
    assert.deepEqual(ledger.journals(), []);
    assert.deepEqual(relay.sends, [hash]);
  }

  relay.heal();
  for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) {
    await operation(service.tick());
  }
  const settled = ledger.get(first.id)!, next = ledger.get(second.id)!;
  assert.equal(settled.status, 'settled');
  assert.ok(settled.raw_tx === raw && settled.tx_hash === hash, 'Healing changed the original reservation');
  assert.equal(next.status, 'settled');
  assert.equal(Transaction.from(next.raw_tx!).nonce, Transaction.from(raw).nonce + 1);
  assert.deepEqual(relay.sends, [hash, next.tx_hash]);
  assert.deepEqual(ledger.journals().map(row => row.tx_hash), [next.tx_hash, hash]);
  assert.equal(await local.token.balanceOf(local.payee.address), 132000000n);
  assert.equal(await local.router.nonces(local.payer.address), 2n);
  const confirmationContradictions = relay.altered();
  const healthy = await operation(service.reconcile());
  assert.equal(healthy.checked, 2);
  assert.deepEqual(healthy.exceptions, []);
  const journals = ledger.journals();
  const audit = ledger.events();

  relay.corrupt();
  const contradictory = await operation(service.reconcile());
  assert.equal(relay.altered(), confirmationContradictions + 1, 'Reconciliation must receive one altered block');
  assert.equal(contradictory.checked, 2);
  assert.deepEqual(contradictory.exceptions, [first.id]);
  const reviewed = ledger.get(first.id)!;
  assert.equal(reviewed.status, 'review');
  assert.equal(reviewed.error, 'Recorded settlement no longer matches canonical receipt and journal');
  assert.ok(isDeepStrictEqual(reviewed, { ...settled, status: 'review', error: reviewed.error, updated_at: reviewed.updated_at }),
    'Review changed the original settlement evidence');
  assert.ok(isDeepStrictEqual(ledger.get(second.id), next), 'Review changed the unaffected settlement');
  assert.deepEqual(ledger.journals(), journals);
  const [reviewEvent, ...earlierEvents] = ledger.events();
  assert.equal(reviewEvent.payment_id, first.id);
  assert.equal(reviewEvent.action, 'review');
  assert.deepEqual(earlierEvents, audit);

  const repeated = await operation(service.reconcile());
  assert.equal(repeated.checked, 1);
  assert.deepEqual(repeated.exceptions, []);
  assert.ok(isDeepStrictEqual(ledger.get(first.id), reviewed));
  assert.ok(isDeepStrictEqual(ledger.get(second.id), next));
  assert.deepEqual(ledger.journals(), journals);
  assert.deepEqual(ledger.events(), [reviewEvent, ...audit]);
  assert.deepEqual(relay.sends, [hash, next.tx_hash]);
  t.diagnostic(JSON.stringify({ contradictoryBlocks: confirmationContradictions, recoveredSettlements: 2,
    reconciliationContradictoryBlocks: relay.altered() - confirmationContradictions, reviewedSettlements: 1,
    retainedJournals: journals.length, nativeSends: relay.sends.length }));
});
