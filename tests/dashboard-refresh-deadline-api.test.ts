import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { type AssetTotal, type Overview } from '../web/dashboard.ts';
import { startPolling, type PollScheduler } from '../web/polling.ts';

// Native HTTP, SQLite and the production poller with synthetic RPC records.
// Controlled interval callbacks are not elapsed-time or mounted-browser proof.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(check: () => boolean, label: string) {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(label + ' timed out');
}
class RefreshTimers implements PollScheduler {
  private next = 0;
  readonly pending = new Map<number, { callback(): void; delay: number }>();
  schedule(callback: () => void, delay: number) {
    const handle = ++this.next;
    this.pending.set(handle, { callback, delay });
    return handle;
  }
  cancel(handle: unknown) { this.pending.delete(handle as number); }
  runNext() {
    const entry = this.pending.entries().next().value;
    assert.ok(entry, 'Expected the next resource refresh');
    assert.equal(entry[1].delay, 100);
    this.pending.delete(entry[0]); entry[1].callback();
  }
}

test('a partial overview body times out while totals refresh and the next resource interval recovers', {
  timeout: 15000
}, async t => {
  const store = new Store(), key = 'resource-body-deadline-token';
  const address = (byte: string) => '0x' + byte.repeat(20), hash = '0x' + 'ee'.repeat(32);
  const overviewTimers = new RefreshTimers(), totalTimers = new RefreshTimers();
  const partialSent = deferred(), partialHeaders = deferred(), release = deferred();
  const forwarding = new Set<Promise<void>>(), paths: string[] = [], overviewSignals: AbortSignal[] = [];
  const polls: { stop(): void }[] = [];
  let server: ReturnType<typeof makeServer> | undefined, forwarder: ReturnType<typeof createServer> | undefined;
  let blockNumber = 20, rpcCalls = 0, holdOverview = false, overviewCommits = 0, totalCommits = 0;
  let overview: Overview | undefined, assets: AssetTotal[] | undefined, overviewError = '', totalError = '';
  function digest() {
    const queries = ['SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
      'SELECT rowid,* FROM payments ORDER BY rowid', 'SELECT rowid,* FROM journals ORDER BY rowid',
      'SELECT * FROM audit ORDER BY sequence', 'SELECT * FROM sqlite_sequence ORDER BY name',
      'SELECT total_changes() AS changes'];
    return createHash('sha256').update(JSON.stringify(queries.map(sql => store.db.prepare(sql).all()))).digest('hex');
  }
  try {
    const row = store.accept({ paymentId: '0x' + 'ab'.repeat(32), payer: address('11'), payee: address('22'),
      token: address('33'), amount: '125000000', nonce: '0', deadline: '2000000000' },
    'resource-private-fingerprint', 'resource-private-signature').row;
    store.broadcast(row.id, 'resource-private-raw', '0x' + 'aa'.repeat(32)); store.finalize(row.id, 17, hash);
    const provider = { getBlock: async () => { rpcCalls++; return { number: blockNumber, hash, timestamp: 1800000000 }; } };
    const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
      { connect() { return this; } }, 31337, address('44'));
    server = makeServer({ service, apiKey: key, mode: 'rpc', port: 0 });
    server.listen(0, '127.0.0.1'); await within(once(server, 'listening'), 'API readiness');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    forwarder = createServer((req, res) => {
      const path = req.url ?? '/', held = path === '/api/overview' && holdOverview;
      if (held) holdOverview = false;
      const operation = (async () => {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(3000),
          headers: { Authorization: req.headers.authorization ?? '' } });
        const text = await response.text();
        assert.ok(!text.includes('resource-private-'));
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        if (held) {
          const split = Math.floor(text.length / 2);
          res.write(text.slice(0, split)); partialSent.resolve(); await release.promise;
          if (!res.destroyed) res.end(text.slice(split));
        } else res.end(text);
      })().catch(() => { if (!res.destroyed) res.destroy(); });
      forwarding.add(operation); void operation.finally(() => forwarding.delete(operation));
    });
    forwarder.listen(0, '127.0.0.1'); await within(once(forwarder, 'listening'), 'Forwarder readiness');
    const base = 'http://127.0.0.1:' + (forwarder.address() as { port: number }).port + '/api/';
    async function read<T>(path: string, signal: AbortSignal): Promise<T> {
      paths.push(path);
      if (path === 'overview') overviewSignals.push(signal);
      const response = await fetch(base + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        headers: { Authorization: 'Bearer ' + key } });
      if (path === 'overview' && overviewSignals.length === 2) partialHeaders.resolve();
      const body = await response.json() as any;
      if (!response.ok) throw new Error(body.error);
      return body as T;
    }
    const before = digest();
    polls.push(startPolling({ timeoutMs: 500, intervalMs: 100, scheduler: overviewTimers,
      load: signal => read<Overview>('overview', signal),
      onValue: value => { overview = value; overviewError = ''; overviewCommits++; },
      onError: error => { overviewError = (error as Error).message; } }));
    polls.push(startPolling({ timeoutMs: 500, intervalMs: 100, scheduler: totalTimers,
      load: async signal => (await read<{ assets: AssetTotal[] }>('totals', signal)).assets,
      onValue: value => { assets = value; totalError = ''; totalCommits++; },
      onError: error => { totalError = (error as Error).message; } }));
    await until(() => overviewCommits === 1 && totalCommits === 1, 'Initial resources');
    const lastOverview = JSON.stringify(overview), lastTotals = JSON.stringify(assets);
    blockNumber = 21; holdOverview = true; overviewTimers.runNext();
    await within(Promise.all([partialSent.promise, partialHeaders.promise]), 'Partial overview JSON');
    assert.equal(rpcCalls, 2, 'The original RPC completed before the response body was held');
    totalTimers.runNext(); await until(() => totalCommits === 2, 'Independent totals refresh');
    assert.equal(JSON.stringify(assets), lastTotals); assert.equal(totalError, '');
    await until(() => overviewError !== '', 'Overview response deadline');
    assert.equal(overviewError, 'Refresh response timed out');
    assert.equal(overviewSignals[1].aborted, true);
    assert.equal((overviewSignals[1].reason as Error).message, 'Refresh response timed out');
    assert.equal(JSON.stringify(overview), lastOverview); assert.equal(overviewCommits, 1);
    assert.equal(overviewTimers.pending.size, 1); assert.equal(overviewSignals.length, 2);
    blockNumber = 22; overviewTimers.runNext();
    await until(() => overviewCommits === 2, 'Scheduled retry recovery');
    assert.equal(overview?.block?.number, 22); assert.equal(overviewError, '');
    release.resolve(); await within(Promise.all([...forwarding]), 'Obsolete body release');
    assert.equal(overview?.block?.number, 22); assert.equal(overviewCommits, 2); assert.equal(overviewError, '');
    assert.equal(rpcCalls, 3); assert.equal(paths.filter(path => path === 'totals').length, 2);
    assert.equal(digest(), before);
    const queued = [...overviewTimers.pending.values(), ...totalTimers.pending.values()].map(timer => timer.callback);
    const completedPaths = [...paths];
    for (const poll of polls) poll.stop();
    for (const callback of queued) callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(paths, completedPaths);
    assert.equal(overviewTimers.pending.size + totalTimers.pending.size, 0);
    t.diagnostic(JSON.stringify({ bodyTimeouts: 1, retainedOverviewBlock: 20, recoveredOverviewBlock: 22,
      totalRefreshes: totalCommits, overviewRpcCalls: rpcCalls, intervalMs: 100,
      intervalExecution: 'controlled callbacks', historyWrites: 0 }));
  } finally {
    for (const poll of polls) poll.stop(); release.resolve();
    await within(Promise.all([...forwarding]), 'Forwarder cleanup');
    await server?.drainRequests();
    for (const listener of [forwarder, server]) {
      listener?.closeAllConnections();
      if (listener?.listening) await within(new Promise<void>(done => listener.close(() => done())), 'Listener cleanup');
    }
    store.close();
  }
});
