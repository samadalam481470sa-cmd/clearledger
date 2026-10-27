import { createServer } from 'node:http';
import { once } from 'node:events';

type Fault = 'http-503' | 'drop' | 'stall' | 'forward-then-drop';
type RpcCall = { method: string; params?: unknown[]; id: unknown; jsonrpc: string };

/** Test-only transport proxy: all successful calls reach the real development EVM. */
export async function rpcProxy(upstream: string) {
  const calls: RpcCall[] = [];
  const methodBatches: string[][] = [];
  const faults = new Map<string, { mode: Fault; remaining: number }>();
  const forwarded = new Map<string, () => void>();
  const pauses = new Map<string, { taken: boolean; enter(): void; wait: Promise<void>; release(): void }>();
  function releasePauses() {
    for (const pause of pauses.values()) pause.release();
    pauses.clear();
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(body) as RpcCall | RpcCall[];
      const batch = Array.isArray(payload) ? payload : [payload];
      calls.push(...batch);
      methodBatches.push(batch.map(call => call.method));
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
      const pause = batch.map(call => pauses.get(call.method)).find(value => value && !value.taken);
      if (pause) {
        pause.taken = true;
        pause.enter();
        await pause.wait;
      }
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
    batches() { return methodBatches.map(batch => [...batch]); },
    fail(method: string, mode: Fault, count = Infinity) { faults.set(method, { mode, remaining: count }); },
    afterForward(method: string, action: () => void) { forwarded.set(method, action); },
    // Hold exactly one successful upstream exchange before returning its bytes.
    // Tests can prove that shutdown waits for a genuine pending RPC operation.
    pauseAfterForward(method: string) {
      pauses.get(method)?.release();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolveEntered => { enter = resolveEntered; });
      const wait = new Promise<void>(resolveRelease => { release = resolveRelease; });
      pauses.set(method, { taken: false, enter, wait, release });
      return { entered, release };
    },
    heal() { faults.clear(); forwarded.clear(); releasePauses(); },
    async close() {
      releasePauses();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}
