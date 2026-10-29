import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../src/http.ts';
import { submissionSchema } from '../src/payment.ts';
import { Conflict } from '../src/store.ts';
import { type PaymentService } from '../src/service.ts';

// Synthetic service failures exercise the real HTTP boundary; no EVM execution
// or real credentials are involved in this classification/redaction matrix.
const apiKey = 'http-rpc-error-test-' + 'a'.repeat(32);
const unavailable = { error: 'Upstream RPC unavailable; check payment history before retrying' };
const markers = ['INTERNAL_RPC_CREDENTIAL_SENTINEL', 'RAW_TRANSACTION_SENTINEL', 'RPC_INFO_SENTINEL'];
const storageFailure = { error: 'Storage operation failed; check payment history before retrying' };
const storageMarkers = ['PRIVATE_SQLITE_PATH_SENTINEL', 'PRIVATE_SQLITE_STATEMENT_SENTINEL', 'PRIVATE_SQLITE_BINDING_SENTINEL'];
type Thrower = () => never;

function serviceFixture(throwFailure: Thrower) {
  let calls = 0;
  const invoke = () => { calls++; return throwFailure(); };
  const service = {
    provider: { getBlockNumber: async () => invoke(), getBlock: async () => invoke() },
    accept: async () => invoke(), reconcile: async () => invoke(),
    publicRow: (row: unknown) => row
  } as unknown as PaymentService;
  return { service, invoke, calls: () => calls };
}

async function withHttp(service: PaymentService,
  run: (url: string) => Promise<void>, demoPayment?: (amount: string) => Promise<unknown>) {
  const server = makeServer({ service, apiKey, port: 0, mode: demoPayment ? 'demo' : 'rpc', demoPayment });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    await run('http://127.0.0.1:' + (server.address() as { port: number }).port);
  } finally {
    await server.drainRequests();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  }
}
async function request(url: string, path: string, body?: unknown, authenticated = true, raw?: string) {
  const response = await fetch(url + path, {
    method: body === undefined && raw === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(3000),
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + apiKey } : {}) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body))
  });
  return { status: response.status, text: await response.text() };
}

const routes = [
  { name: 'health', path: '/healthz' },
  { name: 'overview', path: '/api/overview' },
  { name: 'payment submission', path: '/api/payments', body: {} },
  { name: 'reconciliation', path: '/api/reconcile', body: {} },
  { name: 'demo payment', path: '/api/demo/payment', body: { amount: '1.25' }, demo: true }
];
for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR']) for (const route of routes) {
  test(code + ' on ' + route.name + ' returns a redacted 503 without retrying', { timeout: 5000 }, async () => {
    const error = Object.assign(new Error(markers[0]), {
      code, shortMessage: markers[1], info: { payload: markers[2], url: 'https://test-user:synthetic-secret@rpc.invalid' }
    });
    const fixture = serviceFixture(() => { throw error; });
    await withHttp(fixture.service, async url => {
      const result = await request(url, route.path, route.body);
      assert.equal(result.status, 503);
      assert.deepEqual(JSON.parse(result.text), unavailable);
      for (const marker of [...markers, 'synthetic-secret', 'rpc.invalid', code])
        assert.ok(!result.text.includes(marker), 'Response exposed synthetic internal RPC details');
      assert.equal(fixture.calls(), 1, 'HTTP must not retry an operation with an uncertain outcome');
    }, route.demo ? async () => fixture.invoke() : undefined);
  });
}

for (const route of routes) {
  test('ERR_SQLITE_ERROR on ' + route.name + ' returns a fixed redacted 500 without retrying', { timeout: 5000 }, async () => {
    const code = 'ERR_SQLITE_ERROR';
    const error = Object.assign(new Error(storageMarkers[0]), {
      code, shortMessage: storageMarkers[1], info: { statement: storageMarkers[2],
        authorization: 'PRIVATE_STORED_AUTHORIZATION_SENTINEL' }
    });
    const fixture = serviceFixture(() => { throw error; });
    await withHttp(fixture.service, async url => {
      const result = await request(url, route.path, route.body);
      assert.equal(result.status, 500);
      assert.deepEqual(JSON.parse(result.text), storageFailure);
      for (const marker of [...storageMarkers, 'PRIVATE_STORED_AUTHORIZATION_SENTINEL', code])
        assert.ok(!result.text.includes(marker), 'Response exposed synthetic private storage details');
      assert.equal(fixture.calls(), 1, 'HTTP must not retry a storage operation with an uncertain outcome');
    }, route.demo ? async () => fixture.invoke() : undefined);
  });
}

test('malformed JSON retains 400 and never invokes the payment service', { timeout: 5000 }, async () => {
  const fixture = serviceFixture(() => { throw new Error('Unexpected service invocation'); });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments', undefined, true, '{');
    assert.equal(result.status, 400);
    assert.notDeepEqual(JSON.parse(result.text), unavailable);
    assert.equal(fixture.calls(), 0);
  });
});

test('payment schema validation retains its generic 400 response', { timeout: 5000 }, async () => {
  let calls = 0;
  const service = { accept: async (body: unknown) => { calls++; submissionSchema.parse(body); } } as unknown as PaymentService;
  await withHttp(service, async url => {
    const result = await request(url, '/api/payments', {});
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.text), { error: 'Invalid payment payload' });
    assert.equal(calls, 1);
  });
});

test('invalid pagination remains 400 before accessing service storage', { timeout: 5000 }, async () => {
  const fixture = serviceFixture(() => { throw new Error('Unexpected service invocation'); });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments?limit=0');
    assert.equal(result.status, 400);
    assert.deepEqual(JSON.parse(result.text), { error: 'Invalid payment payload' });
    assert.equal(fixture.calls(), 0);
  });
});

test('a conflicting instruction retains 409 and its deterministic explanation', { timeout: 5000 }, async () => {
  const fixture = serviceFixture(() => { throw new Conflict('Payment ID already has different instructions'); });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments', {});
    assert.equal(result.status, 409);
    assert.deepEqual(JSON.parse(result.text), { error: 'Payment ID already has different instructions' });
    assert.equal(fixture.calls(), 1);
  });
});

test('a deterministic signature rejection retains 422', { timeout: 5000 }, async () => {
  const fixture = serviceFixture(() => { throw new Error('Signature does not authorize this payment'); });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments', {});
    assert.equal(result.status, 422);
    assert.deepEqual(JSON.parse(result.text), { error: 'Signature does not authorize this payment' });
    assert.equal(fixture.calls(), 1);
  });
});

test('CALL_EXCEPTION remains 422 even when nested RPC information contains a timeout code', { timeout: 5000 }, async () => {
  const error = Object.assign(new Error('Contract rejected the instruction'), {
    code: 'CALL_EXCEPTION', shortMessage: 'execution reverted: PolicyLimit', data: '0x12345678',
    info: { error: { code: 'TIMEOUT' } }
  });
  const fixture = serviceFixture(() => { throw error; });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments', {});
    assert.equal(result.status, 422);
    assert.deepEqual(JSON.parse(result.text), { error: 'execution reverted: PolicyLimit' });
    assert.equal(fixture.calls(), 1);
  });
});

test('authentication rejection precedes upstream service errors', { timeout: 5000 }, async () => {
  const fixture = serviceFixture(() => { throw Object.assign(new Error(markers[0]), { code: 'TIMEOUT' }); });
  await withHttp(fixture.service, async url => {
    const result = await request(url, '/api/payments', {}, false);
    assert.equal(result.status, 401);
    assert.deepEqual(JSON.parse(result.text), { error: 'Bearer token required' });
    assert.equal(fixture.calls(), 0);
  });
});
