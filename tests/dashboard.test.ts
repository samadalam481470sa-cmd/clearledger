import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CursorPager, PAGE_SIZE, pagePath, formatAssetAmount,
  type CursorPage, type PagerState } from '../web/dashboard.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
async function within<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' remained pending')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
const assetA = '0x' + 'ab'.repeat(20);
const assetB = '0x' + 'cd'.repeat(20);

test('page URLs bind payment status and safely encode opaque cursors', () => {
  assert.equal(PAGE_SIZE, 25);
  const cursor = 'opaque+/=?&status=failed';
  const payment = new URL(pagePath('payments', cursor, 'settled'), 'https://example.test/api/');
  assert.equal(payment.pathname, '/api/payments');
  assert.equal(payment.searchParams.get('limit'), '25');
  assert.equal(payment.searchParams.get('cursor'), cursor);
  assert.equal(payment.searchParams.get('status'), 'settled');
  assert.equal(payment.searchParams.getAll('status').length, 1);
  const all = new URL(pagePath('payments'), 'https://example.test/api/');
  assert.equal(all.searchParams.has('status'), false);
  assert.equal(all.searchParams.has('cursor'), false);
  const journal = new URL(pagePath('journals', cursor, 'review'), 'https://example.test/api/');
  assert.equal(journal.pathname, '/api/journals');
  assert.equal(journal.searchParams.get('cursor'), cursor);
  assert.equal(journal.searchParams.has('status'), false);
});

test('cursor navigation tracks pages, supports previous/reload, and stops at collection end', async () => {
  const calls: (string | undefined)[] = [];
  const pages: Record<string, CursorPage<number>> = {
    first: { items: [1, 2], nextCursor: 'cursor-2' },
    'cursor-2': { items: [3, 4], nextCursor: 'cursor-3' },
    'cursor-3': { items: [5], nextCursor: null }
  };
  const pager = new CursorPager<number>(async cursor => {
    calls.push(cursor);
    return pages[cursor ?? 'first'];
  }, () => {});
  try {
    assert.equal(await pager.refresh(), true);
    assert.equal(pager.state.page, 1);
    assert.deepEqual(pager.state.items, [1, 2]);
    assert.equal(await pager.previous(), false);
    assert.equal(await pager.next(), true);
    assert.equal(pager.state.page, 2);
    assert.deepEqual(pager.state.items, [3, 4]);
    assert.equal(await pager.next(), true);
    assert.equal(pager.state.page, 3);
    assert.deepEqual(pager.state.items, [5]);
    assert.equal(await pager.next(), false);
    assert.equal(await pager.previous(), true);
    assert.equal(pager.state.page, 2);
    assert.deepEqual(pager.state.items, [3, 4]);
    assert.equal(await pager.reload(), true);
    assert.equal(pager.state.page, 2);
    assert.deepEqual(calls, [undefined, 'cursor-2', 'cursor-3', 'cursor-2', 'cursor-2']);
    assert.equal(await pager.refresh(), true);
    assert.equal(pager.state.page, 1);
    assert.equal(await pager.previous(), false);
  } finally { pager.dispose(); }
});

test('failed next-page load retains current items and cursor so retry neither skips nor duplicates a page', async () => {
  let failNext = true;
  const cursors: (string | undefined)[] = [];
  const pager = new CursorPager<number>(async cursor => {
    cursors.push(cursor);
    if (!cursor) return { items: [1], nextCursor: 'cursor-2' };
    if (failNext) { failNext = false; throw new Error('RPC read unavailable'); }
    return { items: [2], nextCursor: null };
  }, () => {});
  try {
    await pager.refresh();
    assert.equal(await pager.next(), false);
    assert.deepEqual(pager.state.items, [1]);
    assert.equal(pager.state.page, 1);
    assert.equal(pager.state.nextCursor, 'cursor-2');
    assert.match(pager.state.error, /RPC read unavailable/);
    assert.equal(pager.state.loading, false);
    assert.equal(await pager.next(), true);
    assert.equal(pager.state.page, 2);
    assert.deepEqual(pager.state.items, [2]);
    assert.equal(pager.state.error, '');
    assert.deepEqual(cursors, [undefined, 'cursor-2', 'cursor-2']);
    assert.equal(await pager.previous(), true);
    assert.equal(pager.state.page, 1);
  } finally { pager.dispose(); }
});

