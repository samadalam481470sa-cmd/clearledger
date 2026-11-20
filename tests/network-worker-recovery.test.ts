import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ganache from 'ganache';
import memdown from 'memdown';
import { id, keccak256, parseEther, Transaction, Wallet } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { connectRouter, deploy } from '../src/chain.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { PaymentService } from '../src/service.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

const CHAIN_ID = 20261024;
interface Projection {
  row: RecordRow;
  payments: unknown[]; journals: unknown[]; audit: unknown[]; sequence: unknown[];
}
interface Message { type: string; id?: number; ticks?: number; snapshot?: Projection }

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

function reply(child: ChildProcess, command: Record<string, unknown>, expected: string, id?: number) {
  return new Promise<Message>((resolveReply, reject) => {
    const timer = setTimeout(() => fail('Fixture worker acknowledgement timed out'), expected === 'ready' ? 20000 : 10000);
    function clear() {
      clearTimeout(timer); child.off('message', message); child.off('error', failed); child.off('exit', exited);
    }
    function fail(reason: string) { clear(); reject(new Error(reason)); }
    function message(value: Message) {
      if (value.type === 'fatal') fail('Fixture worker rejected its command');
      else if (value.type === expected && value.id === id) { clear(); resolveReply(value); }
    }
    function failed() { fail('Fixture worker process failed'); }
    function exited() { fail('Fixture worker exited before its acknowledgement'); }
    child.on('message', message); child.once('error', failed); child.once('exit', exited);
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      fail('Fixture worker is not connected'); return;
    }
    try { child.send(command, error => { if (error) fail('Fixture worker command could not be sent'); }); }
    catch { fail('Fixture worker command could not be sent'); }
  });
}

async function kill(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL'); // This handle belongs only to the process spawned below.
  await within(exited, 'Fixture worker SIGKILL', 5000);
}

function projection(store: Store, paymentId: string): Projection {
  const rows = (sql: string) => store.db.prepare(sql).all().map(row => ({ ...row }));
  return { row: store.get(paymentId)!,
    payments: rows('SELECT * FROM payments ORDER BY rowid'),
    journals: rows('SELECT * FROM journals ORDER BY rowid'),
    audit: rows('SELECT * FROM audit ORDER BY sequence'),
    sequence: rows('SELECT * FROM sqlite_sequence ORDER BY name') };
}

