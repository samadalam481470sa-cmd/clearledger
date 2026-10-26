import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';
import { startCli } from './fixtures/cli-server.ts';

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function until<T>(probe: () => Promise<T | undefined>, label: string, timeoutMs = 15000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await within(probe(), label, Math.max(1, deadline - performance.now()));
    if (result !== undefined) return result;
    await new Promise<void>(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' did not become ready');
}

function listenerRefused(url: string): Promise<boolean> {
  return new Promise((resolveRefused, reject) => {
    const endpoint = new URL(url);
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    function finish(error?: Error, refused = false) {
      socket.removeAllListeners(); socket.destroy();
      if (error) reject(error); else resolveRefused(refused);
    }
    socket.once('connect', () => finish());
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish(undefined, true);
      else finish(new Error('Could not observe the CLI listener'));
    });
    socket.setTimeout(500, () => finish(new Error('CLI listener probe timed out')));
  });
}

async function api(url: string, key: string, path: string, body?: unknown) {
  const response = await fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

// This uses the actual application entrypoint and automatic scheduler, not an
// IPC-controlled replacement worker. Windows cannot deliver a catchable POSIX
// SIGTERM through child.kill(), so its regular suite reports an explicit skip.
test('the actual CLI drains a mined receipt on SIGTERM and preserves settlements across restart', {
  timeout: 90000,
  skip: process.platform === 'win32' ? 'Actual CLI SIGTERM handling requires catchable POSIX signals; Windows child.kill(SIGTERM) terminates immediately.' : false
}, async t => {
  const children: Awaited<ReturnType<typeof startCli>>[] = [];
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let reader: DatabaseSync | undefined;
  let directory: string | undefined;
  let receiptGate: ReturnType<Awaited<ReturnType<typeof rpcProxy>>['pauseAfterForward']> | undefined;
  const dataRoot = resolve('data');
  try {
    compile();
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(dataRoot, { recursive: true });
    directory = mkdtempSync(join(dataRoot, 'cli-signal-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: Awaited<ReturnType<typeof startCli>>) => { children.push(handle); } };
    let cli = await startCli(config);
    reader = new DatabaseSync(db, { readOnly: true });
    function row(paymentId: string): RecordRow {
      return reader!.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow;
    }
    function count(table: 'journals' | 'audit', action?: string, paymentId?: string): number {
      if (table === 'journals') return Number(reader!.prepare('SELECT COUNT(*) AS count FROM journals').get()!.count);
      return Number(reader!.prepare('SELECT COUNT(*) AS count FROM audit WHERE action=? AND payment_id=?').get(action!, paymentId!)!.count);
    }
    const block = await chain.provider.getBlock('latest');
    assert.ok(block);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')),
        payer: chain!.payer.address, payee: chain!.payee.address, token: String(chain!.token.target),
        amount, nonce, deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0');
    // The first receipt lookup is legitimately null. Arm only after Ganache has
    // accepted the native transaction, so the held response is a mined receipt.
    proxy.afterForward('eth_sendRawTransaction', () => {
      receiptGate ??= proxy!.pauseAfterForward('eth_getTransactionReceipt');
    });
    const accepted = await api(cli.url, cli.apiKey, '/api/payments', firstInput);
    assert.equal(accepted.status, 202);
    const firstId = accepted.body.payment.id as string;
    await until(async () => receiptGate, 'Post-send receipt gate registration');
    await within(receiptGate!.entered, 'Mined receipt held at the RPC boundary');
    const broadcast = row(firstId);
    assert.equal(broadcast.status, 'broadcast');
    assert.ok(broadcast.raw_tx && broadcast.tx_hash);
    const originalRaw = broadcast.raw_tx, originalHash = broadcast.tx_hash;
    const originalNativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(keccak256(originalRaw), originalHash);
    assert.equal((await chain.provider.getTransactionReceipt(originalHash))!.status, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(count('journals'), 0);

    assert.ok(cli.child.kill('SIGTERM'), 'Expected POSIX SIGTERM delivery to the tracked CLI child');
    await until(async () => await listenerRefused(cli.url) ? true : undefined, 'CLI listener shutdown', 3000);
    assert.equal(cli.child.exitCode, null, 'The CLI must await the held receipt before exiting');
    assert.equal(cli.child.signalCode, null);
    assert.equal(row(firstId).status, 'broadcast');
    assert.equal(count('journals'), 0);

    receiptGate!.release();
    assert.deepEqual(await within(cli.exited, 'Graceful application exit'), { code: 0, signal: null });
    reader.close(); reader = new DatabaseSync(db, { readOnly: true });
    assert.equal(row(firstId).status, 'settled', 'The receipt must commit during the active tick drain');
    assert.ok(row(firstId).raw_tx === originalRaw, 'Drain changed the persisted signed transaction');
    assert.equal(row(firstId).tx_hash, originalHash);
    assert.equal(count('journals'), 1);
    assert.equal(count('audit', 'settled', firstId), 1);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);

    proxy.heal();
    cli = await startCli(config);
    const history = await api(cli.url, cli.apiKey, '/api/payments');
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].id, firstId);
    assert.equal(history.body.items[0].status, 'settled');
    assert.equal(history.body.items[0].tx_hash, originalHash);
    const replay = await api(cli.url, cli.apiKey, '/api/payments', firstInput);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.tx_hash, originalHash);
    for (const privateField of ['raw_tx', 'signature', 'fingerprint'])
      assert.equal(replay.body.payment[privateField], undefined);
    // New HTTP acceptance is exercised after restart, with healthy transport.
    // No concurrent API-availability claim is made while a receipt is held.
    const secondInput = await signed('7000000', '1');
    const secondAccepted = await api(cli.url, cli.apiKey, '/api/payments', secondInput);
    assert.equal(secondAccepted.status, 202);
    const secondId = secondAccepted.body.payment.id as string;
    await until(async () => {
      const response = await api(cli.url, cli.apiKey, '/api/payments');
      assert.equal(response.status, 200);
      const first = response.body.items.find((payment: any) => payment.id === firstId);
      const second = response.body.items.find((payment: any) => payment.id === secondId);
      return first?.status === 'settled' && second?.status === 'settled' ? response.body : undefined;
    }, 'Automatic CLI settlement after restart');
    const reconciliation = await api(cli.url, cli.apiKey, '/api/reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 2);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.ok(cli.child.kill('SIGTERM'));
    assert.deepEqual(await within(cli.exited, 'Restarted CLI graceful exit'), { code: 0, signal: null });
    reader.close(); reader = new DatabaseSync(db, { readOnly: true });
    assert.equal(row(firstId).status, 'settled');
    assert.equal(row(secondId).status, 'settled');
    assert.ok(row(firstId).raw_tx === originalRaw, 'Restart replaced the first signed transaction');
    assert.equal(row(firstId).tx_hash, originalHash);
    assert.equal(Transaction.from(row(secondId).raw_tx!).nonce, originalNativeNonce + 1);
    assert.equal(count('journals'), 2);
    for (const paymentId of [firstId, secondId]) {
      assert.equal(count('audit', 'accepted', paymentId), 1);
      assert.equal(count('audit', 'broadcast-prepared', paymentId), 1);
      assert.equal(count('audit', 'settled', paymentId), 1);
    }
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 2);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    t.diagnostic('Actual POSIX CLI SIGTERM drained one receipt, preserved its settlement across restart, and settled a second HTTP instruction exactly once.');
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    receiptGate?.release();
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove SQLite files while a tracked CLI child is alive');
      assert.equal(dirname(resolve(directory!)), dataRoot);
      assert.ok(directory!.startsWith(join(dataRoot, 'cli-signal-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'CLI signal test resource cleanup failed');
  }
});
