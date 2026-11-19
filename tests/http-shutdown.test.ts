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

test('a synchronously reentrant HTTP drain waits for its own handler before closing SQLite', { timeout: 8000 }, async t => {
  // This isolates the exported HTTP drain contract with a synthetic provider
  // callback and a real SQLite write. Keeping the listener open also lets a new
  // request exercise the draining response; no CLI signal or EVM is involved.
  const store = new Store(), entered = deferred<void>(), release = deferred<void>(), finished = deferred<void>();
  const controller = new AbortController();
  const clients: Promise<{ status: number; body: unknown }>[] = [];
  let drain: Promise<void> | undefined, closeResources: Promise<void> | undefined;
  let drainIdentity = false, drained = false, resourcesClosed = false, providerEntered = false, providerFinished = false;
  let calls = 0, closeCalls = 0, lateWrite = false, auditsBeforeClose = 0;
  let auditActionBeforeClose: unknown, providerErrorCode: unknown;
  const service = { provider: { getBlockNumber: async () => {
    calls++; providerEntered = true;
    // Reentry happens before this callback's first await, while handle() is
    // still executing its synchronous prefix in the server request listener.
    drain = server.drainRequests();
    drainIdentity = server.drainRequests() === drain;
    closeResources = drain.then(() => {
      drained = true;
      const audit = store.events();
      auditsBeforeClose = audit.length;
      auditActionBeforeClose = audit[0]?.action;
      closeCalls++;
      store.close(); resourcesClosed = true;
    });
    void closeResources.catch(() => {});
    entered.resolve();
    try {
      await release.promise;
      store.audit('http-reentry-fixture', 'late-write', 'Handler finished before its resources closed');
      lateWrite = true;
      return 1;
    } catch (error) {
      providerErrorCode = (error as NodeJS.ErrnoException).code;
      throw error;
    } finally { providerFinished = true; finished.resolve(); }
  } } } as unknown as PaymentService;
  const server = makeServer({ service, apiKey: 'http-reentry-test-key', port: 0, mode: 'rpc' });
  function request() {
    const pending = (async () => {
      const response = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port + '/healthz', {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)])
      });
      return { status: response.status, body: await response.json() as unknown };
    })();
    void pending.catch(() => {});
    clients.push(pending);
    return pending;
  }
  try {
    server.listen(0, '127.0.0.1'); await within(once(server, 'listening'));
    const client = request();
    await within(entered.promise);
    const denied = await within(request());
    assert.deepEqual(denied, { status: 503, body: { error: 'Service is shutting down' } });
    assert.equal(calls, 1, 'A request arriving after reentrant drain must not enter the provider');
    assert.equal(drainIdentity, true);
    assert.equal(server.drainRequests(), drain);
    t.diagnostic(JSON.stringify({ checkpoint: 'before-release', drained, resourcesClosed, closeCalls, lateWrite }));
    assert.equal(drained, false, 'Reentrant drain must include the HTTP handler requesting it');
    assert.equal(resourcesClosed, false, 'Resources must stay open while the handler owns a pending write');
    assert.equal(closeCalls, 0); assert.equal(lateWrite, false); assert.equal(store.events().length, 0);

    release.resolve();
    const response = await within(client);
    assert.deepEqual(response, { status: 200, body: { status: 'ok', mode: 'rpc' } });
    assert.ok(closeResources); await within(closeResources);
    assert.equal(lateWrite, true); assert.equal(providerFinished, true); assert.equal(providerErrorCode, undefined);
    assert.equal(drained, true); assert.equal(resourcesClosed, true); assert.equal(closeCalls, 1);
    assert.equal(auditsBeforeClose, 1); assert.equal(auditActionBeforeClose, 'late-write');
    assert.equal(server.drainRequests(), drain); await within(server.drainRequests());
    assert.equal(closeCalls, 1, 'An idempotent drain must not close resources twice');
    t.diagnostic(JSON.stringify({ checkpoint: 'after-release', status: response.status, lateWrite,
      auditsBeforeClose, closeCalls, providerErrorCode: null }));
  } finally {
    const failures: unknown[] = [];
    async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
    release.resolve();
    // The old implementation's drain could already be resolved. Track the
    // actual provider/client separately rather than trusting that broken drain.
    if (providerEntered) await cleanup(() => within(finished.promise));
    await cleanup(() => within(Promise.allSettled(clients)));
    controller.abort();
    await cleanup(() => server.closeAllConnections());
    if (server.listening) await cleanup(() => within(new Promise<void>((resolveClose, rejectClose) =>
      server.close(error => error ? rejectClose(error) : resolveClose()))));
    if (closeResources) await cleanup(() => within(closeResources!));
    if (!resourcesClosed && (!providerEntered || providerFinished)) await cleanup(() => { store.close(); resourcesClosed = true; });
    else if (!resourcesClosed) failures.push(new Error('SQLite retained because the reentrant handler did not finish'));
    t.diagnostic(JSON.stringify({ checkpoint: 'cleanup', lateWrite, closeCalls,
      providerErrorCode: providerErrorCode === 'ERR_INVALID_STATE' ? providerErrorCode : null }));
    if (failures.length) throw new AggregateError(failures, 'Reentrant HTTP drain cleanup failed');
  }
});
