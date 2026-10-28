import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

// A real CLI child owns all writes; the parent observes its durable projection.
class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(id: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(id) as unknown as RecordRow | undefined; }
  journals() { return this.db.prepare('SELECT * FROM journals').all(); }
  events() { return this.db.prepare('SELECT * FROM audit').all(); }
  close() { this.db.close(); }
}
async function until(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 20000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.fail(message);
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  return fetch(cli.url + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
}
async function within<T>(pending: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Active CLI outage observation exceeded its phase budget')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test('the actual RPC CLI autonomously recovers after two 30-second observation windows within one receipt outage', { timeout: 150000 }, async t => {
  compile();
  const children: CliHandle[] = [];
  const dataRoot = resolve('../../work');
  let directory: string | undefined, reader: Projection | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let completed = false;
  try {
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(dataRoot, { recursive: true });
    directory = mkdtempSync(join(dataRoot, 'cli-recovery-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    const block = await chain.provider.getBlock('latest');
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    const initialPayerNativeNonce = await chain.provider.getTransactionCount(chain.payer.address, 'pending');
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain!.payer.address,
        payee: chain!.payee.address, token: String(chain!.token.target), amount, nonce, deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0'), secondInput = await signed('7000000', '1');
    const firstId = paymentKey(firstInput.payment), secondId = paymentKey(secondInput.payment);
    const receiptCount = () => proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    let outageStarted: number | undefined, receiptBaseline = 0;
    proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
    proxy.afterForward('eth_sendRawTransaction', () => {
      if (outageStarted !== undefined) return;
      proxy!.fail('eth_getTransactionReceipt', 'http-503');
      outageStarted = performance.now(); receiptBaseline = receiptCount();
    });
    for (const input of [firstInput, secondInput]) {
      const response = await api(cli, 'payments', input);
      assert.equal(response.status, 202);
      const accepted = await response.json() as { replay: boolean; payment: { id: string; raw_tx?: string; signature?: string } };
      assert.equal(accepted.replay, false);
      assert.equal(accepted.payment.id, paymentKey(input.payment));
      assert.equal(accepted.payment.raw_tx, undefined);
      assert.equal(accepted.payment.signature, undefined);
    }
    reader = new Projection(db);
    await until(() => outageStarted !== undefined &&
      reader!.get(firstId)?.status === 'broadcast', 'The autonomous first CLI did not retry receipt lookup');
    const original = reader.get(firstId)!;
    assert.ok(original.raw_tx && original.tx_hash, 'The CLI must persist signed bytes before network transmission');
    const originalRaw = original.raw_tx, originalHash = original.tx_hash;
    const nativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(keccak256(originalRaw), originalHash);
    const projection = () => JSON.stringify({ first: reader!.get(firstId), second: reader!.get(secondId),
      journals: reader!.journals(), audit: reader!.events() });
    const originalProjection = projection();
    const expectedRelayerBalance = await chain.provider.getBalance(chain.relayer.address);
    async function uncertain() {
      const first = reader!.get(firstId)!, second = reader!.get(secondId)!;
      assert.equal(first.status, 'broadcast');
      assert.ok(first.raw_tx === originalRaw, 'Uncertain outcome replaced the durable signed transaction');
      assert.equal(first.tx_hash, originalHash);
      assert.equal(second.status, 'queued');
      assert.equal(second.raw_tx, null); assert.equal(second.tx_hash, null);
      assert.equal(reader!.journals().length, 0);
      const events = reader!.events();
      assert.equal(events.length, 3);
      assert.equal(events.filter(event => event.action === 'accepted').length, 2);
      assert.equal(events.filter(event => event.action === 'broadcast-prepared').length, 1);
      assert.equal(events.filter(event => event.action === 'settled').length, 0);
      assert.ok(projection() === originalProjection, 'Receipt retries changed the exact private SQLite projection');
      const sends = proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction');
      assert.equal(sends.length, 1);
      assert.ok(sends[0].params?.[0] === originalRaw, 'RPC observed unexpected signed transaction bytes');
      assert.equal(await chain!.token.balanceOf(chain!.payee.address), 125000000n);
      assert.equal(await chain!.token.balanceOf(chain!.payer.address), initialPayerBalance - 125000000n);
      assert.equal(await chain!.router.nonces(chain!.payer.address), 1n);
      assert.equal(await chain!.provider.getTransactionCount(chain!.relayer.address, 'pending'), nativeNonce + 1);
      assert.equal(await chain!.provider.getTransactionCount(chain!.payer.address, 'pending'), initialPayerNativeNonce);
      assert.equal(await chain!.provider.getBalance(chain!.relayer.address), expectedRelayerBalance);
      const receipt = await chain!.provider.getTransactionReceipt(originalHash);
      assert.equal(receipt?.status, 1); assert.equal(receipt?.hash, originalHash);
    }
    async function observeOutage(phase: 'before-restart' | 'after-restart') {
      const started = performance.now(), deadline = started + 45000, baseline = receiptCount();
      let observations = 0, boundaryCount: number | undefined, boundaryElapsedMs: number | undefined, passed = false;
      let ended: number | undefined;
      try {
        for (;;) {
          const remaining = deadline - performance.now();
          assert.ok(remaining > 0, 'Active receipt outage did not meet its observations within 45 seconds');
          assert.equal(cli.child.exitCode, null, 'The observed CLI process exited during the active outage');
          assert.equal(cli.child.signalCode, null);
          await within(uncertain(), remaining);
          observations++;
          const elapsed = performance.now() - started, current = receiptCount();
          assert.ok(elapsed <= 45000, 'Active receipt outage exceeded its 45-second observation budget');
          if (elapsed >= 30000 && boundaryCount === undefined) {
            boundaryCount = current; boundaryElapsedMs = elapsed;
          }
          // Require a fresh failed RPC after the 30-second endpoint, rather
          // than allowing early retries followed by a stalled scheduler to pass.
          if (boundaryCount !== undefined && current > boundaryCount &&
            current - baseline > 20 && observations > 20) {
            passed = true; ended = performance.now();
            return { durationMs: ended - started, observations, failedReceiptAttempts: current - baseline,
              boundaryElapsedMs: boundaryElapsedMs!, failedReceiptsAfterBoundary: current - boundaryCount };
          }
          await new Promise(resolvePause => setTimeout(resolvePause, Math.min(1000, Math.max(1, deadline - performance.now()))));
        }
      } finally {
        ended ??= performance.now();
        t.diagnostic(JSON.stringify({ phase, passed, durationMs: Math.floor(ended - started), observations,
          failedReceiptAttempts: receiptCount() - baseline, boundaryElapsedMs: boundaryElapsedMs === undefined ? null : Math.floor(boundaryElapsedMs),
          failedReceiptsAfterBoundary: boundaryCount === undefined ? 0 : receiptCount() - boundaryCount }));
      }
    }
    assert.ok(performance.now() >= outageStarted!);
    const firstWindow = await observeOutage('before-restart');
    await cli.kill(); // OS termination skips the real CLI's shutdown/SQLite close.
    const terminated = await cli.exited;
    assert.ok(terminated.signal === 'SIGKILL' || (terminated.code !== null && terminated.code !== 0), 'Expected abrupt child termination');
    const previousClosedAt = performance.now();
    reader.close(); reader = new Projection(db);
    await uncertain();
    const restartStartupBaseline = receiptCount();
    cli = await startCli({ ...config, apiKey: cli.apiKey });
    const restartedReadyAt = performance.now();
    const startupReceiptAttempts = receiptCount() - restartStartupBaseline;
    assert.notEqual(cli.child.pid, originalPid);
    const secondWindow = await observeOutage('after-restart');
    const outageDurationMs = performance.now() - outageStarted!;
    const observedWindowMs = firstWindow.durationMs + secondWindow.durationMs;
    const restartDowntimeMs = restartedReadyAt - previousClosedAt; // Closed-to-ready gap, excluded from both windows.
    assert.ok(firstWindow.durationMs >= 30000 && secondWindow.durationMs >= 30000);
    assert.ok(firstWindow.failedReceiptAttempts > 20 && secondWindow.failedReceiptAttempts > 20);
    assert.ok(observedWindowMs >= 60000);

    proxy.heal();
    await until(() => reader!.get(firstId)?.status === 'settled' && reader!.get(secondId)?.status === 'settled',
      'The autonomous CLI did not settle persisted work after RPC recovery');
    assert.ok(reader.get(firstId)!.raw_tx === originalRaw, 'Recovery replaced the first signed bytes');
    assert.equal(reader.get(firstId)!.tx_hash, originalHash);
    const second = reader.get(secondId)!;
    assert.ok(second.raw_tx && second.tx_hash);
    assert.equal(keccak256(second.raw_tx), second.tx_hash);
    assert.equal(Transaction.from(second.raw_tx).nonce, nativeNonce + 1);
    assert.equal(reader.journals().length, 2);
    for (const paymentId of [firstId, secondId]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), nativeNonce + 2);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 2);
    for (const input of [firstInput, secondInput]) {
      const replay = await api(cli, 'payments', input);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as { replay: boolean }).replay, true);
    }
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    const result = await reconciliation.json() as { checked: number; exceptions: string[] };
    assert.equal(result.checked, 2); assert.deepEqual(result.exceptions, []);
    assert.equal(reader.journals().length, 2);
    assert.equal(reader.events().length, 6);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    t.diagnostic(JSON.stringify({ outageDurationMs: Math.floor(outageDurationMs), observedWindowMs: Math.floor(observedWindowMs),
      restartDowntimeMs: Math.floor(restartDowntimeMs), startupReceiptAttempts,
      receiptAttemptsBeforeRestart: firstWindow.failedReceiptAttempts, receiptAttemptsAfterRestart: secondWindow.failedReceiptAttempts,
      observationsBeforeRestart: firstWindow.observations, observationsAfterRestart: secondWindow.observations,
      settledPayments: 2, journalRows: 2, reconciled: result.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const cli of children) await cleanup(() => cli.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(cli => cli.child.exitCode !== null || cli.child.signalCode !== null), 'Do not remove files under a live CLI');
      assert.equal(dirname(resolve(directory!)), dataRoot);
      assert.ok(directory!.startsWith(join(dataRoot, 'cli-recovery-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'CLI recovery resource cleanup failed');
  }
});
