import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Contract, ContractFactory, id, isError } from 'ethers';
import solc from 'solc';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';
import { PaymentService } from '../src/service.ts';
import { Store } from '../src/store.ts';

function compileSenderFeeToken() {
  const source = 'SenderFeeToken.sol';
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { [source]: { content: readFileSync('tests/fixtures/' + source, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  }), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unapproved fixture import' };
    try { return { contents: readFileSync(resolve('node_modules', path), 'utf8') }; }
    catch { return { error: 'Fixture import not found' }; }
  } }));
  const errors = (result.errors ?? []).filter((error: any) => error.severity === 'error');
  assert.deepEqual(errors, []);
  const token = result.contracts[source].SenderFeeToken;
  return { abi: token.abi, bytecode: '0x' + token.evm.bytecode.object };
}

test('settlement rejects an extra sender fee and accepts the exact transfer after the fee is removed', {
  timeout: 30000
}, async t => {
  compile();
  const chain = await localChain();
  const store = new Store();
  try {
    const { router, payer, payee, relayer, admin, provider } = chain;
    const amount = 125n;
    const fixture = compileSenderFeeToken();
    const deployed = await new ContractFactory(fixture.abi, fixture.bytecode, admin).deploy(payer.address, 1000n);
    await deployed.waitForDeployment();
    const tokenAddress = await deployed.getAddress();
    const token = new Contract(tokenAddress, fixture.abi, admin);
    const routerAddress = await router.getAddress();
    const payerToken = new Contract(tokenAddress, fixture.abi, payer);
    await (await payerToken.approve(routerAddress, 500n)).wait();
    await (await router.setPolicy(tokenAddress, 500n, 1000n)).wait();
    const relayerRouter = router.connect(relayer);
    const service = new PaymentService(store, provider, relayer, router, 31337, routerAddress);
    const latest = await provider.getBlock('latest');
    assert.ok(latest);
    const payment: Payment = {
      paymentId: id('sender fee rollback'), payer: payer.address, payee: payee.address, token: tokenAddress,
      amount: amount.toString(), nonce: '0', deadline: String(latest.timestamp + 3600)
    };
    const signature = await payer.signTypedData(service.signingDomain, paymentTypes, payment);
    const state = async () => ({
      payerBalance: await token.balanceOf(payer.address),
      payeeBalance: await token.balanceOf(payee.address),
      supply: await token.totalSupply(),
      allowance: await token.allowance(payer.address, routerAddress),
      payerNonce: await router.nonces(payer.address),
      processed: await router.processed(payer.address, payment.paymentId)
    });
    const spend = async (height: number) => {
      const block = await provider.getBlock(height);
      assert.ok(block);
      return router.dailySpent(payer.address, tokenAddress, Math.floor(block.timestamp / 86400));
    };
    const before = await state();
    const preflightError = await relayerRouter.settle.staticCall(payment, signature).then(
      () => undefined, (error: unknown) => error
    );
    const dispatched = await relayerRouter.settle(payment, signature, { gasLimit: 500_000n });
    const receipt = await provider.getTransactionReceipt(dispatched.hash);
    assert.ok(receipt);
    const after = await state();
    t.diagnostic(JSON.stringify({ receiptStatus: receipt.status, signedAmount: String(amount),
      payerDebit: String(before.payerBalance - after.payerBalance), payeeCredit: String(after.payeeBalance - before.payeeBalance),
      logs: receipt.logs.length }));
    assert.equal(receipt.status, 0);
    assert.equal(receipt.logs.length, 0);
    assert.ok(receipt.gasUsed < 500_000n, 'The fixture must revert within its gas budget');
    assert.ok(isError(preflightError, 'CALL_EXCEPTION'));
    assert.equal(preflightError.data, router.interface.encodeErrorResult('UnexpectedTransferAmount'));
    assert.deepEqual(after, before);
    assert.equal(await spend(receipt.blockNumber), 0n);

    await (await token.disableFee()).wait();
    const accepted = await service.accept({ payment, signature });
    await service.tick();
    const settled = store.get(accepted.row.id);
    assert.equal(settled?.status, 'settled');
    assert.deepEqual(await state(), { payerBalance: before.payerBalance - amount, payeeBalance: before.payeeBalance + amount,
      supply: before.supply, allowance: before.allowance - amount, payerNonce: 1n, processed: true });
    assert.equal(await spend(settled!.block_number!), amount);
    assert.equal(store.journals().length, 1);
    assert.equal(store.journal(accepted.row.id)?.amount, payment.amount);
    const reconciliation = await service.reconcile();
    assert.equal(reconciliation.checked, 1);
    assert.deepEqual(reconciliation.exceptions, []);
  } finally {
    try { store.close(); } finally { await chain.close(); }
  }
});
