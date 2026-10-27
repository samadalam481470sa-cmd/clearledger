import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

// The actual RPC process owns every write. The parent observes file-backed
// evidence and sends HTTP requests; it never drives a service tick over IPC.
class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(id: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(id) as unknown as RecordRow | undefined; }
  journals() { return this.db.prepare('SELECT * FROM journals').all(); }
  events() { return this.db.prepare('SELECT * FROM audit').all(); }
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

test('the actual CLI recovers an unpropagated reservation across SIGKILL without releasing queued nonce priority', {
  timeout: 90000
}, async t => {
  const children: CliHandle[] = [];
  const workRoot = resolve('../../work');
  let directory: string | undefined, reader: Projection | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  try {
    compile();
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'cli-unpropagated-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    let forwardedDuringFault = 0, forwardedAfterHeal = 0, acceptance503Retries = 0;
    // Reject the complete send exchange before the proxy forwards any bytes.
    // This exercises attempted broadcasts, not a crash before the provider call.
    proxy.fail('eth_sendRawTransaction', 'http-503');
    proxy.afterForward('eth_sendRawTransaction', () => { forwardedDuringFault++; });
    const sends = () => proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction');
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    const sidecar = realpathSync(db) + '.worker-lock.sqlite';
    const sidecarIdentity = statSync(sidecar, { bigint: true }).ino;
    reader = new Projection(db);
    const block = await chain.provider.getBlock('latest');
    assert.ok(block);
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    const initialPayerNativeNonce = await chain.provider.getTransactionCount(chain.payer.address, 'pending');
    const initialRelayerNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');
    const initialPayerNonce = await chain.router.nonces(chain.payer.address);
    async function signed(amount: string, nonce: bigint) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain!.payer.address,
        payee: chain!.payee.address, token: String(chain!.token.target), amount, nonce: nonce.toString(), deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', initialPayerNonce);
    const secondInput = await signed('7000000', initialPayerNonce + 1n);
    const firstId = paymentKey(firstInput.payment), secondId = paymentKey(secondInput.payment);
    async function acceptSameIntent(input: typeof firstInput) {
      const deadline = performance.now() + 15000;
      for (let attempt = 0; attempt < 100 && performance.now() < deadline; attempt++) {
        const result = await api(cli, 'payments', input);
        if (result.status === 202 || result.status === 200) {
          assert.equal(result.body.payment.id, paymentKey(input.payment));
          assert.equal(result.body.replay, result.status === 200);
          return;
        }
        assert.equal(result.status, 503, 'Only an explicit upstream-unavailable response may be retried');
        assert.deepEqual(result.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
        acceptance503Retries++;
        await new Promise(resolvePause => setTimeout(resolvePause, 100));
      }
      throw new Error('The identical HTTP payment intent did not become accepted within its retry bound');
    }
    await acceptSameIntent(firstInput);
    await until(() => reader!.get(firstId)?.status === 'broadcast' && sends().length >= 1,
      'The autonomous CLI must persist and attempt the first transaction');
    const original = reader.get(firstId)!;
    assert.ok(original.raw_tx && original.tx_hash);
    const originalRaw = original.raw_tx, originalHash = original.tx_hash;
    const nativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(nativeNonce, initialRelayerNonce);
    assert.equal(keccak256(originalRaw), originalHash);
    await acceptSameIntent(secondInput);

    function assertReservation() {
      const first = reader!.get(firstId)!, second = reader!.get(secondId)!;
      assert.equal(first.status, 'broadcast');
      assert.ok(first.raw_tx === originalRaw, 'An unpropagated reservation changed signed bytes');
      assert.equal(first.tx_hash, originalHash);
      assert.equal(second.status, 'queued');
      assert.equal(second.raw_tx, null); assert.equal(second.tx_hash, null);
      assert.equal(reader!.journals().length, 0);
      const events = reader!.events();
      assert.equal(events.length, 3);
      assert.equal(events.filter(event => event.action === 'accepted').length, 2);
      assert.equal(events.filter(event => event.action === 'broadcast-prepared').length, 1);
      for (const call of sends()) assert.ok(call.params?.[0] === originalRaw, 'RPC retried different signed bytes during the send outage');
      assert.equal(forwardedDuringFault, 0);
    }
    async function assertUnpropagated() {
      assertReservation();
      // Use the direct, healthy upstream rather than the faulting client provider.
      assert.equal(await chain!.provider.getTransaction(originalHash), null);
      assert.equal(await chain!.provider.getTransactionReceipt(originalHash), null);
      assert.equal(await chain!.token.balanceOf(chain!.payee.address), 0n);
      assert.equal(await chain!.token.balanceOf(chain!.payer.address), initialPayerBalance);
      assert.equal(await chain!.router.nonces(chain!.payer.address), initialPayerNonce);
      assert.equal(await chain!.provider.getTransactionCount(chain!.relayer.address, 'pending'), initialRelayerNonce);
      assert.equal(await chain!.provider.getTransactionCount(chain!.relayer.address, 'latest'), initialRelayerNonce);
      assert.equal(await chain!.provider.getTransactionCount(chain!.payer.address, 'pending'), initialPayerNativeNonce);
    }
    await until(() => { assertReservation(); return sends().length >= 4; }, 'Four autonomous unpropagated sends before termination');
    await assertUnpropagated();
    await cli.kill();
    const killed = await cli.exited;
    assert.ok(killed.signal === 'SIGKILL' || killed.code !== 0, 'Expected actual abrupt CLI termination');
    reader.close(); reader = new Projection(db);
    await assertUnpropagated();
    const attemptsBeforeRestart = sends().length;
    const restartBaseline = attemptsBeforeRestart;
    assert.ok(attemptsBeforeRestart >= 4);
    assert.ok(existsSync(sidecar));
    assert.equal(statSync(sidecar, { bigint: true }).ino, sidecarIdentity);

    cli = await startCli({ ...config, apiKey: cli.apiKey });
    assert.notEqual(cli.child.pid, originalPid);
    assert.equal(statSync(sidecar, { bigint: true }).ino, sidecarIdentity);
    await until(() => { assertReservation(); return sends().length - restartBaseline >= 4; },
      'Four autonomous unpropagated sends after restart');
    await assertUnpropagated();
    const attemptsAfterRestart = sends().length - restartBaseline;
    assert.ok(attemptsAfterRestart >= 4);

    const attemptsBeforeHeal = sends().length;
    proxy.heal(); // This also clears hooks, so install the success counter again.
    proxy.afterForward('eth_sendRawTransaction', () => { forwardedAfterHeal++; });
    await until(() => reader!.get(firstId)?.status === 'settled' && reader!.get(secondId)?.status === 'settled',
      'Autonomous settlement after send recovery');
    const firstSettled = reader.get(firstId)!, secondSettled = reader.get(secondId)!;
    assert.ok(firstSettled.raw_tx === originalRaw, 'Recovery replaced the first signed reservation');
    assert.equal(firstSettled.tx_hash, originalHash);
    assert.ok(secondSettled.raw_tx && secondSettled.tx_hash);
    assert.equal(keccak256(secondSettled.raw_tx), secondSettled.tx_hash);
    assert.equal(Transaction.from(secondSettled.raw_tx).nonce, nativeNonce + 1);
    assert.equal(reader.journals().length, 2);
    for (const paymentId of [firstId, secondId]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(reader.events().length, 6);
    assert.equal(forwardedDuringFault, 0); assert.equal(forwardedAfterHeal, 2);
    assert.equal(sends().length - attemptsBeforeHeal, 2);
    const hashes = new Set(sends().map(call => keccak256(call.params![0] as string)));
    assert.deepEqual(hashes, new Set([originalHash, secondSettled.tx_hash]));
    for (const hash of hashes) assert.equal((await chain.provider.getTransactionReceipt(hash))!.status, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), initialPayerNonce + 2n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), initialRelayerNonce + 2);
    assert.equal(await chain.provider.getTransactionCount(chain.payer.address, 'pending'), initialPayerNativeNonce);
    for (const input of [firstInput, secondInput]) {
      const replay = await api(cli, 'payments', input);
      assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
      for (const field of ['raw_tx', 'signature', 'fingerprint']) assert.equal(replay.body.payment[field], undefined);
    }
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 2); assert.deepEqual(reconciliation.body.exceptions, []);
    assert.equal(reader.journals().length, 2); assert.equal(reader.events().length, 6);
    assert.equal(forwardedAfterHeal, 2);
    t.diagnostic(JSON.stringify({ attemptsBeforeRestart, attemptsAfterRestart, forwardedDuringFault,
      forwardedAfterHeal, uniqueNativeHashes: hashes.size, acceptance503Retries, settledPayments: 2,
      journalRows: 2, reconciled: reconciliation.body.checked }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove database/ownership files while a registered CLI child is alive');
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'cli-unpropagated-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Unpropagated CLI cleanup failed');
  }
});
