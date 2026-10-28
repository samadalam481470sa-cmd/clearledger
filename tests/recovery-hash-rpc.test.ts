import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { acquireDatabaseOwnership, type DatabaseOwnership } from '../src/database-ownership.ts';
import { bindDatabaseContext } from '../src/database-context.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

let chain: Awaited<ReturnType<typeof localChain>>;
let snapshot: string | undefined;
let directory: string;
let ownership: DatabaseOwnership | undefined;
let proxy: Awaited<ReturnType<typeof rpcProxy>> | undefined;
let provider: ReturnType<typeof createRpcProvider> | undefined;
let store: Store | undefined;
let relayer: Wallet;
let service: PaymentService;
let forwarded: number;
let completed: boolean;
const workRoot = resolve('../../work');
before(async () => { compile(); chain = await localChain(); });
after(async () => { await chain?.close(); });
beforeEach(async () => {
  snapshot = undefined; ownership = undefined; proxy = undefined; provider = undefined; store = undefined;
  forwarded = 0; completed = false;
  mkdirSync(workRoot, { recursive: true });
  directory = mkdtempSync(join(workRoot, 'recovery-hash-rpc-test-'));
  snapshot = await chain.provider.send('evm_snapshot', []);
  ownership = acquireDatabaseOwnership(join(directory, 'journal.sqlite'));
  store = new Store(ownership.databasePath);
  const genesis = await chain.provider.getBlock(0);
  assert.ok(genesis?.hash);
  bindDatabaseContext(store.db, { chainId: 31337, genesisHash: genesis.hash,
    router: String(chain.router.target), relayer: chain.relayer.address });
  proxy = await rpcProxy(chain.provider._getConnection().url);
  proxy.afterForward('eth_sendRawTransaction', () => { forwarded++; });
  provider = createRpcProvider(proxy.url, 2000);
  relayer = new Wallet(chain.relayer.privateKey, provider);
  service = makeService();
});
afterEach(async () => {
  const failures: unknown[] = [];
  async function cleanup(action: () => unknown) { try { await action(); } catch (error) { failures.push(error); } }
  await cleanup(() => provider?.destroy());
  await cleanup(() => proxy?.close());
  if (store) await cleanup(() => { store!.close(); store = undefined; });
  if (!store) await cleanup(() => { ownership?.release(); ownership = undefined; });
  if (snapshot) await cleanup(() => chain.provider.send('evm_revert', [snapshot]));
  if (completed && failures.length === 0) await cleanup(() => {
    assert.equal(store, undefined); assert.equal(ownership, undefined);
    assert.equal(dirname(resolve(directory)), workRoot);
    assert.ok(directory.startsWith(join(workRoot, 'recovery-hash-rpc-test-')));
    rmSync(directory, { recursive: true, force: true });
  });
  if (failures.length) throw new AggregateError(failures, 'Recovered hash RPC fixture cleanup failed');
});
function makeService() {
  return new PaymentService(store!, provider!, relayer, connectRouter(String(chain.router.target), relayer),
    31337, String(chain.router.target));
}
function reopenStore() {
  store!.close(); store = undefined;
  store = new Store(ownership!.databasePath);
  service = makeService();
}
async function signed(amount = '125000000', nonce = '0') {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: chain.payer.address,
    payee: chain.payee.address, token: String(chain.token.target), amount, nonce, deadline: String(block!.timestamp + 3600) };
  return { payment, signature: await chain.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
async function reserve(input: Awaited<ReturnType<typeof signed>>) {
  const accepted = await service.accept(input);
  const request = await chain.router.connect(relayer).settle.populateTransaction(input.payment, input.signature);
  const raw = await relayer.signTransaction(await relayer.populateTransaction(request));
  const hash = keccak256(raw);
  store!.broadcast(accepted.row.id, raw, hash);
  return { id: accepted.row.id, raw, hash, nonce: Transaction.from(raw).nonce };
}
async function otherSignedTransaction(nonce: number) {
  const raw = await relayer.signTransaction(await relayer.populateTransaction({
    to: chain.payee.address, value: 1n, nonce, gasLimit: 21000n
  }));
  const transaction = Transaction.from(raw);
  assert.equal(transaction.from, chain.relayer.address); assert.equal(transaction.nonce, nonce);
  assert.equal(transaction.value, 1n);
  return { raw, hash: keccak256(raw) };
}
function sends() { return proxy!.calls.filter(call => call.method === 'eth_sendRawTransaction'); }

// Actual HTTP RPC, valid signatures and genuine Ganache execution; manual ticks
// and direct corruption of a task-owned SQLite file do not establish CLI recovery.
test('recovered mismatched raw bytes cannot be sent or release a later queued nonce before repair', { timeout: 30000 }, async t => {
  const firstInput = await signed(), original = await reserve(firstInput);
  const secondInput = await signed('7000000', '1');
  const second = (await service.accept(secondInput)).row;
  const other = await otherSignedTransaction(original.nonce);
  assert.notEqual(other.hash, original.hash);
  const initialPayerTokens = await chain.token.balanceOf(chain.payer.address);
  const initialPayeeNative = await chain.provider.getBalance(chain.payee.address);
  const initialRelayerNative = await chain.provider.getBalance(chain.relayer.address);
  store!.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run(other.raw, original.id);
  reopenStore();
  const corruptSnapshot = JSON.stringify({ rows: store!.list(), audits: store!.events(), journals: store!.journals() });
  const nonceReads = proxy!.calls.filter(call => call.method === 'eth_getTransactionCount').length;
  for (let attempt = 0; attempt < 3; attempt++) {
    await service.tick();
    const first = store!.get(original.id)!, queued = store!.get(second.id)!;
    assert.equal(first.status, 'broadcast'); assert.equal(first.tx_hash, original.hash);
    assert.ok(first.raw_tx === other.raw, 'A read/retry must retain the conflicting archived evidence');
    assert.equal(queued.status, 'queued'); assert.equal(queued.raw_tx, null); assert.equal(queued.tx_hash, null);
    assert.equal(sends().length, 0); assert.equal(forwarded, 0);
    assert.equal(store!.journals().length, 0);
    assert.ok(JSON.stringify({ rows: store!.list(), audits: store!.events(), journals: store!.journals() }) === corruptSnapshot,
      'Hash mismatch must not overwrite, terminally fail or re-audit the reservation');
  }
  assert.equal(proxy!.calls.filter(call => call.method === 'eth_getTransactionCount').length, nonceReads,
    'Queued work must not request a new relayer nonce while the reservation is unresolved');
  for (const hash of [original.hash, other.hash]) {
    assert.equal(await chain.provider.getTransaction(hash), null);
    assert.equal(await chain.provider.getTransactionReceipt(hash), null);
  }
  assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerTokens);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
  assert.equal(await chain.provider.getBalance(chain.payee.address), initialPayeeNative);
  assert.equal(await chain.provider.getBalance(chain.relayer.address), initialRelayerNative);
  assert.equal(await chain.router.nonces(chain.payer.address), 0n);
  assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), original.nonce);

  // Controlled fixture repair restores the exact original bytes, not a new
  // authorization, transaction, signing attempt or production repair endpoint.
  store!.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run(original.raw, original.id);
  for (let attempt = 0; attempt < 4 && store!.get(second.id)!.status !== 'settled'; attempt++) await service.tick();
  const firstSettled = store!.get(original.id)!, secondSettled = store!.get(second.id)!;
  assert.equal(firstSettled.status, 'settled'); assert.equal(secondSettled.status, 'settled');
  assert.equal(firstSettled.tx_hash, original.hash);
  assert.ok(firstSettled.raw_tx === original.raw, 'Recovery replaced the repaired original bytes');
  assert.ok(secondSettled.raw_tx && secondSettled.tx_hash);
  assert.equal(keccak256(secondSettled.raw_tx), secondSettled.tx_hash);
  assert.equal(Transaction.from(secondSettled.raw_tx).nonce, original.nonce + 1);
  assert.equal(sends().length, 2); assert.equal(forwarded, 2);
  assert.ok(sends()[0].params?.[0] === original.raw && sends()[1].params?.[0] === secondSettled.raw_tx,
    'Only the two intended raw transactions may cross the HTTP send boundary');
  assert.equal(await chain.provider.getTransaction(other.hash), null);
  assert.equal(await chain.provider.getTransactionReceipt(other.hash), null);
  assert.equal(await chain.provider.getBalance(chain.payee.address), initialPayeeNative);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
  assert.equal(await chain.token.balanceOf(chain.payer.address), initialPayerTokens - 132000000n);
  assert.equal(await chain.router.nonces(chain.payer.address), 2n);
  assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), original.nonce + 2);
  assert.equal(store!.journals().length, 2);
  for (const paymentId of [original.id, second.id]) for (const action of ['accepted', 'broadcast-prepared', 'settled'])
    assert.equal(store!.events().filter(event => event.payment_id === paymentId && event.action === action).length, 1);
  for (const input of [firstInput, secondInput]) assert.equal((await service.accept(input)).replay, true);
  const result = await service.reconcile();
  assert.equal(result.checked, 2); assert.deepEqual(result.exceptions, []);
  assert.equal(store!.events().length, 6); assert.equal(sends().length, 2);
  t.diagnostic(JSON.stringify({ mismatchTicks: 3, sendsBeforeRepair: 0, sendsAfterRepair: 2, journalRows: 2, reconciled: 2 }));
  completed = true;
});

