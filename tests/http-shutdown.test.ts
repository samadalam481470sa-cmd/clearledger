import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { makeServer } from '../src/http.ts';
import { Store } from '../src/store.ts';
import { createShutdown } from '../src/lifecycle.ts';
import { type PaymentService } from '../src/service.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('HTTP shutdown checkpoint timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

test('HTTP drain rejects new requests without invoking service operations and is idempotent', async () => {
  let calls = 0;
  const service = { provider: { getBlockNumber: async () => { calls++; return 1; } } } as unknown as PaymentService;
  const server = makeServer({ service, apiKey: 'shutdown-test-key', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const first = server.drainRequests();
    assert.equal(server.drainRequests(), first);
    await first;
    const response = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/healthz');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('connection'), 'close');
    assert.deepEqual(await response.json(), { error: 'Service is shutting down' });
    assert.equal(calls, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('a disconnected client does not let shutdown close SQLite beneath its paused HTTP handler', async () => {
  // Synthetic HTTP operation with a real late SQLite write, not an EVM payment.
  const store = new Store(), entered = deferred<void>(), release = deferred<void>(), socketClosed = deferred<void>();
  let lateWrite = false, resourcesClosed = false;
  const service = {
    accept: async () => {
      entered.resolve();
      await release.promise;
      store.audit('shutdown-fixture', 'late-write', 'Handler finished after its client disconnected');
      lateWrite = true;
      return { replay: false, row: { id: 'shutdown-fixture' } };
    },
    publicRow: (row: unknown) => row
  } as unknown as PaymentService;
  const server = makeServer({ service, apiKey: 'shutdown-test-key', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const controller = new AbortController();
  const client = fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/api/payments', {
    method: 'POST', signal: controller.signal,
    headers: { Authorization: 'Bearer shutdown-test-key', 'Content-Type': 'application/json' }, body: '{}'
  }).then(() => 'replied', () => 'disconnected');
  let stopped: Promise<unknown> | undefined;
  try {
    await within(entered.promise);
    const shutdown = createShutdown({
      stopWorker: async () => {},
      drainRequests: () => server.drainRequests(),
      closeServer: () => new Promise<void>((resolve, reject) => {
        server.close(error => {
          socketClosed.resolve();
          if (error) reject(error); else resolve();
        });
        server.closeIdleConnections();
      }),
      closeResources: () => {
        assert.equal(lateWrite, true, 'Handler must finish before SQLite closes');
        store.close(); resourcesClosed = true;
      },
      timeoutMs: 3000
    });
    stopped = shutdown();
    controller.abort();
    assert.equal(await within(client), 'disconnected');
    await within(socketClosed.promise);
    assert.equal(resourcesClosed, false, 'Socket drain alone cannot authorize closing SQLite');
    release.resolve();
    assert.equal(await within(stopped), 'closed');
    assert.equal(lateWrite, true);
    assert.equal(resourcesClosed, true);
    assert.equal(await shutdown(), 'closed');
  } finally {
    controller.abort(); release.resolve();
    await server.drainRequests();
    if (stopped) await stopped;
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (!resourcesClosed) store.close();
  }
});
