import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256, Transaction, Wallet, type JsonRpcProvider } from 'ethers';
import { digest, domain, paymentKey, paymentSchema, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';
import { withFixtureLogsBloom } from './fixtures/signed-settlement.ts';

// Real in-memory SQLite and offline native signatures, with synthetic provider
// and router decisions. No payer-signature, contract-policy or EVM proof is claimed.
const routerAddress = '0x' + '44'.repeat(20), blockHash = '0x' + 'ee'.repeat(32);
const signingDomain = domain(31337, routerAddress), signature = '0x1234';
const nativeSigner = new Wallet('0x' + '01'.repeat(32));
const iface = new Interface([
  'function settle((bytes32 paymentId,address payer,address payee,address token,uint256 amount,uint256 nonce,uint256 deadline) p,bytes signature)',
  'event PaymentSettled(bytes32 indexed paymentId,address indexed payer,address indexed payee,address token,uint256 amount,uint256 nonce)',
  'error PolicyLimit(uint256 amount)'
]);
const independentError = Object.assign(new Error('Synthetic independent RPC uncertainty'), { code: 'NETWORK_ERROR' });
const changedError = 'Stored queued payment changed during preparation; retry';
type Phase = 'preflight' | 'router' | 'relayer' | 'budgetHead' | 'budgetBalance' | 'signing';
let store: Store, worker: PaymentService, first: Payment, second: Payment, firstId: string, secondId: string;
let hook: ((phase: Phase) => Promise<void>) | undefined, firstFailure: unknown;
let calls: { preflight: string[]; router: number; relayer: number; budgetHead: number; budgetBalance: number;
  signing: number; sends: number; receipt: number; head: number; block: number };
let receipt: any;
function payment(n: number) {
  return paymentSchema.parse({ paymentId: '0x' + n.toString(16).padStart(64, '0'),
    payer: '0x' + (n === 1 ? 'ab' : 'cd').repeat(20), payee: '0x' + '22'.repeat(20),
    token: '0x' + 'ef'.repeat(20), amount: '125000000', nonce: '0', deadline: '2000000000' });
}
function snapshot() {
  return JSON.stringify({ payments: store.db.prepare('SELECT * FROM payments ORDER BY rowid').all(),
    journals: store.db.prepare('SELECT * FROM journals ORDER BY rowid').all(),
    audit: store.db.prepare('SELECT * FROM audit ORDER BY sequence').all(),
    sequence: store.db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(),
    schema: store.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),
    changes: store.db.prepare('SELECT total_changes() AS changes').get() });
}
function assertChanged(error: unknown) {
  assert.ok(error instanceof Error); assert.equal(error.message, changedError);
  return true;
}
function mutateAt(target: Phase, change: () => void, failure?: Error) {
  let enabled = true, afterMutation = '';
  hook = async phase => {
    if (!enabled || phase !== target) return;
    enabled = false;
    await Promise.resolve();
    change(); afterMutation = snapshot();
    if (failure) throw failure;
  };
  return () => afterMutation;
}
function rewriteAuthorization() {
  const changed = { ...first, amount: '125000001' };
  store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
    .run(JSON.stringify(changed), digest(changed, signingDomain), firstId);
}
function assertHeld(phase: Phase, afterMutation: string) {
  const expected = {
    preflight: [0, 0, 0, 0, 0], router: [1, 0, 0, 0, 0], relayer: [1, 1, 0, 0, 0],
    budgetHead: [1, 1, 1, 1, 0], budgetBalance: [1, 1, 1, 1, 0], signing: [1, 1, 1, 1, 1]
  }[phase];
  assert.deepEqual([calls.router, calls.relayer, calls.budgetHead, calls.budgetBalance, calls.signing], expected);
  assert.deepEqual(calls.preflight, [firstId]);
  assert.deepEqual([calls.sends, calls.receipt, calls.head, calls.block], [0, 0, 0, 0]);
  assert.ok(afterMutation && snapshot() === afterMutation, 'Preparation changed the exact post-mutation projection');
  assert.equal(store.journals().length, 0);
  assert.equal(store.get(secondId)!.status, 'queued');
  assert.equal(store.get(secondId)!.raw_tx, null); assert.equal(store.get(secondId)!.tx_hash, null);
}
async function healthyRecovery(preserveHook = false) {
  if (!preserveHook) hook = undefined;
  firstFailure = undefined;
  const signedBefore = calls.signing, sendsBefore = calls.sends;
  await assert.rejects(worker.tick(), error => error === independentError);
  const row = store.get(firstId)!;
  assert.equal(row.status, 'settled'); assert.ok(row.raw_tx && row.tx_hash);
  assert.equal(keccak256(row.raw_tx), row.tx_hash);
  const transaction = Transaction.from(row.raw_tx);
  assert.equal(transaction.data, iface.encodeFunctionData('settle', [first, signature]));
  assert.equal(transaction.from, nativeSigner.address); assert.equal(transaction.chainId, 31337n);
  assert.equal(transaction.gasLimit, 220000n);
  assert.equal(store.journal(firstId)?.amount, first.amount); assert.equal(store.journal(firstId)?.tx_hash, row.tx_hash);
  assert.deepEqual(store.events().filter(event => event.payment_id === firstId).map(event => event.action),
    ['settled', 'broadcast-prepared', 'accepted']);
  assert.equal(calls.signing, signedBefore + 1); assert.equal(calls.sends, sendsBefore + 1);
  assert.equal(store.get(secondId)!.status, 'queued'); assert.equal(store.get(secondId)!.raw_tx, null);
  const beforeRepeat = snapshot();
  await assert.rejects(worker.tick(), error => error === independentError);
  assert.ok(snapshot() === beforeRepeat); assert.equal(calls.signing, signedBefore + 1); assert.equal(calls.sends, sendsBefore + 1);
}
beforeEach(() => {
  store = new Store(); first = payment(1); second = payment(2);
  firstId = store.accept(first, digest(first, signingDomain), signature).row.id;
  secondId = store.accept(second, digest(second, signingDomain), signature).row.id;
  hook = undefined; firstFailure = undefined; receipt = null;
  calls = { preflight: [], router: 0, relayer: 0, budgetHead: 0, budgetBalance: 0, signing: 0,
    sends: 0, receipt: 0, head: 0, block: 0 };
  const router = { interface: iface, connect() { return this; }, settle: {
    staticCall: async (p: Payment) => {
      const id = paymentKey(p); calls.preflight.push(id);
      if (id === secondId) throw independentError;
      await hook?.('preflight');
      if (firstFailure !== undefined) throw firstFailure;
    },
    populateTransaction: async (p: Payment, authorization: string) => {
      calls.router++; await hook?.('router');
      return { to: routerAddress, value: 0, data: iface.encodeFunctionData('settle', [p, authorization]) };
    }
  } };
  const relayer = { address: nativeSigner.address,
    populateTransaction: async (request: any) => {
      calls.relayer++; await hook?.('relayer');
      return { ...request, type: 2, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
        chainId: 31337, nonce: 7, gasLimit: 200000 };
    },
    signTransaction: async (request: any) => {
      calls.signing++;
      const raw = await nativeSigner.signTransaction(request);
      // The signing checkpoint mutates only after this signature exists.
      // A row guard can prevent archival/send, not undo its production.
      await hook?.('signing'); return raw;
    }
  };
  const provider = {
    getTransactionReceipt: async () => { calls.receipt++; return receipt; },
    broadcastTransaction: async (raw: string) => {
      calls.sends++; const hash = keccak256(raw), transaction = Transaction.from(raw);
      const log = iface.encodeEventLog(iface.getEvent('PaymentSettled')!,
        [first.paymentId, first.payer, first.payee, first.token, first.amount, first.nonce]);
      receipt = withFixtureLogsBloom({ hash, type: transaction.type, index: 0, blockNumber: 17, blockHash, status: 1,
        gasUsed: 125000n, cumulativeGasUsed: 125000n, gasPrice: 2n, from: nativeSigner.address, to: routerAddress,
        logs: [{ address: routerAddress, ...log, transactionHash: hash, transactionIndex: 0, index: 0, blockNumber: 17, blockHash }] });
      return { hash };
    },
    getBlockNumber: async () => { calls.head++; return 17; },
    getBalance: async () => { calls.budgetBalance++; await hook?.('budgetBalance'); return 10_000_000n; },
    getBlock: async (tag: number | 'latest') => {
      if (tag === 'latest') { calls.budgetHead++; await hook?.('budgetHead'); return { gasLimit: 30_000_000n }; }
      calls.block++;
      return { number: 17, hash: blockHash, timestamp: 1_800_000_000, baseFeePerGas: 1n,
        gasUsed: 125000n, gasLimit: 30_000_000n, transactions: [receipt.hash] };
    }
  };
  worker = new PaymentService(store, provider as unknown as JsonRpcProvider,
    relayer as unknown as Wallet, router, 31337, routerAddress);
});
afterEach(() => { store.close(); });

