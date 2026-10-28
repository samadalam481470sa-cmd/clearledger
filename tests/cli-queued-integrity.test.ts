import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, parseUnits, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { acquireDatabaseOwnership, type DatabaseOwnership } from '../src/database-ownership.ts';
import { bindDatabaseContext } from '../src/database-context.ts';
import { digest, domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

const queuedError = 'Stored queued authorization is invalid; verify the original authorization and chain history';
const projectionError = 'Stored payment data is invalid; verify the original authorization';
const privateMarker = 'QUEUED_CORRUPTION_PRIVATE_SENTINEL';
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 100));
  }
  throw new Error(label + ' timed out');
}

// The two genuine EIP-712 instructions are seeded while the parent owns the
// bound database. All later writes and settlement belong to the actual CLI.
test('the actual CLI isolates an unsent corrupt queued authorization and settles an independent payer once', {
  timeout: 90000
}, async t => {
  const children: CliHandle[] = [];
  const workRoot = resolve('../../work');
  let directory: string | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let ownership: DatabaseOwnership | undefined, seeder: Store | undefined, reader: DatabaseSync | undefined;
  let completed = false;
  try {
    compile();
    chain = await localChain();
    await (await chain.token.mint(chain.payee.address, parseUnits('1000', 6))).wait();
    await (await chain.token.connect(chain.payee).approve(chain.router.target, parseUnits('1000', 6))).wait();
    const routerAddress = String(chain.router.target);
    const signingDomain = domain(31337, routerAddress);
    const block = await chain.provider.getBlock('latest'), genesis = await chain.provider.getBlock(0);
    assert.ok(block && genesis?.hash);
    const firstPayment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain.payer.address,
      payee: chain.payee.address, token: String(chain.token.target), amount: '125000000', nonce: '0', deadline: String(block.timestamp + 3600) };
    const secondPayment: Payment = { ...firstPayment, paymentId: id(randomBytes(16).toString('hex')),
      payer: chain.payee.address, payee: chain.payer.address, amount: '7000000' };
    const firstSignature = await chain.payer.signTypedData(signingDomain, paymentTypes, firstPayment);
    const secondSignature = await chain.payee.signTypedData(signingDomain, paymentTypes, secondPayment);
    assert.equal(await chain.router.isValidPaymentSignature(firstPayment, firstSignature), true);
    assert.equal(await chain.router.isValidPaymentSignature(secondPayment, secondSignature), true);
    const firstFingerprint = digest(firstPayment, signingDomain), secondFingerprint = digest(secondPayment, signingDomain);
    const firstId = paymentKey(firstPayment), secondId = paymentKey(secondPayment);
    const firstBalance = await chain.token.balanceOf(chain.payer.address), secondBalance = await chain.token.balanceOf(chain.payee.address);
    const relayerNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');
    assert.equal(await chain.router.nonces(chain.payer.address), 0n);
    assert.equal(await chain.router.nonces(chain.payee.address), 0n);

    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'cli-queued-integrity-test-'));
    const db = join(directory, 'journal.sqlite');
    ownership = acquireDatabaseOwnership(db);
    seeder = new Store(ownership.databasePath);
    bindDatabaseContext(seeder.db, { chainId: 31337, genesisHash: genesis.hash, router: routerAddress, relayer: chain.relayer.address });
    seeder.accept(firstPayment, firstFingerprint, firstSignature);
    seeder.accept(secondPayment, secondFingerprint, secondSignature);
    const corruptPayload = '{"paymentId":"' + privateMarker;
    seeder.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(corruptPayload, firstId);
    assert.equal(seeder.get(firstId)!.status, 'queued');
    assert.equal(seeder.get(firstId)!.raw_tx, null); assert.equal(seeder.get(firstId)!.tx_hash, null);
    seeder.close(); seeder = undefined;
    ownership.release(); ownership = undefined;

    proxy = await rpcProxy(chain.provider._getConnection().url);
    const cli = await startCli({ db, rpc: proxy.url, key: chain.relayer.privateKey, router: routerAddress,
      onSpawn: handle => { children.push(handle); } });
    reader = new DatabaseSync(db, { readOnly: true });
    const row = (recordId: string) => reader!.prepare('SELECT * FROM payments WHERE id=?').get(recordId) as unknown as RecordRow;
    const audits = () => reader!.prepare('SELECT * FROM audit ORDER BY sequence').all();
    await until(() => row(firstId)?.status === 'failed' && row(secondId)?.status === 'settled',
      'Autonomous poison-row isolation and independent settlement');
    const failed = row(firstId), settled = row(secondId);
    assert.equal(failed.error, queuedError);
    assert.ok(failed.payload === corruptPayload, 'Local isolation must preserve the original corrupt payload bytes');
    assert.ok(failed.signature === firstSignature && failed.fingerprint === firstFingerprint,
      'Local isolation must retain authorization evidence');
    assert.equal(failed.raw_tx, null); assert.equal(failed.tx_hash, null);
    assert.equal(failed.block_number, null); assert.equal(failed.block_hash, null);
    assert.equal(reader.prepare('SELECT COUNT(*) AS count FROM journals WHERE payment_id=?').get(firstId)!.count, 0);
    assert.equal(audits().filter(event => event.payment_id === firstId && event.action === 'failed').length, 1);
    assert.equal(audits().find(event => event.payment_id === firstId && event.action === 'failed')!.detail, queuedError);
    assert.equal(audits().filter(event => event.payment_id === firstId && event.action === 'broadcast-prepared').length, 0);

    assert.ok(settled.raw_tx && settled.tx_hash);
    assert.equal(keccak256(settled.raw_tx), settled.tx_hash);
    assert.ok(settled.fingerprint === secondFingerprint && settled.signature === secondSignature);
    const native = Transaction.from(settled.raw_tx);
    assert.equal(native.nonce, relayerNonce); assert.equal(native.to, routerAddress);
    assert.equal(chain.router.interface.decodeFunctionData('settle', native.data)[0].paymentId, secondPayment.paymentId);
    assert.equal((await chain.provider.getTransactionReceipt(settled.tx_hash))!.status, 1);
    const sends = proxy.calls.filter(call => call.method === 'eth_sendRawTransaction');
    assert.equal(sends.length, 1);
    assert.ok(sends[0].params?.[0] === settled.raw_tx, 'Only the independent payment may be broadcast');
    const settleSelector = chain.router.interface.getFunction('settle')!.selector;
    const preflights = proxy.calls.filter(call => {
      const data = (call.params?.[0] as { data?: unknown } | undefined)?.data;
      return ['eth_call', 'eth_estimateGas'].includes(call.method) && typeof data === 'string' && data.startsWith(settleSelector);
    });
    assert.ok(preflights.length >= 1);
    for (const call of preflights) {
      const data = (call.params![0] as { data: string }).data;
      assert.equal(chain.router.interface.decodeFunctionData('settle', data)[0].paymentId, secondPayment.paymentId,
        'The corrupt local row must never reach router preflight or gas estimation');
    }
    assert.equal(await chain.token.balanceOf(chain.payer.address), firstBalance + 7000000n);
    assert.equal(await chain.token.balanceOf(chain.payee.address), secondBalance - 7000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 0n);
    assert.equal(await chain.router.nonces(chain.payee.address), 1n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), relayerNonce + 1);
    const journal = reader.prepare('SELECT * FROM journals').all();
    assert.equal(journal.length, 1); assert.equal(journal[0].payment_id, secondId);
    assert.equal(journal[0].debit_account, chain.payee.address); assert.equal(journal[0].credit_account, chain.payer.address);
    assert.equal(journal[0].amount, '7000000');
    const journalEvidence = JSON.stringify(journal);

    async function api(path: string, body?: unknown) {
      const response = await fetch(cli.url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(7000),
        headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      assert.ok(!text.includes(privateMarker), 'Public history exposed the corrupt private payload');
      return { status: response.status, body: JSON.parse(text) as any };
    }
    const history = await api('payments');
    assert.equal(history.status, 200); assert.equal(history.body.items.length, 2);
    const invalid = history.body.items.find((record: any) => record.id === firstId);
    assert.equal(invalid.status, 'failed'); assert.equal(invalid.error, queuedError);
    assert.equal(invalid.payment, null); assert.equal(invalid.integrityError, projectionError);
    const valid = history.body.items.find((record: any) => record.id === secondId);
    assert.equal(valid.status, 'settled'); assert.deepEqual(valid.payment, secondPayment);
    for (const record of [invalid, valid]) for (const field of ['payload', 'signature', 'fingerprint', 'raw_tx'])
      assert.equal(Object.hasOwn(record, field), false);
    const overview = await api('overview');
    assert.equal(overview.status, 200); assert.equal(overview.body.payments.length, 2);
    assert.equal(overview.body.payments.find((record: any) => record.id === firstId).payment, null);
    const replay = await api('payments', { payment: secondPayment, signature: secondSignature });
    assert.equal(replay.status, 200); assert.equal(replay.body.replay, true);
    assert.equal(replay.body.payment.tx_hash, settled.tx_hash);
    const reconciliation = await api('reconcile', {});
    assert.equal(reconciliation.status, 200); assert.equal(reconciliation.body.checked, 1);
    assert.deepEqual(reconciliation.body.exceptions, []);
    assert.ok(JSON.stringify(reader.prepare('SELECT * FROM journals').all()) === journalEvidence);
    const events = audits();
    assert.equal(events.length, 5);
    for (const [action, count] of [['accepted', 2], ['failed', 1], ['broadcast-prepared', 1], ['settled', 1]] as const)
      assert.equal(events.filter(event => event.action === action).length, count);
    assert.equal(row(firstId).status, 'failed'); assert.equal(row(secondId).status, 'settled');
    assert.equal(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length, 1);
    t.diagnostic(JSON.stringify({ isolatedQueuedRows: 1, independentSettlements: 1, nativeSends: 1,
      journalRows: 1, corruptPayerNonce: 0, validPayerNonce: 1, reconciled: reconciliation.body.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const child of children) await cleanup(() => child.kill());
    await cleanup(() => reader?.close());
    if (seeder) await cleanup(() => { seeder!.close(); seeder = undefined; });
    if (!seeder) await cleanup(() => { ownership?.release(); ownership = undefined; });
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(child => child.child.exitCode !== null || child.child.signalCode !== null),
        'Do not remove files beneath a live registered CLI');
      assert.equal(seeder, undefined); assert.equal(ownership, undefined);
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'cli-queued-integrity-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'Queued integrity CLI cleanup failed');
  }
});
