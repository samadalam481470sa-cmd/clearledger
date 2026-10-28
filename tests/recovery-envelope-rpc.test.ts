import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { bindDatabaseContext } from '../src/database-context.ts';
import { acquireDatabaseOwnership, type DatabaseOwnership } from '../src/database-ownership.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

// Genuine EVM signatures and a real HTTP JSON-RPC boundary, with controlled
// corruption under the parent's exclusive DB ownership. Manual ticks and a
// reopened Store do not establish autonomous CLI or Besu behavior.
test('a hash-coherent unrelated native envelope cannot replace a recovered payment reservation', {
  timeout: 45000
}, async t => {
  const workRoot = resolve('../../work');
  let directory: string | undefined, completed = false;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let ownership: DatabaseOwnership | undefined, store: Store | undefined;
  try {
    compile();
    const live = chain = await localChain();
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'recovery-envelope-rpc-test-'));
    ownership = acquireDatabaseOwnership(join(directory, 'journal.sqlite'));
    store = new Store(ownership.databasePath);
    const genesis = await live.provider.getBlock(0), block = await live.provider.getBlock('latest');
    assert.ok(genesis?.hash && block);
    const routerAddress = await live.router.getAddress();
    bindDatabaseContext(store.db, { chainId: 31337, genesisHash: genesis.hash,
      router: routerAddress, relayer: live.relayer.address });
    const gateway = proxy = await rpcProxy(live.provider._getConnection().url);
    provider = createRpcProvider(gateway.url, 2000);
    const relayer = new Wallet(live.relayer.privateKey, provider);
    let service = new PaymentService(store, provider, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live.payer.address,
        payee: live.payee.address, token: await live.token.getAddress(), amount, nonce,
        deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await live.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const first = (await service.accept(firstInput)).row, second = (await service.accept(secondInput)).row;
    const initialPayerTokens = await live.token.balanceOf(live.payer.address);
    const initialPayeeNative = await live.provider.getBalance(live.payee.address);
    const initialRelayerNative = await live.provider.getBalance(live.relayer.address);
    const initialRelayerNonce = await live.provider.getTransactionCount(live.relayer.address, 'pending');
    let forwarded = 0;
    gateway.afterForward('eth_sendRawTransaction', () => { forwarded++; });
    gateway.fail('eth_sendRawTransaction', 'http-503');
    await service.tick();
    const reserved = store.get(first.id)!;
    assert.equal(reserved.status, 'broadcast'); assert.ok(reserved.raw_tx && reserved.tx_hash);
    const originalRaw = reserved.raw_tx, originalHash = reserved.tx_hash;
    const reservedNonce = Transaction.from(originalRaw).nonce;
    assert.equal(reservedNonce, initialRelayerNonce);
    assert.equal(keccak256(originalRaw), originalHash);
    const sends = () => gateway.calls.filter(call => call.method === 'eth_sendRawTransaction');
    assert.equal(sends().length, 1); assert.equal(forwarded, 0);
    assert.equal(await live.provider.getTransaction(originalHash), null);
    assert.equal(await live.provider.getTransactionReceipt(originalHash), null);

    // Both replacement fields agree cryptographically, but this is a different
    // genuinely signed transaction: one wei to an EOA instead of router.settle.
    const unrelatedRaw = await live.relayer.signTransaction(await live.relayer.populateTransaction({
      to: live.payee.address, value: 1n, nonce: reservedNonce, gasLimit: 21000n
    }));
    const unrelatedHash = keccak256(unrelatedRaw), unrelated = Transaction.from(unrelatedRaw);
    assert.notEqual(unrelatedHash, originalHash);
    assert.equal(unrelated.from, live.relayer.address); assert.equal(unrelated.chainId, 31337n);
    assert.equal(unrelated.to, live.payee.address); assert.equal(unrelated.value, 1n);
    assert.equal(unrelated.data, '0x'); assert.equal(unrelated.nonce, reservedNonce);
    store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(unrelatedRaw, unrelatedHash, first.id);
    store.close(); store = undefined;
    store = new Store(ownership.databasePath);
    service = new PaymentService(store, provider, relayer, connectRouter(routerAddress, relayer), 31337, routerAddress);
    const corruptSnapshot = JSON.stringify({ rows: store.list(), events: store.events(), journals: store.journals() });
    const phaseSendBaseline = sends().length;
    const nonceReads = gateway.calls.filter(call => call.method === 'eth_getTransactionCount').length;
    gateway.heal();
    gateway.afterForward('eth_sendRawTransaction', () => { forwarded++; });
    for (let attempt = 0; attempt < 3; attempt++) await service.tick();
    const unexpectedReceipt = await live.provider.getTransactionReceipt(unrelatedHash);
    const nativeDelta = await live.provider.getBalance(live.payee.address) - initialPayeeNative;
    t.diagnostic(JSON.stringify({ recoveryTicks: 3, coherentEnvelopeSendAttempts: sends().length - phaseSendBaseline,
      forwarded, unrelatedReceiptStatus: unexpectedReceipt?.status ?? null,
      payeeNativeDeltaWei: nativeDelta.toString(), firstStatus: store.get(first.id)!.status,
      secondStatus: store.get(second.id)!.status }));
    assert.equal(sends().length - phaseSendBaseline, 0, 'A hash-coherent unrelated envelope must not cross the send boundary');
    assert.equal(forwarded, 0);
    assert.ok(JSON.stringify({ rows: store.list(), events: store.events(), journals: store.journals() }) === corruptSnapshot,
      'Envelope rejection must retain status, bytes, authorization, journal and audit evidence');
    assert.equal(store.get(first.id)!.status, 'broadcast');
    assert.ok(store.get(first.id)!.raw_tx === unrelatedRaw, 'Validation must not repair the archived raw transaction');
    assert.equal(store.get(first.id)!.tx_hash, unrelatedHash);
    assert.equal(store.get(second.id)!.status, 'queued');
    assert.equal(store.get(second.id)!.raw_tx, null); assert.equal(store.get(second.id)!.tx_hash, null);
    assert.equal(store.journals().length, 0);
    assert.equal(gateway.calls.filter(call => call.method === 'eth_getTransactionCount').length, nonceReads,
      'An unresolved envelope must retain queued native-nonce priority');
    for (const hash of [originalHash, unrelatedHash]) {
      assert.equal(await live.provider.getTransaction(hash), null);
      assert.equal(await live.provider.getTransactionReceipt(hash), null);
    }
    assert.equal(nativeDelta, 0n);
    assert.equal(await live.provider.getBalance(live.relayer.address), initialRelayerNative);
    assert.equal(await live.token.balanceOf(live.payer.address), initialPayerTokens);
    assert.equal(await live.token.balanceOf(live.payee.address), 0n);
    assert.equal(await live.router.nonces(live.payer.address), 0n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), reservedNonce);

    // Fixture-only repair while this parent still owns the DB restores the
    // original reservation; it does not prepare or sign a replacement payment.
    store.db.prepare('UPDATE payments SET raw_tx=?,tx_hash=? WHERE id=?').run(originalRaw, originalHash, first.id);
    for (let attempt = 0; attempt < 4 && store.get(second.id)!.status !== 'settled'; attempt++) await service.tick();
    const firstSettled = store.get(first.id)!, secondSettled = store.get(second.id)!;
    assert.equal(firstSettled.status, 'settled'); assert.equal(secondSettled.status, 'settled');
    assert.ok(firstSettled.raw_tx === originalRaw); assert.equal(firstSettled.tx_hash, originalHash);
    assert.ok(secondSettled.raw_tx && secondSettled.tx_hash);
    assert.equal(keccak256(secondSettled.raw_tx), secondSettled.tx_hash);
    assert.equal(Transaction.from(secondSettled.raw_tx).nonce, reservedNonce + 1);
    assert.equal(sends().length - phaseSendBaseline, 2); assert.equal(forwarded, 2);
    const recoverySends = sends().slice(phaseSendBaseline);
    assert.ok(recoverySends[0].params?.[0] === originalRaw && recoverySends[1].params?.[0] === secondSettled.raw_tx,
      'Only the two original payment authorizations may cross the recovered HTTP send boundary');
    assert.equal(await live.provider.getTransaction(unrelatedHash), null);
    assert.equal(await live.provider.getTransactionReceipt(unrelatedHash), null);
    assert.equal(await live.provider.getBalance(live.payee.address), initialPayeeNative);
    assert.equal(await live.token.balanceOf(live.payee.address), 132000000n);
    assert.equal(await live.token.balanceOf(live.payer.address), initialPayerTokens - 132000000n);
    assert.equal(await live.router.nonces(live.payer.address), 2n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), reservedNonce + 2);
    assert.equal(store.journals().length, 2); assert.equal(store.events().length, 6);
    for (const paymentId of [first.id, second.id]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(store.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    for (const input of [firstInput, secondInput]) assert.equal((await service.accept(input)).replay, true);
    const reconciliation = await service.reconcile();
    assert.equal(reconciliation.checked, 2); assert.deepEqual(reconciliation.exceptions, []);
    assert.equal(store.events().length, 6); assert.equal(store.journals().length, 2);
    assert.equal(sends().length - phaseSendBaseline, 2);
    t.diagnostic(JSON.stringify({ repairedPaymentSends: 2, journalRows: 2, reconciled: reconciliation.checked,
      unrelatedNativeTransferOccurred: false }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    await cleanup(() => provider?.destroy());
    await cleanup(() => proxy?.close());
    if (store) await cleanup(() => { store!.close(); store = undefined; });
    if (!store) await cleanup(() => { ownership?.release(); ownership = undefined; });
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.equal(store, undefined); assert.equal(ownership, undefined);
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'recovery-envelope-rpc-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Recovery envelope RPC cleanup failed');
  }
});
