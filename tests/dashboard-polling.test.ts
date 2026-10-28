import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPolling, type PollScheduler } from '../web/polling.ts';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
class Timers implements PollScheduler {
  private next = 0;
  readonly pending = new Map<number, { callback: () => void; delay: number }>();
  readonly cancelled: unknown[] = [];
  schedule(callback: () => void, delay: number) {
    const handle = ++this.next;
    this.pending.set(handle, { callback, delay });
    return handle;
  }
  cancel(handle: unknown) { this.cancelled.push(handle); this.pending.delete(handle as number); }
  takeNext() {
    const entry = this.pending.entries().next().value;
    assert.ok(entry, 'Expected a scheduled refresh');
    this.pending.delete(entry[0]);
    return entry[1];
  }
  runNext() { this.takeNext().callback(); }
}
async function settled() { await Promise.resolve(); await Promise.resolve(); }

test('a resource polls immediately and serially, scheduling only after its current load completes', async () => {
  const timers = new Timers(), first = deferred<number>(), second = deferred<number>();
  let calls = 0, active = 0, maximumActive = 0;
  const values: number[] = [];
  const poller = startPolling({
    load: async () => {
      calls++; active++; maximumActive = Math.max(maximumActive, active);
      try { return await (calls === 1 ? first.promise : second.promise); }
      finally { active--; }
    }, onValue: value => values.push(value), scheduler: timers
  });
  try {
    assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
    await settled();
    assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
    first.resolve(10); await settled(); await settled();
    assert.deepEqual(values, [10]); assert.equal(timers.pending.size, 1);
    const timer = timers.takeNext();
    assert.equal(timer.delay, 5000);
    timer.callback();
    assert.equal(calls, 2); assert.equal(timers.pending.size, 0);
    await settled();
    assert.equal(calls, 2); assert.equal(maximumActive, 1);
    second.resolve(20); await settled(); await settled();
    assert.deepEqual(values, [10, 20]); assert.equal(timers.pending.size, 1);
  } finally { poller.stop(); first.resolve(0); second.resolve(0); }
});

test('totals continue refreshing independently while an overview load remains unresolved', async () => {
  const timers = new Timers(), overview = deferred<string>();
  let overviewCalls = 0, totalCalls = 0;
  const totals: number[] = [], overviews: string[] = [];
  const overviewPoller = startPolling({ load: async () => { overviewCalls++; return overview.promise; },
    onValue: value => overviews.push(value), scheduler: timers, intervalMs: 10 });
  const totalPoller = startPolling({ load: async () => ++totalCalls,
    onValue: value => totals.push(value), scheduler: timers, intervalMs: 10 });
  try {
    await settled();
    for (let iteration = 0; iteration < 4; iteration++) { timers.runNext(); await settled(); }
    assert.equal(overviewCalls, 1); assert.deepEqual(overviews, []);
    assert.equal(totalCalls, 5); assert.deepEqual(totals, [1, 2, 3, 4, 5]);
    assert.equal(timers.pending.size, 1);
    overviewPoller.stop();
    timers.runNext(); await settled();
    assert.equal(totalCalls, 6, 'Stopping one resource must not stop another');
  } finally { overviewPoller.stop(); totalPoller.stop(); overview.resolve('obsolete'); }
});

test('an error retains last-good state and later success clears the per-resource error', async () => {
  const timers = new Timers();
  let calls = 0;
  const model: { value: number | null; error: string } = { value: null, error: '' };
  const poller = startPolling({
    load: async () => { calls++; if (calls === 2) throw new Error('RPC unavailable'); return calls; },
    onValue: value => { model.value = value; model.error = ''; },
    onError: error => { model.error = (error as Error).message; }, scheduler: timers, intervalMs: 20
  });
  try {
    await settled(); assert.deepEqual(model, { value: 1, error: '' });
    timers.runNext(); await settled();
    assert.deepEqual(model, { value: 1, error: 'RPC unavailable' });
    assert.equal(timers.pending.size, 1);
    timers.runNext(); await settled();
    assert.deepEqual(model, { value: 3, error: '' });
  } finally { poller.stop(); }
});

