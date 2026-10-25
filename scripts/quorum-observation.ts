import { performance } from 'node:perf_hooks';

export interface QuorumCheckpoint { height: number; hash: string; heads: number[] }
export class QuorumObservationError extends Error {}

interface ObservationOptions {
  durationMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function validCheckpoint(value: unknown): value is QuorumCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const sample = value as QuorumCheckpoint;
  return Number.isSafeInteger(sample.height) && sample.height > 0 &&
    typeof sample.hash === 'string' && sample.hash.trim().length > 0 &&
    Array.isArray(sample.heads) && sample.heads.length === 2 &&
    sample.heads.every(height => Number.isSafeInteger(height) && height === sample.height);
}

/**
 * Observe two reachable, agreeing nodes over a bounded sample window.
 * An RPC failure is not evidence of halted finalization. This does not prove
 * consensus safety or the behavior of nodes that are not being observed.
 */
export async function observeHalted(
  read: () => Promise<QuorumCheckpoint>,
  baseline: QuorumCheckpoint,
  options: ObservationOptions = {}
): Promise<QuorumCheckpoint & { elapsedMs: number; observations: number }> {
  const durationMs = options.durationMs ?? 20000;
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isSafeInteger(durationMs) || !Number.isSafeInteger(pollMs) ||
    durationMs < 1 || pollMs < 1 || durationMs < pollMs)
    throw new QuorumObservationError('Observation duration and poll interval must be positive safe integers with duration >= poll interval');
  if (!validCheckpoint(baseline))
    throw new QuorumObservationError('Baseline must contain two agreeing positive block heights and a nonempty canonical hash');
  const expected = { height: baseline.height, hash: baseline.hash, heads: [...baseline.heads] };
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

  function clock() {
    const value = now();
    if (!Number.isFinite(value)) throw new QuorumObservationError('Observation clock is invalid');
    return value;
  }
  function check(sample: unknown) {
    if (!validCheckpoint(sample) || sample.height !== expected.height || sample.hash !== expected.hash ||
      sample.heads.some((height, index) => height !== expected.heads[index]))
      throw new QuorumObservationError('Nodes progressed, disagreed, or returned an incomplete checkpoint');
  }

  // Start the observation interval only after the first successful sample, so
  // one slow RPC response cannot stand in for a whole no-progress window.
  check(await read());
  const started = clock();
  let previous = started;
  let observations = 1;
  for (;;) {
    await sleep(Math.min(pollMs, durationMs - (previous - started)));
    const afterSleep = clock();
    if (afterSleep <= previous)
      throw new QuorumObservationError('Observation clock failed to advance after the poll interval');
    check(await read());
    observations++;
    const observedAt = clock();
    if (observedAt < afterSleep)
      throw new QuorumObservationError('Observation clock moved backwards during the read');
    const elapsedMs = observedAt - started;
    if (elapsedMs >= durationMs) return { ...expected, elapsedMs, observations };
    previous = observedAt;
  }
}