test('a next-page response timeout retains rows and retries the same cursor only on explicit navigation', {
  timeout: 3000
}, async () => {
  const held = deferred<CursorPage<number>>();
  const cursors: (string | undefined)[] = [], signals: AbortSignal[] = [];
  const pager = new CursorPager<number>(async (cursor, signal) => {
    cursors.push(cursor); signals.push(signal);
    if (!cursor) return { items: [1], nextCursor: 'cursor-2' };
    return cursors.length === 2 ? held.promise : { items: [2], nextCursor: 'cursor-3' };
  }, () => {}, 20);
  let pending: Promise<boolean> | undefined;
  try {
    assert.equal(await pager.refresh(), true);
    pending = pager.next();
    assert.equal(await within(pending, 'Silent next-page response'), false);
    assert.deepEqual(pager.state, {
      items: [1], nextCursor: 'cursor-2', page: 1, loading: false,
      error: 'Page response timed out. Try loading this page again.'
    });
    assert.equal(signals[1].aborted, true);
    await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(cursors, [undefined, 'cursor-2']);
    assert.equal(await within(pager.next(), 'Explicit next-page retry'), true);
    assert.deepEqual(cursors, [undefined, 'cursor-2', 'cursor-2']);
    assert.deepEqual(pager.state.items, [2]);
    assert.equal(pager.state.page, 2);
    assert.equal(pager.state.error, '');
    assert.equal(signals[2].aborted, false);
  } finally {
    pager.dispose(); held.resolve({ items: [999], nextCursor: null });
    await Promise.allSettled(pending ? [pending] : []);
  }
});

test('a first-page response timeout exposes an error instead of an empty successful page', { timeout: 3000 }, async () => {
  const held = deferred<CursorPage<number>>();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const pager = new CursorPager<number>(async (_cursor, signal) => {
    signals.push(signal);
    return ++calls === 1 ? held.promise : { items: [1], nextCursor: null };
  }, () => {}, 20);
  const pending = pager.refresh();
  try {
    assert.equal(await within(pending, 'Silent first-page response'), false);
    assert.deepEqual(pager.state, {
      items: [], nextCursor: null, page: 1, loading: false,
      error: 'Page response timed out. Try loading this page again.'
    });
    assert.equal(signals[0].aborted, true);
    assert.equal(calls, 1);
    assert.equal(await within(pager.refresh(), 'First-page retry'), true);
    assert.deepEqual(pager.state.items, [1]);
    assert.equal(calls, 2);
  } finally {
    pager.dispose(); held.resolve({ items: [999], nextCursor: null });
    await Promise.allSettled([pending]);
  }
});

for (const action of ['previous', 'reload', 'refresh'] as const)
  test(`a ${action} response timeout retains the committed historical page until an explicit retry succeeds`, {
    timeout: 3000
  }, async () => {
    const held = deferred<CursorPage<number>>();
    let holdNext = false;
    const cursors: (string | undefined)[] = [];
    const pager = new CursorPager<number>(async cursor => {
      cursors.push(cursor);
      if (holdNext) { holdNext = false; return held.promise; }
      return cursor === 'cursor-3' ? { items: [3], nextCursor: null } :
        cursor === 'cursor-2' ? { items: [2], nextCursor: 'cursor-3' } :
          { items: [1], nextCursor: 'cursor-2' };
    }, () => {}, 20);
    let pending: Promise<boolean> | undefined;
    try {
      assert.equal(await pager.refresh(), true);
      assert.equal(await pager.next(), true);
      if (action === 'previous') assert.equal(await pager.next(), true);
      const committed = { ...pager.state }, calls = cursors.length;
      const expectedCursor = action === 'refresh' ? undefined : 'cursor-2';
      holdNext = true;
      pending = pager[action]();
      assert.equal(await within(pending, 'Silent ' + action + ' response'), false);
      assert.deepEqual(pager.state, {
        ...committed, loading: false, error: 'Page response timed out. Try loading this page again.'
      });
      assert.equal(cursors.length, calls + 1);
      assert.equal(cursors.at(-1), expectedCursor);
      assert.equal(await within(pager[action](), action + ' retry'), true);
      assert.deepEqual(cursors.slice(calls), [expectedCursor, expectedCursor]);
      assert.equal(pager.state.page, action === 'refresh' ? 1 : 2);
      assert.deepEqual(pager.state.items, action === 'refresh' ? [1] : [2]);
      assert.equal(pager.state.error, '');
      if (action === 'refresh') {
        assert.equal(await pager.previous(), false);
        assert.equal(await pager.next(), true);
      }
      assert.equal(await pager.previous(), true);
      assert.equal(pager.state.page, 1);
      assert.deepEqual(pager.state.items, [1]);
    } finally {
      pager.dispose(); held.resolve({ items: [999], nextCursor: null });
      await Promise.allSettled(pending ? [pending] : []);
    }
  });