for (const outcome of ['success', 'error'] as const) {
  test('stop aborts pending transport and suppresses a late ' + outcome + ' and reschedule', async () => {
    const timers = new Timers(), waiting = deferred<number>();
    let signal: AbortSignal | undefined;
    const values: number[] = [], errors: unknown[] = [];
    const poller = startPolling({ load: current => { signal = current; return waiting.promise; },
      onValue: value => values.push(value), onError: error => errors.push(error), scheduler: timers });
    assert.equal(signal?.aborted, false);
    poller.stop(); poller.stop();
    assert.equal(signal?.aborted, true);
    if (outcome === 'success') waiting.resolve(42); else waiting.reject(new Error('Late obsolete error'));
    await settled();
    assert.deepEqual(values, []); assert.deepEqual(errors, []); assert.equal(timers.pending.size, 0);
  });
}

test('stop cancels an idle timer and even an already-queued timer callback cannot start work', async () => {
  const timers = new Timers();
  let calls = 0;
  const poller = startPolling({ load: async () => ++calls, onValue: () => {}, scheduler: timers });
  await settled();
  const queued = [...timers.pending.values()][0].callback;
  assert.equal(timers.pending.size, 1);
  poller.stop(); poller.stop();
  assert.equal(timers.pending.size, 0); assert.equal(timers.cancelled.length, 1);
  queued(); await settled();
  assert.equal(calls, 1); assert.equal(timers.pending.size, 0);
});

test('a replacement context ignores an old loader that does not honor cancellation', async () => {
  const timers = new Timers(), old = deferred<string>(), fresh = deferred<string>();
  const model = { context: 'old', value: '', error: '' };
  let oldSignal: AbortSignal | undefined, freshSignal: AbortSignal | undefined;
  const previous = startPolling({ load: signal => { oldSignal = signal; return old.promise; },
    onValue: value => { model.value = value; }, onError: () => { model.error = 'old error'; }, scheduler: timers });
  previous.stop(); model.context = 'new'; model.value = '';
  const current = startPolling({ load: signal => { freshSignal = signal; return fresh.promise; },
    onValue: value => { model.value = value; }, onError: () => { model.error = 'new error'; }, scheduler: timers });
  try {
    assert.equal(oldSignal?.aborted, true); assert.equal(freshSignal?.aborted, false);
    fresh.resolve('current totals'); await settled();
    old.resolve('obsolete totals'); await settled();
    assert.deepEqual(model, { context: 'new', value: 'current totals', error: '' });
    assert.equal(timers.pending.size, 1);
  } finally { previous.stop(); current.stop(); }
});

test('a synchronous loader failure and throwing diagnostic callback still permit the next refresh', async () => {
  const timers = new Timers();
  let calls = 0;
  const values: number[] = [];
  const poller = startPolling({ load: () => {
    if (++calls === 1) throw new Error('Synchronous load failure');
    return Promise.resolve(2);
  }, onValue: value => values.push(value), onError: () => { throw new Error('Diagnostic failure'); }, scheduler: timers });
  try {
    assert.equal(timers.pending.size, 1);
    timers.runNext(); await settled();
    assert.equal(calls, 2); assert.deepEqual(values, [2]); assert.equal(timers.pending.size, 1);
  } finally { poller.stop(); }
});

test('invalid intervals are rejected before loading or scheduling', () => {
  for (const intervalMs of [0, -1, 1.5, NaN, Infinity, 2147483648]) {
    let calls = 0;
    const timers = new Timers();
    assert.throws(() => startPolling({ intervalMs, scheduler: timers,
      load: async () => { calls++; return 0; }, onValue: () => {} }), RangeError);
    assert.equal(calls, 0); assert.equal(timers.pending.size, 0);
  }
});
