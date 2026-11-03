import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, createShutdown, type ShutdownResult } from '../src/lifecycle.ts';
import { Store } from '../src/store.ts';

// Native timers and a real SQLite audit write isolate synchronous reentry into
// lifecycle helpers. These are not process-signal, CLI or EVM integration tests.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Worker reentrancy checkpoint timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('a later tick synchronously stopping its worker waits for that exact gated tick', { timeout: 5000 }, async t => {
  const gate = deferred(), entered = deferred();
  let calls = 0, errors = 0, completed = false, stopped = false;
  let actualTick: Promise<void> | undefined, firstStop: Promise<void> | undefined, secondStop: Promise<void> | undefined;
  const worker = startWorker(() => {
    calls++;
    if (calls === 1) return Promise.resolve();
    if (calls !== 2) return Promise.reject(new Error('An extra tick started after synchronous stop'));
    // These calls happen before this tick returns its pending promise to launch.
    firstStop = worker.stop(); secondStop = worker.stop();
    void firstStop.then(() => { stopped = true; });
    actualTick = gate.promise.then(() => { completed = true; });
    entered.resolve();
    return actualTick;
  }, { intervalMs: 1, onError: () => { errors++; } });
  try {
    assert.equal(calls, 1, 'The first tick must still run synchronously at startup');
    await within(entered.promise); await turn();
    t.diagnostic(JSON.stringify({ phase: 'before-release', calls, stopResolved: stopped, tickCompleted: completed, errors }));
    assert.equal(firstStop, secondStop); assert.equal(firstStop, worker.stop());
    assert.equal(completed, false); assert.equal(stopped, false, 'Stop resolved using a previous tick instead of the gated active tick');
    gate.resolve();
    await within(actualTick!); await within(firstStop!);
    assert.equal(completed, true); assert.equal(stopped, true);
    await sleep(10);
    assert.equal(calls, 2); assert.equal(errors, 0); assert.equal(worker.stop(), firstStop);
  } finally {
    // The buggy stop promise is insufficient cleanup evidence: release and
    // await the actual tick independently before stopping or leaving the test.
    gate.resolve();
    if (actualTick) await within(Promise.allSettled([actualTick]));
    await within(worker.stop()); await turn();
  }
});

test('shutdown reentered by a later tick keeps SQLite open through its post-gate audit write', { timeout: 5000 }, async t => {
  const store = new Store(), gate = deferred(), entered = deferred();
  const order: string[] = [];
  let calls = 0, errors = 0, closes = 0, resourceClosed = false, completed = false;
  let drainCalls = 0, listenerCalls = 0, auditsAtClose = -1;
  let actualTick: Promise<void> | undefined, closing: Promise<ShutdownResult> | undefined;
  let result: ShutdownResult | undefined, shutdown!: () => Promise<ShutdownResult>;
  const worker = startWorker(() => {
    calls++;
    if (calls === 1) return Promise.resolve();
    if (calls !== 2) return Promise.reject(new Error('An extra tick started during reentrant shutdown'));
    closing = shutdown();
    assert.equal(closing, shutdown(), 'Reentrant shutdown calls must share one result promise');
    void closing.then(value => { result = value; });
    actualTick = gate.promise.then(() => {
      order.push('audit-write');
      store.audit('synthetic-worker', 'late-tick-write', 'Controlled post-gate audit');
      completed = true; order.push('tick-complete');
    });
    entered.resolve();
    return actualTick;
  }, { intervalMs: 1, onError: () => { errors++; } });
  shutdown = createShutdown({
    stopWorker: () => worker.stop(),
    drainRequests: async () => { drainCalls++; },
    closeServer: async () => { listenerCalls++; },
    closeResources: () => {
      closes++; order.push('resource-close'); auditsAtClose = store.events().length;
      store.close(); resourceClosed = true;
    }, timeoutMs: 3000
  });
  try {
    assert.equal(calls, 1, 'The initial tick must run immediately');
    await within(entered.promise); await turn();
    t.diagnostic(JSON.stringify({ phase: 'before-release', calls, shutdownResult: result ?? null,
      storeOpen: store.db.isOpen, resourceClosed, closes, tickCompleted: completed, errors }));
    assert.equal(result, undefined); assert.equal(closes, 0);
    assert.equal(store.db.isOpen, true); assert.equal(resourceClosed, false); assert.equal(completed, false);
    assert.equal(store.events().length, 0); assert.equal(drainCalls, 1); assert.equal(listenerCalls, 1);
    assert.equal(closing, shutdown());
    gate.resolve();
    await within(actualTick!);
    assert.equal(await within(closing!), 'closed');
    await turn(); await sleep(10);
    assert.equal(completed, true); assert.equal(errors, 0);
    assert.deepEqual(order, ['audit-write', 'tick-complete', 'resource-close']);
    assert.equal(auditsAtClose, 1); assert.equal(closes, 1); assert.equal(store.db.isOpen, false);
    assert.equal(resourceClosed, true); assert.equal(calls, 2);
    assert.equal(await shutdown(), 'closed'); assert.equal(closes, 1);
  } finally {
    gate.resolve();
    let tickRejected = false, tickFailureCode: unknown = null;
    if (actualTick) {
      const settled = await within(Promise.allSettled([actualTick]));
      tickRejected = settled[0].status === 'rejected';
      if (settled[0].status === 'rejected') tickFailureCode = (settled[0].reason as { code?: unknown })?.code ?? null;
    }
    await within(worker.stop());
    await within(shutdown()); await turn();
    t.diagnostic(JSON.stringify({ phase: 'cleanup', calls, closes, auditsAtClose,
      tickCompleted: completed, tickRejected, tickFailureCode, errors, storeOpen: store.db.isOpen }));
    if (store.db.isOpen) store.close();
  }
});