for (const outcome of ['success', 'error'] as const)
  for (const retryFirst of [false, true])
    test(`a timed-out page ignores late ${outcome} ${retryFirst ? 'after retry success' : 'before explicit retry'}`, {
      timeout: 3000
    }, async () => {
      const held = deferred<CursorPage<number>>();
      let calls = 0;
      const changes: PagerState<number>[] = [];
      const pager = new CursorPager<number>(async () => ++calls === 1 ? held.promise : { items: [2], nextCursor: null },
        state => changes.push(state), 20);
      const pending = pager.refresh();
      try {
        assert.equal(await within(pending, 'Page before late ' + outcome), false);
        if (retryFirst) assert.equal(await within(pager.refresh(), 'Replacement page'), true);
        const committed = JSON.stringify(pager.state), updates = changes.length;
        if (outcome === 'success') held.resolve({ items: [999], nextCursor: 'obsolete-cursor' });
        else held.reject(new Error('Late obsolete page failure'));
        for (let turn = 0; turn < 8; turn++) await Promise.resolve();
        assert.equal(JSON.stringify(pager.state), committed);
        assert.equal(changes.length, updates);
        assert.equal(calls, retryFirst ? 2 : 1);
        if (!retryFirst) assert.equal(await within(pager.refresh(), 'Explicit page retry'), true);
        assert.deepEqual(pager.state.items, [2]);
        assert.equal(pager.state.error, '');
      } finally {
        pager.dispose(); held.resolve({ items: [999], nextCursor: null });
        await Promise.allSettled([pending]);
      }
    });

test('the default page response deadline is 15 seconds even when the loader ignores cancellation', {
  timeout: 3000
}, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const held = deferred<CursorPage<number>>();
  let signal: AbortSignal | undefined;
  const pager = new CursorPager<number>(async (_cursor, active) => { signal = active; return held.promise; }, () => {});
  const pending = pager.refresh();
  try {
    t.mock.timers.tick(14999);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(pager.state.loading, true);
    assert.equal(signal?.aborted, false);
    t.mock.timers.tick(1);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(pager.state.loading, false);
    assert.equal(pager.state.error, 'Page response timed out. Try loading this page again.');
    assert.equal(signal?.aborted, true);
    assert.equal(await pending, false);
  } finally {
    pager.dispose(); held.resolve({ items: [999], nextCursor: null });
    await Promise.allSettled([pending]);
  }
});

test('a synchronous page loader still starts immediately and a completed load clears its deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0, signal: AbortSignal | undefined;
  const changes: PagerState<number>[] = [];
  const pager = new CursorPager<number>((_cursor, active) => {
    calls++; signal = active; return Promise.resolve({ items: [1], nextCursor: null });
  }, state => changes.push(state), 20);
  try {
    const pending = pager.refresh();
    assert.equal(calls, 1, 'Starting a page must not defer its loader to a later microtask');
    assert.equal(await pending, true);
    const committed = JSON.stringify(pager.state), updates = changes.length;
    t.mock.timers.tick(20000);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(JSON.stringify(pager.state), committed);
    assert.equal(changes.length, updates);
    assert.equal(signal?.aborted, false);
  } finally { pager.dispose(); }
});

