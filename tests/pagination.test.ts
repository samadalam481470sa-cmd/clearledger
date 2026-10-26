import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { getAddress, Interface, type JsonRpcProvider, type Wallet } from 'ethers';
import { Store, type Status } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { type Payment } from '../src/payment.ts';

// Synthetic projection records test pagination/accounting, not EVM settlement.
const payer = '0x' + '11'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const tokenA = getAddress('0x' + 'ab'.repeat(20));
const tokenB = getAddress('0x' + 'cd'.repeat(20));
const blockHash = '0x' + 'ee'.repeat(32);
const routerAddress = '0x' + '44'.repeat(20);
const settlementInterface = new Interface([
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)'
]);
const hash = (n: number) => '0x' + n.toString(16).padStart(64, '0');
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

function seed(n: number, status: Status = 'queued', amount = '1000000', token = tokenA) {
  const payment: Payment = {
    paymentId: hash(n), payer, payee, token, amount, nonce: String(n - 1), deadline: '2000000000'
  };
  const row = store.accept(payment, 'private-fingerprint-' + n, 'private-signature-' + n).row;
  if (status === 'settled' || status === 'review' || status === 'broadcast') {
    store.broadcast(row.id, 'private-raw-transaction-' + n, hash(100000 + n));
    if (status !== 'broadcast') store.finalize(row.id, n, blockHash);
  }
  if (status === 'review' || status === 'failed') store.setStatus(row.id, status, 'Synthetic fixture status');
  return store.get(row.id)!;
}
function coherentReceipt(tx: string) {
  // Synthetic transaction IDs encode the fixture number, avoiding an unindexed
  // scan per receipt in the >10,000-record traversal test.
  const n = Number(BigInt(tx) - 100000n);
  const row = store.get(payer.toLowerCase() + ':' + hash(n));
  if (!row || row.tx_hash !== tx) return null;
  const payment = JSON.parse(row.payload) as Payment;
  const log = settlementInterface.encodeEventLog(settlementInterface.getEvent('PaymentSettled')!,
    [payment.paymentId, payment.payer, payment.payee, payment.token, payment.amount, payment.nonce]);
  return { hash: tx, blockNumber: row.block_number, status: 1, blockHash: row.block_hash,
    logs: [{ address: routerAddress, ...log }] };
}
function readService(overrides: Record<string, unknown> = {}) {
  const provider = {
    getBlockNumber: async () => 12345,
    getBlock: async (number: number | string) => ({ hash: blockHash, number: typeof number === 'number' ? number : 12345, timestamp: 1800000000 }),
    getTransactionReceipt: async (tx: string) => coherentReceipt(tx),
    ...overrides
  };
  const router = { interface: settlementInterface, connect() { return this; } };
  return new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    router, 31337, routerAddress);
}
async function withApi(action: (url: string, headers: Record<string, string>) => Promise<void>) {
  const server = makeServer({ service: readService(), apiKey: 'pagination-test-token', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await action('http://127.0.0.1:' + (server.address() as any).port,
      { Authorization: 'Bearer pagination-test-token' });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('empty keyset pages have no continuation cursor', () => {
  assert.deepEqual(store.pagePayments({}), { items: [], nextCursor: null });
  assert.deepEqual(store.pageJournals({}), { items: [], nextCursor: null });
});

test('default page size is 50 and the supported upper limit is 100', () => {
  for (let i = 1; i <= 51; i++) seed(i, 'settled');
  const payments = store.pagePayments({});
  const journals = store.pageJournals({});
  assert.equal(payments.items.length, 50);
  assert.equal(journals.items.length, 50);
  assert.ok(payments.nextCursor && journals.nextCursor);
  assert.equal(store.pagePayments({ cursor: payments.nextCursor }).items.length, 1);
  assert.equal(store.pageJournals({ cursor: journals.nextCursor }).items.length, 1);
  assert.equal(store.pagePayments({ limit: 100 }).items.length, 51);
  assert.equal(store.pageJournals({ limit: 100 }).items.length, 51);
});

test('payment pages use insertion order despite timestamp ties and freeze out later inserts', () => {
  const original = Array.from({ length: 7 }, (_, i) => seed(i + 1));
  store.db.prepare('UPDATE payments SET created_at=?').run('2026-10-25T00:00:00.000Z');
  const first = store.pagePayments({ limit: 2 });
  assert.deepEqual(first.items.map(row => row.id), [original[6].id, original[5].id]);
  assert.ok(first.nextCursor);
  const late = seed(8);
  const collected = first.items.map(row => row.id);
  let cursor: string | null = first.nextCursor;
  while (cursor) {
    const page = store.pagePayments({ limit: 2, cursor });
    collected.push(...page.items.map(row => row.id));
    cursor = page.nextCursor;
  }
  assert.deepEqual(collected, original.map(row => row.id).reverse());
  assert.equal(new Set(collected).size, 7);
  assert.ok(!collected.includes(late.id));
  assert.equal(store.pagePayments({ limit: 1 }).items[0].id, late.id);
});

test('payment cursor binds status filter and excludes other statuses', () => {
  seed(1, 'failed');
  const firstSettled = seed(2, 'settled');
  seed(3, 'queued');
  const lastSettled = seed(4, 'settled');
  const page = store.pagePayments({ limit: 1, status: 'settled' });
  assert.equal(page.items[0].id, lastSettled.id);
  assert.ok(page.nextCursor);
  assert.throws(() => store.pagePayments({ cursor: page.nextCursor!, status: 'queued' }));
  assert.throws(() => store.pagePayments({ cursor: page.nextCursor! }));
  const next = store.pagePayments({ limit: 1, cursor: page.nextCursor!, status: 'settled' });
  assert.deepEqual(next.items.map(row => row.id), [firstSettled.id]);
  assert.equal(next.nextCursor, null);
});

test('journal pages are insertion ordered and do not grow while being traversed', () => {
  const rows = [seed(1, 'settled'), seed(2, 'settled'), seed(3, 'settled'), seed(4, 'settled')];
  // Journal ordering must not depend on block-number uniqueness or wall time.
  store.db.prepare('UPDATE journals SET block_number=10').run();
  const page = store.pageJournals({ limit: 2 });
  assert.deepEqual(page.items.map(row => row.payment_id), [rows[3].id, rows[2].id]);
  seed(5, 'settled');
  const next = store.pageJournals({ limit: 2, cursor: page.nextCursor! });
  assert.deepEqual(next.items.map(row => row.payment_id), [rows[1].id, rows[0].id]);
  assert.equal(next.nextCursor, null);
  assert.throws(() => store.pagePayments({ cursor: page.nextCursor! }));
});

test('malformed cursors and out-of-range or fractional limits reject instead of silently changing a page', () => {
  seed(1, 'settled'); seed(2, 'settled');
  const malformed = ['', '*not-base64*', 'a'.repeat(4096),
    Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ version: 999, kind: 'payments', last: 1, upper: 2 })).toString('base64url')];
  for (const cursor of malformed) {
    assert.throws(() => store.pagePayments({ cursor }), 'payment cursor must reject ' + cursor.slice(0, 20));
    assert.throws(() => store.pageJournals({ cursor }), 'journal cursor must reject ' + cursor.slice(0, 20));
  }
  for (const limit of [0, -1, 101, 1.5, Infinity, NaN]) {
    assert.throws(() => store.pagePayments({ limit }));
    assert.throws(() => store.pageJournals({ limit }));
  }
});

