import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, parseUnits, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { bindDatabaseContext } from '../src/database-context.ts';
import { acquireDatabaseOwnership, type DatabaseOwnership } from '../src/database-ownership.ts';
import { digest, domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

const queuedError = 'Stored queued authorization is invalid; verify the original authorization and chain history';
const projectionError = 'Stored payment data is invalid; verify the original authorization';
const privateMarker = 'LISTENER_STARTUP_PRIVATE_PAYLOAD_SENTINEL';

async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLI listener checkpoint timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' timed out');
}
function snapshot(db: DatabaseSync) {
  return JSON.stringify({
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all(),
    payments: db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: db.prepare('SELECT * FROM journals ORDER BY payment_id').all(),
    audit: db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    sequence: db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
    context: db.prepare('SELECT * FROM deployment_context ORDER BY singleton').all()
  });
}

// A real occupied TCP listener must prevent every worker step, including the
// synchronous local isolation of a corrupt row. Parent ledger writes occur only
// while it explicitly owns the bound DB; CLI writes use the genuine scheduler.
test('an occupied RPC CLI listener leaves queued evidence untouched before a normal restart settles once', {
  timeout: 90000
}, async t => {
  const children: CliHandle[] = [];
  const workRoot = resolve('../../work');
  let directory: string | undefined, completed = false;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let occupied: ReturnType<typeof createServer> | undefined;
  let ownership: DatabaseOwnership | undefined, seeder: Store | undefined, reader: DatabaseSync | undefined;
  try {
    compile();
    const live = chain = await localChain();
    await (await live.token.mint(live.payee.address, parseUnits('1000', 6))).wait();
    await (await live.token.connect(live.payee).approve(live.router.target, parseUnits('1000', 6))).wait();
    const routerAddress = await live.router.getAddress(), signingDomain = domain(31337, routerAddress);
    const block = await live.provider.getBlock('latest'), genesis = await live.provider.getBlock(0);
    assert.ok(block && genesis?.hash);
    const corruptPayment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: live.payer.address,
      payee: live.payee.address, token: await live.token.getAddress(), amount: '125000000', nonce: '0',
      deadline: String(block.timestamp + 3600) };
    const validPayment: Payment = { ...corruptPayment, paymentId: id(randomBytes(16).toString('hex')),
      payer: live.payee.address, payee: live.payer.address, amount: '7000000' };
    const corruptSignature = await live.payer.signTypedData(signingDomain, paymentTypes, corruptPayment);
    const validSignature = await live.payee.signTypedData(signingDomain, paymentTypes, validPayment);
    assert.equal(await live.router.isValidPaymentSignature(corruptPayment, corruptSignature), true);
    assert.equal(await live.router.isValidPaymentSignature(validPayment, validSignature), true);
    const corruptId = paymentKey(corruptPayment), validId = paymentKey(validPayment);
    const corruptFingerprint = digest(corruptPayment, signingDomain), validFingerprint = digest(validPayment, signingDomain);
    const corruptPayload = '{"paymentId":"' + privateMarker;
    const initialPayerBalance = await live.token.balanceOf(live.payer.address);
    const initialPayeeBalance = await live.token.balanceOf(live.payee.address);
    const initialRelayerNonce = await live.provider.getTransactionCount(live.relayer.address, 'pending');
    const initialPayerNativeNonce = await live.provider.getTransactionCount(live.payer.address, 'pending');
    const initialPayeeNativeNonce = await live.provider.getTransactionCount(live.payee.address, 'pending');
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'cli-listener-startup-test-'));
    const db = join(directory, 'journal.sqlite');
    ownership = acquireDatabaseOwnership(db);
    const sidecar = ownership.sidecarPath;
    const sidecarIdentity = statSync(sidecar, { bigint: true }).ino;
    seeder = new Store(ownership.databasePath);
    bindDatabaseContext(seeder.db, { chainId: 31337, genesisHash: genesis.hash,
      router: routerAddress, relayer: live.relayer.address });
    seeder.accept(corruptPayment, corruptFingerprint, corruptSignature);
    seeder.accept(validPayment, validFingerprint, validSignature);
    seeder.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(corruptPayload, corruptId);
    const before = snapshot(seeder.db);
    const beforeContext = JSON.stringify(seeder.db.prepare('SELECT * FROM deployment_context').all());
    seeder.close(); seeder = undefined;
    ownership.release(); ownership = undefined;

    occupied = createServer((_request, response) => { response.writeHead(200); response.end('occupied listener fixture'); });
    occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    const occupiedPort = (occupied.address() as { port: number }).port;
    const gateway = proxy = await rpcProxy(live.provider._getConnection().url);
    let forwarded = 0;
    gateway.afterForward('eth_sendRawTransaction', () => { forwarded++; });
    const config = { db, rpc: gateway.url, key: live.relayer.privateKey, router: routerAddress,
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    await assert.rejects(startCli({ ...config, port: occupiedPort }), { message: 'RPC CLI could not become ready' });
    assert.equal(children.length, 1);
    const refused = children[0], exit = await within(refused.exited);
    assert.equal(exit.code, 1); assert.equal(exit.signal, null); assert.equal(refused.url, '');
    const occupiedResponse = await fetch('http://127.0.0.1:' + occupiedPort, { signal: AbortSignal.timeout(3000) });
    assert.equal(await occupiedResponse.text(), 'occupied listener fixture');
    const settleSelector = live.router.interface.getFunction('settle')!.selector;
    function workerCalls() {
      return gateway.calls.filter(call => {
        if (['eth_estimateGas', 'eth_sendRawTransaction', 'eth_getTransactionCount',
          'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_getTransactionReceipt'].includes(call.method)) return true;
        const data = (call.params?.[0] as { data?: unknown } | undefined)?.data;
        return call.method === 'eth_call' && typeof data === 'string' && data.startsWith(settleSelector);
      });
    }
    assert.ok(gateway.calls.some(call => call.method === 'eth_getCode'), 'The refused child must reach real RPC startup verification');
    assert.equal(workerCalls().length, 0, 'No worker preflight, fee/nonce read, reservation recovery, or send may precede listening');
    assert.equal(forwarded, 0);
    reader = new DatabaseSync(db, { readOnly: true });
    assert.ok(snapshot(reader) === before, 'Listener failure changed private ledger, context, schema, sequence, or audit evidence');
    const row = (paymentId: string) => reader!.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as unknown as RecordRow;
    for (const paymentId of [corruptId, validId]) {
      assert.equal(row(paymentId).status, 'queued');
      assert.equal(row(paymentId).raw_tx, null); assert.equal(row(paymentId).tx_hash, null);
    }
    assert.equal(await live.token.balanceOf(live.payer.address), initialPayerBalance);
    assert.equal(await live.token.balanceOf(live.payee.address), initialPayeeBalance);
    assert.equal(await live.router.nonces(live.payer.address), 0n);
    assert.equal(await live.router.nonces(live.payee.address), 0n);
    assert.equal(await live.router.processed(live.payer.address, corruptPayment.paymentId), false);
    assert.equal(await live.router.processed(live.payee.address, validPayment.paymentId), false);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialPayerNativeNonce);
    assert.equal(await live.provider.getTransactionCount(live.payee.address, 'pending'), initialPayeeNativeNonce);
    reader.close(); reader = undefined;
    ownership = acquireDatabaseOwnership(db);
    assert.equal(ownership.sidecarPath, sidecar); assert.ok(existsSync(sidecar));
    assert.equal(statSync(sidecar, { bigint: true }).ino, sidecarIdentity);
    ownership.release(); ownership = undefined;
    occupied.closeAllConnections();
    await within(new Promise<void>((resolveClose, rejectClose) =>
      occupied!.close(error => error ? rejectClose(error) : resolveClose())));
    occupied = undefined;

    // The default port-zero helper now launches the same DB on a free port.
    // Parent inspection remains read-only throughout the successful CLI lifetime.
    const cli = await startCli({ ...config, apiKey: refused.apiKey });
    assert.notEqual(cli.child.pid, refused.child.pid);
    reader = new DatabaseSync(db, { readOnly: true });
    await until(() => row(corruptId)?.status === 'failed' && row(validId)?.status === 'settled',
      'Autonomous worker after successful listening');
    const failed = row(corruptId), settled = row(validId);
    assert.equal(failed.error, queuedError);
    assert.ok(failed.payload === corruptPayload && failed.signature === corruptSignature && failed.fingerprint === corruptFingerprint,
      'The corrupt authorization evidence must remain private and intact');
    assert.equal(failed.raw_tx, null); assert.equal(failed.tx_hash, null);
    assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.ok(settled.signature === validSignature && settled.fingerprint === validFingerprint);
    assert.equal(Transaction.from(settled.raw_tx).nonce, initialRelayerNonce);
    assert.equal((await live.provider.getTransactionReceipt(settled.tx_hash))!.status, 1);
    const sends = () => gateway.calls.filter(call => call.method === 'eth_sendRawTransaction');
    assert.equal(sends().length, 1); assert.equal(forwarded, 1);
    assert.ok(sends()[0].params?.[0] === settled.raw_tx, 'Only the valid queued authorization may be sent');
    for (const call of gateway.calls.filter(call => ['eth_call', 'eth_estimateGas'].includes(call.method))) {
      const data = (call.params?.[0] as { data?: unknown } | undefined)?.data;
      if (typeof data === 'string' && data.startsWith(settleSelector))
        assert.equal(live.router.interface.decodeFunctionData('settle', data)[0].paymentId, validPayment.paymentId);
    }
    assert.equal(await live.token.balanceOf(live.payer.address), initialPayerBalance + 7000000n);
    assert.equal(await live.token.balanceOf(live.payee.address), initialPayeeBalance - 7000000n);
    assert.equal(await live.router.nonces(live.payer.address), 0n);
    assert.equal(await live.router.nonces(live.payee.address), 1n);
    assert.equal(await live.provider.getTransactionCount(live.relayer.address, 'pending'), initialRelayerNonce + 1);
    assert.equal(await live.provider.getTransactionCount(live.payer.address, 'pending'), initialPayerNativeNonce);
    assert.equal(await live.provider.getTransactionCount(live.payee.address, 'pending'), initialPayeeNativeNonce);
    const journals = () => reader!.prepare('SELECT * FROM journals').all();
    const events = () => reader!.prepare('SELECT * FROM audit ORDER BY sequence').all();
    assert.equal(journals().length, 1); assert.equal(journals()[0].payment_id, validId);
    assert.equal(journals()[0].amount, '7000000');
    const journalEvidence = JSON.stringify(journals());
    const actions = (paymentId: string) => events().filter(event => event.payment_id === paymentId).map(event => event.action);
    assert.deepEqual(actions(corruptId), ['accepted', 'failed']);
    assert.deepEqual(actions(validId), ['accepted', 'broadcast-prepared', 'settled']);
    assert.equal(events().length, 5);
    assert.ok(JSON.stringify(reader.prepare('SELECT * FROM deployment_context').all()) === beforeContext);
    async function api(path: string, body?: unknown) {
      const response = await fetch(cli.url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
        headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      assert.ok(!text.includes(privateMarker), 'History exposed the private corrupt payload');
      return { status: response.status, body: JSON.parse(text) as any };
    }
    const history = await api('payments');
    assert.equal(history.status, 200); assert.equal(history.body.items.length, 2);
    const invalid = history.body.items.find((record: any) => record.id === corruptId);
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.payment, null);
    assert.equal(invalid.error, queuedError); assert.equal(invalid.integrityError, projectionError);
    const valid = history.body.items.find((record: any) => record.id === validId);
    assert.equal(valid.status, 'settled'); assert.deepEqual(valid.payment, validPayment);
    for (const record of [invalid, valid]) for (const field of ['payload', 'signature', 'fingerprint', 'raw_tx'])
      assert.equal(Object.hasOwn(record, field), false);
    const replay = await api('payments', { payment: validPayment, signature: validSignature });
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.tx_hash, settled.tx_hash);
    const reconciliation = await api('reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.ok(JSON.stringify(journals()) === journalEvidence);
    assert.equal(events().length, 5); assert.equal(sends().length, 1); assert.equal(forwarded, 1);
    assert.ok(row(validId).raw_tx === settled.raw_tx); assert.equal(row(validId).tx_hash, settled.tx_hash);
    t.diagnostic(JSON.stringify({ occupiedBindRefusals: 1, workerRpcCallsBeforeListening: 0,
      queuedRowsPreservedOnRefusal: 2, sidecarReacquired: true, isolatedCorruptRows: 1,
      settlements: 1, nativeSends: 1, journalRows: 1, reconciled: reconciliation.body.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    if (seeder) await cleanup(() => { seeder!.close(); seeder = undefined; });
    if (!seeder) await cleanup(() => { ownership?.release(); ownership = undefined; });
    if (occupied) {
      await cleanup(() => occupied!.closeAllConnections());
      if (occupied.listening) await cleanup(() => within(new Promise<void>((resolveClose, rejectClose) =>
        occupied!.close(error => error ? rejectClose(error) : resolveClose()))));
    }
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove task files beneath a live registered CLI');
      assert.equal(seeder, undefined); assert.equal(ownership, undefined);
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'cli-listener-startup-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'CLI listener startup cleanup failed');
  }
});
