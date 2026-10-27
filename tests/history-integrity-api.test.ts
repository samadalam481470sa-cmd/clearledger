import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { getAddress, type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { PaymentService } from '../src/service.ts';
import { Store, type RecordRow, type Status } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

// Controlled SQLite projection fixtures, not claims of executed EVM transfers.
const payer = '0x' + '11'.repeat(20), payee = '0x' + '22'.repeat(20);
const token = getAddress('0x' + 'ab'.repeat(20)), routerAddress = '0x' + '44'.repeat(20);
const blockHash = '0x' + 'ee'.repeat(32);
const integrityError = 'Stored payment data is invalid; verify the original authorization';
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
let store: Store;
let expectedPayments: Map<string, Payment>;
let invalid: Set<string>;
let privateValues: string[];
beforeEach(() => {
  store = new Store(); expectedPayments = new Map(); invalid = new Set();
  privateValues = ['HISTORY_FINGERPRINT_PRIVATE', 'HISTORY_SIGNATURE_PRIVATE', 'HISTORY_RAW_PRIVATE',
    'HISTORY_PARSE_PRIVATE', 'HISTORY_ARRAY_PRIVATE', 'HISTORY_SCHEMA_PRIVATE'];
});
afterEach(() => { store.close(); });

function seed(n: number, status: Status = 'queued') {
  const payment: Payment = { paymentId: hash(n), payer, payee, token, amount: '125000000', nonce: String(n - 1), deadline: '2000000000' };
  const row = store.accept(payment, 'HISTORY_FINGERPRINT_PRIVATE_' + n, 'HISTORY_SIGNATURE_PRIVATE_' + n).row;
  if (['broadcast', 'settled', 'review'].includes(status)) {
    store.broadcast(row.id, 'HISTORY_RAW_PRIVATE_' + n, hash(100000 + n));
    if (status !== 'broadcast') store.finalize(row.id, n, blockHash);
  }
  if (status === 'failed' || status === 'review') store.setStatus(row.id, status, 'Synthetic fixture status');
  expectedPayments.set(row.id, payment);
  return row.id;
}
function corrupt(id: string, payload: string) {
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(payload, id);
  invalid.add(id);
}
function seedMixedHistory() {
  const ids = [seed(1, 'settled'), seed(2), seed(3), seed(4, 'settled'), seed(5),
    seed(6, 'broadcast'), seed(7, 'failed'), seed(8), seed(9, 'review'), seed(10)];
  corrupt(ids[1], '{HISTORY_PARSE_PRIVATE');
  corrupt(ids[3], 'null');
  corrupt(ids[4], JSON.stringify(['HISTORY_ARRAY_PRIVATE', { signature: 'HISTORY_SIGNATURE_PRIVATE' }]));
  corrupt(ids[5], JSON.stringify({ ...expectedPayments.get(ids[5]), amount: '1.5', privateKey: 'HISTORY_SCHEMA_PRIVATE' }));
  const wrongId = hash(900008); privateValues.push(wrongId);
  corrupt(ids[7], JSON.stringify({ ...expectedPayments.get(ids[7]), paymentId: wrongId }));
  // Valid mixed-case input is normalized in the returned copy, without rewriting
  // the lowercase token bytes kept in this queued fixture's stored JSON.
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(
    JSON.stringify({ ...expectedPayments.get(ids[2]), token: token.toLowerCase() }), ids[2]);
  store.db.prepare('UPDATE payments SET created_at=?,updated_at=?').run('2026-10-27T00:00:00.000Z', '2026-10-27T00:00:00.000Z');
  return ids;
}
function snapshot() {
  return JSON.stringify({
    schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    payments: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: store.db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    changes: store.db.prepare('SELECT total_changes() AS changes').get()!.changes
  });
}
function service() {
  const provider = {
    getBlock: async () => ({ number: 123, hash: blockHash, timestamp: 1800000000 }),
    getBlockNumber: async () => 123,
    getTransactionReceipt: async () => { throw new Error('Malformed stored authorization must be rejected before receipt RPC'); }
  };
  const router = { connect() { return this; } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet, router, 31337, routerAddress);
}
async function withApi(run: (request: (path: string, post?: boolean) => Promise<any>) => Promise<void>) {
  const server = makeServer({ service: service(), apiKey: 'history-integrity-test-token', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    await run(async (path, post = false) => {
      const response = await fetch(url + '/api/' + path, { method: post ? 'POST' : 'GET', signal: AbortSignal.timeout(3000),
        headers: { Authorization: 'Bearer history-integrity-test-token', 'Content-Type': 'application/json' },
        body: post ? '{}' : undefined });
      const text = await response.text();
      assert.equal(response.status, 200);
      for (const value of privateValues) assert.ok(!text.includes(value), 'HTTP history exposed a private persisted value');
      return JSON.parse(text);
    });
  } finally {
    await server.drainRequests(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}
function assertRow(actual: any, row: RecordRow) {
  const { raw_tx, signature, fingerprint, payload, ...metadata } = row;
  const keys = [...Object.keys(metadata), 'payment', ...(invalid.has(row.id) ? ['integrityError'] : [])].sort();
  assert.deepEqual(Object.keys(actual).sort(), keys);
  for (const [key, value] of Object.entries(metadata)) assert.equal(actual[key], value);
  if (invalid.has(row.id)) {
    assert.equal(actual.payment, null); assert.equal(actual.integrityError, integrityError);
  } else {
    assert.deepEqual(actual.payment, expectedPayments.get(row.id));
    assert.equal(Object.hasOwn(actual, 'integrityError'), false);
  }
}

test('mixed corrupt history remains paginated, filtered and readable without any GET-side writes', { timeout: 10000 }, async () => {
  const ids = seedMixedHistory();
  const before = snapshot();
  await withApi(async request => {
    for (const status of [undefined, 'queued', 'settled', 'broadcast', 'failed', 'review'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        assert.ok(++pages <= ids.length, 'Pagination failed to terminate for the fixed insertion range');
        const expected = store.pagePayments({ limit: 2, status, cursor });
        const query = new URLSearchParams({ limit: '2' });
        if (status) query.set('status', status);
        if (cursor) query.set('cursor', cursor);
        const page = await request('payments?' + query);
        assert.equal(page.items.length, expected.items.length);
        assert.equal(page.nextCursor, expected.nextCursor, 'Invalid rows must not alter the insertion boundary or cursor');
        for (let index = 0; index < expected.items.length; index++) {
          assertRow(page.items[index], expected.items[index]);
          seen.push(page.items[index].id);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      const expectedIds = ids.filter(id => !status || store.get(id)!.status === status).reverse();
      assert.deepEqual(seen, expectedIds);
      assert.equal(new Set(seen).size, seen.length);
    }
    const overview = await request('overview');
    assert.deepEqual(overview.payments.map((row: any) => row.id), [...ids].reverse());
    for (const row of overview.payments) assertRow(row, store.get(row.id)!);
    assert.equal(overview.payments.filter((row: any) => row.payment === null).length, 5);
    assert.equal(overview.journals.length, 3);
  });
  assert.ok(snapshot() === before, 'GET history changed database schema, financial rows, audit, journals or write counters');
});

test('reconciliation can flag corrupt settled payload while retained journal and history remain readable', { timeout: 10000 }, async () => {
  const id = seed(1, 'settled');
  const evidence = store.journal(id);
  corrupt(id, '{HISTORY_PARSE_PRIVATE');
  await withApi(async request => {
    const initial = snapshot();
    const before = await request('payments?status=settled');
    assert.equal(before.items.length, 1); assertRow(before.items[0], store.get(id)!);
    assert.ok(snapshot() === initial, 'Reading corruption must not itself change payment status');
    const result = await request('reconcile', true);
    assert.equal(result.checked, 1); assert.deepEqual(result.exceptions, [id]);
    assert.equal(store.get(id)!.status, 'review');
    assert.deepEqual(store.journal(id), evidence);
    assert.equal(store.events().filter(row => row.payment_id === id && row.action === 'review').length, 1);
    const afterReview = snapshot();
    const page = await request('payments?status=review');
    assert.equal(page.items.length, 1); assertRow(page.items[0], store.get(id)!);
    const overview = await request('overview');
    assert.equal(overview.payments.length, 1); assertRow(overview.payments[0], store.get(id)!);
    assert.deepEqual(overview.journals, [evidence]);
    const journals = await request('journals');
    assert.deepEqual(journals.items, [evidence]);
    assert.deepEqual((await request('totals')).assets, [{ token: token.toLowerCase(), settledPayments: 0,
      settledBaseUnits: '0', reviewPayments: 1, reviewBaseUnits: '125000000' }]);
    assert.ok(snapshot() === afterReview, 'GET review projections changed retained evidence or audit');
  });
});
