import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { type JsonRpcProvider, Wallet, id, keccak256, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';
import { createRpcProvider } from '../src/rpc.ts';

let chain: Awaited<ReturnType<typeof localChain>>;
let snapshot: string;
let proxy: Awaited<ReturnType<typeof rpcProxy>>;
let provider: JsonRpcProvider;
let store: Store;
let service: PaymentService;

before(async () => { compile(); chain = await localChain(); });
after(async () => { await chain.close(); });
beforeEach(async () => {
  snapshot = await chain.provider.send('evm_snapshot', []);
  proxy = await rpcProxy(chain.provider._getConnection().url);
  provider = createRpcProvider(proxy.url, 2000);
  const relayer = new Wallet(chain.relayer.privateKey, provider);
  store = new Store();
  service = new PaymentService(store, provider, relayer,
    connectRouter(String(chain.router.target), relayer), 31337, String(chain.router.target));
  await provider.getBlockNumber();
});
afterEach(async () => {
  provider.destroy();
  await proxy.close();
  store.close();
  await chain.provider.send('evm_revert', [snapshot]);
});
async function signed(overrides: Partial<Payment> = {}) {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = {
    paymentId: id(randomBytes(16).toString('hex')), payer: chain.payer.address, payee: chain.payee.address,
    token: String(chain.token.target), amount: '125000000',
    nonce: String(await chain.router.nonces(chain.payer.address)),
    deadline: String(block!.timestamp + 3600), ...overrides
  };
  return { payment, signature: await chain.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
function sentTransactions() { return proxy.calls.filter(call => call.method === 'eth_sendRawTransaction'); }

for (const fault of ['http-503', 'drop'] as const) {
  test('real preflight ' + fault + ' outage keeps queued intent and recovers', { timeout: 15000 }, async () => {
    const accepted = await service.accept(await signed());
    proxy.fail('eth_call', fault);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(() => service.tick());
      assert.equal(store.get(accepted.row.id)!.status, 'queued');
      assert.equal(store.get(accepted.row.id)!.raw_tx, null);
    }
    assert.equal(sentTransactions().length, 0);
    assert.equal(store.journals().length, 0);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
    proxy.heal();
    await service.tick();
    assert.equal(store.get(accepted.row.id)!.status, 'settled');
    assert.equal(store.journals().length, 1);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  });
}

test('a stalled HTTP preflight times out and later retries successfully', { timeout: 15000 }, async () => {
  const accepted = await service.accept(await signed());
  proxy.fail('eth_call', 'stall');
  const started = performance.now();
  await assert.rejects(() => service.tick());
  assert.ok(performance.now() - started < 7000, 'Client timeout must release the worker');
  assert.equal(store.get(accepted.row.id)!.status, 'queued');
  assert.equal(sentTransactions().length, 0);
  proxy.heal();
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
  assert.equal(store.journals().length, 1);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
});

test('accepted raw transaction with a dropped HTTP response settles once by its stored hash', { timeout: 15000 }, async () => {
  const accepted = await service.accept(await signed());
  proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
  await service.tick();
  const recovered = store.get(accepted.row.id)!;
  assert.equal(recovered.status, 'settled');
  assert.ok(recovered.raw_tx && recovered.tx_hash);
  assert.equal(keccak256(recovered.raw_tx), recovered.tx_hash);
  await service.tick();
  assert.equal(sentTransactions().length, 1);
  assert.equal(sentTransactions()[0].params![0], recovered.raw_tx);
  assert.equal(store.journals().length, 1);
  assert.equal(store.events().filter(event => event.action === 'settled').length, 1);
  assert.equal(await chain.router.nonces(chain.payer.address), 1n);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
});

test('receipt transport outage blocks queued nonce allocation until durable broadcast is recovered', { timeout: 15000 }, async () => {
  const first = await service.accept(await signed());
  const second = await service.accept(await signed({ nonce: '1', amount: '7000000' }));
  // Allow the initial empty receipt check, then lose all reads after send.
  proxy.fail('eth_sendRawTransaction', 'forward-then-drop', 1);
  const receiptReads = () => proxy.calls.filter(call => call.method === 'eth_getTransactionReceipt').length;
  // Arm the receipt fault only once the real upstream send has returned.
  proxy.afterForward('eth_sendRawTransaction', () => proxy.fail('eth_getTransactionReceipt', 'http-503'));
  await service.tick();
  const firstRow = store.get(first.row.id)!;
  assert.equal(firstRow.status, 'broadcast');
  assert.equal(store.get(second.row.id)!.status, 'queued');
  assert.equal(store.get(second.row.id)!.raw_tx, null);
  assert.ok(firstRow.raw_tx && firstRow.tx_hash);
  assert.equal(keccak256(firstRow.raw_tx), firstRow.tx_hash);
  for (let attempt = 0; attempt < 3; attempt++) await service.tick();
  assert.ok(receiptReads() >= 3);
  assert.equal(sentTransactions().length, 1);
  assert.equal(store.journals().length, 0);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  proxy.heal();
  await service.tick();
  assert.equal(store.get(first.row.id)!.status, 'settled');
  assert.equal(store.get(first.row.id)!.tx_hash, firstRow.tx_hash);
  assert.equal(store.get(second.row.id)!.status, 'settled');
  const firstNonce = Transaction.from(firstRow.raw_tx).nonce;
  const secondNonce = Transaction.from(store.get(second.row.id)!.raw_tx!).nonce;
  assert.equal(secondNonce, firstNonce + 1);
  assert.equal(store.journals().length, 2);
  assert.equal(await chain.router.nonces(chain.payer.address), 2n);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 132000000n);
});
