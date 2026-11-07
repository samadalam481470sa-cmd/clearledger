import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { id, keccak256, Transaction, type TransactionReceipt } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import type { RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

// The actual RPC CLI owns all writes. This connection only observes its ledger.
class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(key: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(key) as unknown as RecordRow | undefined; }
  journals() { return this.db.prepare('SELECT * FROM journals ORDER BY rowid').all(); }
  events() { return this.db.prepare('SELECT * FROM audit ORDER BY sequence').all(); }
  dataVersion() { return this.db.prepare('PRAGMA data_version').get()!.data_version; }
  snapshot() {
    const queries = {
      schema: 'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name',
      payments: 'SELECT rowid,* FROM payments ORDER BY rowid',
      journals: 'SELECT rowid,* FROM journals ORDER BY rowid',
      audit: 'SELECT * FROM audit ORDER BY sequence',
      context: 'SELECT * FROM deployment_context ORDER BY singleton',
      sequence: 'SELECT * FROM sqlite_sequence ORDER BY name'
    };
    const rows = Object.fromEntries(Object.entries(queries).map(([name, sql]) => {
      const query = this.db.prepare(sql);
      query.setReadBigInts(true);
      return [name, query.all()];
    }));
    return createHash('sha256').update(JSON.stringify(rows, (_, value) =>
      typeof value === 'bigint' ? { sqliteInteger: value.toString() } : value)).digest('hex');
  }
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
  return fetch(cli.url + '/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(7000)
  });
}

