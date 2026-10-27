import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Wallet, id, keccak256, Transaction, type TransactionReceipt } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';

type Provenance = 'transactionHash' | 'blockHash' | 'blockNumber';
const fields: Provenance[] = ['transactionHash', 'blockHash', 'blockNumber'];
const differentHash = (value: string) => '0x' + (value.toLowerCase() === '0x' + 'fa'.repeat(32) ? 'fb' : 'fa').repeat(32);

/** Only the matching event's JSON provenance changes; all requests reach Ganache. */
async function receiptProxy(upstream: string, routerAddress: string, topic: string) {
  let fault: Provenance | undefined, target: string | undefined, altered = 0;
  const sends: string[] = [];
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body);
        const calls = Array.isArray(payload) ? payload : [payload];
        for (const call of calls) if (call.method === 'eth_sendRawTransaction') sends.push(keccak256(call.params[0]));
        const response = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          signal: AbortSignal.timeout(3000) });
        const result = await response.json() as any;
        const replies = Array.isArray(result) ? result : [result];
        for (const reply of replies) {
          if (!fault || !calls.some(call => call.id === reply.id && call.method === 'eth_getTransactionReceipt') ||
            !reply.result || !Array.isArray(reply.result.logs)) continue;
          const receipt = reply.result;
          if (target && receipt.transactionHash.toLowerCase() !== target) continue;
          for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== routerAddress.toLowerCase() || log.topics[0]?.toLowerCase() !== topic.toLowerCase()) continue;
            target ??= receipt.transactionHash.toLowerCase();
            log[fault] = fault === 'blockNumber' ? '0x' + (BigInt(log.blockNumber) + 1n).toString(16) : differentHash(log[fault]);
            altered++;
          }
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Receipt fixture upstream unavailable'); }
      }
    })();
    active.add(operation);
    void operation.finally(() => active.delete(operation));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as { port: number }).port,
    sends,
    corrupt(field: Provenance, hash?: string) { fault = field; target = hash?.toLowerCase(); },
    heal() { fault = undefined; target = undefined; },
    altered: () => altered,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolveClose => server.close(() => resolveClose()));
      await Promise.allSettled([...active]);
    }
  };
}

