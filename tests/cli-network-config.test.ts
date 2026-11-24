import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import ganache from 'ganache';
import memdown from 'memdown';
import { id, keccak256, parseEther, Transaction, Wallet } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { deploy } from '../src/chain.ts';
import { acquireDatabaseOwnership, DatabaseOwnershipError } from '../src/database-ownership.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

const CHAIN_ID = 20261024;
const workRoot = resolve('../../work');

async function within<T>(pending: Promise<T>, label: string, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise<void>(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' timed out');
}
function removeOwned(directory: string, prefix: string) {
  const actual = realpathSync(directory);
  assert.equal(dirname(actual), realpathSync(workRoot));
  assert.ok(basename(actual).startsWith(prefix));
  rmSync(actual, { recursive: true, force: true });
}
async function stopChildren(children: CliHandle[], failures: unknown[]) {
  let stopped = true;
  for (const child of children) {
    try { await child.kill(); }
    catch (error) {
      failures.push(error); stopped = false; child.child.unref();
      (child.child.stdout as any)?.unref?.(); (child.child.stderr as any)?.unref?.();
    }
  }
  return stopped;
}
function requireCliOwnership(dbPath: string) {
  let unexpected: ReturnType<typeof acquireDatabaseOwnership>;
  try { unexpected = acquireDatabaseOwnership(dbPath); }
  catch (error) {
    assert.ok(error instanceof DatabaseOwnershipError);
    assert.equal(error.message, 'Database is already owned by another ClearLedger RPC process');
    return;
  }
  unexpected.release();
  assert.fail('A live CLI allowed a competing database owner');
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}

for (const [field, message] of [
  ['chainId', 'CLI test chain ID must be a positive safe integer'],
  ['confirmations', 'CLI test confirmation count must be a positive safe integer']
] as const) {
  test('CLI fixture rejects invalid ' + field + ' before filesystem or process creation', async () => {
    mkdirSync(workRoot, { recursive: true });
    const directory = mkdtempSync(join(workRoot, 'cli-network-validation-'));
    const children: CliHandle[] = [];
    try {
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '31337']) {
        await assert.rejects(startCli({ db: join(directory, 'uncreated', 'ledger.sqlite'),
          rpc: 'http://127.0.0.1:1', key: 'unused-test-key', router: '0x' + '44'.repeat(20),
          [field]: value as number, onSpawn: child => children.push(child) }),
        error => error instanceof Error && error.message === message);
        assert.equal(children.length, 0);
        assert.equal(existsSync(join(directory, 'uncreated')), false);
      }
    } finally {
      const failures: unknown[] = [];
      const stopped = await stopChildren(children, failures);
      if (stopped && failures.length === 0) {
        assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null));
        removeOwned(directory, 'cli-network-validation-');
      }
      if (failures.length) throw new AggregateError(failures, 'CLI option validation cleanup failed');
    }
  });
}

