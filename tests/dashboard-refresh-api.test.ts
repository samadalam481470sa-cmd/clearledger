import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { startPolling } from '../web/polling.ts';
import { type AssetTotal, type Overview } from '../web/dashboard.ts';
import { type Payment } from '../src/payment.ts';

// Real authenticated HTTP and the production polling helper, with synthetic
// SQLite/RPC controls. This does not mount React or establish browser behavior.
const key = 'dashboard-refresh-test-token', blockHash = '0x' + 'ee'.repeat(32);
const token = '0x' + '33'.repeat(20), routerAddress = '0x' + '44'.repeat(20);
const payment: Payment = { paymentId: '0x' + 'ab'.repeat(32), payer: '0x' + '11'.repeat(20),
  payee: '0x' + '22'.repeat(20), token, amount: '125000000', nonce: '0', deadline: '2000000000' };
let store: Store, server: ReturnType<typeof makeServer>, url: string, paymentId: string;
let fault: 'ready' | 'held' | 'failed', blockNumber: number, held: (() => void)[];
let polls: { stop(): void }[], requests: { path: string; status: number }[];
let overview: Overview | undefined, assets: AssetTotal[] | undefined;
let overviewError: string, totalsError: string, overviewCommits: number, totalsCommits: number;
beforeEach(async () => {
  store = new Store(); fault = 'ready'; blockNumber = 20; held = []; polls = []; requests = [];
  overview = undefined; assets = undefined; overviewError = ''; totalsError = '';
  overviewCommits = 0; totalsCommits = 0;
  paymentId = store.accept(payment, 'synthetic-fingerprint', 'synthetic-signature').row.id;
  store.broadcast(paymentId, 'synthetic-raw', '0x' + 'aa'.repeat(32));
  store.finalize(paymentId, 17, blockHash);
  const provider = {
    getBlock: async () => {
      if (fault === 'held') await new Promise<void>(resolveHeld => { held.push(resolveHeld); });
      if (fault === 'failed') throw Object.assign(new Error('Controlled private RPC detail'), { code: 'NETWORK_ERROR' });
      return { number: blockNumber, hash: blockHash, timestamp: 1800000000 };
    }
  };
  const router = { connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider,
    {} as Wallet, router, 31337, routerAddress);
  server = makeServer({ service, apiKey: key, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  for (const poll of polls) poll.stop();
  fault = 'ready'; for (const release of held) release(); held = [];
  await server.drainRequests(); server.closeAllConnections();
  if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  store.close();
});
async function until(check: () => boolean, label: string) {
  const end = performance.now() + 8000;
  while (performance.now() < end) {
    if (check()) return;
    await new Promise(resolvePause => setTimeout(resolvePause, 10));
  }
  throw new Error(label + ' timed out');
}
async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url + '/api/' + path, { signal, headers: { Authorization: 'Bearer ' + key } });
  const body = await response.json() as any; requests.push({ path, status: response.status });
  if (!response.ok) throw new Error(body.error);
  return body as T;
}
function startOverview() {
  polls.push(startPolling({ intervalMs: 25, load: signal => read<Overview>('overview', signal),
    onValue: value => { overview = value; overviewError = ''; overviewCommits++; },
    onError: error => { overviewError = (error as Error).message; } }));
}
function startTotals() {
  polls.push(startPolling({ intervalMs: 25, load: async signal => (await read<{ assets: AssetTotal[] }>('totals', signal)).assets,
    onValue: value => { assets = value; totalsError = ''; totalsCommits++; },
    onError: error => { totalsError = (error as Error).message; } }));
}
function snapshot() {
  return JSON.stringify({ rows: store.list(), audit: store.events(), journals: store.journals(),
    changes: store.db.prepare('SELECT total_changes() AS n').get()!.n });
}

test('local totals reflect review while independent overview HTTP is held, fails, and later recovers', { timeout: 15000 }, async t => {
  startOverview(); await until(() => overview !== undefined, 'Initial network context');
  startTotals(); await until(() => assets?.[0]?.settledPayments === 1, 'Initial settled totals');
  fault = 'held'; await until(() => held.length === 1, 'Pending overview RPC');
  const lastOverview = JSON.stringify(overview), previousCommits = overviewCommits;
  store.setStatus(paymentId, 'review', 'Controlled reconciliation fixture');
  const afterReview = snapshot(), previousTotals = totalsCommits;
  await until(() => assets?.[0]?.reviewPayments === 1 && totalsCommits > previousTotals, 'Local totals during held overview');
  assert.equal(assets![0].settledBaseUnits, '0'); assert.equal(assets![0].reviewBaseUnits, '125000000');
  assert.equal(overviewCommits, previousCommits); assert.equal(JSON.stringify(overview), lastOverview);
  assert.equal(totalsError, '');
  const history = await read<{ items: { status: string }[] }>('payments');
  assert.equal(history.items[0].status, 'review');
  fault = 'failed'; for (const release of held) release(); held = [];
  await until(() => overviewError.length > 0, 'Overview failure warning');
  assert.equal(overviewError, 'Upstream RPC unavailable; check payment history before retrying');
  assert.ok(requests.some(request => request.path === 'overview' && request.status === 503));
  const duringFailure = totalsCommits;
  await until(() => totalsCommits > duringFailure, 'Local totals during failed overview');
  assert.equal(totalsError, ''); assert.equal(JSON.stringify(overview), lastOverview);
  blockNumber = 22; fault = 'ready';
  await until(() => overview?.block?.number === 22 && overviewError === '', 'Healed overview');
  assert.equal(assets![0].settledPayments, 0); assert.equal(assets![0].reviewPayments, 1);
  assert.equal(snapshot(), afterReview);
  t.diagnostic(JSON.stringify({ localReviewPayments: 1, localSettledPayments: 0,
    updatedWhileOverviewHeld: true, overviewFailureStatus: 503, recoveredBlock: 22 }));
});

test('a totals HTTP failure retains its last data and warning while overview refresh continues independently', { timeout: 15000 }, async t => {
  const originalTotals = store.assetTotals.bind(store); let failTotals = false;
  store.assetTotals = () => { if (failTotals) throw new Error('Controlled local totals unavailable'); return originalTotals(); };
  startOverview(); await until(() => overview !== undefined, 'Initial network context');
  startTotals(); await until(() => assets !== undefined, 'Initial totals');
  const before = snapshot(), lastAssets = JSON.stringify(assets);
  failTotals = true; blockNumber = 23;
  await until(() => totalsError.length > 0 && overview?.block?.number === 23, 'Independent error and overview update');
  assert.equal(totalsError, 'Controlled local totals unavailable'); assert.equal(JSON.stringify(assets), lastAssets);
  assert.equal(overviewError, ''); assert.ok(requests.some(request => request.path === 'totals' && request.status === 422));
  const commits = overviewCommits;
  await until(() => overviewCommits > commits, 'Continued overview polling');
  failTotals = false;
  await until(() => totalsError === '', 'Healed local totals');
  assert.equal(snapshot(), before);
  t.diagnostic(JSON.stringify({ retainedLastTotals: true, totalsFailureStatus: 422,
    independentOverviewBlock: 23, recoveredTotals: true }));
});
