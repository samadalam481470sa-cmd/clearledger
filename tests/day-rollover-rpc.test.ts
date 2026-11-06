import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Wallet, id, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { connectRouter } from '../src/chain.ts';
import { createRpcProvider } from '../src/rpc.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { rpcProxy } from './fixtures/rpc-proxy.ts';

test('a reserved settlement survives a UTC day rollover before its first successful RPC send', { timeout: 30000 }, async t => {
  compile();
  const local = await localChain();
  t.after(() => local.close());
  const proxy = await rpcProxy(local.provider._getConnection().url);
  t.after(() => proxy.close());
  const provider = createRpcProvider(proxy.url, 2000);
  t.after(() => provider.destroy());
  const workRoot = resolve('../../work');
  mkdirSync(workRoot, { recursive: true });
  const directory = mkdtempSync(join(workRoot, 'day-rollover-rpc-test-'));
  const database = join(directory, 'journal.sqlite');
  let ledger: Store | undefined;
  t.after(() => {
    ledger?.close();
    assert.equal(dirname(resolve(directory)), workRoot);
    rmSync(directory, { recursive: true, force: true });
  });
  ledger = new Store(database);
  const routerAddress = String(local.router.target);
  const tokenAddress = String(local.token.target);
  const relayer = new Wallet(local.relayer.privateKey, provider);
  const router = connectRouter(routerAddress, relayer);
  let service = new PaymentService(ledger, provider, relayer, router, 31337, routerAddress);
  const beforeMidnight = Date.parse('2031-04-08T23:55:00.000Z');
  const afterMidnight = Date.parse('2031-04-09T00:05:00.000Z');
  const firstDay = Math.floor(beforeMidnight / 86400000);
  await local.provider.send('evm_setTime', [beforeMidnight]);
  await local.provider.send('evm_mine', []);
  const firstBlock = await local.provider.getBlock('latest');
  assert.ok(firstBlock);
  const deadline = String(firstBlock.timestamp + 3600);
  async function signed(amount: string, nonce: string) {
    const payment: Payment = {
      paymentId: id('UTC rollover payment ' + nonce), payer: local.payer.address, payee: local.payee.address,
      token: tokenAddress, amount, nonce, deadline
    };
    return { payment, signature: await local.payer.signTypedData(service.signingDomain, paymentTypes, payment) };
  }

  const first = (await service.accept(await signed('125000000', '0'))).row;
  await service.tick();
  const settledFirst = ledger.get(first.id)!;
  assert.equal(settledFirst.status, 'settled');
  const oldHead = await local.provider.getBlock('latest');
  assert.ok(oldHead);
  assert.equal(Math.floor(oldHead.timestamp / 86400), firstDay);
  assert.equal(await local.router.dailySpent(local.payer.address, tokenAddress, firstDay), 125000000n);
  assert.equal(await local.router.dailySpent(local.payer.address, tokenAddress, firstDay + 1), 0n);

  const input = await signed('37500000', '1');
  const next = (await service.accept(input)).row;
  const request = await router.settle.populateTransaction(input.payment, input.signature);
  const sameDayEstimate = await relayer.estimateGas(request);
  proxy.fail('eth_sendRawTransaction', 'http-503');
  await service.tick();
  const reserved = ledger.get(next.id)!;
  assert.equal(reserved.status, 'broadcast');
  assert.ok(reserved.raw_tx && reserved.tx_hash);
  const envelope = Transaction.from(reserved.raw_tx);
  assert.equal(envelope.hash, reserved.tx_hash);
  assert.equal(envelope.nonce, Transaction.from(settledFirst.raw_tx!).nonce + 1);
  assert.equal(await local.provider.getTransaction(reserved.tx_hash), null);
  assert.equal(ledger.journals().length, 1);

  await local.provider.send('evm_setTime', [afterMidnight]);
  assert.equal((await local.provider.getBlock('latest'))?.hash, oldHead.hash);
  assert.equal(await relayer.estimateGas(request), sameDayEstimate);
  ledger.close();
  ledger = undefined;
  ledger = new Store(database);
  assert.ok(isDeepStrictEqual(ledger.get(next.id), reserved), 'Reopen changed the reserved settlement');
  service = new PaymentService(ledger, provider, relayer, router, 31337, routerAddress);
  proxy.heal();
  await service.tick();

  const receipt = await local.provider.getTransactionReceipt(reserved.tx_hash);
  assert.ok(receipt);
  const block = await local.provider.getBlock(receipt.blockNumber);
  assert.ok(block);
  assert.equal(Math.floor(block.timestamp / 86400), firstDay + 1);
  assert.equal(block.transactions[receipt.index], reserved.tx_hash);
  assert.ok(BigInt(block.timestamp) < BigInt(deadline));
  t.diagnostic(JSON.stringify({ sameDayEstimate: String(sameDayEstimate), gasLimit: String(envelope.gasLimit),
    gasUsed: String(receipt.gasUsed), receiptStatus: receipt.status, dayBefore: firstDay, dayMined: firstDay + 1 }));
  assert.equal(receipt.status, 1, 'The original signed reservation must execute on the next UTC day');
  assert.equal(envelope.gasLimit, sameDayEstimate + 20000n);
  assert.ok(receipt.gasUsed > sameDayEstimate, 'Fresh-day execution must cost more than the same-day estimate');
  const settledNext = ledger.get(next.id)!;
  assert.equal(settledNext.status, 'settled');
  assert.ok(settledNext.raw_tx === reserved.raw_tx && settledNext.tx_hash === reserved.tx_hash);
  assert.ok(isDeepStrictEqual(ledger.get(first.id), settledFirst), 'Recovery changed the previous settlement');
  assert.equal(await local.router.dailySpent(local.payer.address, tokenAddress, firstDay), 125000000n);
  assert.equal(await local.router.dailySpent(local.payer.address, tokenAddress, firstDay + 1), 37500000n);
  assert.equal(await local.router.nonces(local.payer.address), 2n);
  assert.equal(await local.token.balanceOf(local.payee.address), 162500000n);
  assert.deepEqual(ledger.journals().map(row => row.tx_hash), [reserved.tx_hash, settledFirst.tx_hash]);
  assert.deepEqual(ledger.events().filter(event => event.payment_id === next.id).map(event => event.action),
    ['settled', 'broadcast-prepared', 'accepted']);
  const reconciliation = await service.reconcile();
  assert.equal(reconciliation.checked, 2);
  assert.deepEqual(reconciliation.exceptions, []);
  await service.tick();
  assert.equal(ledger.journals().length, 2);
  assert.deepEqual(proxy.calls.filter(call => call.method === 'eth_sendRawTransaction')
    .map(call => Transaction.from(call.params![0] as string).hash),
    [settledFirst.tx_hash, reserved.tx_hash, reserved.tx_hash]);
});