test('a synchronous loader throw retains its real error and permits an explicit retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const pager = new CursorPager<number>(() => {
    if (++calls === 1) throw new Error('Synchronous page read failed');
    return Promise.resolve({ items: [1], nextCursor: null });
  }, () => {}, 20);
  try {
    const pending = pager.refresh();
    assert.equal(calls, 1);
    assert.equal(await pending, false);
    assert.equal(pager.state.error, 'Synchronous page read failed');
    assert.equal(pager.state.loading, false);
    t.mock.timers.tick(20000);
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    assert.equal(pager.state.error, 'Synchronous page read failed');
    assert.equal(await pager.refresh(), true);
    assert.deepEqual(pager.state.items, [1]);
    assert.equal(pager.state.error, '');
  } finally { pager.dispose(); }
});

test('invalid page deadlines are rejected before loading or publishing a state', () => {
  for (const timeoutMs of [NaN, Infinity, 0, -1, 0.5, 2147483648]) {
    let calls = 0, updates = 0;
    assert.throws(() => new CursorPager<number>(async () => { calls++; return { items: [], nextCursor: null }; },
      () => { updates++; }, timeoutMs), RangeError);
    assert.equal(calls, 0);
    assert.equal(updates, 0);
  }
});

test('failed previous-page load preserves navigation history for retry', async () => {
  let failFirst = false;
  const pager = new CursorPager<number>(async cursor => {
    if (!cursor && failFirst) { failFirst = false; throw new Error('Previous page unavailable'); }
    return cursor ? { items: [2], nextCursor: null } : { items: [1], nextCursor: 'cursor-2' };
  }, () => {});
  try {
    await pager.refresh(); await pager.next();
    failFirst = true;
    assert.equal(await pager.previous(), false);
    assert.equal(pager.state.page, 2);
    assert.deepEqual(pager.state.items, [2]);
    assert.equal(await pager.previous(), true);
    assert.equal(pager.state.page, 1);
    assert.deepEqual(pager.state.items, [1]);
  } finally { pager.dispose(); }
});

test('loading prevents overlapping navigation and reload requests', async () => {
  const waiting = deferred<CursorPage<number>>();
  let calls = 0;
  const pager = new CursorPager<number>(async () => { calls++; return waiting.promise; }, () => {});
  try {
    const first = pager.refresh();
    assert.equal(pager.state.loading, true);
    assert.equal(await pager.next(), false);
    assert.equal(await pager.previous(), false);
    assert.equal(await pager.reload(), false);
    assert.equal(calls, 1);
    waiting.resolve({ items: [7], nextCursor: 'next' });
    assert.equal(await first, true);
    assert.equal(pager.state.loading, false);
    assert.deepEqual(pager.state.items, [7]);
  } finally { pager.dispose(); }
});

test('refresh aborts an old request and ignores a late response even if the loader ignores cancellation', async () => {
  const old = deferred<CursorPage<string>>();
  const fresh = deferred<CursorPage<string>>();
  const signals: AbortSignal[] = [];
  const changes: PagerState<string>[] = [];
  const pager = new CursorPager<string>(async (_cursor, signal) => {
    signals.push(signal);
    return signals.length === 1 ? old.promise : fresh.promise;
  }, state => changes.push(state));
  try {
    const obsolete = pager.refresh();
    const current = pager.refresh();
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    assert.equal(await within(obsolete, 'Superseded page cancellation'), false,
      'Refresh must release the old wait before an ignored-abort loader finishes');
    fresh.resolve({ items: ['fresh'], nextCursor: null });
    assert.equal(await current, true);
    const eventsBeforeOld = changes.length;
    old.resolve({ items: ['obsolete'], nextCursor: 'obsolete-cursor' });
    assert.equal(await obsolete, false);
    assert.equal(changes.length, eventsBeforeOld);
    assert.deepEqual(pager.state.items, ['fresh']);
    assert.equal(pager.state.nextCursor, null);
    assert.equal(pager.state.error, '');
  } finally { pager.dispose(); }
});

