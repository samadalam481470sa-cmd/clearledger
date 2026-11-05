import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, isError, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  assert.fail(message);
}

async function post(cli: CliHandle, path: string, body: unknown) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

// Keep private payloads and signed transactions out of assertion output.
function snapshot(reader: DatabaseSync) {
  return createHash('sha256').update(JSON.stringify({
    schema: reader.prepare('SELECT * FROM sqlite_schema ORDER BY type,name').all(),
    payments: reader.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: reader.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: reader.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    sequence: reader.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
    context: reader.prepare('SELECT * FROM deployment_context ORDER BY singleton').all()
  })).digest('hex');
}

test('the actual CLI rejects a competing payer nonce before signing and settles the next nonce', {
  timeout: 90000
}, async t => {
  let child: CliHandle | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let reader: DatabaseSync | undefined;
  let directory: string | undefined;
  const workRoot = resolve('../../work');
  const prefix = 'cli-competing-nonce-test-';
  try {
    compile();
    const local = chain = await localChain();
    const relay = proxy = await rpcProxy(local.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, prefix));
    const db = join(directory, 'journal.sqlite');
    const routerAddress = await local.router.getAddress();

    let forwardedWhileBlocked = 0;
    relay.fail('eth_sendRawTransaction', 'http-503');
    relay.afterForward('eth_sendRawTransaction', () => { forwardedWhileBlocked++; });
    const cli = await startCli({ db, rpc: relay.url, key: local.relayer.privateKey, router: routerAddress,
      onSpawn: handle => { child = handle; } });
    const ledger = reader = new DatabaseSync(db, { readOnly: true });
    const row = (key: string) => ledger.prepare('SELECT * FROM payments WHERE id=?').get(key) as unknown as RecordRow;
    const journals = () => ledger.prepare('SELECT * FROM journals ORDER BY rowid').all();
    const actions = () => ledger.prepare('SELECT payment_id, action FROM audit ORDER BY sequence').all()
      .map(event => [event.payment_id, event.action]);
    const sends = () => relay.calls.filter(call => call.method === 'eth_sendRawTransaction');

    const block = await local.provider.getBlock('latest');
    assert.ok(block);
    const signingDomain = domain(31337, routerAddress);
    const token = await local.token.getAddress();
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')),
        payer: local.payer.address, payee: local.payee.address, token, amount, nonce,
        deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await local.payer.signTypedData(signingDomain, paymentTypes, payment) };
    }
    const a = await signed('125000000', '0');
    const b = await signed('7000000', '0');
    const c = await signed('5000000', '1');
    const [aId, bId, cId] = [a, b, c].map(input => paymentKey(input.payment));
    assert.equal(new Set([aId, bId, cId]).size, 3);
    const nativeNonce = await local.provider.getTransactionCount(local.relayer.address, 'pending');
    const payerNativeNonce = await local.provider.getTransactionCount(local.payer.address, 'pending');
    const payerNativeBalance = await local.provider.getBalance(local.payer.address);
    const relayerBalance = await local.provider.getBalance(local.relayer.address);
    const payerBalance = await local.token.balanceOf(local.payer.address);
    const payeeBalance = await local.token.balanceOf(local.payee.address);
    assert.equal(await local.router.nonces(local.payer.address), 0n);

    let acceptance503Retries = 0;
    async function accept(input: typeof a) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const result = await post(cli, 'payments', input);
        if (result.status === 202) {
          assert.equal(result.body.replay, false);
          assert.equal(result.body.payment.id, paymentKey(input.payment));
          assert.equal(result.body.payment.status, 'queued');
          return;
        }
        assert.equal(result.status, 503, 'Only the fixed upstream-unavailable response may be retried');
        assert.ok(result.body.error === 'Upstream RPC unavailable; check payment history before retrying');
        acceptance503Retries++;
        await new Promise(resolvePause => setTimeout(resolvePause, 100));
      }
      assert.fail('The original signed instruction did not become accepted');
    }

    await accept(a);
    await until(() => row(aId)?.status === 'broadcast' && sends().length > 0, 'A must reserve and attempt a native transaction');
    const first = row(aId);
    assert.ok(first.raw_tx && first.tx_hash);
    const originalRaw = first.raw_tx, originalHash = first.tx_hash;
    assert.equal(keccak256(originalRaw), originalHash);
    assert.equal(Transaction.from(originalRaw).nonce, nativeNonce);
    await accept(b);
    await accept(c);

    assert.equal(row(aId).status, 'broadcast');
    assert.ok(row(aId).raw_tx === originalRaw && row(aId).tx_hash === originalHash);
    for (const key of [bId, cId]) {
      const queued = row(key);
      assert.equal(queued.status, 'queued');
      assert.ok(queued.raw_tx === null && queued.tx_hash === null, 'Queued intent reserved native evidence');
    }
    const blockedActions = [[aId, 'accepted'], [aId, 'broadcast-prepared'], [bId, 'accepted'], [cId, 'accepted']];
    assert.deepEqual(actions(), blockedActions);
    assert.equal(journals().length, 0);
    assert.equal(await local.provider.getTransaction(originalHash), null);
    assert.equal(await local.provider.getTransactionReceipt(originalHash), null);
    assert.equal(await local.token.balanceOf(local.payer.address), payerBalance);
    assert.equal(await local.token.balanceOf(local.payee.address), payeeBalance);
    assert.equal(await local.router.nonces(local.payer.address), 0n);
    assert.equal(await local.provider.getTransactionCount(local.relayer.address, 'pending'), nativeNonce);
    assert.equal(await local.provider.getBalance(local.relayer.address), relayerBalance);
    const directRouter = local.router.connect(local.relayer);
    await assert.doesNotReject(async () => {
      try { await directRouter.settle.staticCall(b.payment, b.signature); }
      catch { throw new Error('B must pass simulation before A propagates'); }
    });

    const blockedAttempts = sends().length;
    const beforeHeal = relay.calls.length;
    assert.ok(blockedAttempts > 0 && sends().every(call => call.params?.[0] === originalRaw));
    assert.equal(forwardedWhileBlocked, 0);
    const bCalldata = directRouter.interface.encodeFunctionData('settle', [b.payment, b.signature]).toLowerCase();
    function isBPreflight(call: (typeof relay.calls)[number]) {
      const request = call.params?.[0] as { from?: string; to?: string; data?: string } | undefined;
      return call.method === 'eth_call' && request?.to?.toLowerCase() === routerAddress.toLowerCase() &&
        request?.from?.toLowerCase() === local.relayer.address.toLowerCase() && request?.data?.toLowerCase() === bCalldata;
    }
    relay.heal();
    let forwardedAfterHeal = 0;
    const held = { gate: undefined as ReturnType<typeof relay.pauseAfterForward> | undefined, entered: false };
    relay.afterForward('eth_sendRawTransaction', () => {
      forwardedAfterHeal++;
      // Once A reaches the EVM, the next worker eth_call should be B's preflight.
      if (forwardedAfterHeal === 1) {
        held.gate = relay.pauseAfterForward('eth_call');
        void held.gate.entered.then(() => { held.entered = true; });
      }
    });
    try {
      await until(() => held.entered, 'Hold the worker preflight after A reaches the EVM');
      const preflights = relay.calls.slice(beforeHeal).filter(call => call.method === 'eth_call');
      assert.ok(preflights.length === 1 && isBPreflight(preflights[0]), 'The held call must contain B settle calldata');
      assert.equal(row(aId).status, 'settled');
      assert.equal(row(bId).status, 'queued');
      assert.equal(row(cId).status, 'queued');
      assert.equal(forwardedAfterHeal, 1);
      assert.equal(journals().length, 1);
      assert.equal(await local.router.nonces(local.payer.address), 1n);
      let decodedNonceRevert = false;
      try { await directRouter.settle.staticCall(b.payment, b.signature); }
      catch (error) {
        decodedNonceRevert = isError(error, 'CALL_EXCEPTION') && error.data === directRouter.interface.getError('InvalidNonce').selector;
      }
      assert.ok(decodedNonceRevert, 'The identical router simulation must reject B with InvalidNonce');
      assert.equal(row(bId).status, 'queued');
      assert.equal(row(cId).status, 'queued');
    } finally {
      held.gate?.release();
    }
    await until(() => row(aId).status === 'settled' && row(bId).status === 'failed' && row(cId).status === 'settled',
      'The autonomous worker must settle A and C and reject stale B');

    const settledA = row(aId), failedB = row(bId), settledC = row(cId);
    assert.ok(settledA.raw_tx === originalRaw && settledA.tx_hash === originalHash, 'Recovery changed A native evidence');
    // ethers retains the original shortMessage when decoding a custom error.
    assert.ok(failedB.error?.startsWith('execution reverted'), 'B must retain a contract rejection message');
    assert.ok(failedB.raw_tx === null && failedB.tx_hash === null && failedB.block_number === null && failedB.block_hash === null,
      'B acquired native reservation or inclusion evidence');
    assert.ok(settledC.raw_tx && settledC.tx_hash);
    assert.equal(keccak256(settledC.raw_tx), settledC.tx_hash);
    assert.equal(Transaction.from(settledC.raw_tx).nonce, nativeNonce + 1);
    const calls = relay.calls.slice(beforeHeal);
    const aSend = calls.findIndex(call => call.method === 'eth_sendRawTransaction' && call.params?.[0] === originalRaw);
    const bPreflight = calls.findIndex(isBPreflight);
    const cSend = calls.findIndex(call => call.method === 'eth_sendRawTransaction' && call.params?.[0] === settledC.raw_tx);
    assert.ok(aSend >= 0 && aSend < bPreflight && bPreflight < cSend, 'Expected A send, B preflight, then C send');
    assert.equal(sends().length - blockedAttempts, 2);
    assert.equal(forwardedAfterHeal, 2);
    assert.deepEqual(journals().map(journal => [journal.payment_id, journal.amount, journal.tx_hash]),
      [[aId, a.payment.amount, originalHash], [cId, c.payment.amount, settledC.tx_hash]]);
    assert.deepEqual(actions(), [...blockedActions, [aId, 'settled'], [bId, 'failed'], [cId, 'broadcast-prepared'], [cId, 'settled']]);

    const aReceipt = await local.provider.getTransactionReceipt(originalHash);
    const cReceipt = await local.provider.getTransactionReceipt(settledC.tx_hash);
    assert.ok(aReceipt?.status === 1 && cReceipt?.status === 1);
    assert.equal(await local.provider.getBalance(local.relayer.address), relayerBalance - aReceipt.fee - cReceipt.fee);
    assert.equal(await local.provider.getTransactionCount(local.relayer.address, 'pending'), nativeNonce + 2);
    assert.equal(await local.provider.getTransactionCount(local.payer.address, 'pending'), payerNativeNonce);
    assert.equal(await local.provider.getBalance(local.payer.address), payerNativeBalance);
    assert.equal(await local.token.balanceOf(local.payer.address), payerBalance - 130000000n);
    assert.equal(await local.token.balanceOf(local.payee.address), payeeBalance + 130000000n);
    assert.equal(await local.router.nonces(local.payer.address), 2n);
    for (const [input, processed] of [[a, true], [b, false], [c, true]] as const) {
      assert.equal(await local.router.processed(local.payer.address, input.payment.paymentId), processed);
    }

    const finalSnapshot = snapshot(ledger);
    const replay = await post(cli, 'payments', b);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.id, bId);
    assert.equal(replay.body.payment.status, 'failed');
    assert.ok(replay.body.payment.error === failedB.error && replay.body.payment.tx_hash === null);
    for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload']) {
      assert.ok(!Object.hasOwn(replay.body.payment, field), 'The replay exposed private evidence');
    }
    assert.equal(snapshot(ledger), finalSnapshot);
    const reconciliation = await post(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 2);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.equal(snapshot(ledger), finalSnapshot);
    assert.equal(forwardedAfterHeal, 2);
    t.diagnostic(JSON.stringify({ blockedAttempts, forwardedWhileBlocked, acceptance503Retries, accepted: 3,
      heldPayerNonce: 1, decodedError: 'InvalidNonce',
      forwardedAfterHeal, settled: 2, failedBeforeReservation: 1, journalRows: 2, reconciled: 2,
      payeeBaseUnitDelta: '130000000', payerNonce: 2 }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    await cleanup(() => child?.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && failures.length === 0) await cleanup(() => {
      assert.ok(!child || child.child.exitCode !== null || child.child.signalCode !== null);
      const target = realpathSync(directory!);
      assert.equal(dirname(target), realpathSync(workRoot));
      assert.ok(basename(target).startsWith(prefix));
      rmSync(target, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Competing nonce CLI cleanup failed');
  }
});
