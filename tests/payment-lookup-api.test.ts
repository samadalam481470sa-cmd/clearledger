import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { id, type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { paymentSchema, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store, type RecordRow, type Status } from '../src/store.ts';

// Actual authenticated HTTP and native SQLite with synthetic lifecycle records.
// No worker, EVM transfer, signature authentication or RPC availability is proved.
const apiKey = 'payment-lookup-test-' + 'a'.repeat(32), privateMarker = 'PAYMENT_LOOKUP_PRIVATE_SENTINEL';
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const integrityError = 'Stored payment data is invalid; verify the original authorization';
const invalidId = { error: 'Invalid payment identifier' }, invalidQuery = { error: 'Payment lookup does not accept query parameters' };
const publicFields = ['id', 'status', 'tx_hash', 'block_number', 'block_hash', 'error', 'created_at', 'updated_at'] as const;
let store: Store, server: ReturnType<typeof makeServer>, url: string, rpcCalls: number, lookups: string[];

async function bounded<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
function payment(n: number): Payment {
  return paymentSchema.parse({ paymentId: id('lookup-payment-' + n), payer: '0x' + 'ab'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: '0x' + 'cd'.repeat(20), amount: '125000000',
    nonce: String(n - 1), deadline: '2000000000' });
}
function seed(n: number, status: Status = 'queued') {
  const row = store.accept(payment(n), privateMarker + '_fingerprint_' + n, privateMarker + '_signature_' + n).row;
  if (status === 'broadcast' || status === 'settled' || status === 'review') {
    store.broadcast(row.id, privateMarker + '_raw_' + n, id('lookup-native-' + n));
    if (status !== 'broadcast') store.finalize(row.id, n, blockHash);
  }
  if (status === 'failed' || status === 'review') store.setStatus(row.id, status, 'Controlled public lifecycle diagnostic');
  store.db.prepare('UPDATE payments SET private_note=? WHERE id=?').run(privateMarker + '_unknown_column_' + n, row.id);
  return row.id;
}
function snapshot() {
  const sql = { schema: 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
    payments: 'SELECT rowid,* FROM payments ORDER BY rowid', journals: 'SELECT rowid,* FROM journals ORDER BY rowid',
    audit: 'SELECT * FROM audit ORDER BY sequence', sequence: 'SELECT * FROM sqlite_sequence ORDER BY name',
    changes: 'SELECT total_changes() AS changes' };
  const captured = Object.fromEntries(Object.entries(sql).map(([name, query]) => [name, store.db.prepare(query).all()]));
  // Assert only this digest, never private rows or payloads in failure output.
  return createHash('sha256').update(JSON.stringify(captured)).digest('hex');
}
async function read(path: string, authenticated = true) {
  const before = snapshot(), firstLookup = lookups.length;
  const response = await fetch(url + path, { signal: AbortSignal.timeout(2000),
    headers: authenticated ? { Authorization: 'Bearer ' + apiKey } : {} });
  const text = await response.text();
  assert.ok(!text.includes(privateMarker), 'A lookup response exposed private persisted evidence');
  assert.equal(snapshot(), before, 'A read changed private records/schema/audit/sequence/total_changes');
  assert.equal(rpcCalls, 0, 'Local history must not call an unavailable upstream');
  return { status: response.status, body: JSON.parse(text) as any, localLookups: lookups.slice(firstLookup) };
}
function metadata(row: RecordRow) { return Object.fromEntries(publicFields.map(field => [field, row[field]])); }
beforeEach(async () => {
  store = new Store(); rpcCalls = 0; lookups = [];
  store.db.exec('ALTER TABLE payments ADD COLUMN private_note TEXT');
  const get = store.get.bind(store);
  store.get = key => { lookups.push(key); return get(key); };
  const unavailable = async () => { rpcCalls++; throw new Error('Controlled RPC unavailable'); };
  const provider = { getBlock: unavailable, getBlockNumber: unavailable, getTransactionReceipt: unavailable, getNetwork: unavailable };
  const router = { connect() { return this; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet, router, 31337, routerAddress);
  server = makeServer({ service, apiKey, mode: 'rpc', port: 0 });
  server.listen(0, '127.0.0.1'); await bounded(once(server, 'listening'), 'Lookup server readiness');
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
});
afterEach(async () => {
  const failures: unknown[] = [];
  async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
  if (server) {
    await cleanup(() => bounded(server.drainRequests(), 'Lookup handler drain'));
    await cleanup(() => server.closeAllConnections());
    if (server.listening) await cleanup(() => bounded(new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    }), 'Lookup listener close'));
  }
  await cleanup(() => { if (store?.db.isOpen) store.close(); });
  if (failures.length) throw new AggregateError(failures, 'Payment lookup HTTP cleanup failed');
});