test('authenticated page APIs sanitize signed material and enforce cursor and query boundaries', async () => {
  seed(1, 'settled'); seed(2, 'settled'); seed(3, 'queued');
  await withApi(async (url, headers) => {
    for (const route of ['/api/payments', '/api/journals', '/api/totals'])
      assert.equal((await fetch(url + route)).status, 401);
    const response = await fetch(url + '/api/payments?limit=1&status=settled', { headers });
    assert.equal(response.status, 200);
    const first = await response.json() as any;
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].status, 'settled');
    assert.ok(first.items[0].payment.paymentId);
    for (const hidden of ['signature', 'raw_tx', 'fingerprint', 'payload'])
      assert.ok(!(hidden in first.items[0]), hidden + ' must remain private');
    assert.ok(!JSON.stringify(first).includes('private-'));
    const next = await fetch(url + '/api/payments?limit=1&status=settled&cursor=' + encodeURIComponent(first.nextCursor), { headers });
    assert.equal(next.status, 200);
    const second = await next.json() as any;
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0].id, first.items[0].id);
    assert.equal(second.nextCursor, null);
    const invalidRoutes = [
      '/api/payments?limit=0', '/api/payments?limit=101', '/api/payments?limit=1.5',
      '/api/payments?limit=not-a-number', '/api/payments?limit=',
      '/api/payments?cursor=*invalid*', '/api/payments?cursor=',
      '/api/payments?status=unknown',
      '/api/payments?status=queued&cursor=' + encodeURIComponent(first.nextCursor),
      '/api/journals?cursor=' + encodeURIComponent(first.nextCursor),
      '/api/journals?limit=-2', '/api/journals?cursor=*invalid*'
    ];
    for (const route of invalidRoutes)
      assert.equal((await fetch(url + route, { headers })).status, 400, route);
    const journal = await fetch(url + '/api/journals?limit=1', { headers });
    assert.equal(journal.status, 200);
    const journalPage = await journal.json() as any;
    assert.equal(journalPage.items.length, 1);
    assert.ok(journalPage.nextCursor);
    assert.ok(!JSON.stringify(journalPage).includes('private-'));
  });
});

