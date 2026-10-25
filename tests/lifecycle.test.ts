import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorker, createShutdown } from '../src/lifecycle.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
async function until(condition: () => boolean) {
  const end = performance.now() + 2000;
  while (!condition()) {
    if (performance.now() >= end) throw new Error('Expected lifecycle event did not occur');
    await sleep(1);
  }
}

test('worker starts immediately and never overlaps a pending tick', async () => {
  const first = deferred(), second = deferred();
  let calls = 0, running = 0, maximum = 0;
  const worker = startWorker(async () => {
    calls++; running++; maximum = Math.max(maximum, running);
    await (calls === 1 ? first.promise : second.promise);
    running--;
  }, { intervalMs: 1 });
  try {
    assert.equal(calls, 1);
    await sleep(10);
    assert.equal(calls, 1);
    first.resolve();
    await until(() => calls === 2);
    assert.equal(maximum, 1);
    const stopping = worker.stop();
    second.resolve();
    await stopping;
    await sleep(5);
    assert.equal(calls, 2);
  } finally { first.resolve(); second.resolve(); await worker.stop(); }
});

test('worker stop is idempotent and waits for the current tick before resolving', async () => {
  const pending = deferred();
  let calls = 0;
  const worker = startWorker(async () => { calls++; await pending.promise; }, { intervalMs: 1 });
  const first = worker.stop(), second = worker.stop();
  assert.equal(first, second);
  let stopped = false;
  void first.then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  pending.resolve();
  await first;
  assert.equal(stopped, true);
  await sleep(5);
  assert.equal(calls, 1);
});

test('worker retries rejected ticks and emits only the fixed error callback', async () => {
  const next = deferred();
  let calls = 0, errors = 0;
  const worker = startWorker(async () => {
    if (++calls === 1) throw new Error('A private transport diagnostic must not escape');
    await next.promise;
  }, { intervalMs: 1, onError: () => { errors++; } });
  try {
    await until(() => calls === 2);
    assert.equal(errors, 1);
    const stopping = worker.stop();
    next.resolve();
    await stopping;
    assert.equal(calls, 2);
  } finally { next.resolve(); await worker.stop(); }
});

test('a throwing error callback does not stop retries or reject shutdown', async () => {
  let calls = 0;
  const next = deferred();
  const worker = startWorker(async () => {
    if (++calls === 1) throw new Error('first tick');
    await next.promise;
  }, { intervalMs: 1, onError: () => { throw new Error('diagnostic callback'); } });
  try {
    await until(() => calls === 2);
    const stopping = worker.stop();
    next.resolve();
    await stopping;
  } finally { next.resolve(); await worker.stop(); }
});

test('stopping an idle worker cancels its scheduled next tick', async () => {
  let calls = 0;
  const worker = startWorker(async () => { calls++; }, { intervalMs: 30 });
  await flush();
  await worker.stop();
  await sleep(40);
  assert.equal(calls, 1);
});

test('all drains start immediately but resources close only after every drain completes', async () => {
  const worker = deferred(), requests = deferred(), listener = deferred();
  const started: string[] = [];
  let closes = 0;
  const shutdown = createShutdown({
    stopWorker: () => { started.push('worker'); return worker.promise; },
    drainRequests: () => { started.push('requests'); return requests.promise; },
    closeServer: () => { started.push('listener'); return listener.promise; },
    closeResources: () => { closes++; }, timeoutMs: 1000
  });
  const result = shutdown();
  assert.deepEqual(started, ['worker', 'requests', 'listener']);
  assert.equal(result, shutdown());
  requests.resolve(); listener.resolve();
  await flush();
  assert.equal(closes, 0);
  worker.resolve();
  assert.equal(await result, 'closed');
  assert.equal(await shutdown(), 'closed');
  assert.equal(closes, 1);
  assert.equal(started.length, 3);
});