test('local lookup returns the same sanitized public item for all five lifecycle statuses', { timeout: 5000 }, async t => {
  const keys = (['queued', 'broadcast', 'settled', 'failed', 'review'] as const).map((status, index) => seed(index + 1, status));
  const page = await read('/api/payments?limit=100'); assert.equal(page.status, 200);
  assert.deepEqual(page.localLookups, []);
  for (const key of keys) {
    const result = await read('/api/payments/' + key);
    if (result.status !== 200) t.diagnostic(JSON.stringify({ lookupStatus: result.status, localLookupCalls: result.localLookups.length }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.localLookups, [key]);
    assert.deepEqual(Object.keys(result.body).sort(), [...publicFields, 'payment'].sort());
    assert.deepEqual(result.body, page.body.items.find((row: { id: string }) => row.id === key));
    for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload', 'private_note'])
      assert.equal(Object.hasOwn(result.body, field), false);
  }
});

test('literal identifiers and encoded colons resolve without case folding or repeated decoding', { timeout: 5000 }, async () => {
  const key = seed(1, 'settled'), encoded = encodeURIComponent(key);
  assert.notEqual(encoded, key); assert.ok(encoded.includes('%3A'));
  const literal = await read('/api/payments/' + key), escaped = await read('/api/payments/' + encoded);
  assert.equal(literal.status, 200); assert.equal(escaped.status, 200);
  assert.deepEqual(literal.body, escaped.body); assert.deepEqual(literal.localLookups, [key]); assert.deepEqual(escaped.localLookups, [key]);
});

test('direct lookup reaches an original record outside the latest 100-record preview', { timeout: 5000 }, async () => {
  const key = seed(1, 'settled');
  for (let n = 2; n <= 105; n++) seed(n);
  assert.equal(store.list(100).some(row => row.id === key), false);
  const result = await read('/api/payments/' + key);
  assert.equal(result.status, 200); assert.equal(result.body.id, key); assert.equal(result.body.status, 'settled');
  assert.deepEqual(result.localLookups, [key]);
});

for (const mismatch of [false, true]) test('unreadable stored ' + (mismatch ? 'business identity' : 'JSON') + ' retains public metadata and nullable history', { timeout: 5000 }, async () => {
  const key = seed(1, 'review'), expected = metadata(store.get(key)!);
  const payload = mismatch ? JSON.stringify({ ...payment(1), paymentId: id('different-payment') }) : privateMarker + '_bad_json{';
  store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run(payload, key);
  const result = await read('/api/payments/' + key);
  assert.equal(result.status, 200); assert.deepEqual(result.localLookups, [key]);
  assert.deepEqual(result.body, { ...expected, payment: null, integrityError });
});

test('well-formed unknown and all-zero identifiers return a local fixed 404', { timeout: 5000 }, async () => {
  seed(1);
  const keys = ['0x' + 'ab'.repeat(20) + ':0x' + '12'.repeat(32), '0x' + '00'.repeat(20) + ':0x' + '00'.repeat(32)];
  for (const key of keys) {
    const result = await read('/api/payments/' + key);
    assert.equal(result.status, 404); assert.deepEqual(result.body, { error: 'Payment not found' });
    assert.deepEqual(result.localLookups, [key]);
  }
});

test('unauthenticated lookup is rejected before accessing Store', { timeout: 5000 }, async () => {
  const key = seed(1), result = await read('/api/payments/' + key, false);
  assert.equal(result.status, 401); assert.deepEqual(result.body, { error: 'Bearer token required' });
  assert.deepEqual(result.localLookups, []);
});

test('every lookup query is rejected before identifier decoding or Store access', { timeout: 5000 }, async () => {
  const key = seed(1);
  for (const path of ['/api/payments/' + key + '?limit=1', '/api/payments/' + key + '?unknown=',
    '/api/payments/' + key + '?x=1&x=2', '/api/payments/not-an-id?x=1', '/api/payments/%FF?x=1']) {
    const result = await read(path);
    assert.equal(result.status, 400); assert.deepEqual(result.body, invalidQuery); assert.deepEqual(result.localLookups, []);
  }
});

const malformed: [string, (key: string) => string][] = [
  ['empty identifier', () => ''], ['missing separator', key => key.replace(':', '')],
  ['uppercase payer digits', key => '0x' + key.slice(2, 42).toUpperCase() + key.slice(42)],
  ['uppercase payment ID digits', key => key.slice(0, 45) + key.slice(45).toUpperCase()],
  ['short payer', key => key.slice(0, 40) + key.slice(42)], ['short payment ID', key => key.slice(0, -2)],
  ['extra literal slash', key => key + '/extra'], ['encoded slash', key => key + '%2Fextra'],
  ['leading encoded whitespace', key => '%20' + key], ['trailing encoded whitespace', key => key + '%20'],
  ['trailing encoded newline', key => key + '%0A'], ['invalid UTF-8', () => '%E0%A4%A'],
  ['invalid percent encoding', () => '%GG'], ['double-encoded colon', key => encodeURIComponent(encodeURIComponent(key))]
];
for (const [label, invalid] of malformed) test(label + ' yields fixed 400 without a Store lookup', { timeout: 5000 }, async () => {
  const key = seed(1), result = await read('/api/payments/' + invalid(key));
  assert.equal(result.status, 400); assert.deepEqual(result.body, invalidId); assert.deepEqual(result.localLookups, []);
});
