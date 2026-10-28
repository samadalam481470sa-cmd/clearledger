import { createConnection } from 'node:net';

const diagnosticCodes = new Set(['EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAI_AGAIN',
  'ECONNABORTED', 'EHOSTDOWN', 'EHOSTUNREACH', 'EINVAL', 'EMFILE', 'ENETDOWN', 'ENETUNREACH',
  'ENFILE', 'ENOBUFS', 'ENOMEM', 'ENOTFOUND', 'ENOTSOCK', 'EPERM', 'EPIPE', 'EPROTONOSUPPORT', 'ETIMEDOUT']);

/** Only a refusal establishes that the listener stopped accepting connections. */
export function classifyListenerError(code: unknown): boolean {
  if (code === 'ECONNREFUSED') return true;
  if (code === 'ECONNRESET') return false;
  const diagnostic = typeof code === 'string' && diagnosticCodes.has(code) ? code : 'UNKNOWN';
  throw new Error('Could not observe the CLI listener (' + diagnostic + ')');
}

/** Test-only loopback observation; open/reset results require another probe. */
export function listenerRefused(url: string): Promise<boolean> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' ||
      !Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535)
      throw new Error();
  } catch { return Promise.reject(new Error('Could not observe the CLI listener (UNKNOWN)')); }
  return new Promise((resolveRefused, reject) => {
    const socket = createConnection({ host: endpoint.hostname, port: Number(endpoint.port) });
    let finished = false, refused = false, failure: Error | undefined;
    const timer = setTimeout(() => finish(new Error('CLI listener probe timed out')), 500);
    function finish(error?: Error, observedRefusal = false) {
      if (finished) return;
      finished = true; failure = error; refused = observedRefusal;
      clearTimeout(timer);
      socket.off('connect', connected);
      // Keep the error listener through close: a late reset must neither reject
      // an already decided observation nor escape as an unhandled socket error.
      socket.destroy();
    }
    function connected() { finish(); }
    function failed(error: NodeJS.ErrnoException) {
      if (finished) return;
      try { finish(undefined, classifyListenerError(error.code)); }
      catch (failure) { finish(failure as Error); }
    }
    socket.once('connect', connected);
    socket.on('error', failed);
    socket.once('close', () => {
      if (!finished) { finished = true; failure = new Error('Could not observe the CLI listener (UNKNOWN)'); }
      clearTimeout(timer);
      socket.off('connect', connected); socket.off('error', failed);
      if (failure) reject(failure); else resolveRefused(refused);
    });
  });
}
