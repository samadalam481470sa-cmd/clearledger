import { FetchRequest, JsonRpcProvider } from 'ethers';

/** Bound each HTTP exchange so the single settlement worker can retry outages. */
export function createRpcProvider(url: string, timeoutMs = 5000): JsonRpcProvider {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('RPC_TIMEOUT_MS must be an integer from 1 to 60000');
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new Error('RPC_URL must use HTTP or HTTPS');
  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  // Logical payment retries belong to the durable worker, not an opaque HTTP loop.
  request.setThrottleParams({ maxAttempts: 1 });
  return new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
}