test('a coherent authorization rewrite during gas budgeting cannot archive a stale prepared transaction', async t => {
  let afterMutation = '', failure: unknown;
  hook = async phase => {
    if (phase !== 'budgetHead') return;
    await Promise.resolve();
    const changed = { ...first, amount: '125000001' };
    store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
      .run(JSON.stringify(changed), digest(changed, signingDomain), firstId);
    afterMutation = snapshot();
  };
  try { await worker.tick(); } catch (error) { failure = error; }
  const row = store.get(firstId)!;
  const archivedAmount = row.raw_tx ? iface.decodeFunctionData('settle', Transaction.from(row.raw_tx).data)[0].amount.toString() : null;
  t.diagnostic(JSON.stringify({ evidence: 'synthetic SQL mutation with offline native signing',
    currentAmount: JSON.parse(row.payload).amount, archivedAmount, status: row.status,
    rawReserved: row.raw_tx !== null, hashReserved: row.tx_hash !== null,
    signing: calls.signing, sends: calls.sends, receiptReads: calls.receipt,
    auditActions: store.events().filter(event => event.payment_id === firstId).map(event => event.action),
    rejected: failure instanceof Error, postMutationProjectionRetained: snapshot() === afterMutation }));
  assert.equal(row.status, 'queued'); assert.equal(row.raw_tx, null); assert.equal(row.tx_hash, null);
  assert.ok(snapshot() === afterMutation, 'Preparation wrote after the coherent authorization change');
  assert.equal(calls.signing, 0); assert.equal(calls.sends, 0); assert.equal(calls.receipt, 0);
  assert.deepEqual(calls.preflight, [firstId]);
  assert.equal(store.get(secondId)!.status, 'queued'); assert.equal(store.get(secondId)!.raw_tx, null);
  assertChanged(failure);
  store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
    .run(JSON.stringify(first), digest(first, signingDomain), firstId);
  await healthyRecovery();
});

