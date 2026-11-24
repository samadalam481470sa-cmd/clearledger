import { FetchRequest, JsonRpcProvider, makeError, type Network, type TransactionReceipt,
  type TransactionReceiptParams } from 'ethers';

class ReceiptEvidenceProvider extends JsonRpcProvider {
  override _wrapTransactionReceipt(value: TransactionReceiptParams, network: Network): TransactionReceipt {
    // ethers' receipt formatter drops raw log.removed flags. Validate the raw
    // values first; keep its ordinary formatting and other evidence checks intact.
    if (Array.isArray(value?.logs) && value.logs.some(log => {
      const removed: unknown = log?.removed;
      return removed != null && removed !== false && removed !== 'false';
    })) throw makeError('Receipt contains removed or invalid log evidence', 'BAD_DATA',
      { value: '[redacted receipt log evidence]' });
    return super._wrapTransactionReceipt(value, network);
  }
}

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
  return new ReceiptEvidenceProvider(request, undefined, { cacheTimeout: -1 });
}