test('a synchronous drain throw still starts the other drains and never closes resources', async () => {
  const requests = deferred(), listener = deferred();
  const started: string[] = [];
  let closes = 0;
  const shutdown = createShutdown({
    stopWorker: () => { started.push('worker'); throw new Error('synchronous stop failure'); },
    drainRequests: () => { started.push('requests'); return requests.promise; },
    closeServer: () => { started.push('listener'); return listener.promise; },
    closeResources: () => { closes++; }, timeoutMs: 1000
  });
  const result = shutdown();
  assert.deepEqual(started, ['worker', 'requests', 'listener']);
  assert.equal(await result, 'failed');
  requests.resolve(); listener.resolve();
  await flush();
  assert.equal(closes, 0);
  assert.equal(await shutdown(), 'failed');
});

test('a rejected drain cannot cause resource closure when the other drains finish later', async () => {
  const worker = deferred(), requests = deferred();
  let closes = 0;
  const shutdown = createShutdown({ stopWorker: () => worker.promise, drainRequests: () => requests.promise,
    closeServer: async () => {}, closeResources: () => { closes++; }, timeoutMs: 1000 });
  const result = shutdown();
  worker.reject(new Error('Stop failed'));
  assert.equal(await result, 'failed');
  requests.resolve();
  await flush();
  assert.equal(closes, 0);
});

test('timeout leaves resources open and permanently ignores late successful drains', async () => {
  const worker = deferred();
  let closes = 0, drains = 0;
  const shutdown = createShutdown({
    stopWorker: () => { drains++; return worker.promise; },
    drainRequests: async () => { drains++; }, closeServer: async () => { drains++; },
    closeResources: () => { closes++; }, timeoutMs: 10
  });
  const result = shutdown();
  assert.equal(await result, 'timeout');
  worker.resolve();
  await flush();
  assert.equal(closes, 0);
  assert.equal(result, shutdown());
  assert.equal(drains, 3);
});

test('late drain rejection after timeout is handled without reopening shutdown', async () => {
  const worker = deferred();
  let closes = 0;
  const shutdown = createShutdown({ stopWorker: () => worker.promise, drainRequests: async () => {},
    closeServer: async () => {}, closeResources: () => { closes++; }, timeoutMs: 10 });
  assert.equal(await shutdown(), 'timeout');
  worker.reject(new Error('Late rejection'));
  await flush();
  assert.equal(await shutdown(), 'timeout');
  assert.equal(closes, 0);
});

test('resource-close rejection and synchronous throws become failed results', async () => {
  for (const closeResources of [() => { throw new Error('sync close'); }, async () => { throw new Error('async close'); }]) {
    let closes = 0;
    const shutdown = createShutdown({ stopWorker: async () => {}, drainRequests: async () => {}, closeServer: async () => {},
      closeResources: () => { closes++; return closeResources(); }, timeoutMs: 1000 });
    assert.equal(await shutdown(), 'failed');
    assert.equal(await shutdown(), 'failed');
    assert.equal(closes, 1);
  }
});

test('the overall timeout also bounds an already-started resource close', async () => {
  const closing = deferred();
  let closes = 0;
  const shutdown = createShutdown({ stopWorker: async () => {}, drainRequests: async () => {}, closeServer: async () => {},
    closeResources: () => { closes++; return closing.promise; }, timeoutMs: 10 });
  assert.equal(await shutdown(), 'timeout');
  assert.equal(closes, 1);
  closing.resolve();
  await flush();
  assert.equal(await shutdown(), 'timeout');
  assert.equal(closes, 1);
});

test('synchronous resource cleanup cannot report success after blocking past the shared deadline', async () => {
  const shutdown = createShutdown({ stopWorker: async () => {}, drainRequests: async () => {}, closeServer: async () => {},
    closeResources: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }, timeoutMs: 10 });
  assert.equal(await shutdown(), 'timeout');
});

test('worker intervals and shutdown deadlines reject invalid timings before starting work', () => {
  for (const timing of [0, -1, 0.5, NaN, Infinity, 2 ** 31, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    let calls = 0;
    assert.throws(() => startWorker(async () => { calls++; }, { intervalMs: timing }));
    assert.throws(() => createShutdown({ stopWorker: async () => { calls++; }, drainRequests: async () => {},
      closeServer: async () => {}, closeResources: () => { calls++; }, timeoutMs: timing }));
    assert.equal(calls, 0);
  }
});
