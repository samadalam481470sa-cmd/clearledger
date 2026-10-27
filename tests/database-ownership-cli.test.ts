import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256 } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

async function until(check: () => Promise<boolean>, label: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise<void>(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' timed out');
}
async function api(cli: CliHandle, path: string, body?: unknown) {
  const response = await fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() as any };
}
function readDatabase<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); } finally { db.close(); }
}
function snapshot(path: string) {
  return readDatabase(path, db => JSON.stringify({
    payments: db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    context: db.prepare('SELECT * FROM deployment_context ORDER BY singleton').all(),
    schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all()
  }));
}

// Actual application children run their automatic scheduler. Chain, database,
// sidecar and runtime temp files are ephemeral test resources on one local host.
test('actual RPC processes enforce one database owner and reacquire a retained sidecar after termination', {
  timeout: 90000
}, async t => {
  const children: CliHandle[] = [];
  const workRoot = resolve('..', '..', 'work');
  let directory: string | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  try {
    compile();
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'database-ownership-cli-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    const sends = () => proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction').length;
    const owner = await startCli(config);
    const ownerPid = owner.child.pid;
    const sidecar = realpathSync(db) + '.worker-lock.sqlite';
    assert.ok(existsSync(sidecar), 'The running CLI must retain its ownership sidecar');
    const sidecarIdentity = statSync(sidecar, { bigint: true });
    assert.ok(sidecarIdentity.isFile());
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    const initialRelayerNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');

    async function refused(overrides: Partial<typeof config> = {}) {
      const before = snapshot(db), sendsBefore = sends();
      const index = children.length;
      await assert.rejects(startCli({ ...config, ...overrides }),
        error => error instanceof Error && error.message === 'RPC CLI could not become ready');
      assert.equal(children.length, index + 1, 'Failed startup must still register its child');
      const contender = children[index];
      assert.deepEqual(await contender.exited, { code: 1, signal: null });
      assert.equal(contender.url, '', 'A refused process must not expose an HTTP listener');
      assert.ok(snapshot(db) === before, 'Refused startup changed financial rows, context or schema');
      assert.equal(sends(), sendsBefore, 'A refused process must not send a native transaction');
    }

    // Every input is the same already-working deployment; only ownership differs.
    await refused();
    assert.equal(owner.child.exitCode, null);
    assert.equal(owner.child.signalCode, null);
    const emptyHistory = await api(owner, 'payments');
    assert.equal(emptyHistory.status, 200);
    assert.deepEqual(emptyHistory.body.items, []);

    const latest = await chain.provider.getBlock('latest');
    assert.ok(latest);
    const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')),
      payer: chain.payer.address, payee: chain.payee.address, token: String(chain.token.target),
      amount: '125000000', nonce: '0', deadline: String(latest.timestamp + 3600) };
    const input = { payment, signature: await chain.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    const paymentId = paymentKey(payment);
    const accepted = await api(owner, 'payments', input);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.payment.id, paymentId);
    await until(async () => {
      const history = await api(owner, 'payments');
      assert.equal(history.status, 200);
      return history.body.items.some((row: any) => row.id === paymentId && row.status === 'settled');
    }, 'The original owner must remain able to settle after competing startup');
    const original = readDatabase(db, reader => reader.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow);
    assert.equal(original.status, 'settled');
    assert.ok(original.raw_tx && original.tx_hash);
    assert.equal(keccak256(original.raw_tx), original.tx_hash);
    assert.equal(sends(), 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);

    const dotAlias = directory + sep + '.' + sep + 'journal.sqlite';
    assert.notEqual(dotAlias, db);
    assert.equal(realpathSync(dotAlias), realpathSync(db));
    await refused({ db: dotAlias });
    assert.equal(owner.child.exitCode, null);
    const settledSnapshot = snapshot(db);
    await owner.kill(); // Actual SIGKILL/OS termination skips graceful sidecar release.
    const terminated = await owner.exited;
    assert.ok(terminated.signal === 'SIGKILL' || terminated.code !== 0, 'Expected abrupt owner termination');
    assert.ok(existsSync(sidecar), 'Owner termination must not require stale sidecar deletion');
    assert.equal(statSync(sidecar, { bigint: true }).ino, sidecarIdentity.ino);

    let restarted = await startCli({ ...config, db: dotAlias, apiKey: owner.apiKey });
    assert.notEqual(restarted.child.pid, ownerPid);
    assert.ok(existsSync(sidecar));
    assert.equal(statSync(sidecar, { bigint: true }).ino, sidecarIdentity.ino,
      'Reacquisition must reuse the existing sidecar file');
    const history = await api(restarted, 'payments');
    assert.equal(history.status, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].id, paymentId);
    assert.equal(history.body.items[0].status, 'settled');
    assert.equal(history.body.items[0].tx_hash, original.tx_hash);
    for (const field of ['raw_tx', 'signature', 'fingerprint'])
      assert.equal(history.body.items[0][field], undefined);
    const replay = await api(restarted, 'payments', input);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    const reconciliation = await api(restarted, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    assert.equal(reconciliation.body.checked, 1);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.ok(snapshot(db) === settledSnapshot, 'Reacquisition, replay or reconciliation changed settled evidence');
    assert.equal(sends(), 1);
    await restarted.kill(); await restarted.exited;

    // This eligible replacement key passes RPC role checks but mismatches the
    // bound database. A startup refusal must still leave the sidecar reusable.
    await (await chain.router.grantRole(await chain.router.SETTLER_ROLE(), chain.payee.address)).wait();
    assert.equal(await chain.router.hasRole(await chain.router.SETTLER_ROLE(), chain.payee.address), true);
    assert.ok(await chain.provider.getBalance(chain.payee.address) > 0n);
    await refused({ key: chain.payee.privateKey });
    restarted = await startCli(config);
    const finalHistory = await api(restarted, 'payments');
    assert.equal(finalHistory.status, 200);
    assert.equal(finalHistory.body.items[0].id, paymentId);
    assert.equal(finalHistory.body.items[0].status, 'settled');
    assert.ok(snapshot(db) === settledSnapshot, 'Valid startup after context refusal changed persisted evidence');
    const final = readDatabase(db, reader => ({
      payment: reader.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow,
      journals: reader.prepare('SELECT * FROM journals').all(),
      audit: reader.prepare('SELECT * FROM audit').all()
    }));
    assert.ok(final.payment.raw_tx === original.raw_tx, 'Ownership restart replaced persisted signed bytes');
    assert.equal(final.payment.tx_hash, original.tx_hash);
    assert.equal(final.journals.length, 1);
    for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(final.audit.filter(row => row.payment_id === paymentId && row.action === action).length, 1);
    assert.equal(sends(), 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), initialRelayerNonce + 1);
    t.diagnostic(JSON.stringify({ refusedCompetingStarts: 2, abruptOwnerRestarts: 1,
      refusedContextStarts: 1, validRestartAfterContextRefusal: 1, settledPayments: 1,
      journalRows: 1, nativeSends: 1, retainedSidecar: true }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    // Retain task data for review after any incomplete resource cleanup.
    if (directory && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove ownership/database files while a tracked CLI child is alive');
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'database-ownership-cli-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Database ownership CLI cleanup failed');
  }
});