test('a genuine existing receipt still confirms without retransmitting conflicting archived bytes', { timeout: 30000 }, async t => {
  const input = await signed(), original = await reserve(input);
  const other = await otherSignedTransaction(original.nonce);
  assert.notEqual(other.hash, original.hash);
  const initialPayeeNative = await chain.provider.getBalance(chain.payee.address);
  const sent = await chain.provider.broadcastTransaction(original.raw);
  assert.equal((await sent.wait())!.status, 1);
  store!.db.prepare('UPDATE payments SET raw_tx=? WHERE id=?').run(other.raw, original.id);
  reopenStore();
  await service.tick();
  const settled = store!.get(original.id)!;
  assert.equal(settled.status, 'settled'); assert.equal(settled.tx_hash, original.hash);
  assert.ok(settled.raw_tx === other.raw, 'Genuine receipt confirmation must not silently rewrite archived evidence');
  assert.equal(sends().length, 0); assert.equal(forwarded, 0);
  assert.equal(store!.journals().length, 1); assert.equal(store!.journal(original.id)!.tx_hash, original.hash);
  assert.equal(await chain.provider.getTransaction(other.hash), null);
  assert.equal(await chain.provider.getBalance(chain.payee.address), initialPayeeNative);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  assert.equal(await chain.router.nonces(chain.payer.address), 1n);
  assert.equal(await chain.provider.getTransactionCount(chain.relayer.address, 'pending'), original.nonce + 1);
  assert.equal((await service.accept(input)).replay, true);
  const result = await service.reconcile();
  assert.equal(result.checked, 1); assert.deepEqual(result.exceptions, []);
  assert.equal(store!.events().length, 3); assert.equal(sends().length, 0);
  t.diagnostic(JSON.stringify({ genuineReceiptConfirmations: 1, serviceSendAttempts: 0, journalRows: 1, reconciled: 1 }));
  completed = true;
});
