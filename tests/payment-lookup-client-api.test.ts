import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { id, type JsonRpcProvider, type Wallet } from 'ethers';
import { makeServer } from '../src/http.ts';
import { paymentSchema, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store, type Status } from '../src/store.ts';
import { CursorPager, pagePath, type CursorPage, type PaymentRow } from '../web/dashboard.ts';
import { PaymentLookup, PAYMENT_LOOKUP_NOT_FOUND, type PaymentLookupSnapshot, type PaymentLookupState } from '../web/payment-lookup.ts';

// Actual native HTTP, SQLite and the dashboard controller. Records and upstream
// failures are synthetic; this does not mount React or execute EVM transactions.
const apiKey = 'payment-lookup-client-' + 'a'.repeat(32);
const privateMarker = 'LOOKUP_CLIENT_PRIVATE_SENTINEL';
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const invalidAuthorization = 'Stored payment data is invalid; verify the original authorization';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within<T>(pending: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), 3000);
    })]);
  } finally { clearTimeout(timer); }
}
function payment(n: number): Payment {
  return paymentSchema.parse({ paymentId: id('lookup-client-payment-' + n), payer: '0x' + 'ab'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: '0x' + 'cd'.repeat(20), amount: '125000000',
    nonce: String(n - 1), deadline: '2000000000' });
}
function seed(store: Store, n: number, status: Status = 'queued') {
  const row = store.accept(payment(n), privateMarker + '_fingerprint_' + n, privateMarker + '_signature_' + n).row;
  if (status === 'settled' || status === 'review') {
    store.broadcast(row.id, privateMarker + '_raw_' + n, id('lookup-client-native-' + n));
    store.finalize(row.id, n, blockHash);
    if (status === 'review') store.setStatus(row.id, 'review', 'Synthetic history fixture');
  }
  return row.id;
}
function snapshot(store: Store) {
  const queries = {
    schema: 'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name',
    payments: 'SELECT rowid,* FROM payments ORDER BY rowid', journals: 'SELECT rowid,* FROM journals ORDER BY rowid',
    audit: 'SELECT * FROM audit ORDER BY sequence', sequence: 'SELECT * FROM sqlite_sequence ORDER BY name',
    changes: 'SELECT total_changes() AS changes'
  };
  const rows = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, store.db.prepare(sql).all()]));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

