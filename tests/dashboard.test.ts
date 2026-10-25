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
