import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, StateTransitionError, type Status } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

// Synthetic durable-state fixtures; these tests make no EVM settlement claim.
const payer = '0x' + '11'.repeat(20);
const payee = '0x' + '22'.repeat(20);
const token = '0x' + '33'.repeat(20);
const raw = '0x123456';
const tx = '0x' + '44'.repeat(32);
const block = 17;
const blockHash = '0x' + '55'.repeat(32);
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

function queued(n = 1) {
  const payment: Payment = {
    paymentId: '0x' + n.toString(16).padStart(64, '0'), payer, payee, token,
    amount: '123456789012345678901234567890', nonce: String(n - 1), deadline: '2000000000'
  };
  return store.accept(payment, 'fingerprint-' + n, 'signature-' + n).row.id;
}
function at(status: Status, n = 1) {
  const id = queued(n);
  if (status === 'broadcast' || status === 'settled' || status === 'review') store.broadcast(id, raw, tx);
  if (status === 'settled') store.finalize(id, block, blockHash);
  if (status === 'failed' || status === 'review') store.setStatus(id, status, 'fixture reason');
  return id;
}
function snapshot(id: string) {
  return { row: store.get(id), journals: store.journals(), events: store.events() };
}
function rejectedWithoutMutation(id: string, action: () => void) {
  const before = snapshot(id);
  assert.throws(action, StateTransitionError);
  assert.deepEqual(snapshot(id), before);
}

test('unknown payment mutations cannot create orphan audit entries', () => {
  const unknown = payer + ':0x' + '99'.repeat(32);
  for (const action of [
    () => store.broadcast(unknown, raw, tx),
    () => store.finalize(unknown, block, blockHash),
    () => store.setStatus(unknown, 'failed', 'missing'),
    () => store.setStatus(unknown, 'review', 'missing')
  ]) rejectedWithoutMutation(unknown, action);
  assert.equal(store.events().length, 0);
  assert.equal(store.journals().length, 0);
});

test('identical broadcast retry preserves the row and emits no duplicate audit', () => {
  const id = at('broadcast');
  const before = snapshot(id);
  for (let i = 0; i < 4; i++) store.broadcast(id, raw, tx);
  assert.deepEqual(snapshot(id), before);
  assert.equal(store.events().filter(event => event.action === 'broadcast-prepared').length, 1);
});

test('conflicting signed bytes or transaction hash cannot replace a reserved broadcast', () => {
  const id = at('broadcast');
  rejectedWithoutMutation(id, () => store.broadcast(id, '0xabcdef', tx));
  rejectedWithoutMutation(id, () => store.broadcast(id, raw, '0x' + '77'.repeat(32)));
  rejectedWithoutMutation(id, () => store.broadcast(id, '0xabcdef', '0x' + '77'.repeat(32)));
});

for (const status of ['failed', 'review', 'settled'] as const) {
  test('broadcast cannot rewrite a ' + status + ' record even with matching signed bytes', () => {
    const id = at(status);
    rejectedWithoutMutation(id, () => store.broadcast(id, raw, tx));
  });
}

for (const status of ['queued', 'failed', 'review'] as const) {
  test('finalization cannot manufacture settlement from ' + status, () => {
    const id = at(status);
    rejectedWithoutMutation(id, () => store.finalize(id, block, blockHash));
  });
}