test('late errors from superseded loads cannot replace a newer successful page', async () => {
  const old = deferred<CursorPage<number>>();
  let calls = 0;
  const pager = new CursorPager<number>(async () => {
    calls++;
    return calls === 1 ? old.promise : { items: [22], nextCursor: null };
  }, () => {});
  try {
    const obsolete = pager.refresh();
    assert.equal(await pager.refresh(), true);
    old.reject(new Error('Obsolete request failed'));
    assert.equal(await obsolete, false);
    assert.deepEqual(pager.state.items, [22]);
    assert.equal(pager.state.error, '');
  } finally { pager.dispose(); }
});

test('dispose aborts transport and prevents all later state updates or loads', async () => {
  const waiting = deferred<CursorPage<number>>();
  let calls = 0;
  let signal!: AbortSignal;
  const changes: PagerState<number>[] = [];
  const pager = new CursorPager<number>(async (_cursor, active) => {
    calls++; signal = active; return waiting.promise;
  }, state => changes.push(state));
  const request = pager.refresh();
  pager.dispose();
  assert.equal(signal.aborted, true);
  const count = changes.length;
  assert.equal(await within(request, 'Disposed page cancellation'), false,
    'Disposal must release the old wait before an ignored-abort loader finishes');
  waiting.resolve({ items: [99], nextCursor: null });
  assert.equal(await request, false);
  assert.equal(await pager.refresh(), false);
  assert.equal(await pager.reload(), false);
  assert.equal(await pager.next(), false);
  assert.equal(await pager.previous(), false);
  assert.equal(calls, 1);
  assert.equal(changes.length, count);
});

test('malformed or cyclic server pages keep the current view and remain retryable', async () => {
  const invalidPages = [
    { items: [2], nextCursor: 'cursor-2' },
    { items: Array.from({ length: PAGE_SIZE + 1 }, (_, index) => index), nextCursor: null },
    { items: null, nextCursor: null },
    { items: [2], nextCursor: '' },
    { items: [2], nextCursor: 'x'.repeat(513) },
    { items: [2], nextCursor: 123 }
  ];
  for (const invalid of invalidPages) {
    let valid = false;
    const pager = new CursorPager<number>(async cursor => {
      if (!cursor) return { items: [1], nextCursor: 'cursor-2' };
      return valid ? { items: [2], nextCursor: null } : invalid as CursorPage<number>;
    }, () => {});
    try {
      await pager.refresh();
      assert.equal(await pager.next(), false);
      assert.equal(pager.state.page, 1);
      assert.deepEqual(pager.state.items, [1]);
      assert.equal(pager.state.nextCursor, 'cursor-2');
      assert.match(pager.state.error, /invalid cursor page/i);
      valid = true;
      assert.equal(await pager.next(), true);
      assert.equal(pager.state.page, 2);
      assert.deepEqual(pager.state.items, [2]);
    } finally { pager.dispose(); }
  }
});

test('unknown and RPC assets retain exact base-unit strings without invented decimals', () => {
  const huge = (2n ** 256n - 1n).toString();
  for (const overview of [undefined, { mode: 'rpc', token: assetA }, { mode: 'demo', token: assetB }]) {
    const result = formatAssetAmount(huge, assetA, overview);
    assert.equal(result.value, huge);
    assert.equal(result.unit, 'base units');
  }
  assert.equal(formatAssetAmount('0', assetA).value, '0');
});

test('only the configured demo asset uses exact six-decimal dUSD formatting', () => {
  const overview = { mode: 'demo', token: assetA.toUpperCase().replace('0X', '0x') };
  for (const [input, value] of [
    ['0', '0.00'], ['1', '0.000001'], ['10', '0.00001'], ['100000', '0.1'],
    ['1000000', '1.00'], ['125000000', '125.00'], ['125500000', '125.5']
  ]) assert.deepEqual(formatAssetAmount(input, assetA, overview), { value, unit: 'dUSD' });
  const huge = 2n ** 256n - 1n;
  const expected = (huge / 1000000n).toString() + '.' + (huge % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  assert.equal(formatAssetAmount(huge.toString(), assetA, overview).value, expected);
});