for (const phase of ['preflight', 'router', 'relayer', 'signing'] as const) {
  test('a coherent authorization rewrite during ' + phase + ' aborts stale preparation before archival', async () => {
    const afterMutation = mutateAt(phase, rewriteAuthorization);
    await assert.rejects(worker.tick(), assertChanged);
    assertHeld(phase, afterMutation());
    assert.equal(store.get(firstId)!.status, 'queued');
    assert.equal(store.get(firstId)!.raw_tx, null); assert.equal(store.get(firstId)!.tx_hash, null);
    store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
      .run(JSON.stringify(first), digest(first, signingDomain), firstId);
    await healthyRecovery();
  });
}

// Each remaining field is exercised at one representative boundary, rather
// than multiplying every field by every await checkpoint.
for (const [phase, field, value] of [
  ['preflight', 'signature', '0x0123Abcd'], ['router', 'fingerprint', digest(payment(1), domain(31338, routerAddress))],
  ['relayer', 'raw_tx', '0x1234'], ['budgetBalance', 'tx_hash', '0x' + '99'.repeat(32)],
  ['preflight', 'block_number', 17], ['relayer', 'block_hash', blockHash],
  ['router', 'error', 'Synthetic concurrent queue note'], ['budgetHead', 'created_at', '2001-01-01T00:00:00.000Z'],
  ['signing', 'updated_at', '2002-01-01T00:00:00.000Z']
] as const) {
  test('synthetic SQL ' + field + ' change during ' + phase + ' preserves queued evidence without stale archival', async () => {
    const original = store.get(firstId)!;
    const afterMutation = mutateAt(phase, () => {
      store.db.prepare('UPDATE payments SET ' + field + '=? WHERE id=?').run(value, firstId);
    });
    await assert.rejects(worker.tick(), assertChanged); assertHeld(phase, afterMutation());
    store.db.prepare('UPDATE payments SET ' + field + '=? WHERE id=?').run(original[field], firstId);
    await healthyRecovery();
  });
}