test('the exact-ID client reads old and corrupt local history during RPC failure without changing cursor history', {
  timeout: 20000
}, async t => {
  const store = new Store();
  let server: ReturnType<typeof makeServer> | undefined, forwarder: ReturnType<typeof createServer> | undefined;
  let lookup: PaymentLookup | undefined, timeoutLookup: PaymentLookup | undefined, pager: CursorPager<PaymentRow> | undefined;
  let onReadHeaders: (() => void) | undefined;
  let rpcCalls = 0, activeKey = apiKey;
  const clientOperations: Promise<unknown>[] = [], forwarding = new Set<Promise<void>>();
  const gates: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred>; body: boolean }[] = [];
  let held: typeof gates[number] | undefined;
  const requests: { method: string; path: string }[] = [];
  const statuses: number[] = [], states: PaymentLookupState[] = [], found: PaymentLookupSnapshot[] = [];
  const lookupPaths: string[] = [], lookupSignals: AbortSignal[] = [], pagePaths: string[] = [];
  const track = <T>(pending: Promise<T>) => { void pending.catch(() => {}); clientOperations.push(pending); return pending; };
  try {
    const oldId = seed(store, 1, 'settled'), corruptId = seed(store, 2, 'review');
    for (let n = 3; n <= 107; n++) seed(store, n);
    store.db.exec('ALTER TABLE payments ADD COLUMN private_note TEXT');
    store.db.prepare('UPDATE payments SET private_note=?').run(privateMarker + '_unknown_column');
    store.db.prepare('UPDATE payments SET payload=? WHERE id=?').run('{' + privateMarker + '_invalid_json', corruptId);
    assert.equal(store.list(100).some(row => row.id === oldId || row.id === corruptId), false);
    const unavailable = async () => {
      rpcCalls++;
      throw Object.assign(new Error('Synthetic RPC unavailable'), { code: 'NETWORK_ERROR' });
    };
    const provider = { getBlock: unavailable, getBlockNumber: unavailable, getTransactionReceipt: unavailable };
    const router = { connect() { return this; } };
    const service = new PaymentService(store, provider as unknown as JsonRpcProvider, {} as Wallet, router, 31337, routerAddress);
    server = makeServer({ service, apiKey, mode: 'rpc', port: 0 });
    server.listen(0, '127.0.0.1'); await within(once(server, 'listening'), 'History server readiness');
    const origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    // Hold a real upstream response after reading its body. Reset/dispose must
    // abort the still-pending native client fetch and suppress its old snapshot.
    forwarder = createServer((req, res) => {
      const operation = (async () => {
        const path = req.url ?? '/'; requests.push({ method: req.method ?? '', path });
        const gate = held; held = undefined;
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(3000),
          headers: { Authorization: req.headers.authorization ?? '' } });
        const text = await response.text();
        if (gate?.body) {
          const split = Math.floor(text.length / 2);
          res.writeHead(response.status, { 'Content-Type': 'application/json' });
          res.write(text.slice(0, split));
          gate.entered.resolve(); await gate.release.promise;
          if (!res.destroyed) res.end(text.slice(split));
          return;
        }
        if (gate) { gate.entered.resolve(); await gate.release.promise; }
        if (!res.destroyed) { res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(text); }
      })().catch(() => { if (!res.destroyed) { res.writeHead(502); res.end('{"error":"Test response forwarding failed"}'); } });
      forwarding.add(operation); void operation.finally(() => forwarding.delete(operation));
    });
    forwarder.listen(0, '127.0.0.1'); await within(once(forwarder, 'listening'), 'Client forwarder readiness');
    const url = 'http://127.0.0.1:' + (forwarder.address() as { port: number }).port;
    async function read(path: string, signal: AbortSignal) {
      const response = await fetch(url + '/api/' + path, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), headers: { Authorization: 'Bearer ' + activeKey }
      });
      onReadHeaders?.();
      const text = await response.text();
      assert.ok(!text.includes(privateMarker), 'A local history response exposed private persisted evidence');
      statuses.push(response.status);
      return { status: response.status, body: JSON.parse(text) as any };
    }
    async function load(path: string, signal: AbortSignal) {
      const result = await read(path, signal);
      if (result.status !== 200) throw Object.assign(new Error(result.body.error), { status: result.status });
      return result.body;
    }
    pager = new CursorPager<PaymentRow>(async (cursor, signal) => {
      const path = pagePath('payments', cursor, 'queued'); pagePaths.push(path);
      return load(path, signal) as Promise<CursorPage<PaymentRow>>;
    }, () => {});
    assert.equal(await track(pager.refresh()), true); assert.equal(await track(pager.next()), true);
    assert.equal(pager.state.page, 2); assert.equal(pager.state.items.length, 25);
    const pageBefore = JSON.stringify(pager.state), pagesBefore = [...pagePaths], privateBefore = snapshot(store);
    assert.ok(pagePaths.every(path => path.includes('status=queued')));
    const failedOverview = await track(read('overview', new AbortController().signal));
    assert.equal(failedOverview.status, 503);
    assert.deepEqual(failedOverview.body, { error: 'Upstream RPC unavailable; check payment history before retrying' });
    assert.equal(rpcCalls, 1);
    lookup = new PaymentLookup((path, signal) => {
      lookupPaths.push(path); lookupSignals.push(signal);
      return load(path, signal) as Promise<PaymentRow>;
    }, state => states.push(state), result => found.push(result), () => new Date('2026-11-03T12:00:00.000Z'));
    lookup.setInput(oldId); assert.equal(await track(lookup.find()), true);
    assert.equal(lookup.state.phase, 'found'); assert.equal(found.length, 1);
    assert.equal(found[0].capturedAt, '2026-11-03T12:00:00.000Z');
    assert.deepEqual(found[0].row, service.publicRow(store.get(oldId)!));
    assert.deepEqual(found[0].row.payment, payment(1));
    for (const field of ['raw_tx', 'signature', 'fingerprint', 'payload', 'private_note'])
      assert.equal(Object.hasOwn(found[0].row, field), false);
    assert.equal(lookupPaths[0], 'payments/' + encodeURIComponent(oldId));
    assert.ok(lookupPaths[0].includes('%3A')); assert.ok(!lookupPaths[0].includes('?'));
    lookup.setInput(corruptId); assert.equal(await track(lookup.find()), true);
    assert.equal(found.length, 2); assert.equal(found[1].row.payment, null);
    assert.equal(found[1].row.integrityError, invalidAuthorization); assert.equal(found[1].row.status, 'review');
    const unknownId = payment(999).payer.toLowerCase() + ':' + payment(999).paymentId;
    lookup.setInput(unknownId); assert.equal(await track(lookup.find()), false);
    assert.equal(lookup.state.phase, 'not-found'); assert.equal(lookup.state.snapshot, null);
    assert.equal(lookup.state.error, PAYMENT_LOOKUP_NOT_FOUND); assert.equal(statuses.at(-1), 404);
    assert.equal(found.length, 2);
    activeKey = 'incorrect-test-token'; lookup.setInput(oldId);
    assert.equal(await track(lookup.find()), false); assert.equal(statuses.at(-1), 401);
    assert.equal(lookup.state.phase, 'error'); assert.equal(lookup.state.error, 'Bearer token required');
    assert.equal(lookup.state.snapshot, null); assert.equal(found.length, 2);
    activeKey = apiKey;
    assert.equal(await track(lookup.find()), true); assert.equal(found.length, 3);
    assert.deepEqual(found[2].row, found[0].row);
    function arm(body = false) { const gate = { entered: deferred(), release: deferred(), body }; gates.push(gate); held = gate; return gate; }
    const resetGate = arm(); lookup.setInput(oldId);
    const resetPending = track(lookup.find()); await within(resetGate.entered.promise, 'Reset lookup response');
    const resetSignal = lookupSignals.at(-1)!; assert.equal(resetSignal.aborted, false);
    lookup.reset(); assert.equal(resetSignal.aborted, true);
    assert.deepEqual(lookup.state, { id: '', phase: 'idle', error: '', snapshot: null });
    resetGate.release.resolve(); assert.equal(await within(resetPending, 'Reset lookup cancellation'), false);
    assert.equal(found.length, 3);
    const disposeGate = arm(); lookup.setInput(corruptId);
    const disposePending = track(lookup.find()); await within(disposeGate.entered.promise, 'Disposed lookup response');
    const updatesBeforeDispose = states.length; lookup.dispose();
    assert.equal(lookupSignals.at(-1)!.aborted, true);
    disposeGate.release.resolve(); assert.equal(await within(disposePending, 'Disposed lookup cancellation'), false);
    assert.equal(states.length, updatesBeforeDispose); assert.equal(found.length, 3);
    assert.equal(await track(lookup.find()), false);
    await within(Promise.all([...forwarding]), 'Response forwarding completion');
    // Send genuine HTTP headers and half a valid response before withholding the
    // remainder. The lookup deadline must cover body consumption, not only fetch.
    const bodyGate = arm(true), receivedHeaders = deferred(), abortedBody = deferred();
    const timeoutFound: PaymentLookupSnapshot[] = [], timeoutStates: PaymentLookupState[] = [];
    onReadHeaders = () => receivedHeaders.resolve();
    timeoutLookup = new PaymentLookup((path, signal) => {
      lookupPaths.push(path); lookupSignals.push(signal);
      return load(path, signal).catch(error => { if (signal.aborted) abortedBody.resolve(); throw error; });
    }, state => timeoutStates.push(state), result => timeoutFound.push(result), undefined, 500);
    timeoutLookup.setInput(oldId);
    const beforeTimeoutRequests = requests.length;
    const timeoutPending = track(timeoutLookup.find());
    await within(bodyGate.entered.promise, 'Held HTTP body');
    await within(receivedHeaders.promise, 'Received HTTP response headers');
    assert.equal(timeoutLookup.state.phase, 'loading');
    assert.equal(await within(timeoutPending, 'Payment lookup body deadline'), false);
    await within(abortedBody.promise, 'Native response body cancellation');
    assert.equal(lookupSignals.at(-1)!.aborted, true);
    assert.deepEqual(timeoutLookup.state, {
      id: oldId, phase: 'error', error: 'Payment lookup timed out. Try this ID again.', snapshot: null
    });
    assert.equal(timeoutFound.length, 0);
    assert.equal(requests.length, beforeTimeoutRequests + 1, 'Timeout must not issue an automatic retry');
    assert.equal(snapshot(store), privateBefore);
    assert.equal(JSON.stringify(pager.state), pageBefore);
    const timeoutUpdates = timeoutStates.length;
    bodyGate.release.resolve(); onReadHeaders = undefined;
    await within(Promise.all([...forwarding]), 'Timed-out body forwarding cleanup');
    assert.equal(timeoutStates.length, timeoutUpdates);
    assert.equal(timeoutFound.length, 0);
    assert.equal(await track(timeoutLookup.find()), true);
    assert.equal(timeoutFound.length, 1);
    assert.deepEqual(timeoutFound[0].row, found[0].row);
    assert.equal(timeoutLookup.state.id, oldId);
    assert.equal(rpcCalls, 1, 'Exact lookup and cursor reads must not consult the unavailable provider');
    assert.equal(snapshot(store), privateBefore, 'History reads changed schema, rows, journal, audit, sequence or write count');
    assert.equal(JSON.stringify(pager.state), pageBefore); assert.deepEqual(pagePaths, pagesBefore);
    assert.equal(pagePaths.length, 2, 'Lookup must not refresh or traverse the existing filtered pager');
    assert.ok(requests.every(request => request.method === 'GET'));
    assert.equal(requests.filter(request => request.path === '/api/overview').length, 1);
    assert.equal(requests.filter(request => request.path.startsWith('/api/payments/')).length, 9);
    assert.equal(requests.length, 12, 'The controller issued an unrelated request');
    t.diagnostic(JSON.stringify({ syntheticRecords: 107, exactReads: 9, foundCallbacks: found.length + timeoutFound.length,
      lookupRpcCalls: rpcCalls - 1, filteredPage: pager.state.page, pagerLoads: pagePaths.length,
      historyWrites: 0, cancelledNativeRequests: 3, bodyTimeouts: 1, automaticMutations: 0 }));
  } finally {
    lookup?.dispose(); timeoutLookup?.dispose(); pager?.dispose(); for (const gate of gates) gate.release.resolve();
    const failures: unknown[] = [];
    const cleanup = async (action: () => unknown) => { try { await action(); } catch (error) { failures.push(error); } };
    await cleanup(() => within(Promise.allSettled(clientOperations), 'Client lookup cleanup'));
    await cleanup(() => within(Promise.all([...forwarding]), 'Forwarder cleanup'));
    for (const listener of [forwarder, server]) {
      if (!listener) continue;
      await cleanup(() => listener.closeAllConnections());
      if (listener.listening) await cleanup(() => within(new Promise<void>((done, fail) =>
        listener.close(error => error ? fail(error) : done())), 'History listener close'));
    }
    let drained = !server;
    if (server) await cleanup(() => within(server!.drainRequests().then(() => { drained = true; }), 'History handler drain'));
    if (drained) await cleanup(() => store.close());
    else failures.push(new Error('SQLite retained because history handlers did not drain'));
    if (failures.length) throw new AggregateError(failures, 'Client history HTTP cleanup failed');
  }
});
