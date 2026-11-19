/** Bound a client wait and abort its transport without cancelling server-side work. */
export async function requestWithTimeout<T>(send: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal, timeoutMs: number, timeoutMessage: string): Promise<T> {
  if (parentSignal.aborted) throw parentSignal.reason;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    const stop = (reason: unknown) => {
      reject(reason);
      controller.abort(reason);
    };
    cancel = () => stop(parentSignal.reason);
    parentSignal.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => stop(new Error(timeoutMessage)), timeoutMs);
  });
  try {
    const response = new Promise<T>(resolve => { resolve(send(controller.signal)); });
    return await Promise.race([interrupted, response]);
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', cancel);
  }
}
