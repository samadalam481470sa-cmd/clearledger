import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractFactory, id, keccak256, parseUnits, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { compileTestWallet } from './fixtures/compile-wallet.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

// The genuine RPC entry point owns all ledger writes and scheduling. The parent
// observes SQLite read-only; its direct EVM transactions only change wallet policy.
// ContractWallet is an adversarial fixture, not a production wallet or multisig.
class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(paymentId: string) {
    return this.db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow | undefined;
  }
  journals() { return this.db.prepare('SELECT * FROM journals').all(); }
  events() {
    return this.db.prepare('SELECT payment_id,action,detail FROM audit ORDER BY sequence').all() as
      { payment_id: string; action: string; detail: string }[];
  }
  close() { this.db.close(); }
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(message + ' timed out');
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

test('the autonomous CLI preserves an unpropagated wallet reservation across crash and mines its live revocation once', {
  timeout: 120000
}, async t => {
  const children: CliHandle[] = [];
  const workRoot = resolve('../../work');
  let directory: string | undefined, reader: Projection | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let completed = false;
  try {
    compile();
    const live = chain = await localChain();
    const artifact = compileTestWallet();
    const wallet: any = await new ContractFactory(artifact.abi, artifact.bytecode, live.payer).deploy(live.payer.address);
    await wallet.waitForDeployment();
    const walletAddress = await wallet.getAddress(), routerAddress = await live.router.getAddress();
    await (await wallet.setRequiredCaller(routerAddress)).wait();
    await (await live.token.setAllowed(walletAddress, true)).wait();
    await (await live.token.mint(walletAddress, parseUnits('1000', 6))).wait();
    await (await wallet.execute(await live.token.getAddress(), live.token.interface.encodeFunctionData('approve',
      [routerAddress, parseUnits('1000', 6)]))).wait();
    const gateway = proxy = await rpcProxy(live.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'cli-wallet-revocation-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: gateway.url, key: live.relayer.privateKey, router: routerAddress,
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    let forwardedDuringFault = 0, forwardedAfterHeal = 0, acceptance503Retries = 0;
    gateway.fail('eth_sendRawTransaction', 'http-503');
    gateway.afterForward('eth_sendRawTransaction', () => { forwardedDuringFault++; });
    const sends = () => gateway.calls.filter(call => call.method === 'eth_sendRawTransaction');
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    reader = new Projection(db);
    const block = await live.provider.getBlock('latest');
    assert.ok(block);
    const initialRelayerNonce = await live.provider.getTransactionCount(live.relayer.address, 'pending');
    const initialOwnerNativeNonce = await live.provider.getTransactionCount(live.payer.address, 'pending');
    const initialEoaBalance = await live.token.balanceOf(live.payer.address);
    async function signed(payer: string, amount: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer,
        payee: live.payee.address, token: await live.token.getAddress(), amount, nonce: '0',
        deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await live.payer.signTypedData(domain(31337, routerAddress), paymentTypes, payment) };
    }
    const walletInput = await signed(walletAddress, '125000000');
    const eoaInput = await signed(live.payer.address, '7000000');
    const walletId = paymentKey(walletInput.payment), eoaId = paymentKey(eoaInput.payment);
    const walletDigest = await live.router.hashPayment(walletInput.payment);
    assert.equal(await wallet.isValidSignature.staticCall(walletDigest, walletInput.signature), '0xffffffff');
    assert.equal(await live.router.isValidPaymentSignature(walletInput.payment, walletInput.signature), true);
    async function acceptSameIntent(input: typeof walletInput) {
      const deadline = performance.now() + 15000;
      for (let attempt = 0; attempt < 100 && performance.now() < deadline; attempt++) {
        const result = await api(cli, 'payments', input);
        if (result.status === 202 || result.status === 200) {
          assert.equal(result.body.payment.id, paymentKey(input.payment));
          assert.equal(result.body.replay, result.status === 200);
          return result;
        }
        assert.equal(result.status, 503, 'Only the explicit fixed RPC-unavailable result may be retried');
        assert.deepEqual(result.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
        acceptance503Retries++;
        await new Promise(resolvePause => setTimeout(resolvePause, 100));
      }
      throw new Error('The identical payment intent did not become accepted within its retry bound');
    }
    await acceptSameIntent(walletInput);
    await until(() => reader!.get(walletId)?.status === 'broadcast' && sends().length >= 1,
      'Autonomous wallet transaction reservation');
    const original = reader.get(walletId)!;
    assert.ok(original.raw_tx && original.tx_hash);
    const originalRaw = original.raw_tx, originalHash = original.tx_hash;
    const reserved = Transaction.from(originalRaw);
    assert.equal(reserved.nonce, initialRelayerNonce);
    assert.equal(keccak256(originalRaw), originalHash);
    await acceptSameIntent(eoaInput);

    function assertReservation() {
      const first = reader!.get(walletId)!, second = reader!.get(eoaId)!;
      assert.equal(first.status, 'broadcast');
      for (const field of ['raw_tx', 'tx_hash', 'payload', 'signature', 'fingerprint'] as const)
        assert.ok(first[field] === original[field], 'The persisted wallet reservation changed');
      assert.equal(second.status, 'queued');
      assert.equal(second.raw_tx, null); assert.equal(second.tx_hash, null);
      assert.equal(reader!.journals().length, 0);
      const events = reader!.events();
      assert.equal(events.length, 3);
      assert.equal(events.filter(event => event.action === 'accepted').length, 2);
      assert.equal(events.filter(event => event.action === 'broadcast-prepared').length, 1);
      for (const call of sends()) assert.ok(call.params?.[0] === originalRaw, 'A send retry changed the reserved bytes');
      assert.equal(forwardedDuringFault, 0);
    }
    async function assertUnpropagated() {
      assertReservation();
      assert.equal(await live.provider.getTransaction(originalHash), null);
      assert.equal(await live.provider.getTransactionReceipt(originalHash), null);
      assert.equal(await live.token.balanceOf(walletAddress), parseUnits('1000', 6));
      assert.equal(await live.token.balanceOf(live.payer.address), initialEoaBalance);
      assert.equal(await live.token.balanceOf(live.payee.address), 0n);
      assert.equal(await live.router.nonces(walletAddress), 0n);
      assert.equal(await live.router.nonces(live.payer.address), 0n);
      assert.equal(await live.router.processed(walletAddress, walletInput.payment.paymentId), false);
      assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce);
      assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'latest'), initialRelayerNonce);
    }
    await until(() => { assertReservation(); return sends().length >= 4; }, 'Four autonomous blocked sends before termination');
    await assertUnpropagated();
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialOwnerNativeNonce);
    await cli.kill();
    const killed = await cli.exited;
    assert.ok(killed.signal === 'SIGKILL' || (killed.code !== null && killed.code !== 0), 'Expected abrupt CLI termination');
    reader.close(); reader = new Projection(db);
    await assertUnpropagated();
    const attemptsBeforeRestart = sends().length;
    assert.ok(attemptsBeforeRestart >= 4);

    // The wallet owner changes live authorization while the old native bytes
    // remain unsent. This transaction does not use the reserved relayer nonce.
    assert.equal((await (await wallet.setRevoked(true)).wait())!.status, 1);
    assert.equal(await wallet.revoked(), true);
    assert.equal(await live.router.isValidPaymentSignature(walletInput.payment, walletInput.signature), false);
    let rejection: { code?: string; name?: string } = {};
    try { await live.router.connect(live.relayer).settle.staticCall(walletInput.payment, walletInput.signature); }
    catch (error: any) {
      rejection.code = error.code;
      try { rejection.name = live.router.interface.parseError(error.data)?.name; } catch { /* Fixed assertions below. */ }
    }
    assert.equal(rejection.code, 'CALL_EXCEPTION'); assert.equal(rejection.name, 'InvalidSignature');
    await assertUnpropagated();
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialOwnerNativeNonce + 1);

    const restartBaseline = sends().length;
    cli = await startCli({ ...config, apiKey: cli.apiKey });
    assert.notEqual(cli.child.pid, originalPid);
    await until(() => { assertReservation(); return sends().length - restartBaseline >= 4; },
      'Four autonomous blocked sends after wallet revocation and restart');
    await assertUnpropagated();
    const attemptsAfterRestart = sends().length - restartBaseline;
    const attemptsBeforeHeal = sends().length;
    gateway.heal();
    gateway.afterForward('eth_sendRawTransaction', () => { forwardedAfterHeal++; });
    await until(() => reader!.get(walletId)?.status === 'failed' && reader!.get(eoaId)?.status === 'settled',
      'Canonical failed wallet receipt followed by independent EOA settlement');
    function assertFailedWallet() {
      const failed = reader!.get(walletId)!;
      assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Transaction reverted on chain');
      for (const field of ['raw_tx', 'tx_hash', 'payload', 'signature', 'fingerprint'] as const)
        assert.ok(failed[field] === original[field], 'A failed wallet transaction lost its original evidence');
      assert.equal(failed.block_number, null); assert.equal(failed.block_hash, null);
      assert.equal(reader!.journals().filter(row => row.payment_id === walletId).length, 0);
      const events = reader!.events().filter(event => event.payment_id === walletId);
      assert.deepEqual(events.map(event => event.action), ['accepted', 'broadcast-prepared', 'failed']);
      assert.equal(events[2].detail, 'Transaction reverted on chain');
    }
    assertFailedWallet();
    const failedReceipt = await live.provider.getTransactionReceipt(originalHash);
    assert.ok(failedReceipt); assert.equal(failedReceipt.status, 0); assert.equal(failedReceipt.hash, originalHash);
    assert.ok(failedReceipt.gasUsed < reserved.gasLimit, 'The genuine revert must not be out of gas');
    const canonical = await live.provider.getBlock(failedReceipt.blockNumber);
    assert.ok(canonical); assert.equal(canonical.number, failedReceipt.blockNumber);
    assert.equal(canonical.hash, failedReceipt.blockHash);
    const settled = reader.get(eoaId)!;
    assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(Transaction.from(settled.raw_tx).nonce, reserved.nonce + 1);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.equal((await live.provider.getTransactionReceipt(settled.tx_hash))!.status, 1);
    assert.equal(reader.journals().length, 1); assert.equal(reader.events().length, 6);
    assert.deepEqual(reader.events().filter(event => event.payment_id === eoaId).map(event => event.action),
      ['accepted', 'broadcast-prepared', 'settled']);
    assert.equal(await live.token.balanceOf(walletAddress), parseUnits('1000', 6));
    assert.equal(await live.token.balanceOf(live.payer.address), initialEoaBalance - 7000000n);
    assert.equal(await live.token.balanceOf(live.payee.address), 7000000n);
    assert.equal(await live.router.nonces(walletAddress), 0n);
    assert.equal(await live.router.processed(walletAddress, walletInput.payment.paymentId), false);
    assert.equal(await live.router.nonces(live.payer.address), 1n);
    assert.equal(await live.router.processed(live.payer.address, eoaInput.payment.paymentId), true);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 2);
    assert.equal(forwardedDuringFault, 0); assert.equal(forwardedAfterHeal, 2);
    assert.equal(sends().length - attemptsBeforeHeal, 2);
    const history = await api(cli, 'payments');
    assert.equal(history.status, 200); assert.equal(history.body.items.length, 2);
    for (const [paymentId, status] of [[walletId, 'failed'], [eoaId, 'settled']]) {
      const item = history.body.items.find((row: any) => row.id === paymentId);
      assert.equal(item.status, status); assert.ok(item.payment);
      for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload']) assert.equal(item[field], undefined);
    }
    assert.equal((await api(cli, 'payments', walletInput)).status, 422);
    const eoaReplay = await api(cli, 'payments', eoaInput);
    assert.equal(eoaReplay.status, 200); assert.equal(eoaReplay.body.replay, true);
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 1); assert.deepEqual(reconciliation.body.exceptions, []);
    assertFailedWallet(); assert.equal(reader.events().length, 6);

    assert.equal((await (await wallet.setRevoked(false)).wait())!.status, 1);
    assert.equal(await live.router.isValidPaymentSignature(walletInput.payment, walletInput.signature), true);
    const restoredReplay = await api(cli, 'payments', walletInput);
    assert.equal(restoredReplay.status, 200); assert.equal(restoredReplay.body.replay, true);
    assert.equal(restoredReplay.body.payment.status, 'failed');
    assertFailedWallet(); assert.equal(reader.events().length, 6);
    assert.equal(forwardedAfterHeal, 2); assert.equal(sends().length - attemptsBeforeHeal, 2);

    // A new ID at the still-unused wallet nonce succeeds. Restoring policy and
    // replaying the old ID never resuscitates its failed transaction or journal.
    const freshInput = await signed(walletAddress, '5000000');
    const freshId = paymentKey(freshInput.payment);
    assert.equal((await acceptSameIntent(freshInput)).status, 202);
    await until(() => reader!.get(freshId)?.status === 'settled', 'New wallet authorization at nonce zero');
    const fresh = reader.get(freshId)!;
    assert.ok(fresh.raw_tx && fresh.tx_hash);
    assert.equal(Transaction.from(fresh.raw_tx).nonce, reserved.nonce + 2);
    assert.equal(keccak256(fresh.raw_tx), fresh.tx_hash);
    assert.equal((await live.provider.getTransactionReceipt(fresh.tx_hash))!.status, 1);
    assertFailedWallet();
    assert.equal(await live.router.nonces(walletAddress), 1n);
    assert.equal(await live.router.processed(walletAddress, walletInput.payment.paymentId), false);
    assert.equal(await live.router.processed(walletAddress, freshInput.payment.paymentId), true);
    assert.equal(await live.token.balanceOf(walletAddress), parseUnits('995', 6));
    assert.equal(await live.token.balanceOf(live.payee.address), 12000000n);
    assert.equal(await live.token.balanceOf(live.payer.address), initialEoaBalance - 7000000n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 3);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialOwnerNativeNonce + 2);
    assert.equal(reader.journals().length, 2); assert.equal(reader.events().length, 9);
    assert.deepEqual(reader.events().filter(event => event.payment_id === freshId).map(event => event.action),
      ['accepted', 'broadcast-prepared', 'settled']);
    assert.equal(forwardedAfterHeal, 3); assert.equal(sends().length - attemptsBeforeHeal, 3);
    const hashes = new Set(sends().map(call => keccak256(call.params![0] as string)));
    assert.deepEqual(hashes, new Set([originalHash, settled.tx_hash, fresh.tx_hash]));
    const finalReconciliation = await api(cli, 'reconcile', {});
    assert.equal(finalReconciliation.status, 200);
    assert.equal(finalReconciliation.body.checked, 2); assert.deepEqual(finalReconciliation.body.exceptions, []);
    assertFailedWallet(); assert.equal(reader.journals().length, 2); assert.equal(reader.events().length, 9);
    t.diagnostic(JSON.stringify({ attemptsBeforeRestart, attemptsAfterRestart, forwardedDuringFault,
      forwardedAfterHeal, uniqueNativeHashes: hashes.size, acceptance503Retries, revertedPayments: 1,
      settledPayments: 2, journalRows: 2, reconciled: finalReconciliation.body.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && failures.length === 0 && completed) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Never remove task database files under a live registered CLI child');
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'cli-wallet-revocation-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Wallet-revocation CLI cleanup failed');
  }
});
