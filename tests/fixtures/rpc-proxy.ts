import { createServer } from 'node:http';
import { once } from 'node:events';

type Fault = 'http-503' | 'drop' | 'stall' | 'forward-then-drop';
type RpcCall = { method: string; params?: unknown[]; id: unknown; jsonrpc: string };

/** Test-only transport proxy: all successful calls reach the real development EVM. */
export async function rpcProxy(upstream: string) {
  const calls: RpcCall[] = [];
  const faults = new Map<string, { mode: Fault; remaining: number }>();
  const forwarded = new Map<string, () => void>();
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(body) as RpcCall | RpcCall[];
      const batch = Array.isArray(payload) ? payload : [payload];
      calls.push(...batch);
      const fault = batch.map(call => faults.get(call.method)).find(f => f && f.remaining > 0);
      if (fault) {
        fault.remaining--;
        if (fault.mode === 'http-503') {
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('Injected upstream outage');
          return;
        }
        if (fault.mode === 'drop') { res.destroy(); return; }
        // Do not reply. The client's real HTTP timeout must release the worker.
        if (fault.mode === 'stall') return;
      }
      const response = await fetch(upstream, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(3000)
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      for (const call of batch) forwarded.get(call.method)?.();
      // The EVM accepted the request, but the client never receives its response.
      if (fault?.mode === 'forward-then-drop') { res.destroy(); return; }
      if (!res.destroyed) {
        res.writeHead(response.status, { 'Content-Type': 'application/json' });
        res.end(bytes);
      }
    } catch {
      if (!res.destroyed) { res.writeHead(502); res.end('Proxy upstream unavailable'); }
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: 'http://127.0.0.1:' + (server.address() as any).port,
    calls,
    fail(method: string, mode: Fault, count = Infinity) { faults.set(method, { mode, remaining: count }); },
    afterForward(method: string, action: () => void) { forwarded.set(method, action); },
    heal() { faults.clear(); forwarded.clear(); },
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
