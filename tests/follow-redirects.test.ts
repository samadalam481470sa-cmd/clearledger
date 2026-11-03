import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions } from 'node:http';
import { createRequire } from 'node:module';
import { type Socket } from 'node:net';
import { runInNewContext } from 'node:vm';

// Exercise the actual transitive library resolved from solc's wrapper without
// loading a compiler or calling solc.loadRemoteVersion. All traffic and header
// values are synthetic and loopback-only; this is not a ClearLedger exploit.
const projectRequire = createRequire(import.meta.url);
const compilerRequire = createRequire(projectRequire.resolve('solc/wrapper.js'));
const dependency = compilerRequire('follow-redirects') as {
  http: { get(url: string, options: RequestOptions & { sensitiveHeaders: string[]; maxRedirects: number },
    callback: (response: IncomingMessage) => void): ClientRequest }
};
const dependencyVersion = (compilerRequire('follow-redirects/package.json') as { version: string }).version;
const credentialHeader = 'x-clearledger-synthetic-credential', harmlessHeader = 'x-clearledger-test-trace';
const credential = 'SYNTHETIC_DEPENDENCY_TEST_CREDENTIAL', harmless = 'harmless-loopback-trace';

async function bounded<T>(pending: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Loopback redirect checkpoint timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const headerForm of ['object', 'array'] as const) for (const crossRealm of [false, true]) {
  test('solc redirect dependency strips custom credentials with a ' + (crossRealm ? 'cross-realm' : 'same-realm') +
    ' sensitiveHeaders list and ' + headerForm + ' headers', { timeout: 7000 }, async t => {
    const sensitiveHeaders: string[] = crossRealm
      ? runInNewContext(JSON.stringify([credentialHeader])) as string[] : [credentialHeader];
    assert.equal(Array.isArray(sensitiveHeaders), true);
    assert.equal(sensitiveHeaders instanceof Array, !crossRealm);
    const sourceRequests: IncomingHttpHeaders[] = [], targetRequests: IncomingHttpHeaders[] = [];
    const sockets = new Set<Socket>(), requests: ClientRequest[] = [], responses: IncomingMessage[] = [];
    let targetUrl = '';
    const target = createServer((req, res) => {
      targetRequests.push({ ...req.headers });
      res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' }); res.end('ok');
    });
    const source = createServer((req, res) => {
      sourceRequests.push({ ...req.headers });
      res.writeHead(302, { Location: targetUrl, Connection: 'close' }); res.end();
    });
    for (const server of [source, target]) server.on('connection', socket => {
      sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    });
    try {
      target.listen(0, '127.0.0.1'); await bounded(once(target, 'listening'));
      targetUrl = 'http://127.0.0.1:' + (target.address() as { port: number }).port + '/target';
      source.listen(0, '127.0.0.1'); await bounded(once(source, 'listening'));
      const sourceUrl = 'http://127.0.0.1:' + (source.address() as { port: number }).port + '/redirect';
      assert.notEqual(new URL(sourceUrl).origin, new URL(targetUrl).origin);
      const headers = headerForm === 'object'
        ? { [credentialHeader]: credential, [harmlessHeader]: harmless }
        : [credentialHeader, credential, harmlessHeader, harmless];
      const result = await bounded(new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
        const request = dependency.http.get(sourceUrl, { headers, sensitiveHeaders, maxRedirects: 1, agent: false }, response => {
          responses.push(response);
          let body = '';
          response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
          response.once('error', reject);
          response.once('end', () => resolve({ status: response.statusCode, body }));
        });
        requests.push(request);
        request.once('error', reject);
        request.setTimeout(2000, () => request.destroy(new Error('Loopback redirect request timed out')));
      }));
      assert.deepEqual(result, { status: 200, body: 'ok' });
      assert.equal(sourceRequests.length, 1); assert.equal(targetRequests.length, 1);
      assert.equal(sourceRequests[0][credentialHeader], credential, 'The source must receive the synthetic credential');
      assert.equal(sourceRequests[0][harmlessHeader], harmless);
      assert.equal(targetRequests[0][harmlessHeader], harmless, 'Unrelated headers must survive redirection');
      t.diagnostic(JSON.stringify({ dependencyVersion, headerForm, crossRealm,
        sensitiveArrayIsArray: Array.isArray(sensitiveHeaders), sensitiveArrayInstanceofArray: sensitiveHeaders instanceof Array,
        sourceRequests: sourceRequests.length, targetRequests: targetRequests.length,
        credentialForwarded: targetRequests[0][credentialHeader] !== undefined, harmlessHeaderPreserved: true }));
      assert.equal(targetRequests[0][credentialHeader], undefined, 'Cross-origin redirect exposed a custom sensitive header');
    } finally {
      // Destroy all tracked native resources even when the header assertion
      // fails, so the vulnerable baseline cannot leak sockets or keep Node alive.
      for (const request of requests) request.destroy();
      for (const response of responses) response.destroy();
      for (const socket of sockets) socket.destroy();
      const closed = await Promise.allSettled([source, target].map(async server => {
        server.closeAllConnections();
        if (server.listening) await bounded(new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        }));
      }));
      const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Loopback redirect cleanup failed');
    }
  });
}
