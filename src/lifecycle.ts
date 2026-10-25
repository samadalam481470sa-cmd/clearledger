interface WorkerOptions { intervalMs?: number; onError?: () => void }
export interface WorkerHandle { stop(): Promise<void> }
export type ShutdownResult = 'closed' | 'timeout' | 'failed';
interface ShutdownOptions {
  stopWorker: () => Promise<void>;
  drainRequests: () => Promise<void>;
  closeServer: () => Promise<void>;
  closeResources: () => Promise<void> | void;
  timeoutMs?: number;
}

function positiveTiming(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    throw new Error(name + ' must be an integer from 1 to 2147483647 milliseconds');
  return value;
}

/** Schedule one serialized tick at a time; resource ownership stays with callers. */
export function startWorker(tick: () => Promise<unknown>, options: WorkerOptions = {}): WorkerHandle {
  const intervalMs = positiveTiming(options.intervalMs ?? 1000, 'Worker interval');
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void>;
  let stopping: Promise<void> | undefined;

  async function run() {
    try { await tick(); }
    catch {
      // Logging policy belongs to the caller; no transaction data is forwarded.
      try { options.onError?.(); } catch { /* A diagnostic callback must not kill retries. */ }
    } finally {
      if (!stopped) timer = setTimeout(launch, intervalMs);
    }
  }
  function launch() { if (!stopped) active = run(); }
  launch();
  return {
    stop() {
      if (!stopping) {
        // This happens before returning the promise, so no future tick can start.
        stopped = true;
        clearTimeout(timer);
        stopping = active!;
      }
      return stopping;
    }
  };
}

/**
 * Drain worker, requests, and listener together before closing shared resources.
 * A timeout/failure never closes resources underneath unresolved operations.
 */
export function createShutdown(options: ShutdownOptions): () => Promise<ShutdownResult> {
  const timeoutMs = positiveTiming(options.timeoutMs ?? 20000, 'Shutdown timeout');
  let result: Promise<ShutdownResult> | undefined;
  return () => {
    if (result) return result;
    let resolveResult!: (value: ShutdownResult) => void;
    result = new Promise(resolve => { resolveResult = resolve; });
    let finished = false;
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    function finish(value: ShutdownResult) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveResult(value);
    }
    function begin(action: () => Promise<void>) {
      try { return Promise.resolve(action()); }
      catch { return Promise.reject(new Error('Shutdown drain failed')); }
    }
    // Construct every promise even when an earlier action throws synchronously.
    const drains = [begin(options.stopWorker), begin(options.drainRequests), begin(options.closeServer)];
    void Promise.all(drains).then(async () => {
      if (finished) return;
      if (performance.now() >= deadline) { finish('timeout'); return; }
      try {
        await options.closeResources();
        finish(performance.now() >= deadline ? 'timeout' : 'closed');
      }
      catch { finish('failed'); }
    }, () => finish('failed'));
    return result;
  };
}
