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
type RpcReply = { id: number | string; result?: unknown };
const PREPARATION_CHANGED = 'Stored queued payment changed during preparation; retry';

async function within<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Preparation snapshot fixture operation exceeded its bound')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/** Hold a genuine pending relayer balance reply after gas/fee population. */
async function balanceGateProxy(upstream: string, relayer: string) {
  const calls: RpcCall[] = [], rawSends: string[] = [];
  const active = new Set<Promise<void>>();
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
  const wait = new Promise<void>(resolveRelease => { release = resolveRelease; });
  let taken = false, heldResult: unknown, heldParams: unknown[] | undefined;
  const server = createServer((req, res) => {
    const pending = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString('utf8');
        const payload = JSON.parse(body) as RpcCall | RpcCall[];
        const batch = Array.isArray(payload) ? payload : [payload]; calls.push(...batch);
        for (const call of batch) if (call.method === 'eth_sendRawTransaction' && typeof call.params[0] === 'string')
          rawSends.push(call.params[0]);
        const response = await fetch(upstream, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(3000) });
        const bytes = await response.text(), result = JSON.parse(bytes) as RpcReply | RpcReply[];
        if (!taken) for (const reply of Array.isArray(result) ? result : [result]) {
          const call = batch.find(candidate => candidate.id === reply.id);
          if (call?.method !== 'eth_getBalance' || String(call.params[0]).toLowerCase() !== relayer.toLowerCase() ||
            call.params[1] !== 'pending' || typeof reply.result !== 'string') continue;
          taken = true; heldResult = reply.result; heldParams = call.params;
          enter(); await wait; break;
        }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(bytes); }
      } catch {
        if (!res.destroyed) { res.writeHead(502); res.end('Preparation snapshot fixture upstream unavailable'); }
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

// Fixture-only SQL mutation/restoration and manual PaymentService ticks exercise
// genuine Ganache HTTP responses. No user evidence-repair API, autonomous CLI
// scheduling, real reorganization or Besu behavior is established.
test('queued preparation rejects a changed row after a genuine gas-budget balance return without signing', {
  timeout: 45000
}, async t => {
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof balanceGateProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let store: Store | undefined;
  const operations = new Set<Promise<unknown>>();
  function operation<T>(pending: Promise<T>): Promise<T> {
    const safe = pending.catch(() => { throw new Error('Preparation row snapshot fixture operation failed'); });
    operations.add(safe); void safe.then(() => operations.delete(safe), () => operations.delete(safe)); return safe;
  }
  try {
    compile();
    const local = chain = await operation(localChain());
    const relay = proxy = await balanceGateProxy(local.provider._getConnection().url, local.relayer.address);
    const rpc = provider = createRpcProvider(relay.url, 5000), ledger = store = new Store();
    let successfulTargetBalanceReturns = 0;
    const getBalance = rpc.getBalance.bind(rpc);
    rpc.getBalance = async (address, blockTag) => {
      const balance = await getBalance(address, blockTag);
      if (typeof address === 'string' && address.toLowerCase() === local.relayer.address.toLowerCase() && blockTag === 'pending')
        successfulTargetBalanceReturns++;
      return balance;
    };
    const routerAddress = await local.router.getAddress(), relayer = new Wallet(local.relayer.privateKey, rpc);
    let signingCalls = 0;
    const signTransaction = relayer.signTransaction.bind(relayer);
    relayer.signTransaction = async transaction => { signingCalls++; return signTransaction(transaction); };
    const router = connectRouter(routerAddress, relayer);
    const service = new PaymentService(ledger, rpc, relayer, router, 31337, routerAddress);
    const latest = await operation(local.provider.getBlock('latest')); assert.ok(latest);
    const nativeNonce = await operation(local.provider.getTransactionCount(relayer.address, 'pending'));
    const initialPayerTokens = await operation<bigint>(local.token.balanceOf(local.payer.address));
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id('preparation row snapshot ' + nonce), payer: local.payer.address,
        payee: local.payee.address, token: await local.token.getAddress(), amount, nonce,
        deadline: String(latest!.timestamp + 3600) };
      return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const first = (await operation(service.accept(firstInput))).row, second = (await operation(service.accept(secondInput))).row;
    // Resolve rejection as data so an unexpected RPC error cannot print signed
    // arguments; only the fixed preparation-change diagnostic is accepted below.
    const firstTick = operation(service.tick().then(() => ({ rejected: false, error: undefined as unknown }),
      error => ({ rejected: true, error: error as unknown })));
    await operation(within(relay.entered, 5000));
    const genuineBalance = await operation(local.provider.send('eth_getBalance', relay.params()!));
    assert.ok(relay.result() === genuineBalance && typeof genuineBalance === 'string' && BigInt(genuineBalance) > 0n,
      'The gas-budget reply must retain the genuine positive pending balance');
    const nonceReadsAtGate = relay.calls.filter(call => call.method === 'eth_getTransactionCount').length;
    const gasEstimatesAtGate = relay.calls.filter(call => call.method === 'eth_estimateGas').length;
    assert.ok(nonceReadsAtGate > 0 && gasEstimatesAtGate > 0, 'Gas-budget gating must follow genuine nonce and estimate work');
    assert.equal(successfulTargetBalanceReturns, 0); assert.equal(signingCalls, 0);
    assert.ok(isDeepStrictEqual(ledger.get(first.id), first));
    const changedPayment: Payment = { ...firstInput.payment, amount: '126000000' };
    const changedFingerprint = digest(changedPayment, service.signingDomain);
    // Change only fixture-owned local evidence. The original signature still
    // authorizes 125 dUSD, while the current queued payload claims 126 dUSD.
    ledger.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
      .run(JSON.stringify(changedPayment), changedFingerprint, first.id);
    const changed = ledger.get(first.id)!;
    assert.ok(changed.payload === JSON.stringify(changedPayment) && changed.fingerprint === changedFingerprint);
    assert.ok(changed.signature === first.signature); assert.equal(changed.status, 'queued');
    const snapshot = () => JSON.stringify({ payments: ledger.list(), journals: ledger.journals(), audit: ledger.events(),
      changes: ledger.db.prepare('SELECT total_changes() AS count').get()!.count });
    const held = snapshot(), preflightsAtGate = relay.calls.filter(call => call.method === 'eth_call').length;
    relay.release(); const outcome = await firstTick;
    assert.equal(successfulTargetBalanceReturns, 1, 'Preparation rejection must follow successful factory balance resolution');
    assert.ok(outcome.rejected, 'Changed queued evidence must reject this preparation pass');
    assert.ok(outcome.error instanceof Error && outcome.error.message === PREPARATION_CHANGED,
      'Preparation rejection must use its fixed changed-row diagnostic');
    const errorText = String(outcome.error) + JSON.stringify(outcome.error);
    for (const marker of [firstInput.signature, secondInput.signature, first.payload, changed.payload, relay.url])
      assert.ok(!errorText.includes(marker), 'Preparation error exposed private stored or upstream details');
    assert.ok(snapshot() === held, 'Stale preparation changed the newer queued payment, journal or audit');
    assert.ok(isDeepStrictEqual(ledger.get(first.id), changed));
    assert.ok(isDeepStrictEqual(ledger.get(second.id), second), 'Rejected preparation changed the queued successor');
    for (const row of [ledger.get(first.id)!, ledger.get(second.id)!]) {
      assert.equal(row.status, 'queued'); assert.equal(row.raw_tx, null); assert.equal(row.tx_hash, null);
    }
    const downstreamPreflights = relay.calls.filter(call => call.method === 'eth_call').length - preflightsAtGate;
    assert.equal(downstreamPreflights, 0); assert.equal(signingCalls, 0); assert.equal(relay.rawSends.length, 0);
    assert.equal(ledger.journals().length, 0); assert.equal(ledger.events().length, 2);
    assert.equal(ledger.events().filter(event => event.action === 'broadcast-prepared').length, 0);
    assert.equal(await operation(local.provider.getTransactionCount(relayer.address, 'pending')), nativeNonce);
    assert.equal(await operation(local.router.nonces(local.payer.address)), 0n);
    assert.equal(await operation(local.token.balanceOf(local.payee.address)), 0n);
    assert.equal(await operation(local.token.balanceOf(local.payer.address)), initialPayerTokens);

    // Explicit fixture-only restoration does not re-sign either authorization
    // or expose an administrative repair capability in the application.
    ledger.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?').run(first.payload, first.fingerprint, first.id);
    assert.ok(isDeepStrictEqual(ledger.get(first.id), first), 'Fixture restoration must restore the exact queued row');
    for (let retry = 0; retry < 4 && ledger.get(second.id)!.status !== 'settled'; retry++) await operation(service.tick());
    const settled = ledger.get(first.id)!, successor = ledger.get(second.id)!;
    assert.equal(settled.status, 'settled'); assert.equal(successor.status, 'settled');
    assert.ok(settled.raw_tx && settled.tx_hash && successor.raw_tx && successor.tx_hash);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash); assert.equal(keccak256(successor.raw_tx), successor.tx_hash);
    const firstTransaction = Transaction.from(settled.raw_tx), secondTransaction = Transaction.from(successor.raw_tx);
    assert.equal(firstTransaction.nonce, nativeNonce); assert.equal(secondTransaction.nonce, nativeNonce + 1);
    assert.ok(firstTransaction.data === router.interface.encodeFunctionData('settle', [firstInput.payment, firstInput.signature]),
      'Healing must sign only the original first authorization');
    assert.ok(secondTransaction.data === router.interface.encodeFunctionData('settle', [secondInput.payment, secondInput.signature]),
      'Healing must sign only the original successor authorization');
    assert.equal(ledger.journal(first.id)!.amount, firstInput.payment.amount);
    assert.equal(ledger.journal(second.id)!.amount, secondInput.payment.amount);
    assert.equal(signingCalls, 2); assert.equal(relay.rawSends.length, 2);
    assert.ok(relay.rawSends[0] === settled.raw_tx && relay.rawSends[1] === successor.raw_tx);
    assert.equal(ledger.journals().length, 2); assert.equal(ledger.events().length, 6);
    for (const paymentId of [first.id, second.id]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(ledger.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
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
    assert.equal(signingCalls, 2); assert.equal(relay.rawSends.length, 2);
    t.diagnostic(JSON.stringify({ fixture: 'manual-payment-service-native-http', successfulTargetBalanceReturns: 1,
      nonceReadsAtGate, gasEstimatesAtGate, changedAmountBaseUnits: changedPayment.amount,
      originalAmountBaseUnits: firstInput.payment.amount, queuedRowsRetained: 2, stalePreparationRejected: true,
      signingCallsBeforeRestoration: 0, sendsBeforeRestoration: 0, heldJournalRows: 0, heldAuditEvents: 2,
      downstreamPreflights, totalSigningCalls: signingCalls, totalNativeSends: relay.rawSends.length,
      consumedNativeNonces: 2, settledPayments: 2, journalRows: ledger.journals().length, auditEvents: ledger.events().length,
      recipientBaseUnits: '132000000', reconciliationChecked: reconciliation.checked,
      reconciliationExceptions: reconciliation.exceptions.length, fixtureFieldsRestored: true, genuineChainRepliesUnchanged: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch { failures.push(true); } }
    proxy?.release(); await cleanup(() => within(Promise.allSettled([...operations]), 5000));
    await cleanup(() => provider?.destroy()); await cleanup(() => proxy?.close()); await cleanup(() => store?.close());
    if (chain) await cleanup(() => within(chain!.close(), 5000));
    if (failures.length) throw new Error('Preparation row snapshot fixture cleanup failed');
  }
});