test('the actual RPC CLI recovers the same reserved transaction after its mined block is replaced', {
  timeout: 90000
}, async t => {
  compile();
  const children: CliHandle[] = [];
  const workRoot = resolve('../../work');
  let directory: string | undefined, reader: Projection | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let completed = false;
  try {
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(workRoot, { recursive: true });
    directory = mkdtempSync(join(workRoot, 'cli-reorg-recovery-'));
    const db = join(directory, 'journal.sqlite');
    const config = {
      db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); }
    };
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    const beforeBlock = await chain.provider.getBlock('latest');
    assert.ok(beforeBlock);
    const initialPayerTokens = await chain.token.balanceOf(chain.payer.address);
    const initialPayeeTokens = await chain.token.balanceOf(chain.payee.address);
    const initialRelayerBalance = await chain.provider.getBalance(chain.relayer.address);
    const initialRelayerNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');
    const initialPayerNativeNonce = await chain.provider.getTransactionCount(chain.payer.address, 'pending');
    const initialPaymentNonce = await chain.router.nonces(chain.payer.address);
    assert.equal(initialPaymentNonce, 0n);
    const chainSnapshot = await chain.provider.send('evm_snapshot', []);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = {
        paymentId: id(randomBytes(16).toString('hex')), payer: chain!.payer.address,
        payee: chain!.payee.address, token: String(chain!.token.target), amount, nonce,
        deadline: String(beforeBlock!.timestamp + 3600)
      };
      return { payment, signature: await chain!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    }
    const firstInput = await signed('125000000', '0');
    const secondInput = await signed('7000000', '1');
    const firstId = paymentKey(firstInput.payment), secondId = paymentKey(secondInput.payment);
    const sends = () => proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction');
    const receiptAttempts = () => proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    let receiptFaultActivated = false;
    proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
    proxy.afterForward('eth_sendRawTransaction', () => {
      if (!receiptFaultActivated) {
        receiptFaultActivated = true;
        proxy!.fail('eth_getTransactionReceipt', 'http-503');
      }
    });
    let acceptance503Retries = 0;
    async function acceptSameIntent(input: typeof firstInput) {
      const deadline = performance.now() + 15000;
      for (let attempt = 0; attempt < 100 && performance.now() < deadline; attempt++) {
        const response = await api(cli, 'payments', input);
        const body = await response.json() as { replay?: boolean; payment?: { id: string }; error?: string };
        if (response.status === 202 || response.status === 200) {
          assert.equal(body.replay, response.status === 200);
          assert.equal(body.payment?.id, paymentKey(input.payment));
          return;
        }
        // Ethers may batch authorization verification with a failed receipt read.
        // Retry only the same signed intent after the fixed public outage result.
        assert.equal(response.status, 503, 'Only the fixed RPC-unavailable response may be retried');
        assert.deepEqual(body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
        acceptance503Retries++;
        await new Promise(resolvePause => setTimeout(resolvePause, 100));
      }
      throw new Error('The identical payment intent did not become accepted within its retry bound');
    }
    await acceptSameIntent(firstInput);
    await acceptSameIntent(secondInput);
    reader = new Projection(db);
    await until(() => receiptFaultActivated && reader!.get(firstId)?.status === 'broadcast',
      'The CLI did not reserve the first mined transaction');
    const reservation = reader.get(firstId)!;
    assert.ok(reservation.raw_tx && reservation.tx_hash);
    const originalRaw = reservation.raw_tx, originalHash = reservation.tx_hash;
    const firstNativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(firstNativeNonce, initialRelayerNonce);
    assert.equal(keccak256(originalRaw), originalHash);
    await until(async () => (await chain!.provider.getTransactionReceipt(originalHash))?.status === 1,
      'The original forwarded transaction did not mine');
    const oldReceipt = await chain.provider.getTransactionReceipt(originalHash);
    assert.ok(oldReceipt?.status === 1);
    const oldBlock = await chain.provider.getBlock(oldReceipt.blockNumber);
    assert.ok(oldBlock);
    assert.equal(oldBlock.hash, oldReceipt.blockHash);
    assert.equal(oldBlock.number, beforeBlock.number + 1);
    assert.equal(oldBlock.transactions[oldReceipt.index], originalHash);
    assert.equal(await chain.token.balanceOf(chain.payee.address), initialPayeeTokens + 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), firstNativeNonce + 1);

    const heldProjection = reader.snapshot();
    function assertReservation() {
      assert.equal(reader!.get(firstId)!.status, 'broadcast');
      assert.ok(reader!.get(firstId)!.raw_tx === originalRaw, 'The saved signed transaction changed');
      assert.equal(reader!.get(firstId)!.tx_hash, originalHash);
      const queued = reader!.get(secondId)!;
      assert.equal(queued.status, 'queued');
      assert.equal(queued.raw_tx, null);
      assert.equal(queued.tx_hash, null);
      assert.equal(reader!.journals().length, 0);
      assert.equal(reader!.events().length, 3);
      assert.ok(reader!.snapshot() === heldProjection, 'The held ledger projection changed');
      assert.equal(sends().length, 1);
      assert.ok(sends()[0].params?.[0] === originalRaw, 'The proxy received different signed bytes');
    }
    assertReservation();
    const beforeKillAttempts = receiptAttempts();
    await until(() => {
      assertReservation();
      return receiptAttempts() > beforeKillAttempts;
    }, 'The live CLI did not attempt a receipt lookup under the fault');
    await cli.kill();
    const stopped = await cli.exited;
    assert.ok(stopped.signal === 'SIGKILL' || (stopped.code !== null && stopped.code !== 0));
    reader.close();
    reader = new Projection(db);
    assertReservation();

    assert.equal(await chain.provider.send('evm_revert', [chainSnapshot]), true);
    await chain.provider.send('evm_increaseTime', [1]);
    await chain.provider.send('evm_mine', []);
    const replacement = await chain.provider.getBlock(oldReceipt.blockNumber);
    assert.ok(replacement);
    assert.equal(replacement.transactions.length, 0);
    assert.notEqual(replacement.hash, oldBlock.hash);
    const erasedBlockLookup = await chain.provider.send('eth_getBlockByHash', [oldBlock.hash, false]) as { hash: string } | null;
    // Ganache can retain an old-hash alias pointing at the replacement block.
    // Its canonical height, transaction absence and restored state prove the rollback.
    if (erasedBlockLookup) assert.equal(erasedBlockLookup.hash, replacement.hash);
    assert.equal(await chain.provider.getTransactionReceipt(originalHash), null);
    assert.equal(await chain.provider.getTransaction(originalHash), null);
    assert.equal(await chain.token.balanceOf(chain.payee.address), initialPayeeTokens);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerTokens);
    assert.equal(await chain.router.nonces(chain.payer.address), initialPaymentNonce);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), initialRelayerNonce);
    assert.equal(await chain.provider.getTransactionCount(chain.payer.address, 'pending'), initialPayerNativeNonce);
    assert.equal(await chain.provider.getBalance(chain.relayer.address), initialRelayerBalance);
    assertReservation();

    cli = await startCli({ ...config, apiKey: cli.apiKey });
    assert.notEqual(cli.child.pid, originalPid);
    assertReservation();
    const restartVersion = reader.dataVersion(), afterReadyAttempts = receiptAttempts();
    await until(() => {
      assert.equal(cli.child.exitCode, null);
      assert.equal(cli.child.signalCode, null);
      assertReservation();
      assert.equal(reader!.dataVersion(), restartVersion, 'The restarted CLI committed while receipt reads were unavailable');
      return receiptAttempts() - afterReadyAttempts >= 4;
    }, 'The restarted CLI did not make four receipt attempts under the fault');
    const restartReceiptAttempts = receiptAttempts() - afterReadyAttempts;
    assert.equal(await chain.provider.getTransactionReceipt(originalHash), null);
    assert.equal(await chain.token.balanceOf(chain.payee.address), initialPayeeTokens);

    proxy.heal();
    await until(() => reader!.get(firstId)?.status === 'settled' && reader!.get(secondId)?.status === 'settled',
      'The restarted CLI did not recover both authorizations after the chain replacement');
    const recovered = reader.get(firstId)!, successor = reader.get(secondId)!;
    assert.ok(recovered.raw_tx === originalRaw && recovered.tx_hash === originalHash,
      'Recovery changed the original signed transaction');
    for (const field of ['payload', 'signature', 'fingerprint'] as const)
      assert.ok(recovered[field] === reservation[field], 'Recovery changed saved authorization evidence');
    assert.ok(successor.raw_tx && successor.tx_hash);
    assert.equal(keccak256(successor.raw_tx), successor.tx_hash);
    assert.equal(Transaction.from(successor.raw_tx).nonce, firstNativeNonce + 1);
    const newReceipt = await chain.provider.getTransactionReceipt(originalHash);
    assert.ok(newReceipt?.status === 1);
    assert.notEqual(newReceipt.blockHash, oldReceipt.blockHash);
    assert.ok(newReceipt.blockNumber > replacement.number);
    for (const row of [recovered, successor]) {
      const receipt: TransactionReceipt | null = await chain.provider.getTransactionReceipt(row.tx_hash!);
      assert.ok(receipt?.status === 1);
      const canonical = await chain.provider.getBlock(receipt.blockNumber);
      assert.ok(canonical);
      assert.equal(canonical.hash, receipt.blockHash);
      assert.equal(canonical.transactions[receipt.index], row.tx_hash);
      assert.equal(row.block_number, receipt.blockNumber);
      assert.equal(row.block_hash, receipt.blockHash);
      const journal: Record<string, SQLOutputValue> | undefined =
        reader.journals().find(entry => entry.payment_id === row.id);
      assert.ok(journal);
      assert.equal(journal.tx_hash, receipt.hash);
      assert.equal(journal.block_number, receipt.blockNumber);
      assert.equal(journal.block_hash, receipt.blockHash);
    }
    assert.equal(reader.journals().length, 2);
    assert.equal(reader.events().length, 6);
    for (const paymentId of [firstId, secondId]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), initialPayeeTokens + 132000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerTokens - 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), firstNativeNonce + 2);
    assert.equal(await chain.provider.getTransactionCount(chain.payer.address, 'pending'), initialPayerNativeNonce);
    assert.equal(sends().length, 3);
    assert.ok(sends()[0].params?.[0] === originalRaw && sends()[1].params?.[0] === originalRaw &&
      sends()[2].params?.[0] === successor.raw_tx, 'Recovery sent unexpected transaction bytes');
    for (const input of [firstInput, secondInput]) {
      const response = await api(cli, 'payments', input);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { replay: boolean }).replay, true);
    }
    const response = await api(cli, 'reconcile', {});
    assert.equal(response.status, 200);
    const reconciliation = await response.json() as { checked: number; exceptions: string[] };
    assert.equal(reconciliation.checked, 2);
    assert.deepEqual(reconciliation.exceptions, []);
    assert.equal(reader.journals().length, 2);
    assert.equal(reader.events().length, 6);
    assert.equal(sends().length, 3);
    const oldHeight = await chain.provider.getBlock(oldReceipt.blockNumber);
    assert.equal(oldHeight?.hash, replacement.hash);
    assert.equal(oldHeight.transactions.length, 0);
    const finalOldHashLookup = await chain.provider.send('eth_getBlockByHash', [oldBlock.hash, false]) as { hash: string } | null;
    if (finalOldHashLookup) assert.equal(finalOldHashLookup.hash, replacement.hash);
    t.diagnostic(JSON.stringify({
      originalBlock: oldReceipt.blockNumber, replacementBlock: replacement.number,
      recoveredBlock: newReceipt.blockNumber, originalReceiptAbsentAfterRevert: true,
      oldHashAliasesReplacement: erasedBlockLookup !== null, acceptance503Retries,
      restartReceiptAttempts, serviceSendAttempts: sends().length, distinctTransactions: 2,
      settledPayments: 2, journalRows: 2, reconciliationChecked: reconciliation.checked
    }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const cli of children) await cleanup(() => cli.kill());
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(cli => cli.child.exitCode !== null || cli.child.signalCode !== null));
      assert.equal(dirname(resolve(directory!)), workRoot);
      assert.ok(directory!.startsWith(join(workRoot, 'cli-reorg-recovery-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'CLI chain replacement resource cleanup failed');
  }
});
