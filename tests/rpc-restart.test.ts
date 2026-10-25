import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

type Message = { type: string; id?: number; ticks?: number; reason?: string };
type Worker = { process: ChildProcess; tick(): Promise<Message>; shutdown(): Promise<void>; kill(): Promise<void> };

class ReadProjection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(id: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(id) as unknown as RecordRow | undefined; }
  journals() { return this.db.prepare('SELECT * FROM journals').all(); }
  events() { return this.db.prepare('SELECT * FROM audit').all(); }
  close() { this.db.close(); }
}

function reply(child: ChildProcess, expected: string, command: Record<string, unknown>, id?: number) {
  return new Promise<Message>((resolveReply, reject) => {
    const timer = setTimeout(() => finish(new Error('Worker reply timed out')), 12000);
    function finish(error?: Error, message?: Message) {
      clearTimeout(timer);
      child.off('message', messageReceived);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error); else resolveReply(message!);
    }
    function messageReceived(message: Message) {
      if (message.type === 'fatal') finish(new Error('Worker rejected its command'));
      else if (message.type === expected && message.id === id) finish(undefined, message);
    }
    function failed() { finish(new Error('Worker process failed')); }
    function exited() { finish(new Error('Worker exited before replying')); }
    child.on('message', messageReceived);
    child.once('error', failed);
    child.once('exit', exited);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      finish(new Error('Worker is not connected')); return;
    }
    try { child.send(command, error => { if (error) finish(new Error('Worker command could not be sent')); }); }
    catch { finish(new Error('Worker command could not be sent')); }
  });
}

async function stopped(child: ChildProcess, force: boolean) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      finish(new Error('Worker did not terminate'));
    }, 5000);
    function finish(error?: Error) {
      clearTimeout(timer); child.off('exit', exited); child.off('error', failed);
      if (error) reject(error); else resolveExit();
    }
    function exited() { finish(); }
    function failed() { finish(new Error('Worker termination failed')); }
    child.once('exit', exited);
    child.once('error', failed);
    if (force) child.kill('SIGKILL');
  });
}

async function startWorker(config: { db: string; rpc: string; key: string; router: string }, children: Set<ChildProcess>): Promise<Worker> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/outage-worker.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.once('close', () => children.delete(child));
  child.once('error', () => { if (!child.pid) children.delete(child); });
  let sequence = 0;
  await reply(child, 'ready', { type: 'start', ...config });
  return {
    process: child,
    async tick() {
      const id = ++sequence;
      return await reply(child, 'tick', { type: 'tick', id }, id);
    },
    async shutdown() {
      const id = ++sequence;
      await reply(child, 'shutdown', { type: 'shutdown', id }, id);
      await stopped(child, false);
    },
    async kill() { await stopped(child, true); }
  };
}

