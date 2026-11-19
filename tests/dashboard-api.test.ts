import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { CursorPager, pagePath, type PaymentRow, type JournalRow, type AssetTotal } from '../web/dashboard.ts';

// Real HTTP/API/controller integration over synthetic projection records, not an EVM test.
test('dashboard controllers browse beyond overview, retain history on auth failure, and separate asset totals', async () => {
  const store = new Store();
  const address = (byte: string) => '0x' + byte.repeat(20);
  const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
  const payer = address('11'), payee = address('22');
  const expected = new Map<string, { settled: bigint; review: bigint }>();
  function seed(n: number) {
    const token = n % 2 ? address('ab') : address('cd'), amount = 10n ** 30n + BigInt(n);
    const row = store.accept({ paymentId: hash(n), payer, payee, token, amount: String(amount),
      nonce: String(n), deadline: '2000000000' }, 'private-fingerprint-' + n, 'private-signature-' + n).row;
    store.broadcast(row.id, 'private-raw-' + n, hash(10000 + n));
    store.finalize(row.id, n, hash(20000 + n));
    const total = expected.get(token) ?? { settled: 0n, review: 0n };
    if (n % 5 === 0) { store.setStatus(row.id, 'review', 'Synthetic review'); total.review += amount; }
    else total.settled += amount;
    expected.set(token, total);
    return row.id;
  }
  const ids = Array.from({ length: 126 }, (_, i) => seed(i + 1));
  const provider = { getBlock: async () => ({ number: 126, hash: hash(20126), timestamp: 1800000000 }) };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    { connect() { return this; } }, 31337, address('33'));
  const key = 'dashboard-integration-token';
  let activeKey = key;
  const server = makeServer({ service, apiKey: key, port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/';
  async function read(path: string, signal?: AbortSignal) {
    const response = await fetch(base + path, { signal, headers: { Authorization: 'Bearer ' + activeKey } });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(result.error);
    return result;
  }
  const payments = new CursorPager<PaymentRow>((cursor, signal) => read(pagePath('payments', cursor, 'settled'), signal), () => {});
  const journals = new CursorPager<JournalRow>((cursor, signal) => read(pagePath('journals', cursor), signal), () => {});
  try {
    assert.equal((await read('overview')).payments.length, 100);
    assert.equal(await payments.refresh(), true);
    const firstPage = payments.state.items;
    activeKey = 'incorrect-token';
    assert.equal(await payments.next(), false);
    assert.equal(payments.state.page, 1);
    assert.deepEqual(payments.state.items, firstPage);
    assert.match(payments.state.error, /Bearer token required/);
    activeKey = key;
    const lateId = seed(127);
    const visited = firstPage.map(row => row.id);
    for (let i = 0; payments.state.nextCursor && i < 10; i++) {
      assert.equal(await payments.next(), true);
      visited.push(...payments.state.items.map(row => row.id));
    }
    assert.equal(payments.state.nextCursor, null);
    assert.equal(visited.length, 101);
    assert.equal(new Set(visited).size, visited.length);
    assert.ok(visited.includes(ids[0]), 'Oldest payment must remain reachable');
    assert.ok(!visited.includes(lateId), 'Later insertion must not enter an existing scan');
    assert.ok(payments.state.items.every(row => row.status === 'settled'));
    assert.ok(!JSON.stringify(payments.state.items).includes('private-'));
    assert.equal(await payments.refresh(), true);
    assert.equal(payments.state.page, 1);
    assert.equal(payments.state.items[0].id, lateId);
    assert.equal(await journals.refresh(), true);
    const journalIds = journals.state.items.map(row => row.payment_id);
    for (let i = 0; journals.state.nextCursor && i < 10; i++) {
      assert.equal(await journals.next(), true);
      journalIds.push(...journals.state.items.map(row => row.payment_id));
    }
    assert.equal(journalIds.length, 127);
    assert.equal(new Set(journalIds).size, journalIds.length);
    const assets = (await read('totals')).assets as AssetTotal[];
    assert.equal(assets.length, 2);
    for (const asset of assets) {
      assert.equal(asset.settledBaseUnits, expected.get(asset.token)!.settled.toString());
      assert.equal(asset.reviewBaseUnits, expected.get(asset.token)!.review.toString());
    }
  } finally {
    payments.dispose(); journals.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test('a partial page body times out without advancing filtered history or changing the ledger', { timeout: 15000 }, async t => {
  const store = new Store(), key = 'page-body-deadline-test-token';
  const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
  const address = (byte: string) => '0x' + byte.repeat(20);
  const expected: string[] = [], paths: string[] = [], signals: AbortSignal[] = [];
  let server: ReturnType<typeof makeServer> | undefined, forwarder: ReturnType<typeof createServer> | undefined;
  let pager: CursorPager<PaymentRow> | undefined, rpcCalls = 0, holdNext = false, headersReceived = false;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const partialBody = new Promise<void>(resolve => { entered = resolve; });
  const forwarding = new Set<Promise<void>>();
  async function within<T>(pending: Promise<T>, label: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
      })]);
    } finally { clearTimeout(timer); }
  }
  function digest() {
    const queries = ['SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
      'SELECT rowid,* FROM payments ORDER BY rowid', 'SELECT rowid,* FROM journals ORDER BY rowid',
      'SELECT * FROM audit ORDER BY sequence', 'SELECT * FROM sqlite_sequence ORDER BY name',
      'SELECT total_changes() AS changes'];
    return createHash('sha256').update(JSON.stringify(queries.map(sql => store.db.prepare(sql).all()))).digest('hex');
  }
  try {
    for (let n = 1; n <= 65; n++) {
      const row = store.accept({ paymentId: hash(n), payer: address('11'), payee: address('22'),
        token: address('33'), amount: String(n), nonce: String(n), deadline: '2000000000' },
        'page-private-fingerprint-' + n, 'page-private-signature-' + n).row;
      if (n <= 4) {
        store.broadcast(row.id, 'page-private-raw-' + n, hash(1000 + n));
        store.finalize(row.id, n, hash(2000 + n));
      } else expected.unshift(row.id);
    }
    const unavailable = async () => { rpcCalls++; throw new Error('Synthetic RPC unavailable'); };
    const provider = { getBlock: unavailable, getBlockNumber: unavailable, getTransactionReceipt: unavailable };
    const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
      { connect() { return this; } }, 31337, address('44'));
    server = makeServer({ service, apiKey: key, mode: 'rpc', port: 0 });
    server.listen(0, '127.0.0.1'); await within(once(server, 'listening'), 'History server readiness');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    forwarder = createServer((req, res) => {
      const held = holdNext; holdNext = false;
      const operation = (async () => {
        const response = await fetch(origin + req.url, { signal: AbortSignal.timeout(3000),
          headers: { Authorization: req.headers.authorization ?? '' } });
        const text = await response.text();
        assert.ok(!text.includes('page-private-'));
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        if (held) {
          const split = Math.floor(text.length / 2);
          res.write(text.slice(0, split)); entered(); await gate;
          if (!res.destroyed) res.end(text.slice(split));
        } else res.end(text);
      })().catch(() => { if (!res.destroyed) { res.destroy(); } });
      forwarding.add(operation); void operation.finally(() => forwarding.delete(operation));
    });
    forwarder.listen(0, '127.0.0.1'); await within(once(forwarder, 'listening'), 'Response forwarder readiness');
    const base = 'http://127.0.0.1:' + (forwarder.address() as { port: number }).port + '/api/';
    pager = new CursorPager<PaymentRow>(async (cursor, signal) => {
      const path = pagePath('payments', cursor, 'queued'); paths.push(path); signals.push(signal);
      const response = await fetch(base + path, { signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        headers: { Authorization: 'Bearer ' + key } });
      if (paths.length === 2) headersReceived = true;
      const body = await response.json() as { items: PaymentRow[]; nextCursor: string | null; error?: string };
      if (!response.ok) throw new Error(body.error);
      return body;
    }, () => {}, 500);
    const before = digest();
    assert.equal(await within(pager.refresh(), 'First page'), true);
    const firstPage = structuredClone(pager.state);
    holdNext = true;
    const pending = pager.next();
    await within(partialBody, 'Partial page body');
    assert.equal(await within(pending, 'Page client deadline'), false);
    assert.equal(headersReceived, true); assert.equal(signals[1].aborted, true);
    assert.equal((signals[1].reason as Error).message, 'Page response timed out. Try loading this page again.');
    assert.deepEqual(pager.state, { ...firstPage, error: 'Page response timed out. Try loading this page again.' });
    assert.equal(paths.length, 2);
    assert.equal(await within(pager.next(), 'Explicit same-cursor retry'), true);
    assert.equal(paths[2], paths[1]); assert.equal(pager.state.page, 2); assert.equal(pager.state.error, '');
    const visited = [...firstPage.items, ...pager.state.items].map(row => row.id);
    assert.equal(await within(pager.next(), 'Final filtered page'), true);
    visited.push(...pager.state.items.map(row => row.id));
    assert.deepEqual(visited, expected); assert.equal(new Set(visited).size, 61);
    assert.equal(pager.state.nextCursor, null); assert.equal(paths.length, 4);
    assert.ok(paths.every(path => path.includes('status=queued')));
    const finalPage = structuredClone(pager.state);
    release(); await within(Promise.all([...forwarding]), 'Held body release');
    assert.deepEqual(pager.state, finalPage); assert.equal(digest(), before); assert.equal(rpcCalls, 0);
    t.diagnostic(JSON.stringify({ records: 65, filteredRecords: 61, pageRequests: paths.length,
      bodyTimeouts: 1, abortedTimedOutRead: true, sameCursorRetry: true, historyWrites: 0, rpcCalls }));
  } finally {
    pager?.dispose(); release();
    await within(Promise.all([...forwarding]), 'Response cleanup');
    for (const listener of [forwarder, server]) {
      listener?.closeAllConnections();
      if (listener?.listening) await within(new Promise<void>(resolve => listener.close(() => resolve())), 'Listener cleanup');
    }
    await server?.drainRequests(); store.close();
  }
});