// Actual src/server.ts owns the ledger and dispatches from its normal scheduler.
// The parent observes SQLite and native JSON-RPC; it never ticks PaymentService.
test('actual CLI restarts a bound non-default-chain ledger with two confirmations and OS ownership', {
  timeout: 90000
}, async t => {
  compile();
  mkdirSync(workRoot, { recursive: true });
  const directory = mkdtempSync(join(workRoot, 'cli-network-config-'));
  const dbPath = join(directory, 'ledger.sqlite');
  const secrets = Array.from({ length: 4 }, () => Wallet.createRandom().privateKey);
  const chain = ganache.server({ database: { db: memdown() },
    chain: { chainId: CHAIN_ID, hardfork: 'shanghai' },
    wallet: { accounts: secrets.map(secretKey => ({ secretKey, balance: '0x' + parseEther('1000').toString(16) })) },
    logging: { quiet: true }, miner: { instamine: 'eager' } });
  const children: CliHandle[] = [];
  let listening = false, completed = false;
  let provider: ReturnType<typeof createRpcProvider> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let reader: DatabaseSync | undefined;
  try {
    await within(chain.listen(0, '127.0.0.1'), 'Local chain readiness'); listening = true;
    provider = createRpcProvider('http://127.0.0.1:' + (chain.address() as { port: number }).port, 3000);
    provider.pollingInterval = 50;
    const [admin, relayer, payer, payee] = secrets.map(key => new Wallet(key, provider));
    const { token, router } = await within(deploy(provider, admin, relayer, payer, payee), 'Contract deployment', 20000);
    const routerAddress = await router.getAddress();
    const genesis = await provider.getBlock(0); assert.ok(genesis?.hash);
    proxy = await rpcProxy(provider._getConnection().url);
    const config = { db: dbPath, rpc: proxy.url, key: relayer.privateKey, router: routerAddress,
      chainId: CHAIN_ID, confirmations: 2, onSpawn: (child: CliHandle) => children.push(child) };
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    assert.notEqual(cli.child.pid, process.pid);
    const overview = await api(cli, 'overview');
    assert.equal(overview.status, 200); assert.equal(overview.body.chainId, CHAIN_ID);
    assert.equal(overview.body.confirmations, 2);
    reader = new DatabaseSync(dbPath, { readOnly: true });
    const context = reader.prepare('SELECT singleton,version,chain_id,genesis_hash,router,relayer FROM deployment_context').all();
    assert.deepEqual(context.map(row => ({ ...row })), [{ singleton: 1, version: 1, chain_id: CHAIN_ID,
      genesis_hash: genesis.hash.toLowerCase(), router: routerAddress, relayer: relayer.address }]);
    const sidecar = realpathSync(dbPath) + '.worker-lock.sqlite';
    const sidecarIdentity = statSync(sidecar, { bigint: true });
    requireCliOwnership(dbPath);
    const latest = await provider.getBlock('latest'); assert.ok(latest);
    const payment: Payment = { paymentId: id('actual-cli-network-confirmations'), payer: payer.address,
      payee: payee.address, token: await token.getAddress(), amount: '125000000', nonce: '0',
      deadline: String(latest.timestamp + 3600) };
    const input = { payment, signature: await payer.signTypedData(domain(CHAIN_ID, routerAddress), paymentTypes, payment) };
    const paymentId = paymentKey(payment);
    const nativeNonce = await provider.getTransactionCount(relayer.address, 'latest');
    assert.equal((await api(cli, 'payments', input)).status, 202);
    const row = () => reader!.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow;
    await until(() => row()?.status === 'broadcast', 'Autonomous CLI broadcast');
    const reserved = row(); assert.ok(reserved.raw_tx && reserved.tx_hash);
    const raw = reserved.raw_tx, hash = reserved.tx_hash;
    assert.equal(keccak256(raw), hash); assert.equal(Transaction.from(raw).chainId, BigInt(CHAIN_ID));
    await until(async () => !!await provider!.getTransactionReceipt(hash), 'Genuine receipt availability');
    const receipt = await provider.getTransactionReceipt(hash); assert.ok(receipt?.status === 1);
    const receiptBlock = receipt.blockNumber;
    assert.equal(await provider.getBlockNumber(), receiptBlock);
    const receiptReads = () => proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt' && call.params?.[0] === hash).length;
    const snapshot = () => JSON.stringify({ row: row(), journals: reader!.prepare('SELECT * FROM journals').all(),
      audit: reader!.prepare('SELECT * FROM audit ORDER BY sequence').all(), context:
        reader!.prepare('SELECT * FROM deployment_context').all(),
      sequence: reader!.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
      schema: reader!.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all() });
    const held = snapshot();
    async function observeSingleConfirmation(label: string) {
      const baseline = receiptReads();
      await until(async () => {
        assert.equal(cli.child.exitCode, null); assert.equal(cli.child.signalCode, null);
        assert.equal(row().status, 'broadcast', 'One confirmation must not finalize a two-confirmation CLI payment');
        assert.equal(reader!.prepare('SELECT COUNT(*) AS count FROM journals').get()!.count, 0);
        assert.equal(await provider!.getBlockNumber(), receiptBlock);
        assert.ok(snapshot() === held, 'Autonomous confirmation checks changed the unconfirmed ledger');
        return receiptReads() >= baseline + 2;
      }, label);
      return receiptReads() - baseline;
    }
    const checksBeforeRestart = await observeSingleConfirmation('Initial autonomous single-confirmation checks');
    await cli.kill();
    const interrupted = await cli.exited;
    assert.ok(interrupted.signal === 'SIGKILL' || (interrupted.code !== null && interrupted.code !== 0));
    reader.close(); reader = new DatabaseSync(dbPath, { readOnly: true });
    assert.ok(snapshot() === held, 'Reopening after confirmed CLI close changed the ledger/context');
    const released = acquireDatabaseOwnership(dbPath); released.release();
    cli = await startCli({ ...config, apiKey: cli.apiKey });
    assert.notEqual(cli.child.pid, originalPid);
    assert.ok(snapshot() === held, 'Restart changed the original reservation, schema, context or audit sequence');
    requireCliOwnership(dbPath);
    const afterRestartOverview = await api(cli, 'overview');
    assert.equal(afterRestartOverview.status, 200); assert.equal(afterRestartOverview.body.chainId, CHAIN_ID);
    assert.equal(afterRestartOverview.body.confirmations, 2);
    const checksAfterRestart = await observeSingleConfirmation('Restarted autonomous single-confirmation checks');
    await provider.send('evm_mine', []);
    await until(() => row().status === 'settled', 'Autonomous settlement at two confirmations');
    const settled = row();
    assert.ok(settled.raw_tx === raw && settled.tx_hash === hash);
    assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM journals').get()!.count, 1);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM audit WHERE action='settled'").get()!.count, 1);
    assert.equal(await provider.getTransactionCount(relayer.address, 'latest'), nativeNonce + 1);
    assert.equal(await token.balanceOf(payee.address), 125000000n);
    const replay = await api(cli, 'payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    const reconciled = await api(cli, 'reconcile', {});
    assert.equal(reconciled.status, 200); assert.equal(reconciled.body.checked, 1);
    assert.deepEqual(reconciled.body.exceptions, []);
    const finalSnapshot = snapshot();
    await cli.kill();
    const exit = await cli.exited;
    assert.ok(exit.signal === 'SIGKILL' || (exit.code !== null && exit.code !== 0));
    const ownership = acquireDatabaseOwnership(dbPath); ownership.release();
    const retainedIdentity = statSync(sidecar, { bigint: true });
    assert.equal(retainedIdentity.dev, sidecarIdentity.dev); assert.equal(retainedIdentity.ino, sidecarIdentity.ino);
    assert.ok(snapshot() === finalSnapshot, 'Ownership reacquisition changed the retained ledger');
    t.diagnostic(JSON.stringify({ chainId: CHAIN_ID, confirmations: 2, autonomousReceiptChecksBeforeRestart: checksBeforeRestart,
      autonomousReceiptChecksAfterRestart: checksAfterRestart, exactCheckpointRetained: true,
      contextBound: true, competingOwnerRefused: true, ownershipReacquiredAfterBothKills: true,
      nativeNoncesConsumed: 1, journalRows: 1, reconciled: 1 }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    const stopped = await stopChildren(children, failures);
    for (const close of [() => reader?.close(), () => provider?.destroy(),
      () => proxy ? within(proxy.close(), 'Local proxy cleanup', 5000) : undefined,
      () => listening ? within(chain.close(), 'Local chain cleanup', 5000) : undefined]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (completed && stopped && failures.length === 0) {
      try { removeOwned(directory, 'cli-network-config-'); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'CLI network configuration cleanup failed');
  }
});
