import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHalted, QuorumObservationError, type QuorumCheckpoint } from '../scripts/quorum-observation.ts';

const baseline = (): QuorumCheckpoint => ({ height: 100, hash: 'canonical-block-100', heads: [100, 100] });
function fakeClock() {
  let milliseconds = 0;
  const sleeps: number[] = [];
  return {
    sleeps, now: () => milliseconds,
    advance(ms: number) { milliseconds += ms; },
    sleep: async (ms: number) => { sleeps.push(ms); milliseconds += ms; }
  };
}

test('default observation takes successful samples before and at the end of a full 20-second window', async () => {
  const clock = fakeClock();
  const times: number[] = [];
  const initial = baseline();
  const result = await observeHalted(async () => { times.push(clock.now()); return baseline(); }, initial, clock);
  assert.equal(result.elapsedMs, 20000);
  assert.equal(result.observations, 21);
  assert.deepEqual(times, Array.from({ length: 21 }, (_, index) => index * 1000));
  assert.deepEqual(clock.sleeps, Array.from({ length: 20 }, () => 1000));
  assert.equal(result.height, initial.height);
  assert.equal(result.hash, initial.hash);
  assert.deepEqual(result.heads, initial.heads);
  assert.notEqual(result.heads, initial.heads);
});

test('the final successful observation reaches the entire requested duration even for a partial poll interval', async () => {
  const clock = fakeClock();
  const times: number[] = [];
  const result = await observeHalted(async () => { times.push(clock.now()); return baseline(); }, baseline(),
    { ...clock, durationMs: 2500, pollMs: 1000 });
  assert.equal(result.elapsedMs, 2500);
  assert.equal(result.observations, 4);
  assert.deepEqual(clock.sleeps, [1000, 1000, 500]);
  assert.deepEqual(times, [0, 1000, 2000, 2500]);
});

test('a slow first RPC sample cannot substitute for the subsequent observation duration', async () => {
  const clock = fakeClock();
  const samples: number[] = [];
  const result = await observeHalted(async () => {
    clock.advance(500); samples.push(clock.now()); return baseline();
  }, baseline(), { ...clock, durationMs: 2000, pollMs: 1000 });
  assert.equal(samples[0], 500);
  assert.ok(samples.at(-1)! - samples[0] >= 2000);
  assert.equal(result.elapsedMs, samples.at(-1)! - samples[0]);
  assert.ok(result.observations >= 2);
});

test('read and sleep operations are sequential and never overlap', async () => {
  const clock = fakeClock();
  let reading = false;
  let calls = 0;
  const result = await observeHalted(async () => {
    assert.equal(reading, false);
    reading = true;
    await Promise.resolve();
    calls++;
    reading = false;
    return baseline();
  }, baseline(), { now: clock.now, durationMs: 3, pollMs: 1,
    sleep: async ms => { assert.equal(reading, false); await clock.sleep(ms); } });
  assert.equal(calls, 4);
  assert.equal(result.observations, calls);
});

for (const [description, changed] of [
  ['block progress', { height: 101, hash: 'next-block', heads: [101, 101] }],
  ['canonical hash change at the same height', { height: 100, hash: 'other-block', heads: [100, 100] }],
  ['unequal reachable heads', { height: 100, hash: 'canonical-block-100', heads: [100, 101] }]
] as const) {
  test(description + ' prevents a halted-finalization claim', async () => {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(() => observeHalted(async () => {
      return ++calls === 1 ? baseline() : changed as unknown as QuorumCheckpoint;
    }, baseline(), { ...clock, durationMs: 5, pollMs: 1 }), QuorumObservationError);
    assert.equal(calls, 2);
  });
}

test('missing, malformed or incomplete node observations are not counted as proof of a halt', async () => {
  const malformed: unknown[] = [undefined, null, {},
    { ...baseline(), heads: [] }, { ...baseline(), heads: [100] },
    { ...baseline(), heads: [100, 100, 100] }, { ...baseline(), hash: '' },
    { ...baseline(), hash: '   ' }, { ...baseline(), heads: [100, NaN] }];
  for (const sample of malformed) {
    const clock = fakeClock();
    let calls = 0;
    await assert.rejects(() => observeHalted(async () => {
      return ++calls === 1 ? baseline() : sample as QuorumCheckpoint;
    }, baseline(), { ...clock, durationMs: 5, pollMs: 1 }), QuorumObservationError);
    assert.equal(calls, 2);
  }
});

test('RPC rejection propagates unchanged instead of being treated as an unchanged block', async () => {
  const clock = fakeClock();
  const failure = new Error('RPC service unavailable');
  let calls = 0;
  await assert.rejects(() => observeHalted(async () => {
    if (++calls === 2) throw failure;
    return baseline();
  }, baseline(), { ...clock, durationMs: 5, pollMs: 1 }), error => error === failure);
  assert.equal(calls, 2);
  assert.deepEqual(clock.sleeps, [1]);
});

test('invalid observation timings reject before any RPC read', async () => {
  const timings = [
    { durationMs: 0 }, { durationMs: -1 }, { durationMs: 0.5 }, { durationMs: Infinity },
    { pollMs: 0 }, { pollMs: -1 }, { pollMs: 1.5 }, { pollMs: NaN },
    { durationMs: 2, pollMs: 3 }, { durationMs: Number.MAX_SAFE_INTEGER + 1 }
  ];
  for (const timing of timings) {
    let calls = 0;
    await assert.rejects(() => observeHalted(async () => { calls++; return baseline(); }, baseline(), timing), QuorumObservationError);
    assert.equal(calls, 0);
  }
});

test('invalid baseline or a failed initial read never starts a no-progress window', async () => {
  const invalid: unknown[] = [undefined, {}, { ...baseline(), height: 0 },
    { ...baseline(), height: 1.5 }, { ...baseline(), heads: [100, 99] },
    { ...baseline(), hash: '' }, { ...baseline(), heads: [100] }];
  for (const value of invalid) {
    let calls = 0;
    await assert.rejects(() => observeHalted(async () => { calls++; return baseline(); }, value as QuorumCheckpoint), QuorumObservationError);
    assert.equal(calls, 0);
  }
  const failure = new Error('No initial observation');
  await assert.rejects(() => observeHalted(async () => { throw failure; }, baseline()), error => error === failure);
});

test('a non-advancing or backward clock fails rather than hanging or shortening the window', async () => {
  for (const next of [0, -1, NaN]) {
    let time = 0;
    await assert.rejects(() => observeHalted(async () => baseline(), baseline(), {
      durationMs: 2, pollMs: 1, now: () => time, sleep: async () => { time = next; }
    }), QuorumObservationError);
  }
});

test('sleep rejection is propagated and cannot count a nonexistent final observation', async () => {
  const failure = new Error('Observation cancelled');
  let calls = 0;
  await assert.rejects(() => observeHalted(async () => { calls++; return baseline(); }, baseline(), {
    durationMs: 2, pollMs: 1, now: () => 0, sleep: async () => { throw failure; }
  }), error => error === failure);
  assert.equal(calls, 1);
});
