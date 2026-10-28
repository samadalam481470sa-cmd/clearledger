import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { classifyListenerError, listenerRefused } from './fixtures/listener-probe.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native listener fixture checkpoint timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
async function withListener(accept: (socket: Socket) => void,
  run: (url: string, stop: () => Promise<void>) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    accept(socket);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await within(new Promise<void>((resolveClose, rejectClose) =>
      server.close(error => error ? rejectClose(error) : resolveClose())));
  };
  try { await run('http://127.0.0.1:' + (server.address() as { port: number }).port, stop); }
  finally { await stop(); }
}

test('a native open loopback listener is not reported as refused', { timeout: 5000 }, async () => {
  const accepted = deferred();
  await withListener(() => accepted.resolve(), async url => {
    assert.equal(await within(listenerRefused(url)), false);
    await within(accepted.promise);
  });
});

test('a native reset-on-accept listener never supplies refusal evidence', { timeout: 5000 }, async () => {
  const resetClosed = deferred();
  let resets = 0;
  await withListener(socket => {
    socket.once('close', () => resetClosed.resolve());
    resets++; socket.resetAndDestroy();
  }, async url => {
    // OS scheduling may deliver connect or reset first. Both are inconclusive;
    // the deterministic classification check below separately covers RESET.
    assert.equal(await within(listenerRefused(url)), false);
    await within(resetClosed.promise);
    assert.equal(resets, 1);
  });
});

test('a closed native loopback listener supplies actual connection-refused evidence', { timeout: 5000 }, async () => {
  await withListener(() => {}, async (url, stop) => {
    await stop();
    assert.equal(await within(listenerRefused(url)), true);
  });
});

test('reset classification remains inconclusive while connection-refused is affirmative', () => {
  assert.equal(classifyListenerError('ECONNRESET'), false);
  assert.equal(classifyListenerError('ECONNREFUSED'), true);
});

test('unexpected known system errors fail with only their fixed allowlisted code', () => {
  for (const code of ['EHOSTUNREACH', 'EACCES', 'EMFILE', 'ETIMEDOUT'])
    assert.throws(() => classifyListenerError(code), { message: 'Could not observe the CLI listener (' + code + ')' });
});

test('arbitrary error-code diagnostics are redacted rather than reclassified as refusal', async () => {
  for (const code of ['PRIVATE_RPC_CREDENTIAL_SENTINEL', 'https://user:private@rpc.invalid', undefined,
    { toString() { throw new Error('Do not stringify private diagnostics'); } }])
    assert.throws(() => classifyListenerError(code), { message: 'Could not observe the CLI listener (UNKNOWN)' });
  await assert.rejects(listenerRefused('https://user:private@rpc.invalid'),
    { message: 'Could not observe the CLI listener (UNKNOWN)' });
});
