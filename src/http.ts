import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { z, ZodError } from 'zod';
import { Conflict, PaginationError } from './store.ts';
import { PaymentService } from './service.ts';

interface HttpOptions {
  service: PaymentService; apiKey: string; port: number; mode: 'demo' | 'rpc';
  demoPayment?: (amount: string) => Promise<unknown>;
  demoInfo?: Record<string, unknown>;
}
const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(512).optional(),
  status: z.enum(['queued', 'broadcast', 'settled', 'failed', 'review']).optional()
}).strict();
function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new Error('Request body exceeds 32 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function authenticated(req: IncomingMessage, key: string) {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function makeServer(options: HttpOptions) {
  const { service, apiKey, mode } = options;
  const rate = new Map<string, { started: number; count: number }>();
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
    const host = req.headers.host ?? '';
    const actualPort = (server.address() as any)?.port;
    const hosts = ['127.0.0.1:' + actualPort, 'localhost:' + actualPort];
    if (!hosts.includes(host)) { json(res, 403, { error: 'Unrecognized host' }); return; }
    if (req.headers.origin && !hosts.some(h => req.headers.origin === 'http://' + h)) {
      json(res, 403, { error: 'Cross-origin request rejected' }); return;
    }
    const url = new URL(req.url ?? '/', 'http://' + host);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        await service.provider.getBlockNumber();
        json(res, 200, { status: 'ok', mode }); return;
      }
      // Demo only: ephemeral token is delivered to same-origin local dashboard.
      if (req.method === 'GET' && url.pathname === '/api/bootstrap' && mode === 'demo') {
        json(res, 200, { apiKey, ...options.demoInfo }); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(req, apiKey)) { json(res, 401, { error: 'Bearer token required' }); return; }
        const client = req.socket.remoteAddress ?? 'local';
        const now = Date.now(), old = rate.get(client);
        const counter = !old || now - old.started >= 60000 ? { started: now, count: 0 } : old;
        rate.set(client, counter);
        if (++counter.count > 240) { json(res, 429, { error: 'Rate limit exceeded' }); return; }
        if (req.method === 'GET' && url.pathname === '/api/overview') {
          const block = await service.provider.getBlock('latest');
          const payments = service.store.list().map(r => service.publicRow(r));
          json(res, 200, { mode, chainId: service.chainId, router: service.routerAddress,
            domain: service.signingDomain, block: block ? { number: block.number, hash: block.hash, timestamp: block.timestamp } : null,
            payments, journals: service.store.journals(100), audit: service.store.events(),
            confirmations: service.confirmations, ...options.demoInfo }); return;
        }
        if (req.method === 'GET' && (url.pathname === '/api/payments' || url.pathname === '/api/journals')) {
          const parameters = [...url.searchParams];
          if (new Set(parameters.map(([key]) => key)).size !== parameters.length)
            throw new PaginationError('Duplicate query parameter');
          const query = paginationQuery.parse(Object.fromEntries(parameters));
          if (url.pathname === '/api/journals') {
            if (query.status !== undefined) throw new PaginationError('Journal pages do not support a status filter');
            json(res, 200, service.store.pageJournals(query));
          } else {
            const page = service.store.pagePayments(query);
            json(res, 200, { ...page, items: page.items.map(row => service.publicRow(row)) });
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/totals') {
          json(res, 200, { assets: service.store.assetTotals() }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/payments') {
          const result = await service.accept(await body(req));
          json(res, result.replay ? 200 : 202, { replay: result.replay, payment: service.publicRow(result.row) }); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reconcile') {
          json(res, 200, await service.reconcile()); return;
        }
        if (req.method === 'POST' && url.pathname === '/api/demo/payment' && options.demoPayment) {
          const input = await body(req);
          if (typeof input?.amount !== 'string' || !/^[0-9]{1,7}(\.[0-9]{1,6})?$/.test(input.amount))
            throw new Error('Enter a decimal amount with at most six decimal places');
          json(res, 202, await options.demoPayment(input.amount)); return;
        }
        json(res, 404, { error: 'Route not found' }); return;
      }
      if (req.method !== 'GET') { json(res, 405, { error: 'Method not allowed' }); return; }
      const path = resolve('dist', '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
      if (!path.startsWith(resolve('dist') + '/') && !path.startsWith(resolve('dist') + '\\')) {
        json(res, 404, { error: 'Not found' }); return;
      }
      if (!existsSync(path)) { json(res, 404, { error: 'Build the dashboard with npm run build' }); return; }
      const type: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': type[extname(path)] ?? 'application/octet-stream' });
      res.end(readFileSync(path));
    } catch (e: any) {
      const status = e instanceof Conflict ? 409 : e instanceof ZodError || e instanceof SyntaxError || e instanceof PaginationError ? 400 :
        e.code === 'NETWORK_ERROR' || e.code === 'SERVER_ERROR' ? 503 : 422;
      json(res, status, { error: e instanceof ZodError ? 'Invalid payment payload' : (e.shortMessage ?? e.message ?? 'Request failed').slice(0, 300) });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

