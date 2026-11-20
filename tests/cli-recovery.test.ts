import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentKey, paymentTypes, type Payment } from '../src/payment.ts';
import { type RecordRow } from '../src/store.ts';
import { startCli, type CliHandle } from './fixtures/cli-server.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

const EXTENDED_OUTAGE = process.env.CLEARLEDGER_LONG_RECEIPT_OUTAGE === '1';
const MIN_WINDOW_MS = EXTENDED_OUTAGE ? 300000 : 90000;
const PHASE_BUDGET_MS = MIN_WINDOW_MS * 4 / 3, HISTORY_INTERVAL_MS = 5000;
const MIN_ACTIVE_ATTEMPTS = EXTENDED_OUTAGE ? 290 : 80;
const MIN_HISTORY_BURSTS = MIN_WINDOW_MS / HISTORY_INTERVAL_MS;
const HISTORY_READERS_PER_BURST = 4;
const HISTORY_REQUESTS_PER_BURST = HISTORY_READERS_PER_BURST * 4; // Two exact lookups, a filtered payment page and frozen journal page.
const HISTORICAL_PAYMENTS = 26, HISTORICAL_AMOUNT = 1000000n, HISTORY_SETUP_BUDGET_MS = 90000;
const TEST_TIMEOUT_MS = PHASE_BUDGET_MS * 2 + 120000;

interface Journal {
  payment_id: string; token: string; debit_account: string; credit_account: string;
  amount: string; tx_hash: string; block_number: number; block_hash: string;
}
interface JournalPage { items: Journal[]; nextCursor: string | null }