test('a supported failure after pending-row materialization aborts preparation entry without its RPC or signature', async t => {
  const pending = store.pending.bind(store);
  let afterMutation = '';
  // Schedule a supported Store transition after capturing pending membership.
  // The real Store reads/writes remain unchanged; no parallel-process claim.
  const capture = t.mock.method(store, 'pending', () => {
    const rows = pending();
    store.setStatus(firstId, 'failed', 'Concurrent operator decision');
    afterMutation = snapshot();
    return rows;
  });
  try { await assert.rejects(worker.tick(), assertChanged); }
  finally { capture.mock.restore(); }
  assert.deepEqual(calls, { preflight: [], router: 0, relayer: 0, budgetHead: 0, budgetBalance: 0,
    signing: 0, sends: 0, receipt: 0, head: 0, block: 0 });
  assert.ok(afterMutation && snapshot() === afterMutation);
  assert.equal(store.get(firstId)!.status, 'failed');
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});
test('a supported queued failure during router population is retained without later signing or archival', async () => {
  const afterMutation = mutateAt('router', () => { store.setStatus(firstId, 'failed', 'Concurrent operator decision'); });
  await assert.rejects(worker.tick(), assertChanged); assertHeld('router', afterMutation());
  assert.equal(store.get(firstId)!.status, 'failed');
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});
test('a payment ID renamed during gas budgeting safely aborts the original materialized row', async () => {
  const renamed = firstId + '-changed';
  const afterMutation = mutateAt('budgetHead', () => {
    store.db.prepare('UPDATE payments SET id=? WHERE id=?').run(renamed, firstId);
  });
  await assert.rejects(worker.tick(), assertChanged); assertHeld('budgetHead', afterMutation());
  assert.equal(store.get(firstId), undefined); assert.equal(store.get(renamed)!.raw_tx, null);
  store.db.prepare('UPDATE payments SET id=? WHERE id=?').run(firstId, renamed);
  await healthyRecovery();
});
test('a payment deleted during successful preflight is not recreated, signed or archived', async () => {
  const afterMutation = mutateAt('preflight', () => { store.db.prepare('DELETE FROM payments WHERE id=?').run(firstId); });
  await assert.rejects(worker.tick(), assertChanged); assertHeld('preflight', afterMutation());
  assert.equal(store.get(firstId), undefined);
});
test('a row changed before a recognized preflight rejection is not failed using stale authorization', async () => {
  firstFailure = Object.assign(new Error('Synthetic canonical policy rejection'), {
    code: 'CALL_EXCEPTION', data: iface.encodeErrorResult('PolicyLimit', [125000000]), shortMessage: 'Synthetic policy limit'
  });
  const afterMutation = mutateAt('preflight', rewriteAuthorization);
  await assert.rejects(worker.tick(), assertChanged); assertHeld('preflight', afterMutation());
  assert.equal(store.get(firstId)!.status, 'queued');
  assert.equal(store.events().filter(event => event.action === 'failed').length, 0);
  store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
    .run(JSON.stringify(first), digest(first, signingDomain), firstId);
  await healthyRecovery();
});

for (const phase of ['preflight', 'budgetBalance'] as const) {
  test('an unrelated ' + phase + ' RPC rejection retains its original error after a row change', async () => {
    const failure = Object.assign(new Error('Synthetic transport uncertainty'), { code: 'NETWORK_ERROR' });
    const afterMutation = mutateAt(phase, rewriteAuthorization, failure);
    await assert.rejects(worker.tick(), error => error === failure); assertHeld(phase, afterMutation());
    store.db.prepare('UPDATE payments SET payload=?,fingerprint=? WHERE id=?')
      .run(JSON.stringify(first), digest(first, signingDomain), firstId);
    await healthyRecovery();
  });
}
test('a same-value update during the budget Promise.all still permits ordinary preparation', async () => {
  const before = Number(store.db.prepare('SELECT total_changes() AS changes').get()!.changes);
  let after = 0;
  mutateAt('budgetBalance', () => {
    store.db.prepare('UPDATE payments SET signature=signature WHERE id=?').run(firstId);
    after = Number(store.db.prepare('SELECT total_changes() AS changes').get()!.changes);
  });
  await healthyRecovery(true);
  assert.equal(after, before + 1);
});
test('unchanged BLOB metadata permits preparation and confirmation by deep value', async () => {
  store.db.prepare('UPDATE payments SET error=? WHERE id=?').run(new Uint8Array([0, 1, 255]), firstId);
  const a = store.get(firstId)!.error as unknown, b = store.get(firstId)!.error as unknown;
  assert.ok(a instanceof Uint8Array && b instanceof Uint8Array); assert.notEqual(a, b); assert.deepEqual(a, b);
  await healthyRecovery();
});
test('an unchanged recognized preflight rejection remains a terminal failure without signing', async () => {
  firstFailure = Object.assign(new Error('Synthetic canonical policy rejection'), {
    code: 'CALL_EXCEPTION', data: iface.encodeErrorResult('PolicyLimit', [125000000]), shortMessage: 'Synthetic policy limit'
  });
  await assert.rejects(worker.tick(), error => error === independentError);
  assert.equal(store.get(firstId)!.status, 'failed'); assert.equal(store.get(firstId)!.error, 'Synthetic policy limit');
  assert.deepEqual(calls.preflight, [firstId, secondId]);
  assert.deepEqual([calls.router, calls.relayer, calls.signing, calls.sends], [0, 0, 0, 0]);
  assert.equal(store.events().filter(event => event.action === 'failed').length, 1);
});