let chain: Awaited<ReturnType<typeof localChain>>;
let snapshot: string;
let proxy: Awaited<ReturnType<typeof receiptProxy>>;
let provider: ReturnType<typeof createRpcProvider>;
let store: Store;
let service: PaymentService;
let operations: Set<Promise<unknown>>;
before(async () => { compile(); chain = await localChain(); });
after(async () => { await chain?.close(); });
beforeEach(async () => {
  snapshot = await chain.provider.send('evm_snapshot', []);
  proxy = await receiptProxy(chain.provider._getConnection().url, String(chain.router.target), chain.router.interface.getEvent('PaymentSettled')!.topicHash);
  provider = createRpcProvider(proxy.url, 2000);
  const relayer = new Wallet(chain.relayer.privateKey, provider);
  store = new Store(); operations = new Set();
  service = new PaymentService(store, provider, relayer, connectRouter(String(chain.router.target), relayer), 31337, String(chain.router.target));
});
function operation<T>(pending: Promise<T>): Promise<T> {
  operations.add(pending);
  void pending.then(() => operations.delete(pending), () => operations.delete(pending));
  return pending;
}
afterEach(async () => {
  const failures: unknown[] = [];
  async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
  proxy?.heal();
  await cleanup(() => provider?.destroy());
  await cleanup(() => proxy?.close());
  // HTTP timeouts bound outstanding calls; wait before closing writable SQLite.
  await Promise.allSettled([...(operations ?? [])]);
  await cleanup(() => store?.close());
  await cleanup(() => chain.provider.send('evm_revert', [snapshot]));
  if (failures.length) throw new AggregateError(failures, 'Log provenance integration cleanup failed');
});
async function signed(amount: string, nonce: string) {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain.payer.address,
    payee: chain.payee.address, token: String(chain.token.target), amount, nonce, deadline: String(block!.timestamp + 3600) };
  return { payment, signature: await chain.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
function matchingLog(receipt: TransactionReceipt) {
  const index = receipt.logs.findIndex(log => log.address.toLowerCase() === String(chain.router.target).toLowerCase() &&
    log.topics[0] === chain.router.interface.getEvent('PaymentSettled')!.topicHash);
  assert.ok(index >= 0, 'Actual receipt must contain the genuine router event');
  return { log: receipt.logs[index], index };
}

// Real HTTP JSON-RPC and ethers formatting are exercised. Service ticks are
// explicitly driven; this does not claim autonomous CLI or Besu validation.
for (const field of fields) test('actual RPC log ' + field + ' contradiction blocks confirmation and later flags reconciliation', {
  timeout: 30000
}, async t => {
  const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
  const first = (await operation(service.accept(firstInput))).row;
  const second = (await operation(service.accept(secondInput))).row;
  proxy.corrupt(field);
  await operation(service.tick());
  const reserved = store.get(first.id)!;
  assert.equal(reserved.status, 'broadcast');
  assert.ok(reserved.raw_tx && reserved.tx_hash);
  const originalRaw = reserved.raw_tx, originalHash = reserved.tx_hash;
  const nativeNonce = Transaction.from(originalRaw).nonce;
  assert.equal(keccak256(originalRaw), originalHash);

  const genuine = await chain.provider.getTransactionReceipt(originalHash);
  const presented = await provider.getTransactionReceipt(originalHash);
  assert.ok(genuine && presented);
  assert.equal(genuine.status, 1);
  const { log, index } = matchingLog(presented);
  const genuineLog = genuine.logs[index];
  assert.equal(log[field], field === 'blockNumber' ? genuineLog.blockNumber + 1 : differentHash(genuineLog[field] as string));
  assert.notEqual(log[field], genuineLog[field], 'ethers must retain the contradictory RPC provenance');
  const repairedPresentation = JSON.parse(JSON.stringify(presented));
  repairedPresentation.logs[index][field] = genuineLog[field];
  assert.deepEqual(repairedPresentation, JSON.parse(JSON.stringify(genuine)), 'Only matching-log provenance may differ from the genuine receipt');
  assert.ok(proxy.altered() >= 2);

  for (let retry = 0; retry < 3; retry++) {
    await operation(service.tick());
    assert.equal(store.get(first.id)!.status, 'broadcast');
    assert.ok(store.get(first.id)!.raw_tx === originalRaw, 'Uncertain provenance changed signed bytes');
    assert.equal(store.get(first.id)!.tx_hash, originalHash);
    assert.equal(store.get(second.id)!.status, 'queued');
    assert.equal(store.get(second.id)!.raw_tx, null); assert.equal(store.get(second.id)!.tx_hash, null);
    assert.equal(store.journals().length, 0);
    assert.equal(store.events().filter(event => event.action === 'accepted').length, 2);
    assert.equal(store.events().filter(event => event.action === 'broadcast-prepared').length, 1);
    assert.equal(store.events().filter(event => event.action === 'settled' || event.action === 'failed' || event.action === 'review').length, 0);
  }
  assert.deepEqual(proxy.sends, [originalHash]);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  assert.equal(await chain.router.nonces(chain.payer.address), 1n);
  assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), nativeNonce + 1);

  proxy.heal();
  for (let retry = 0; retry < 4 && store.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
  assert.equal(store.get(first.id)!.status, 'settled'); assert.equal(store.get(second.id)!.status, 'settled');
  assert.ok(store.get(first.id)!.raw_tx === originalRaw, 'Healing replaced the first signed transaction');
  assert.equal(store.get(first.id)!.tx_hash, originalHash);
  assert.equal(Transaction.from(store.get(second.id)!.raw_tx!).nonce, nativeNonce + 1);
  assert.equal(store.journals().length, 2);
  assert.deepEqual(proxy.sends, [originalHash, store.get(second.id)!.tx_hash]);
  for (const input of [firstInput, secondInput]) assert.equal((await operation(service.accept(input))).replay, true);
  const healthy = await operation(service.reconcile());
  assert.equal(healthy.checked, 2); assert.deepEqual(healthy.exceptions, []);
  for (const paymentId of [first.id, second.id]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
    assert.equal(store.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
  assert.equal(await chain.router.nonces(chain.payer.address), 2n);

  const journalEvidence = store.journals();
  proxy.corrupt(field, originalHash);
  const secondReceipt = await provider.getTransactionReceipt(store.get(second.id)!.tx_hash!);
  assert.ok(secondReceipt);
  const secondLog = matchingLog(secondReceipt).log;
  assert.equal(secondLog.transactionHash, secondReceipt.hash);
  assert.equal(secondLog.blockHash, secondReceipt.blockHash);
  assert.equal(secondLog.blockNumber, secondReceipt.blockNumber);
  const inconsistent = await operation(service.reconcile());
  assert.equal(inconsistent.checked, 2); assert.deepEqual(inconsistent.exceptions, [first.id]);
  assert.equal(store.get(first.id)!.status, 'review'); assert.equal(store.get(second.id)!.status, 'settled');
  assert.deepEqual(store.journals(), journalEvidence);
  assert.equal(store.events().filter(event => event.payment_id === first.id && event.action === 'review').length, 1);
  const repeated = await operation(service.reconcile());
  assert.equal(repeated.checked, 1); assert.deepEqual(repeated.exceptions, []);
  proxy.heal(); await operation(service.tick());
  assert.equal(store.get(first.id)!.status, 'review', 'Reconciliation must not automatically repair reviewed evidence');
  assert.deepEqual(store.journals(), journalEvidence);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
  assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), nativeNonce + 2);
  assert.equal(proxy.sends.length, 2);
  t.diagnostic(JSON.stringify({ contradictoryField: field, formatterRetainedContradiction: true,
    settledBeforeReconciliation: healthy.checked, reviewedPayments: 1, retainedJournalRows: store.journals().length, nativeSends: proxy.sends.length }));
});
