import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectDetails } from '../web/project-details.tsx';
import { makeServer } from '../src/http.ts';
import type { PaymentService } from '../src/service.ts';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Project Details explains source code, implemented features, and readiness limits without a session', () => {
  const html = renderToStaticMarkup(createElement(ProjectDetails));
  for (const text of ['ClearLedger', 'EIP-712', 'Reconcile', 'SQLite',
    'React 19', 'Node.js 24', 'Solidity', 'QBFT', 'not a payment processor',
    'production', 'npm run demo']) {
    assert.ok(html.toLowerCase().includes(text.toLowerCase()), 'Missing project detail: ' + text);
  }
  assert.match(html, /href="https:\/\/github\.com\/samadalam481470sa-cmd\/clearledger"/);
  assert.doesNotMatch(html, /api\/bootstrap|Bearer |Authorization|private.key/i);
});

test('GET /details serves the dashboard shell without requiring a payment token', async () => {
  // The server resolves static assets against the working directory. Run the
  // test in an isolated fixture instead of depending on a previously built dist/.
  const original = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), 'clearledger-details-'));
  let server: ReturnType<typeof makeServer> | undefined;
  try {
    mkdirSync(join(temp, 'dist'));
    writeFileSync(join(temp, 'dist', 'index.html'),
      '<!doctype html><title>ClearLedger static application shell</title>');
    process.chdir(temp);
    server = makeServer({ service: {} as PaymentService,
      apiKey: 'local-test-token', port: 0, mode: 'rpc' });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const details = await fetch(url + '/details');
    assert.equal(details.status, 200);
    assert.match(await details.text(), /ClearLedger static application shell/);
    const home = await fetch(url + '/');
    assert.equal(home.status, 200);
    assert.match(await home.text(), /ClearLedger static application shell/);
    const api = await fetch(url + '/api/payments');
    assert.equal(api.status, 401, 'Public details must not bypass API authentication');
    const missing = await fetch(url + '/not-real');
    assert.equal(missing.status, 404);
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    process.chdir(original);
    rmSync(temp, { recursive: true, force: true });
  }
});