// A real CLI child owns all writes; the parent observes its durable projection.
class Projection {
  private readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path, { readOnly: true }); }
  get(id: string) { return this.db.prepare('SELECT * FROM payments WHERE id=?').get(id) as unknown as RecordRow | undefined; }
  payments() { return this.db.prepare('SELECT * FROM payments ORDER BY rowid').all(); }
  journals() { return this.db.prepare('SELECT * FROM journals ORDER BY rowid').all(); }
  events() { return this.db.prepare('SELECT * FROM audit ORDER BY sequence').all(); }
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
  return fetch(cli.url + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + cli.apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
}
async function within<T>(pending: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Active CLI outage observation exceeded its phase budget')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

test(`the actual RPC CLI autonomously recovers after two ${MIN_WINDOW_MS / 1000}-second observation windows within one receipt outage`, { timeout: TEST_TIMEOUT_MS }, async t => {
  compile();
  const children: CliHandle[] = [];
  const dataRoot = resolve('../../work');
  let directory: string | undefined, reader: Projection | undefined;
  let chain: Awaited<ReturnType<typeof localChain>> | undefined;
  let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
  let completed = false;
  const historyRequests = new Set<Promise<void>>();
  try {
    chain = await localChain();
    proxy = await rpcProxy(chain.provider._getConnection().url);
    mkdirSync(dataRoot, { recursive: true });
    directory = mkdtempSync(join(dataRoot, 'cli-recovery-test-'));
    const db = join(directory, 'journal.sqlite');
    const config = { db, rpc: proxy.url, key: chain.relayer.privateKey, router: String(chain.router.target),
      onSpawn: (handle: CliHandle) => { children.push(handle); } };
    let cli = await startCli(config);
    const originalPid = cli.child.pid;
    const block = await chain.provider.getBlock('latest');
    const initialPayerBalance = await chain.token.balanceOf(chain.payer.address);
    const initialPayerNativeNonce = await chain.provider.getTransactionCount(chain.payer.address, 'pending');
    const initialRelayerNativeNonce = await chain.provider.getTransactionCount(chain.relayer.address, 'pending');
    reader = new Projection(db);
    async function signed(amount: string, nonce: string) {
      const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain!.payer.address,
        payee: chain!.payee.address, token: String(chain!.token.target), amount, nonce, deadline: String(block!.timestamp + 3600) };
      return { payment, signature: await chain!.payer.signTypedData(domain(31337, config.router), paymentTypes, payment) };
    }
    async function accept(input: Awaited<ReturnType<typeof signed>>) {
      const response = await api(cli, 'payments', input);
      assert.equal(response.status, 202);
      const accepted = await response.json() as { replay: boolean; payment: { id: string; raw_tx?: string; signature?: string } };
      assert.equal(accepted.replay, false);
      assert.equal(accepted.payment.id, paymentKey(input.payment));
      assert.equal(accepted.payment.raw_tx, undefined);
      assert.equal(accepted.payment.signature, undefined);
    }
    const historicalInputs: Awaited<ReturnType<typeof signed>>[] = [];
    const setupStarted = performance.now(), setupDeadline = setupStarted + HISTORY_SETUP_BUDGET_MS;
    for (let nonce = 0; nonce < HISTORICAL_PAYMENTS; nonce++) {
      assert.ok(performance.now() < setupDeadline, 'Historical CLI settlement setup exceeded its budget');
      const input = await signed(String(HISTORICAL_AMOUNT), String(nonce));
      historicalInputs.push(input);
      await accept(input);
      await until(() => reader!.get(paymentKey(input.payment))?.status === 'settled',
        'Historical payment did not settle autonomously within the setup budget', Math.max(1, setupDeadline - performance.now()));
    }
    const historySetupMs = performance.now() - setupStarted;
    assert.ok(historySetupMs <= HISTORY_SETUP_BUDGET_MS, 'Historical CLI settlement setup exceeded its budget');
    const historicalIds = historicalInputs.map(input => paymentKey(input.payment));
    const historicalIdSet = new Set(historicalIds);
    const historicalTotal = HISTORICAL_AMOUNT * BigInt(HISTORICAL_PAYMENTS);
    const historyProjection = () => JSON.stringify({ payments: historicalIds.map(paymentId => reader!.get(paymentId)),
      journals: reader!.journals().filter(row => historicalIdSet.has(String(row.payment_id))),
      audit: reader!.events().filter(row => historicalIdSet.has(String(row.payment_id))) });
    const retainedHistory = historyProjection();
    assert.equal(reader.journals().length, HISTORICAL_PAYMENTS);
    assert.equal(reader.events().length, HISTORICAL_PAYMENTS * 3);
    for (const paymentId of historicalIds) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), historicalTotal);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - historicalTotal);
    assert.equal(await chain.router.nonces(chain.payer.address), BigInt(HISTORICAL_PAYMENTS));
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), initialRelayerNativeNonce + HISTORICAL_PAYMENTS);
    const historicalSendCount = proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length;
    assert.equal(historicalSendCount, HISTORICAL_PAYMENTS);
    async function journalPage(path: string) {
      const response = await api(cli, path);
      assert.equal(response.status, 200);
      return await response.json() as JournalPage;
    }
    const journalFields = ['payment_id', 'token', 'debit_account', 'credit_account', 'amount', 'tx_hash', 'block_number', 'block_hash'].sort();
    function assertJournalPage(page: JournalPage) {
      assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor']);
      assert.ok(page.nextCursor === null || typeof page.nextCursor === 'string');
      assert.ok(Array.isArray(page.items));
      for (const row of page.items) {
        assert.deepEqual(Object.keys(row).sort(), journalFields, 'Journal history exposed unexpected/private fields');
        const expected = reader!.journals().find(item => item.payment_id === row.payment_id);
        assert.ok(expected, 'Journal history returned an unknown posting');
        assert.deepEqual(row, { ...expected });
      }
    }
    const firstJournalPage = await journalPage('journals?limit=25');
    assertJournalPage(firstJournalPage);
    assert.equal(firstJournalPage.items.length, 25); assert.ok(firstJournalPage.nextCursor);
    assert.deepEqual(firstJournalPage.items.map(row => row.payment_id), historicalIds.slice(1).reverse());
    const frozenJournalPath = 'journals?limit=25&cursor=' + encodeURIComponent(firstJournalPage.nextCursor);
    const frozenJournalPage = await journalPage(frozenJournalPath);
    assertJournalPage(frozenJournalPage);
    assert.equal(frozenJournalPage.nextCursor, null); assert.equal(frozenJournalPage.items.length, 1);
    assert.equal(frozenJournalPage.items[0].payment_id, historicalIds[0]);
    assert.ok(historyProjection() === retainedHistory, 'Capturing the frozen journal page changed historical evidence');
    t.diagnostic(JSON.stringify({ phase: 'historical-setup', historicalPayments: HISTORICAL_PAYMENTS,
      historySetupMs: Math.floor(historySetupMs), historySetupBudgetMs: HISTORY_SETUP_BUDGET_MS,
      historicalNativeSends: historicalSendCount, firstJournalPageRows: 25, frozenJournalPageRows: 1 }));
    const firstInput = await signed('125000000', String(HISTORICAL_PAYMENTS)),
      secondInput = await signed('7000000', String(HISTORICAL_PAYMENTS + 1));
    const firstId = paymentKey(firstInput.payment), secondId = paymentKey(secondInput.payment);
    const receiptCount = () => proxy!.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
    let outageStarted: number | undefined, receiptBaseline = 0;
    proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
    proxy.afterForward('eth_sendRawTransaction', () => {
      if (outageStarted !== undefined) return;
      proxy!.fail('eth_getTransactionReceipt', 'http-503');
      outageStarted = performance.now(); receiptBaseline = receiptCount();
    });
    for (const input of [firstInput, secondInput]) await accept(input);
    await until(() => outageStarted !== undefined &&
      reader!.get(firstId)?.status === 'broadcast', 'The autonomous first CLI did not retry receipt lookup');
    const original = reader.get(firstId)!;
    assert.ok(original.raw_tx && original.tx_hash, 'The CLI must persist signed bytes before network transmission');
    const originalRaw = original.raw_tx, originalHash = original.tx_hash;
    const nativeNonce = Transaction.from(originalRaw).nonce;
    assert.equal(nativeNonce, initialRelayerNativeNonce + HISTORICAL_PAYMENTS);
    assert.equal(keccak256(originalRaw), originalHash);
    const projection = () => JSON.stringify({ payments: reader!.payments(),
      journals: reader!.journals(), audit: reader!.events() });
    const originalProjection = projection();
    const expectedRelayerBalance = await chain.provider.getBalance(chain.relayer.address);
    async function uncertain() {
      const first = reader!.get(firstId)!, second = reader!.get(secondId)!;
      assert.equal(first.status, 'broadcast');
      assert.ok(first.raw_tx === originalRaw, 'Uncertain outcome replaced the durable signed transaction');
      assert.equal(first.tx_hash, originalHash);
      assert.equal(second.status, 'queued');
      assert.equal(second.raw_tx, null); assert.equal(second.tx_hash, null);
      assert.equal(reader!.journals().length, HISTORICAL_PAYMENTS);
      assert.ok(historyProjection() === retainedHistory, 'Receipt outage changed historical private evidence');
      const events = reader!.events();
      assert.equal(events.length, HISTORICAL_PAYMENTS * 3 + 3);
      assert.equal(events.filter(event => event.action === 'accepted').length, HISTORICAL_PAYMENTS + 2);
      assert.equal(events.filter(event => event.action === 'broadcast-prepared').length, HISTORICAL_PAYMENTS + 1);
      assert.equal(events.filter(event => event.action === 'settled').length, HISTORICAL_PAYMENTS);
      assert.ok(projection() === originalProjection, 'Receipt retries changed the exact private SQLite projection');
      const sends = proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction').slice(historicalSendCount);
      assert.equal(sends.length, 1);
      assert.ok(sends[0].params?.[0] === originalRaw, 'RPC observed unexpected signed transaction bytes');
      assert.equal(await chain!.token.balanceOf(chain!.payee.address), historicalTotal + 125000000n);
      assert.equal(await chain!.token.balanceOf(chain!.payer.address), initialPayerBalance - historicalTotal - 125000000n);
      assert.equal(await chain!.router.nonces(chain!.payer.address), BigInt(HISTORICAL_PAYMENTS + 1));
      assert.equal(await chain!.provider.getTransactionCount(chain!.relayer.address, 'pending'), nativeNonce + 1);
      assert.equal(await chain!.provider.getTransactionCount(chain!.payer.address, 'pending'), initialPayerNativeNonce);
      assert.equal(await chain!.provider.getBalance(chain!.relayer.address), expectedRelayerBalance);
      const receipt = await chain!.provider.getTransactionReceipt(originalHash);
      assert.equal(receipt?.status, 1); assert.equal(receipt?.hash, originalHash);
    }
    const publicFields = ['id', 'status', 'tx_hash', 'block_number', 'block_hash', 'error', 'created_at', 'updated_at', 'payment'].sort();
    function assertPublic(row: any, input: typeof firstInput, status: 'broadcast' | 'queued') {
      assert.deepEqual(Object.keys(row).sort(), publicFields, 'Authenticated history exposed unexpected/private fields');
      assert.equal(row.id, paymentKey(input.payment)); assert.equal(row.status, status);
      assert.deepEqual(row.payment, input.payment);
      assert.equal(row.tx_hash, status === 'broadcast' ? originalHash : null);
      assert.equal(row.block_number, null); assert.equal(row.block_hash, null); assert.equal(row.error, null);
      assert.equal(typeof row.created_at, 'string'); assert.equal(typeof row.updated_at, 'string');
    }
    async function observeOutage(phase: 'before-restart' | 'after-restart') {
      const started = performance.now(), deadline = started + PHASE_BUDGET_MS, baseline = receiptCount();
      let observations = 0, boundaryCount: number | undefined, boundaryElapsedMs: number | undefined, passed = false;
      let historyBursts = 0, historyResponses = 0;
      let nextHistoryAt = started, historyBoundaryElapsedMs: number | undefined;
      let firstHistoryElapsedMs: number | undefined, lastHistoryElapsedMs: number | undefined;
      const historyResponseStatuses = new Set<number>();
      let ended: number | undefined;
      async function history() {
        const paths = [
          'payments/' + encodeURIComponent(firstId),
          'payments/' + encodeURIComponent(secondId),
          'payments?limit=25&status=broadcast',
          frozenJournalPath
        ];
        // Sixteen GETs per five-second interval stay below the 240/minute API
        // limit, including setup and an extra burst at the observation boundary.
        const requests = Array.from({ length: HISTORY_READERS_PER_BURST }, () => paths).flat().map(async path => {
          const response = await api(cli, path);
          historyResponseStatuses.add(response.status);
          if (response.status === 200) historyResponses++;
          const body = await response.text();
          assert.equal(response.status, 200);
          return JSON.parse(body);
        });
        // Keep every fetch and body read tracked until it finishes, even when a
        // sibling request fails. The worker can still retry RPC during these reads.
        const responses = await Promise.allSettled(requests);
        const bodies = responses.map(response => {
          if (response.status === 'rejected') throw response.reason;
          return response.value;
        });
        for (let offset = 0; offset < bodies.length; offset += paths.length) {
          const [first, second, filtered, journal] = bodies.slice(offset, offset + paths.length) as any[];
          assertPublic(first, firstInput, 'broadcast'); assertPublic(second, secondInput, 'queued');
          assert.deepEqual(Object.keys(filtered).sort(), ['items', 'nextCursor']);
          assert.equal(filtered.nextCursor, null); assert.equal(filtered.items.length, 1);
          assert.deepEqual(filtered.items[0], first);
          assertJournalPage(journal);
          assert.deepEqual(journal, frozenJournalPage, 'Frozen journal continuation changed during receipt outage');
        }
      }
      try {
        for (;;) {
          const remaining = deadline - performance.now();
          assert.ok(remaining > 0, `Active receipt outage did not meet its observations within ${PHASE_BUDGET_MS / 1000} seconds`);
          assert.equal(cli.child.exitCode, null, 'The observed CLI process exited during the active outage');
          assert.equal(cli.child.signalCode, null);
          await within(uncertain(), remaining);
          observations++;
          const beforeHistory = performance.now();
          if (beforeHistory >= nextHistoryAt || (beforeHistory - started >= MIN_WINDOW_MS && historyBoundaryElapsedMs === undefined)) {
            const before = projection(), beforeResponses = historyResponses;
            const pending = history();
            historyRequests.add(pending);
            void pending.finally(() => historyRequests.delete(pending)).catch(() => {});
            await within(pending, Math.max(1, deadline - performance.now()));
            assert.ok(projection() === before && before === originalProjection,
              'Authenticated outage history reads changed the private payment/audit/journal projection');
            assert.equal(historyResponses - beforeResponses, HISTORY_REQUESTS_PER_BURST);
            historyBursts++;
            const historyElapsedMs = performance.now() - started;
            firstHistoryElapsedMs ??= historyElapsedMs; lastHistoryElapsedMs = historyElapsedMs;
            if (historyElapsedMs >= MIN_WINDOW_MS) historyBoundaryElapsedMs ??= historyElapsedMs;
            nextHistoryAt = performance.now() + HISTORY_INTERVAL_MS;
          }
          const elapsed = performance.now() - started, current = receiptCount();
          assert.ok(elapsed <= PHASE_BUDGET_MS, `Active receipt outage exceeded its ${PHASE_BUDGET_MS / 1000}-second observation budget`);
          if (elapsed >= MIN_WINDOW_MS && boundaryCount === undefined) {
            boundaryCount = current; boundaryElapsedMs = elapsed;
          }
          // Require a fresh failed RPC after the configured window endpoint, rather
          // than allowing early retries followed by a stalled scheduler to pass.
          if (boundaryCount !== undefined && current > boundaryCount &&
            current - baseline > MIN_ACTIVE_ATTEMPTS && observations > MIN_ACTIVE_ATTEMPTS &&
            historyBursts >= MIN_HISTORY_BURSTS && historyBoundaryElapsedMs !== undefined) {
            passed = true; ended = performance.now();
            return { durationMs: ended - started, observations, failedReceiptAttempts: current - baseline,
              boundaryElapsedMs: boundaryElapsedMs!, failedReceiptsAfterBoundary: current - boundaryCount,
              historyBursts, historyResponses, historyBoundaryElapsedMs };
          }
          await new Promise(resolvePause => setTimeout(resolvePause, Math.min(1000, Math.max(1, deadline - performance.now()))));
        }
      } finally {
        ended ??= performance.now();
        t.diagnostic(JSON.stringify({ phase, passed, minimumWindowMs: MIN_WINDOW_MS, phaseBudgetMs: PHASE_BUDGET_MS,
          durationMs: Math.floor(ended - started), observations,
          failedReceiptAttempts: receiptCount() - baseline, boundaryElapsedMs: boundaryElapsedMs === undefined ? null : Math.floor(boundaryElapsedMs),
          failedReceiptsAfterBoundary: boundaryCount === undefined ? 0 : receiptCount() - boundaryCount,
          readersPerBurst: HISTORY_READERS_PER_BURST, requestsPerBurst: HISTORY_REQUESTS_PER_BURST,
          historicalJournalRows: HISTORICAL_PAYMENTS, frozenJournalPageRows: frozenJournalPage.items.length,
          historyBursts, historyResponses, historyResponseStatuses: [...historyResponseStatuses],
          firstHistoryElapsedMs: firstHistoryElapsedMs === undefined ? null : Math.floor(firstHistoryElapsedMs),
          lastHistoryElapsedMs: lastHistoryElapsedMs === undefined ? null : Math.floor(lastHistoryElapsedMs),
          historyBoundaryElapsedMs: historyBoundaryElapsedMs === undefined ? null : Math.floor(historyBoundaryElapsedMs) }));
      }
    }
    assert.ok(performance.now() >= outageStarted!);
    const firstWindow = await observeOutage('before-restart');
    await cli.kill(); // OS termination skips the real CLI's shutdown/SQLite close.
    const terminated = await cli.exited;
    assert.ok(terminated.signal === 'SIGKILL' || (terminated.code !== null && terminated.code !== 0), 'Expected abrupt child termination');
    const previousClosedAt = performance.now();
    reader.close(); reader = new Projection(db);
    await uncertain();
    const restartStartupBaseline = receiptCount();
    cli = await startCli({ ...config, apiKey: cli.apiKey });
    const restartedReadyAt = performance.now();
    const startupReceiptAttempts = receiptCount() - restartStartupBaseline;
    assert.notEqual(cli.child.pid, originalPid);
    const secondWindow = await observeOutage('after-restart');
    const outageDurationMs = performance.now() - outageStarted!;
    const observedWindowMs = firstWindow.durationMs + secondWindow.durationMs;
    const restartDowntimeMs = restartedReadyAt - previousClosedAt; // Closed-to-ready gap, excluded from both windows.
    assert.ok(firstWindow.durationMs >= MIN_WINDOW_MS && secondWindow.durationMs >= MIN_WINDOW_MS);
    assert.ok(firstWindow.failedReceiptAttempts > MIN_ACTIVE_ATTEMPTS && secondWindow.failedReceiptAttempts > MIN_ACTIVE_ATTEMPTS);
    assert.ok(firstWindow.observations > MIN_ACTIVE_ATTEMPTS && secondWindow.observations > MIN_ACTIVE_ATTEMPTS);
    for (const window of [firstWindow, secondWindow]) {
      assert.ok(window.historyBursts >= MIN_HISTORY_BURSTS);
      assert.equal(window.historyResponses, window.historyBursts * HISTORY_REQUESTS_PER_BURST);
    }
    assert.ok(observedWindowMs >= MIN_WINDOW_MS * 2);

    proxy.heal();
    await until(() => reader!.get(firstId)?.status === 'settled' && reader!.get(secondId)?.status === 'settled',
      'The autonomous CLI did not settle persisted work after RPC recovery');
    assert.ok(reader.get(firstId)!.raw_tx === originalRaw, 'Recovery replaced the first signed bytes');
    assert.equal(reader.get(firstId)!.tx_hash, originalHash);
    const second = reader.get(secondId)!;
    assert.ok(second.raw_tx && second.tx_hash);
    assert.equal(keccak256(second.raw_tx), second.tx_hash);
    assert.equal(Transaction.from(second.raw_tx).nonce, nativeNonce + 1);
    assert.equal(reader.journals().length, HISTORICAL_PAYMENTS + 2);
    for (const paymentId of [firstId, secondId]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
      assert.equal(reader.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
    assert.equal(await chain.token.balanceOf(chain.payee.address), historicalTotal + 132000000n);
    assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerBalance - historicalTotal - 132000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), BigInt(HISTORICAL_PAYMENTS + 2));
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), nativeNonce + 2);
    assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), initialRelayerNativeNonce + HISTORICAL_PAYMENTS + 2);
    const totalNativeSends = proxy.calls.filter(call => call.method === 'eth_sendRawTransaction').length;
    assert.equal(totalNativeSends, HISTORICAL_PAYMENTS + 2);
    assert.equal(totalNativeSends - historicalSendCount, 2);
    assert.ok(historyProjection() === retainedHistory, 'Healing receipt lookup changed historical private evidence');
    const frozenAfterHealing = await journalPage(frozenJournalPath);
    assertJournalPage(frozenAfterHealing);
    assert.deepEqual(frozenAfterHealing, frozenJournalPage, 'New settlements leaked into a frozen journal continuation');
    const freshFirst = await journalPage('journals?limit=25');
    assertJournalPage(freshFirst);
    assert.equal(freshFirst.items.length, 25); assert.ok(freshFirst.nextCursor);
    const freshSecond = await journalPage('journals?limit=25&cursor=' + encodeURIComponent(freshFirst.nextCursor));
    assertJournalPage(freshSecond);
    assert.equal(freshSecond.items.length, 3); assert.equal(freshSecond.nextCursor, null);
    const freshIds = [...freshFirst.items, ...freshSecond.items].map(row => row.payment_id);
    const expectedIds = [...historicalIds, firstId, secondId];
    assert.equal(new Set(freshIds).size, HISTORICAL_PAYMENTS + 2);
    assert.deepEqual(freshIds, expectedIds.toReversed());
    for (const input of [firstInput, secondInput]) {
      const replay = await api(cli, 'payments', input);
      assert.equal(replay.status, 200);
      assert.equal((await replay.json() as { replay: boolean }).replay, true);
    }
    const reconciliation = await api(cli, 'reconcile', {});
    assert.equal(reconciliation.status, 200);
    const result = await reconciliation.json() as { checked: number; exceptions: string[] };
    assert.equal(result.checked, HISTORICAL_PAYMENTS + 2); assert.deepEqual(result.exceptions, []);
    assert.equal(reader.journals().length, HISTORICAL_PAYMENTS + 2);
    assert.equal(reader.events().length, (HISTORICAL_PAYMENTS + 2) * 3);
    assert.equal(await chain.token.balanceOf(chain.payee.address), historicalTotal + 132000000n);
    assert.ok(historyProjection() === retainedHistory, 'Replay/reconciliation changed historical private evidence');
    t.diagnostic(JSON.stringify({ minimumWindowMs: MIN_WINDOW_MS, phaseBudgetMs: PHASE_BUDGET_MS,
      outageDurationMs: Math.floor(outageDurationMs), observedWindowMs: Math.floor(observedWindowMs),
      restartDowntimeMs: Math.floor(restartDowntimeMs), startupReceiptAttempts,
      receiptAttemptsBeforeRestart: firstWindow.failedReceiptAttempts, receiptAttemptsAfterRestart: secondWindow.failedReceiptAttempts,
      observationsBeforeRestart: firstWindow.observations, observationsAfterRestart: secondWindow.observations,
      readersPerBurst: HISTORY_READERS_PER_BURST, requestsPerBurst: HISTORY_REQUESTS_PER_BURST,
      historicalPayments: HISTORICAL_PAYMENTS, historySetupMs: Math.floor(historySetupMs),
      frozenJournalPageRows: frozenJournalPage.items.length, historicalProjectionRetained: true,
      historicalNativeSends: historicalSendCount, outageNativeSends: totalNativeSends - historicalSendCount,
      totalNativeSends, minedNativeNonces: HISTORICAL_PAYMENTS + 2,
      historyBurstsBeforeRestart: firstWindow.historyBursts, historyBurstsAfterRestart: secondWindow.historyBursts,
      historyResponsesBeforeRestart: firstWindow.historyResponses, historyResponsesAfterRestart: secondWindow.historyResponses,
      settledPayments: HISTORICAL_PAYMENTS + 2, recoveredPayments: 2, journalRows: HISTORICAL_PAYMENTS + 2,
      auditEvents: reader.events().length, freshJournalPages: [freshFirst.items.length, freshSecond.items.length], reconciled: result.checked }));
    completed = true;
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    for (const cli of children) await cleanup(() => cli.kill());
    await cleanup(() => within(Promise.allSettled([...historyRequests]), 8000));
    await cleanup(() => reader?.close());
    await cleanup(() => proxy?.close());
    await cleanup(() => chain?.close());
    if (directory && completed && failures.length === 0) await cleanup(() => {
      assert.ok(children.every(cli => cli.child.exitCode !== null || cli.child.signalCode !== null), 'Do not remove files under a live CLI');
      assert.equal(dirname(resolve(directory!)), dataRoot);
      assert.ok(directory!.startsWith(join(dataRoot, 'cli-recovery-test-')));
      rmSync(directory!, { recursive: true, force: true });
    });
    if (failures.length) throw new AggregateError(failures, 'CLI recovery resource cleanup failed');
  }
});
