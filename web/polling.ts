export interface PollScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}
interface PollOptions<T> {
  load(signal: AbortSignal): Promise<T>;
  onValue(value: T): void;
  onError?(error: unknown): void;
  intervalMs?: number;
  scheduler?: PollScheduler;
}

/** One independent resource per instance; a new context must stop the old one. */
export function startPolling<T>(options: PollOptions<T>): { stop(): void } {
  const interval = options.intervalMs ?? 5000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2147483647)
    throw new RangeError('Polling interval must be an integer from 1 to 2147483647 milliseconds');
  const scheduler = options.scheduler ?? {
    schedule: (callback: () => void, delay: number) => setTimeout(callback, delay),
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
  };
  const controller = new AbortController();
  let stopped = false, scheduled = false;
  let timer: unknown;
  async function run() {
    if (stopped) return;
    scheduled = false;
    try {
      const value = await options.load(controller.signal);
      if (!stopped) options.onValue(value);
    } catch (error) {
      if (!stopped) {
        try { options.onError?.(error); } catch { /* Diagnostics must not end future refreshes. */ }
      }
    } finally {
      if (!stopped) { timer = scheduler.schedule(() => void run(), interval); scheduled = true; }
    }
  }
  void run();
  return { stop() {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (scheduled) scheduler.cancel(timer);
  } };
}
