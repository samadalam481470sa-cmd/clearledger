import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
