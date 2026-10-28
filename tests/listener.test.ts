import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { listenLoopback } from '../src/listener.ts';

async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('loopback port zero readiness precedes dispatch and exposes the actual assigned port', { timeout: 5000 }, async () => {
  const server = createServer(); let dispatched = false;
  const errors = server.listenerCount('error'), listening = server.listenerCount('listening');
  try {
    const ready = listenLoopback(server, 0).then(() => { assert.equal(server.listening, true); dispatched = true; });
    assert.equal(dispatched, false); await ready;
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    assert.equal(address.address, '127.0.0.1'); assert.ok(address.port > 0 && address.port <= 65535);
    assert.equal(dispatched, true); assert.equal(server.listenerCount('error'), errors);
    assert.equal(server.listenerCount('listening'), listening);
  } finally { await close(server); }
});

test('occupied loopback port rejects before dispatch and preserves caller-owned listeners', { timeout: 5000 }, async () => {
  const occupied = createServer(), server = createServer(); let observedErrors = 0, dispatched = false;
  const observer = () => { observedErrors++; }; server.on('error', observer);
  const listening = server.listeners('listening');
  try {
    await listenLoopback(occupied, 0);
    const address = occupied.address(); assert.ok(address && typeof address !== 'string');
    const ready = listenLoopback(server, address.port).then(() => { dispatched = true; });
    await assert.rejects(ready, error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE');
    assert.equal(dispatched, false); assert.equal(server.listening, false); assert.equal(observedErrors, 1);
    assert.deepEqual(server.listeners('error'), [observer]); assert.deepEqual(server.listeners('listening'), listening);
    assert.equal(occupied.listening, true);
  } finally { await close(server); await close(occupied); }
});

test('synchronous invalid-port failure rejects and removes only readiness listeners', { timeout: 5000 }, async () => {
  const server = createServer(), observer = () => {};
  server.on('error', observer);
  const listening = server.listeners('listening');
  try {
    await assert.rejects(listenLoopback(server, -1), error => (error as NodeJS.ErrnoException).code === 'ERR_SOCKET_BAD_PORT');
    assert.equal(server.listening, false); assert.deepEqual(server.listeners('error'), [observer]);
    assert.deepEqual(server.listeners('listening'), listening);
  } finally { await close(server); }
});

test('a repeated listen attempt rejects without closing the existing caller-owned listener', { timeout: 5000 }, async () => {
  const server = createServer(), observer = () => {};
  server.on('listening', observer);
  const listening = server.listeners('listening');
  try {
    await listenLoopback(server, 0); const address = server.address();
    await assert.rejects(listenLoopback(server, 0), error => (error as NodeJS.ErrnoException).code === 'ERR_SERVER_ALREADY_LISTEN');
    assert.equal(server.listening, true); assert.deepEqual(server.address(), address);
    assert.deepEqual(server.listeners('listening'), listening); assert.equal(server.listenerCount('error'), 0);
  } finally { await close(server); }
});
