import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PaymentLookup, PAYMENT_LOOKUP_NOT_FOUND, isPaymentLookupId, paymentLookupPath,
  type PaymentLookupSnapshot, type PaymentLookupState
} from '../web/payment-lookup.ts';
import type { PaymentRow } from '../web/dashboard.ts';

const payer = '0x' + 'ab'.repeat(20), paymentId = '0x' + 'cd'.repeat(32);
const key = payer + ':' + paymentId, nextKey = payer + ':0x' + 'ef'.repeat(32);
const captured = '2026-11-03T12:34:56.789Z';
const fixedNow = () => new Date(captured);
function row(id = key): PaymentRow {
  return {
    id, status: 'settled', tx_hash: '0x' + '11'.repeat(32), block_number: 27,
    created_at: '2026-11-03T10:00:00.000Z', error: null,
    payment: {
      paymentId: id.slice(43), payer: id.slice(0, 42), payee: '0x' + '22'.repeat(20),
      token: '0x' + '33'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000000000'
    }
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
const statusError = (status: number, message: string) => Object.assign(new Error(message), { status });

test('lookup IDs require exact lowercase syntax without trimming, case folding or business validation', () => {
  assert.equal(isPaymentLookupId(key), true);
  assert.equal(isPaymentLookupId('0x' + '0'.repeat(40) + ':0x' + '0'.repeat(64)), true);
  for (const value of [undefined, null, 7, {}, key.toUpperCase(), key.replace('ab', 'aB'),
    key.replace('cd', 'cD'), ' ' + key, key + ' ', key + '\n', key + '/',
    key.replace(':', '%3A'), key.slice(1), key.slice(0, -1), key + '0'])
    assert.equal(isPaymentLookupId(value), false, String(value));
});

test('lookup path encodes the colon once and adds no query parameters', () => {
  const path = paymentLookupPath(key);
  assert.equal(path, 'payments/' + payer + '%3A' + paymentId);
  const url = new URL(path, 'http://localhost/api/');
  assert.equal(url.pathname.startsWith('/api/payments/'), true);
  assert.equal(decodeURIComponent(url.pathname.slice('/api/payments/'.length)), key);
  assert.equal(url.search, '');
});

test('idle and invalid input never call the loader or schedule an automatic lookup', async () => {
  let calls = 0;
  const changes: PaymentLookupState[] = [];
  const lookup = new PaymentLookup(async () => { calls++; return row(); }, state => changes.push(state));
  assert.deepEqual(lookup.state, { id: '', phase: 'idle', error: '', snapshot: null });
  assert.equal(changes.length, 0);
  assert.equal(await lookup.find(), false);
  assert.equal(lookup.state.phase, 'error');
  assert.match(lookup.state.error, /canonical lowercase/);
  lookup.setInput(' ' + key);
  assert.equal(await lookup.find(), false);
  lookup.setInput(key);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(lookup.state.phase, 'idle');
  lookup.dispose();
});

test('found snapshots copy public fields and timestamp independently of loader and callback mutations', async () => {
  const source = Object.assign(row(), {
    block_hash: '0x' + '44'.repeat(32), updated_at: '2026-11-03T11:00:00.000Z',
    raw_tx: 'PRIVATE_RAW', signature: 'PRIVATE_SIGNATURE', private_note: 'PRIVATE_NOTE'
  });
  Object.assign(source.payment!, { private_note: 'PRIVATE_PAYMENT_NOTE' });
  let receivedPath = '', receivedSignal: AbortSignal | undefined;
  const found: PaymentLookupSnapshot[] = [], changes: PaymentLookupState[] = [];
  const lookup = new PaymentLookup(async (path, signal) => {
    receivedPath = path; receivedSignal = signal; return source;
  }, state => {
    changes.push(state);
    if (state.snapshot?.row.payment) state.snapshot.row.payment.amount = '777';
  }, snapshot => { found.push(snapshot); snapshot.row.payment!.nonce = '999'; }, fixedNow);
  lookup.setInput(key);
  assert.equal(await lookup.find(), true);
  assert.equal(receivedPath, paymentLookupPath(key));
  assert.equal(receivedSignal?.aborted, false);
  assert.deepEqual(changes.map(state => state.phase), ['idle', 'loading', 'found']);
  assert.equal(found.length, 1);
  assert.equal(lookup.state.snapshot?.capturedAt, captured);
  assert.equal(lookup.state.snapshot?.row.payment?.amount, '125000000');
  assert.equal(lookup.state.snapshot?.row.payment?.nonce, '0');
  source.payment!.amount = '1'; source.status = 'failed';
  const copy = lookup.state;
  copy.id = nextKey; copy.snapshot!.row.payment!.amount = '2'; copy.snapshot!.row.error = 'changed';
  assert.equal(lookup.state.id, key);
  assert.equal(lookup.state.snapshot?.row.status, 'settled');
  assert.equal(lookup.state.snapshot?.row.error, null);
  assert.equal(lookup.state.snapshot?.row.payment?.amount, '125000000');
  assert.equal(JSON.stringify(lookup.state).includes('PRIVATE_'), false);
  assert.equal((lookup.state.snapshot?.row as any).block_hash, source.block_hash);
  assert.equal((lookup.state.snapshot?.row as any).updated_at, source.updated_at);
  lookup.dispose();
});

test('an unavailable authorization remains a found receipt with public lifecycle metadata', async () => {
  const source: PaymentRow = { ...row(), payment: null,
    integrityError: 'Stored payment data is invalid; verify the original authorization' };
  let found: PaymentLookupSnapshot | undefined;
  const lookup = new PaymentLookup(async () => source, () => {}, snapshot => { found = snapshot; }, fixedNow);
  lookup.setInput(key);
  assert.equal(await lookup.find(), true);
  assert.equal(lookup.state.phase, 'found');
  assert.deepEqual(found, { row: source, capturedAt: captured });
  lookup.dispose();
});

test('not-found uses local time-qualified copy and permits an explicit later retry', async () => {
  let calls = 0;
  const lookup = new PaymentLookup(async () => {
    if (++calls === 1) throw statusError(404, 'Payment not found');
    return row();
  }, () => {}, undefined, fixedNow);
  lookup.setInput(key);
  assert.equal(await lookup.find(), false);
  assert.deepEqual(lookup.state, { id: key, phase: 'not-found', error: PAYMENT_LOOKUP_NOT_FOUND, snapshot: null });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(await lookup.find(), true);
  assert.equal(calls, 2);
  lookup.dispose();
});

for (const [name, error, message] of [
  ['authentication', statusError(401, 'Unauthorized'), 'Unauthorized'],
  ['upstream', statusError(503, 'Upstream RPC unavailable; check payment history before retrying'), 'Upstream RPC unavailable; check payment history before retrying'],
  ['transport', new Error('Network connection lost'), 'Network connection lost'],
  ['non-Error', 'failed', 'Unable to look up this payment']
] as const) test(`${name} failures are visible without retrying or reporting a missing record`, async () => {
  let calls = 0;
  const lookup = new PaymentLookup(async () => { calls++; throw error; }, () => {});
  lookup.setInput(key);
  assert.equal(await lookup.find(), false);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(lookup.state.phase, 'error');
  assert.equal(lookup.state.error, message);
  assert.equal(lookup.state.snapshot, null);
  lookup.dispose();
});

test('mismatched IDs and non-renderable public records never open a receipt', async () => {
  const malformed: unknown[] = [null, [], row(nextKey), { ...row(), payment: undefined },
    { ...row(), status: 'unknown' }, { ...row(), tx_hash: {} }, { ...row(), error: {} },
    { ...row(), block_number: NaN }, { ...row(), created_at: {} }, { ...row(), integrityError: {} },
    { ...row(), payment: { ...row().payment, amount: 'not-an-integer' } },
    { ...row(), payment: { ...row().payment, amount: (2n ** 256n).toString() } },
    { ...row(), payment: { ...row().payment, token: {} } },
    { ...row(), payment: { ...row().payment, paymentId: '0x' + 'ef'.repeat(32) } }];
  let calls = 0, opened = 0;
  const lookup = new PaymentLookup(async () => malformed[calls++] as PaymentRow,
    () => {}, () => { opened++; }, fixedNow);
  lookup.setInput(key);
  for (const _value of malformed) {
    assert.equal(await lookup.find(), false);
    assert.equal(lookup.state.phase, 'error');
    assert.equal(lookup.state.error, 'The server returned an invalid payment record');
    assert.equal(lookup.state.snapshot, null);
  }
  assert.equal(calls, malformed.length);
  assert.equal(opened, 0);
  lookup.dispose();
});

test('manual repeat lookups replace the snapshot and capture completion time rather than input time', async () => {
  const response = deferred<PaymentRow>();
  let now = new Date('2026-11-03T12:00:00.000Z'), calls = 0;
  const lookup = new PaymentLookup(async () => ++calls === 1 ? row() : response.promise,
    () => {}, undefined, () => now);
  lookup.setInput(key);
  assert.equal(await lookup.find(), true);
  const prior = lookup.state.snapshot;
  const pending = lookup.find();
  assert.equal(lookup.state.snapshot, null);
  now = new Date(captured);
  response.resolve({ ...row(), status: 'review' });
  assert.equal(await pending, true);
  assert.equal(prior?.row.status, 'settled');
  const completedState = lookup.state;
  assert.ok(completedState.snapshot);
  assert.equal(completedState.snapshot.row.status, 'review');
  assert.equal(completedState.snapshot.capturedAt, captured);
  lookup.dispose();
});

for (const outcome of ['success', 'error'] as const)
  test(`superseding a lookup aborts and ignores its late ${outcome} even when cancellation is ignored`, async () => {
    const old = deferred<PaymentRow>(), fresh = deferred<PaymentRow>();
    const signals: AbortSignal[] = [], changes: PaymentLookupState[] = [], found: PaymentLookupSnapshot[] = [];
    const lookup = new PaymentLookup(async (_path, signal) => {
      signals.push(signal); return signals.length === 1 ? old.promise : fresh.promise;
    }, state => changes.push(state), snapshot => found.push(snapshot), fixedNow);
    lookup.setInput(key);
    const obsolete = lookup.find();
    lookup.setInput(nextKey);
    const current = lookup.find();
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[1].aborted, false);
    fresh.resolve(row(nextKey));
    assert.equal(await current, true);
    const events = changes.length;
    if (outcome === 'success') old.resolve(row()); else old.reject(new Error('Obsolete failure'));
    assert.equal(await obsolete, false);
    assert.equal(changes.length, events);
    assert.equal(found.length, 1);
    assert.equal(lookup.state.snapshot?.row.id, nextKey);
    lookup.dispose();
  });

test('a repeated explicit find for the same ID supersedes the first request', async () => {
  const old = deferred<PaymentRow>();
  const signals: AbortSignal[] = [];
  let opened = 0;
  const lookup = new PaymentLookup(async (_path, signal) => {
    signals.push(signal); return signals.length === 1 ? old.promise : row();
  }, () => {}, () => { opened++; }, fixedNow);
  lookup.setInput(key);
  const obsolete = lookup.find();
  assert.equal(await lookup.find(), true);
  assert.equal(signals[0].aborted, true);
  old.resolve(row());
  assert.equal(await obsolete, false);
  assert.equal(opened, 1);
  lookup.dispose();
});

for (const action of ['edit', 'same-input', 'reset', 'dispose'] as const)
  test(`${action} invalidates an active lookup and suppresses obsolete completion`, async () => {
    const response = deferred<PaymentRow>();
    let signal: AbortSignal | undefined, calls = 0, opened = 0;
    const changes: PaymentLookupState[] = [];
    const lookup = new PaymentLookup(async (_path, current) => {
      calls++; signal = current; return response.promise;
    }, state => changes.push(state), () => { opened++; }, fixedNow);
    lookup.setInput(key);
    const pending = lookup.find();
    if (action === 'edit') lookup.setInput('partial');
    else if (action === 'same-input') lookup.setInput(key);
    else if (action === 'reset') lookup.reset();
    else lookup.dispose();
    assert.equal(signal?.aborted, true);
    const events = changes.length;
    response.resolve(row());
    assert.equal(await pending, false);
    assert.equal(changes.length, events);
    assert.equal(opened, 0);
    assert.equal(lookup.state.snapshot, null);
    if (action !== 'dispose') {
      assert.equal(lookup.state.phase, 'idle');
      assert.equal(lookup.state.id, action === 'reset' ? '' : action === 'edit' ? 'partial' : key);
    } else {
      lookup.setInput(nextKey); lookup.reset(); lookup.dispose();
      assert.equal(await lookup.find(), false);
      assert.equal(changes.length, events);
    }
    assert.equal(calls, 1);
    lookup.dispose();
  });

test('reset also ignores an obsolete rejected request rather than restoring its error', async () => {
  const response = deferred<PaymentRow>();
  const lookup = new PaymentLookup(async () => response.promise, () => {});
  lookup.setInput(key);
  const pending = lookup.find();
  lookup.reset();
  response.reject(statusError(404, 'Payment not found'));
  assert.equal(await pending, false);
  assert.deepEqual(lookup.state, { id: '', phase: 'idle', error: '', snapshot: null });
  lookup.dispose();
});

test('synchronous loading cancellation prevents even starting the obsolete loader', async () => {
  let calls = 0;
  const lookup = new PaymentLookup(async () => { calls++; return row(); }, state => {
    if (state.phase === 'loading') lookup.reset();
  });
  lookup.setInput(key);
  assert.equal(await lookup.find(), false);
  assert.equal(calls, 0);
  assert.equal(lookup.state.phase, 'idle');
  lookup.dispose();
});

test('a state callback that invalidates a found response prevents the old receipt callback', async () => {
  let opened = 0;
  const lookup = new PaymentLookup(async () => row(), state => {
    if (state.phase === 'found') lookup.setInput(nextKey);
  }, () => { opened++; }, fixedNow);
  lookup.setInput(key);
  assert.equal(await lookup.find(), false);
  assert.equal(opened, 0);
  assert.deepEqual(lookup.state, { id: nextKey, phase: 'idle', error: '', snapshot: null });
  lookup.dispose();
});
