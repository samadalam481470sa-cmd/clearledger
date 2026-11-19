import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

// Native HTTP and SQLite with synthetic service controls; no EVM execution or
// browser interaction is claimed by these request-body tests.
const apiKey = 'json-body-test-' + 'a'.repeat(32), marker = 'BODY_SIGNATURE_SENTINEL';
const fixed = { error: 'Invalid JSON request body' };
const routes = ['/api/payments', '/api/demo/payment'] as const;

async function within<T>(pending: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
async function withHttp(run: (context: {
  request(path: string, raw: string, headers?: Record<string, string>): Promise<{ status: number; text: string; body: any }>;
  history(): Promise<unknown>;
  digest(): string;
  calls: { accept: number; demo: number; rpc: number };
  fail(error?: Error): void;
}) => Promise<void>) {
  const store = new Store(), calls = { accept: 0, demo: 0, rpc: 0 };
  const row = store.accept({ paymentId: '0x' + 'ab'.repeat(32), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000',
    nonce: '0', deadline: '2000000000' }, marker + '_fingerprint', marker + '_signature').row;
  store.broadcast(row.id, marker + '_raw', '0x' + '44'.repeat(32));
  store.finalize(row.id, 17, '0x' + '55'.repeat(32));
  const provider = { getBlockNumber: async () => { calls.rpc++; return 17; } };
  const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet,
    { connect() { return this; } }, 31337, '0x' + '66'.repeat(20));
  let failure: Error | undefined;
  const accept = service.accept.bind(service);
  service.accept = async value => { calls.accept++; if (failure) throw failure; return accept(value); };
  const server = makeServer({ service, apiKey, port: 0, mode: 'demo', demoPayment: async () => {
    calls.demo++; if (failure) throw failure;
    return { payment: service.publicRow(store.get(row.id)!) };
  } });
  server.listen(0, '127.0.0.1');
  try {
    await within(once(server, 'listening'), 'HTTP readiness');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    function digest() {
      const queries = ['SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
        'SELECT rowid,* FROM payments ORDER BY rowid', 'SELECT rowid,* FROM journals ORDER BY rowid',
        'SELECT * FROM audit ORDER BY sequence', 'SELECT * FROM sqlite_sequence ORDER BY name',
        'SELECT total_changes() AS changes'];
      return createHash('sha256').update(JSON.stringify(queries.map(sql => store.db.prepare(sql).all()))).digest('hex');
    }
    await run({ calls, digest, fail(error) { failure = error; },
      request: async (path, raw, headers = {}) => {
        const response = await fetch(origin + path, { method: 'POST', signal: AbortSignal.timeout(3000),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey, ...headers }, body: raw });
        const text = await response.text();
        return { status: response.status, text, body: JSON.parse(text) };
      },
      history: async () => {
        const response = await fetch(origin + '/api/payments', { signal: AbortSignal.timeout(3000),
          headers: { Authorization: 'Bearer ' + apiKey } });
        assert.equal(response.status, 200);
        return response.json();
      }
    });
  } finally {
    await within(server.drainRequests(), 'HTTP drain'); server.closeAllConnections();
    if (server.listening) await within(new Promise<void>(resolve => server.close(() => resolve())), 'HTTP close');
    store.close();
  }
}

const malformed = [
  { name: 'bare token', raw: marker },
  { name: 'unquoted signature value', raw: '{"signature":' + marker + '}' },
  { name: 'invalid Unicode escape', raw: '{"signature":"\\uZZZZ' + marker + '"}' },
  { name: 'empty body', raw: '' },
  { name: 'truncated object', raw: '{"signature":"' + marker + '"' },
  { name: 'multibyte string with trailing comma', raw: '{"signature":"' + marker + '_λ🙂",}' }
];
for (const route of routes) for (const input of malformed) {
  const name = route === '/api/payments' && input.name === 'bare token'
    ? 'invalid JSON payment text receives a fixed diagnostic without echoing submitted bytes'
    : input.name + ' on ' + route + ' receives a fixed 400 without invoking a mutation';
  test(name, { timeout: 5000 }, async () => {
    await withHttp(async context => {
      const before = context.digest(), history = await context.history();
      const response = await context.request(route, input.raw);
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, fixed);
      assert.ok(!response.text.includes(marker));
      assert.deepEqual(await context.history(), history, 'A subsequent authenticated history read stays healthy');
      assert.deepEqual(context.calls, { accept: 0, demo: 0, rpc: 0 });
      assert.equal(context.digest(), before);
    });
  });
}