test('asset totals preserve uint256-scale integer amounts and separate reviewed settlements', async () => {
  const max = 2n ** 256n - 1n;
  seed(1, 'settled', max.toString(), tokenA);
  seed(2, 'settled', '17', tokenA.toLowerCase());
  seed(3, 'review', (max - 2n).toString(), tokenA.toUpperCase().replace('0X', '0x'));
  seed(4, 'settled', (2n ** 130n).toString(), tokenB);
  seed(5, 'queued', '999', tokenB);
  seed(6, 'failed', '999', tokenB);
  await withApi(async (url, headers) => {
    const response = await fetch(url + '/api/totals', { headers });
    assert.equal(response.status, 200);
    const totals = await response.json() as any;
    assert.equal(totals.assets.length, 2);
    const a = totals.assets.find((asset: any) => asset.token === tokenA.toLowerCase());
    const b = totals.assets.find((asset: any) => asset.token === tokenB.toLowerCase());
    assert.deepEqual(a, { token: tokenA.toLowerCase(), settledPayments: 2,
      settledBaseUnits: (max + 17n).toString(), reviewPayments: 1, reviewBaseUnits: (max - 2n).toString() });
    assert.deepEqual(b, { token: tokenB.toLowerCase(), settledPayments: 1,
      settledBaseUnits: (2n ** 130n).toString(), reviewPayments: 0, reviewBaseUnits: '0' });
  });
});

test('overview bounds payment and journal previews to the latest 100 rows', async () => {
  for (let i = 1; i <= 105; i++) seed(i, 'settled');
  await withApi(async (url, headers) => {
    const response = await fetch(url + '/api/overview', { headers });
    assert.equal(response.status, 200);
    const overview = await response.json() as any;
    assert.equal(overview.payments.length, 100);
    assert.equal(overview.journals.length, 100);
    assert.ok(!JSON.stringify(overview).includes('private-'));
  });
});

test('reconciliation reaches old settlements beyond the previous 10000-record cutoff', async () => {
  let oldest = '';
  for (let i = 1; i <= 10005; i++) {
    const row = seed(i, 'settled');
    if (i === 1) oldest = row.id;
  }
  let checked = 0;
  const service = readService({
    getTransactionReceipt: async (tx: string) => {
      checked++;
      return tx === hash(100001) ? null : coherentReceipt(tx);
    }
  });
  const result = await service.reconcile();
  assert.equal(result.checked, 10005);
  assert.equal(checked, 10005);
  assert.deepEqual(result.exceptions, [oldest]);
  assert.equal(store.get(oldest)!.status, 'review');
});

test('reconciliation freezes its upper rowid while new settled records arrive', async () => {
  for (let i = 1; i <= 105; i++) seed(i, 'settled');
  let inserted = false;
  let reads = 0;
  const service = readService({
    getTransactionReceipt: async (tx: string) => {
      reads++;
      if (!inserted) { inserted = true; seed(106, 'settled'); }
      return coherentReceipt(tx);
    }
  });
  const result = await service.reconcile();
  assert.equal(result.checked, 105);
  assert.equal(reads, 105);
  assert.deepEqual(result.exceptions, []);
  assert.equal(JSON.parse(store.pagePayments({ limit: 1 }).items[0].payload).paymentId, hash(106));
});