test('a real 60-second receipt outage survives worker termination and SQLite reopen without duplicate settlement', { timeout: 180000 }, async t => {
  compile();
  const children = new Set<ChildProcess>();
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let reader: ReadProjection | undefined;
  let seeder: Store | undefined;
  let directory: string | undefined;
  const dataRoot = resolve('data');
  try {
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(dataRoot, { recursive: true });
    directory = mkdtempSync(join(dataRoot, 'rpc-restart-test-'));
    const db = join(directory, 'journal.sqlite');
    seeder = new Store(db);
    const initialService = new PaymentService(seeder, chain.provider, chain.relayer, chain.router, 31337, String(chain.router.target));
    const block = await chain.provider.getBlock('latest');
    async function accept(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')),
        payer: chain!.payer.address, payee: chain!.payee.address, token: String(chain!.token.target),
        amount, nonce, deadline: String(block!.timestamp + 3600) };
      const signature = await chain!.payer.signTypedData(initialService.signingDomain, paymentTypes, payment);
      return (await initialService.accept({ payment, signature })).row.id;
    }
    const firstId = await accept('125000000', '0');
    const secondId = await accept('7000000', '1');
    seeder.close(); seeder = undefined;

    let outageStarted: number | undefined;
    let receiptsBeforeOutage = 0;
    proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
    proxy.afterForward('eth_sendRawTransaction', () => {
      if (outageStarted === undefined) {
        outageStarted = performance.now();
        receiptsBeforeOutage = proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
      }
      proxy!.fail('eth_getTransactionReceipt', 'http-503');
    });
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target) };
    let worker = await startWorker(config, children);
    const originalPid = worker.process.pid;
    await worker.tick();
    assert.ok(outageStarted !== undefined, 'Fault must start only after the real chain accepted the transaction');
    reader = new ReadProjection(db);
    const original = reader.get(firstId)!;
    assert.equal(original.status, 'broadcast');
    assert.ok(original.raw_tx && original.tx_hash, 'Signed transaction must be durable before restart');
    const originalRaw = original.raw_tx;
    const originalHash = original.tx_hash;
    const originalNativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(keccak256(originalRaw), originalHash);
    let restarted = false;
    let observations = 0;
    let ticksBeforeRestart = 1;
    let ticksAfterRestart = 0;
    let firstWorkerReceiptReads = 0;
    const receiptFailures = () => proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt').length - receiptsBeforeOutage;
    async function observePending() {
      const first = reader!.get(firstId)!;
      const second = reader!.get(secondId)!;
      assert.equal(first.status, 'broadcast');
      assert.ok(first.raw_tx === originalRaw, 'Durable signed bytes changed during an uncertain outcome');
      assert.equal(first.tx_hash, originalHash);
      assert.equal(second.status, 'queued');
      assert.equal(second.raw_tx, null);
      assert.equal(second.tx_hash, null);
      assert.equal(reader!.journals().length, 0);
      assert.equal(reader!.events().filter(event => event.action === 'accepted').length, 2);
      assert.equal(reader!.events().filter(event => event.action === 'broadcast-prepared').length, 1);
      assert.equal(reader!.events().filter(event => event.action === 'settled').length, 0);
      const sends = proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction');
      assert.equal(sends.length, 1);
      assert.ok(sends[0].params![0] === originalRaw, 'Proxy observed different signed bytes');
      assert.equal(await chain!.token.balanceOf(chain!.payee.address), 125000000n);
      assert.equal(await chain!.router.nonces(chain!.payer.address), 1n);
      assert.equal(await chain!.provider.getTransactionCount(chain!.relayer.address, 'pending'), originalNativeNonce + 1);
      observations++;
    }
    await observePending();
    while (performance.now() - outageStarted < 60000) {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
      if (!restarted && performance.now() - outageStarted >= 10000) {
        firstWorkerReceiptReads = receiptFailures();
        await worker.kill(); // Actual OS kill: no worker cleanup or SQLite.close().
        reader.close(); reader = undefined;
        reader = new ReadProjection(db); // Explicit parent-side read-only reopen too.
        await observePending();
        worker = await startWorker(config, children);
        assert.notEqual(worker.process.pid, originalPid);
        restarted = true;
      }
      await worker.tick();
      if (restarted) ticksAfterRestart++; else ticksBeforeRestart++;
      await observePending();
    }
    const outageDurationMs = performance.now() - outageStarted;
    const failedReceiptReads = receiptFailures();
    const secondWorkerReceiptReads = failedReceiptReads - firstWorkerReceiptReads;
    assert.ok(restarted);
    assert.ok(outageDurationMs >= 60000);
    assert.ok(ticksBeforeRestart >= 3 && ticksAfterRestart >= 10, 'Both worker lifetimes must perform repeated retry attempts');
    assert.ok(firstWorkerReceiptReads >= 3 && secondWorkerReceiptReads >= 10, 'Both workers must make failed receipt RPC calls');
    assert.ok(failedReceiptReads >= 15 && observations >= 15, 'Outage must be repeatedly observed, not merely slept through');

    proxy.heal();
    for (let attempt = 0; attempt < 10 && reader.get(secondId)!.status !== 'settled'; attempt++) {
      await worker.tick();
      if (reader.get(secondId)!.status !== 'settled') await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
    }
    assert.equal(reader.get(firstId)!.status, 'settled');
    assert.equal(reader.get(secondId)!.status, 'settled');
    assert.equal(reader.get(firstId)!.tx_hash, originalHash);
    assert.ok(reader.get(firstId)!.raw_tx === originalRaw, 'Recovery replaced the original signed transaction');
    assert.equal(Transaction.from(reader.get(secondId)!.raw_tx!).nonce, originalNativeNonce + 1);
    assert.equal(reader.journals().length, 2);
    assert.equal(reader.events().filter(event => event.action === 'accepted').length, 2);
    for (const paymentId of [firstId, secondId])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === 'settled').length, 1);
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 2);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    await worker.shutdown();
    const recoveredStore = new Store(db); // No writer exists after confirmed child exit.
    try {
      const recoveredService = new PaymentService(recoveredStore, chain.provider, chain.relayer, chain.router, 31337, String(chain.router.target));
      const reconciliation = await recoveredService.reconcile();
      assert.equal(reconciliation.checked, 2);
      assert.deepEqual(reconciliation.exceptions, []);
    } finally { recoveredStore.close(); }
    t.diagnostic(JSON.stringify({ outageDurationMs: Math.floor(outageDurationMs), observations,
      ticksBeforeRestart, ticksAfterRestart, failedReceiptReads, firstWorkerReceiptReads, secondWorkerReceiptReads, settledPayments: 2 }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => stopped(child, true));
    await cleanup(() => reader?.close());
    await cleanup(() => seeder?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory) {
      await cleanup(() => {
        assert.equal(children.size, 0, 'Do not delete SQLite files before all workers exit');
        assert.equal(dirname(resolve(directory!)), dataRoot);
        assert.ok(directory!.startsWith(join(dataRoot, 'rpc-restart-test-')));
        rmSync(directory!, { recursive: true, force: true });
      });
    }
    if (failures.length) throw new AggregateError(failures, 'Outage test resource cleanup failed');
  }
});
