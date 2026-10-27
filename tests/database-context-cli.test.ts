import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContractFactory, id, keccak256 } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { artifact } from '../src/chain.ts';
import { digest, domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' timed out');
}
async function api(cli: CliHandle, path: string, body?: unknown, apiKey = cli.apiKey) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}
function readDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function contextRows(db: DatabaseSync) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_context'").get()) return [];
  return db.prepare('SELECT singleton,version,chain_id,genesis_hash,router,relayer FROM deployment_context ORDER BY singleton')
    .all().map(row => ({ ...row }));
}
function snapshot(path: string) {
  return readDatabase(path, db => JSON.stringify({
    payments: db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    context: contextRows(db)
  }));
}

// This invokes the actual RPC CLI and its autonomous scheduler. All chain keys,
// contracts, SQLite files and temporary runtime directories belong to this test.
test('the RPC CLI binds its database identity, permits endpoint and API key changes, and refuses incompatible reuse', {
  timeout: 90000
}, async t => {
  const children: CliHandle[] = [];
  const dataRoot = resolve('data');
  let directory: string | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let firstProxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let alternateProxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  try {
    compile();
    chain = await localChain();
    firstProxy = await rpcProxy(chain.provider._getConnection().url);
    alternateProxy = await rpcProxy(chain.provider._getConnection().url);
    assert.notEqual(firstProxy.url, alternateProxy.url);
    mkdirSync(dataRoot, { recursive: true });
    directory = mkdtempSync(join(dataRoot, 'database-context-cli-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: firstProxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    let cli = await startCli(config);
    const initialApiKey = cli.apiKey;
    const latest = await chain.provider.getBlock('latest');
    assert.ok(latest);
    const signingDomain = domain(31337, config.router);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain!.payer.address,
        payee: chain!.payee.address, token: String(chain!.token.target), amount, nonce,
        deadline: String(latest!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(signingDomain, paymentTypes, payment) };
    }
    const input = await signed('125000000', '0');
    const paymentId = paymentKey(input.payment);
    const accepted = await api(cli, 'payments', input);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.payment.id, paymentId);
    await until(() => readDatabase(db, reader => reader.prepare('SELECT status FROM payments WHERE id=?').get(paymentId)?.status === 'settled'),
      'Autonomous initial settlement');
    await cli.kill();
    await cli.exited;
    const original = readDatabase(db, reader => reader.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow);
    assert.equal(original.status, 'settled');
    assert.ok(original.raw_tx && original.tx_hash);
    assert.equal(keccak256(original.raw_tx), original.tx_hash);
    const genesis = await chain.provider.getBlock(0);
    assert.ok(genesis?.hash);
    assert.deepEqual(readDatabase(db, contextRows), [{ singleton: 1, version: 1, chain_id: 31337,
      genesis_hash: genesis.hash.toLowerCase(), router: config.router, relayer: chain.relayer.address }]);
    const settledSnapshot = snapshot(db);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    const relayerNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');
    assert.equal(relayerNonce, 1);

    const rotatedApiKey = randomBytes(24).toString('hex');
    assert.notEqual(rotatedApiKey, initialApiKey);
    const sendsBeforeRestart = alternateProxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length;
    cli = await startCli({ ...config, rpc: alternateProxy.url, apiKey: rotatedApiKey });
    assert.equal((await api(cli, 'payments', undefined, initialApiKey)).status, 401);
    const history = await api(cli, 'payments');
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].id, paymentId);
    assert.equal(history.body.items[0].status, 'settled');
    for (const field of ['raw_tx', 'signature', 'fingerprint']) assert.equal(history.body.items[0][field], undefined);
    const replay = await api(cli, 'payments', input);
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.tx_hash, original.tx_hash);
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 1); assert.deepEqual(reconciliation.body.exceptions, []);
    await cli.kill(); await cli.exited;
    assert.ok(snapshot(db) === settledSnapshot, 'Compatible restart or replay changed persisted payment/context evidence');
    assert.equal(alternateProxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, sendsBeforeRestart);

    async function refused(overrides: Partial<typeof config>) {
      const targetDb = overrides.db ?? db;
      const before = snapshot(targetDb);
      const sendCount = alternateProxy!.calls.filter(call => call.method === 'eth_sendRawTransaction').length;
      const childIndex = children.length;
      await assert.rejects(startCli({ ...config, rpc: alternateProxy!.url, ...overrides }),
        error => error instanceof Error && error.message === 'RPC CLI could not become ready');
      assert.equal(children.length, childIndex + 1);
      const refusedCli = children[childIndex];
      assert.deepEqual(await refusedCli.exited, { code: 1, signal: null });
      assert.equal(refusedCli.url, '', 'Incompatible context must be rejected before HTTP readiness');
      assert.equal(alternateProxy!.calls.filter(call => call.method === 'eth_sendRawTransaction').length, sendCount);
      assert.ok(snapshot(targetDb) === before, 'Rejected startup changed payment, journal, audit or context evidence');
    }
    // The replacement relayer is funded and role-authorized, so refusal must not
    // be explained by insufficient funds or a missing on-chain settler role.
    await (await chain.router.grantRole(await chain.router.SETTLER_ROLE(), chain.payee.address)).wait();
    assert.equal(await chain.router.hasRole(await chain.router.SETTLER_ROLE(), chain.payee.address), true);
    assert.ok(await chain.provider.getBalance(chain.payee.address) > 0n);
    await refused({ key: chain.payee.privateKey });

    const routerArtifact = artifact('SettlementRouter');
    const otherRouter: any = await new ContractFactory(routerArtifact.abi, routerArtifact.bytecode, chain.admin)
      .deploy(chain.admin.address, chain.relayer.address);
    await otherRouter.waitForDeployment();
    assert.equal(await otherRouter.hasRole(await otherRouter.SETTLER_ROLE(), chain.relayer.address), true);
    await refused({ router: await otherRouter.getAddress() });

    const legacyDb = join(directory, 'legacy-unbound.sqlite');
    const legacyInput = await signed('7000000', '1');
    const legacyId = paymentKey(legacyInput.payment);
    const legacyStore = new Store(legacyDb);
    try { legacyStore.accept(legacyInput.payment, digest(legacyInput.payment, signingDomain), legacyInput.signature); }
    finally { legacyStore.close(); }
    assert.deepEqual(readDatabase(legacyDb, contextRows), []);
    await refused({ db: legacyDb });
    assert.deepEqual(readDatabase(legacyDb, contextRows), [], 'Legacy data must not receive an inferred deployment identity');
    const legacy = readDatabase(legacyDb, reader => reader.prepare('SELECT * FROM payments WHERE id=?').get(legacyId) as unknown as RecordRow);
    assert.equal(legacy.status, 'queued'); assert.equal(legacy.raw_tx, null); assert.equal(legacy.tx_hash, null);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), relayerNonce);
    assert.equal(firstProxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
    assert.equal(alternateProxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 0);
    t.diagnostic(JSON.stringify({ settledPayments: 1, compatibleRestarts: 1, rejectedContexts: 3,
      transfers: 1, legacyQueuedPayments: 1 }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => firstProxy?.close());
    await cleanup(() => alternateProxy?.close());
    await cleanup(() => chain?.close());
    if (directory) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove database files while a registered child is alive');
      assert.equal(dirname(resolve(directory!)), dataRoot);
      assert.ok(directory!.startsWith(join(dataRoot, 'database-context-cli-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Database context CLI cleanup failed');
  }
});