test('identical finalization retry preserves one matching journal and one audit event', () => {
  const id = at('settled');
  const before = snapshot(id);
  for (let i = 0; i < 4; i++) store.finalize(id, block, blockHash);
  assert.deepEqual(snapshot(id), before);
  assert.equal(store.journals().length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
});

test('settled block provenance cannot be silently changed on retry', () => {
  const id = at('settled');
  rejectedWithoutMutation(id, () => store.finalize(id, block + 1, blockHash));
  rejectedWithoutMutation(id, () => store.finalize(id, block, '0x' + '66'.repeat(32)));
});

test('an exact pre-existing broadcast journal is retained when finalization completes', () => {
  const id = at('broadcast');
  store.db.prepare('INSERT INTO journals VALUES(?,?,?,?,?,?,?,?)')
    .run(id, token, payer, payee, JSON.parse(store.get(id)!.payload).amount, tx, block, blockHash);
  const before = store.db.prepare('SELECT *,rowid FROM journals WHERE payment_id=?').get(id);
  store.finalize(id, block, blockHash);
  assert.equal(store.get(id)!.status, 'settled');
  assert.deepEqual(store.db.prepare('SELECT *,rowid FROM journals WHERE payment_id=?').get(id), before);
  assert.equal(store.journals().length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  store.finalize(id, block, blockHash);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  // A second write succeeds, proving both the transition and no-op closed their transaction.
  assert.equal(store.get(queued(2))!.status, 'queued');
});

const divergentJournalFields = {
  token: '0x' + '88'.repeat(20),
  debit_account: payee,
  credit_account: payer,
  amount: '1',
  tx_hash: '0x' + '99'.repeat(32),
  block_number: block + 1,
  block_hash: '0x' + 'aa'.repeat(32)
};
for (const [field, value] of Object.entries(divergentJournalFields)) {
  test('divergent pre-existing journal ' + field + ' is never ignored or overwritten', () => {
    const id = at('broadcast');
    store.db.prepare('INSERT INTO journals VALUES(?,?,?,?,?,?,?,?)')
      .run(id, token, payer, payee, JSON.parse(store.get(id)!.payload).amount, tx, block, blockHash);
    // Field names are a fixed fixture table, never user input.
    store.db.prepare('UPDATE journals SET ' + field + '=? WHERE payment_id=?').run(value, id);
    rejectedWithoutMutation(id, () => store.finalize(id, block, blockHash));
    assert.equal(store.get(id)!.status, 'broadcast');
    assert.equal(store.journals().length, 1);
  });
}

test('settled retry detects a missing or corrupted journal rather than asserting success', () => {
  const id = at('settled');
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('999', id);
  rejectedWithoutMutation(id, () => store.finalize(id, block, blockHash));
  store.db.prepare('DELETE FROM journals WHERE payment_id=?').run(id);
  rejectedWithoutMutation(id, () => store.finalize(id, block, blockHash));
});

for (const initial of ['queued', 'broadcast'] as const) {
  test(initial + ' failure and identical truncated-error retry are atomic and idempotent', () => {
    const id = at(initial);
    const error = 'x'.repeat(500);
    store.setStatus(id, 'failed', error + ' first ignored suffix');
    assert.equal(store.get(id)!.status, 'failed');
    assert.equal(store.get(id)!.error, error);
    const before = snapshot(id);
    store.setStatus(id, 'failed', error + ' another ignored suffix');
    assert.deepEqual(snapshot(id), before);
    assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
    rejectedWithoutMutation(id, () => store.setStatus(id, 'failed', 'different failure'));
    rejectedWithoutMutation(id, () => store.setStatus(id, 'review', 'later review'));
  });
}

for (const initial of ['broadcast', 'settled'] as const) {
  test(initial + ' review preserves existing journals and ignores identical retries', () => {
    const id = at(initial);
    const priorJournals = store.journals();
    store.setStatus(id, 'review', 'canonical block mismatch');
    const before = snapshot(id);
    store.setStatus(id, 'review', 'canonical block mismatch');
    assert.deepEqual(snapshot(id), before);
    assert.deepEqual(store.journals(), priorJournals);
    assert.equal(store.events().filter(event => event.action === 'review').length, 1);
    rejectedWithoutMutation(id, () => store.setStatus(id, 'review', 'different review'));
    rejectedWithoutMutation(id, () => store.setStatus(id, 'failed', 'rewrite review as failure'));
    rejectedWithoutMutation(id, () => store.finalize(id, block, blockHash));
  });
}

test('queued review and settled failure are invalid transitions without side effects', () => {
  const queuedId = at('queued', 1);
  const settledId = at('settled', 2);
  rejectedWithoutMutation(queuedId, () => store.setStatus(queuedId, 'review', 'premature review'));
  rejectedWithoutMutation(settledId, () => store.setStatus(settledId, 'failed', 'erase settlement'));
});

test('audit insertion failure rolls back first broadcast and permits a clean retry', () => {
  const id = at('queued');
  store.db.exec("CREATE TRIGGER reject_broadcast_audit BEFORE INSERT ON audit WHEN NEW.action='broadcast-prepared' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END");
  const before = snapshot(id);
  assert.throws(() => store.broadcast(id, raw, tx), /injected audit failure/);
  assert.deepEqual(snapshot(id), before);
  store.db.exec('DROP TRIGGER reject_broadcast_audit');
  store.broadcast(id, raw, tx);
  assert.equal(store.get(id)!.status, 'broadcast');
  assert.equal(store.events().filter(event => event.action === 'broadcast-prepared').length, 1);
});