for (const route of routes) {
  test('authentication and origin checks precede JSON parsing on ' + route, { timeout: 5000 }, async () => {
    await withHttp(async context => {
      const before = context.digest();
      const denied = await context.request(route, marker, { Authorization: 'Bearer incorrect-token' });
      assert.equal(denied.status, 401); assert.deepEqual(denied.body, { error: 'Bearer token required' });
      const foreign = await context.request(route, marker, { Origin: 'http://json-body.invalid' });
      assert.equal(foreign.status, 403); assert.deepEqual(foreign.body, { error: 'Cross-origin request rejected' });
      const allowed = await context.request(route, marker);
      assert.equal(allowed.status, 400); assert.deepEqual(allowed.body, fixed);
      assert.deepEqual(context.calls, { accept: 0, demo: 0, rpc: 0 });
      assert.equal(context.digest(), before);
    });
  });

  test('the 32 KiB byte cap stays distinct from JSON parsing on ' + route, { timeout: 5000 }, async () => {
    await withHttp(async context => {
      const before = context.digest(), tooLarge = JSON.stringify({ padding: 'π'.repeat(16384) });
      assert.ok(tooLarge.length < 32768 && Buffer.byteLength(tooLarge) > 32768);
      const oversized = await context.request(route, tooLarge);
      assert.equal(oversized.status, 422);
      assert.deepEqual(oversized.body, { error: 'Request body exceeds 32 KiB' });
      assert.deepEqual(context.calls, { accept: 0, demo: 0, rpc: 0 });
      const boundary = ' '.repeat(32766) + '{}';
      assert.equal(Buffer.byteLength(boundary), 32768);
      const parsed = await context.request(route, boundary);
      if (route === '/api/payments') {
        assert.equal(parsed.status, 400); assert.deepEqual(parsed.body, { error: 'Invalid payment payload' });
        assert.deepEqual(context.calls, { accept: 1, demo: 0, rpc: 0 });
      } else {
        assert.equal(parsed.status, 422);
        assert.deepEqual(parsed.body, { error: 'Enter a decimal amount with at most six decimal places' });
        assert.deepEqual(context.calls, { accept: 0, demo: 0, rpc: 0 });
      }
      await context.history(); assert.equal(context.digest(), before);
    });
  });

  test('valid JSON preserves downstream SyntaxError and validation on ' + route, { timeout: 5000 }, async () => {
    await withHttp(async context => {
      const before = context.digest(), demo = route === '/api/demo/payment';
      context.fail(new SyntaxError('Controlled downstream JSON failure'));
      const failure = await context.request(route, demo ? '{"amount":"1.25"}' : '{}');
      assert.equal(failure.status, 400);
      assert.deepEqual(failure.body, { error: 'Controlled downstream JSON failure' });
      assert.deepEqual(context.calls, { accept: demo ? 0 : 1, demo: demo ? 1 : 0, rpc: 0 });
      context.fail();
      const invalid = await context.request(route, demo ? '{"amount":"invalid"}' : '{}');
      assert.equal(invalid.status, demo ? 422 : 400);
      assert.deepEqual(invalid.body, { error: demo ? 'Enter a decimal amount with at most six decimal places' : 'Invalid payment payload' });
      if (demo) {
        const healthy = await context.request(route, '{"amount":"1.25"}');
        assert.equal(healthy.status, 202);
        assert.equal(typeof healthy.body.payment.id, 'string');
      }
      assert.deepEqual(context.calls, { accept: demo ? 0 : 2, demo: demo ? 2 : 0, rpc: 0 });
      await context.history(); assert.equal(context.digest(), before);
    });
  });
}