// This is an actual fixture-process kill over native JSON-RPC/Ganache and a
// file-backed ledger. It is not a Besu runtime or the durable RPC CLI.
test('a Besu-chain fixture worker preserves its file reservation and two-confirmation policy across SIGKILL', {
  timeout: 45000
}, async t => {
  compile();
  const dataRoot = resolve('data'); mkdirSync(dataRoot, { recursive: true });
  const directory = mkdtempSync(join(dataRoot, 'network-worker-test-'));
  const secrets = Array.from({ length: 4 }, () => Wallet.createRandom().privateKey);
  const chain = ganache.server({ database: { db: memdown() },
    chain: { chainId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: secrets.map(secretKey => ({ secretKey, balance: '0x' + parseEther('1000').toString(16) })) },
    logging: { quiet: true }, miner: { instamine: 'eager' } });
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let recoveryProvider: ReturnType<typeof createRpcProvider> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let store: Store | undefined, child: ChildProcess | undefined, listening = false;
  try {
    await within(chain.listen(0, '127.0.0.1'), 'Ganache readiness'); listening = true;
    provider = createRpcProvider('http://127.0.0.1:' + (chain.address() as { port: number }).port, 3000);
    provider.pollingInterval = 50;
    assert.equal((await provider.getNetwork()).chainId, BigInt(CHAIN_ID));
    const [admin, relayer, payer, payee] = secrets.map(key => new Wallet(key, provider));
    const { token, router } = await within(deploy(provider, admin, relayer, payer, payee), 'Contract deployment', 15000);
    const routerAddress = await router.getAddress(), db = join(directory, 'ledger.sqlite');
    store = new Store(db);
    const service = new PaymentService(store, provider, relayer, router, CHAIN_ID, routerAddress, 2);
    const latest = await provider.getBlock('latest'); assert.ok(latest);
    const payment: Payment = { paymentId: id('network-worker-confirmation-policy'), payer: payer.address,
      payee: payee.address, token: await token.getAddress(), amount: '125000000', nonce: '0',
      deadline: String(latest.timestamp + 3600) };
    const signature = await payer.signTypedData(service.signingDomain, paymentTypes, payment);
    const accepted = await within(service.accept({ payment, signature }), 'Queued payment acceptance');
    const nativeNonce = await provider.getTransactionCount(relayer.address, 'latest');
    store.close(); store = undefined;
    proxy = await rpcProxy(provider._getConnection().url);
    child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/outage-worker.ts'], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, TMP: directory, TEMP: directory, TMPDIR: directory,
        TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1' }
    });
    await reply(child, { type: 'start', db, rpc: proxy.url, key: relayer.privateKey,
      router: routerAddress, chainId: CHAIN_ID, confirmations: 2 }, 'ready');
    const tick = await reply(child, { type: 'tick', id: 1, paymentId: accepted.row.id }, 'tick', 1);
    assert.equal(tick.ticks, 1); assert.ok(tick.snapshot);
    const prepared = tick.snapshot, reserved = prepared.row;
    assert.equal(reserved.status, 'broadcast', 'One mined block must not satisfy two confirmations');
    assert.ok(reserved.raw_tx && reserved.tx_hash);
    const raw = reserved.raw_tx, hash = reserved.tx_hash, decoded = Transaction.from(raw);
    assert.equal(keccak256(raw), hash); assert.equal(decoded.chainId, BigInt(CHAIN_ID));
    assert.equal(decoded.nonce, nativeNonce); assert.equal(reserved.signature, signature);
    assert.equal(reserved.fingerprint, accepted.row.fingerprint);
    assert.equal(prepared.journals.length, 0);
    const receipt = await provider.getTransactionReceipt(hash); assert.ok(receipt);
    assert.equal(await provider.getBlockNumber(), receipt.blockNumber);
    const sends = () => proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction');
    const dispatchAttempts = sends().length; assert.ok(dispatchAttempts >= 1);
    assert.ok(sends().every(call => call.params?.[0] === raw));
    const depthCheck = await reply(child, { type: 'tick', id: 2, paymentId: accepted.row.id }, 'tick', 2);
    assert.equal(depthCheck.ticks, 2); assert.ok(depthCheck.snapshot);
    assert.deepEqual(depthCheck.snapshot, prepared, 'A known one-confirmation receipt must remain unjournaled');
    assert.equal(sends().length, dispatchAttempts);
    const checkpoint = depthCheck.snapshot;
    await kill(child); assert.equal(child.signalCode, 'SIGKILL');
    store = new Store(db);
    assert.deepEqual(projection(store, accepted.row.id), checkpoint);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, 0,
      'A reopened connection has its own write counter, not the killed connection counter');
    assert.equal(store.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
    assert.equal(store.db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
    recoveryProvider = createRpcProvider(proxy.url, 3000);
    const recoveryRelayer = new Wallet(relayer.privateKey, recoveryProvider);
    const recovered = new PaymentService(store, recoveryProvider, recoveryRelayer,
      connectRouter(routerAddress, recoveryRelayer), CHAIN_ID, routerAddress, 2);
    await within(recovered.tick(), 'Pre-depth recovery check');
    assert.deepEqual(projection(store, accepted.row.id), checkpoint);
    await provider.send('evm_mine', []);
    await within(recovered.tick(), 'Recovery after second confirmation');
    const settled = store.get(accepted.row.id)!;
    assert.equal(settled.status, 'settled'); assert.equal(settled.raw_tx, raw); assert.equal(settled.tx_hash, hash);
    assert.equal(store.journals().length, 1); assert.equal(store.journal(accepted.row.id)!.tx_hash, hash);
    assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
    assert.equal(await token.balanceOf(payee.address), 125000000n);
    assert.equal(await router.nonces(payer.address), 1n);
    assert.equal(await provider.getTransactionCount(relayer.address, 'latest'), nativeNonce + 1);
    const final = projection(store, accepted.row.id), changes = store.db.prepare('SELECT total_changes() AS n').get()!.n;
    assert.equal((await recovered.accept({ payment, signature })).replay, true);
    await recovered.tick(); const reconciled = await recovered.reconcile();
    assert.equal(reconciled.checked, 1); assert.deepEqual(reconciled.exceptions, []);
    assert.deepEqual(projection(store, accepted.row.id), final);
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.equal(sends().length, dispatchAttempts); assert.ok(sends().every(call => call.params?.[0] === raw));
    t.diagnostic(JSON.stringify({ chainId: CHAIN_ID, confirmations: 2, termination: child.signalCode,
      retainedReservation: true, nativeSendAttempts: sends().length, nativeNonceConsumed: 1,
      journalEntries: 1, reconciliationChecked: 1 }));
  } finally {
    const failures: unknown[] = [];
    let childStopped = true;
    try { if (child) await kill(child); }
    catch (error) {
      failures.push(error); childStopped = false;
      child?.unref(); child?.channel?.unref();
    }
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => store?.close()),
      Promise.resolve().then(() => recoveryProvider?.destroy()),
      Promise.resolve().then(() => provider?.destroy()),
      Promise.resolve().then(() => proxy ? within(proxy.close(), 'RPC proxy cleanup') : undefined),
      Promise.resolve().then(() => listening ? within(chain.close(), 'Ganache cleanup') : undefined)
    ]);
    for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason);
    if (childStopped) {
      try {
        const actual = realpathSync(directory);
        assert.equal(dirname(actual), realpathSync(dataRoot));
        assert.ok(actual.startsWith(join(realpathSync(dataRoot), 'network-worker-test-')));
        rmSync(actual, { recursive: true, force: true });
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }
});
