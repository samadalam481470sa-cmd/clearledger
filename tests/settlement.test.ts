import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { id, parseUnits, Wallet, keccak256, type JsonRpcProvider } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { domain, paymentTypes, paymentSchema, type Payment } from '../src/payment.ts';
import { Store, Conflict } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';

let chain: Awaited<ReturnType<typeof localChain>>;
let snapshot: string;
let store: Store;
let service: PaymentService;
before(async () => { compile(); chain = await localChain(); });
after(async () => { await chain.close(); });
beforeEach(async () => {
  snapshot = await chain.provider.send('evm_snapshot', []);
  store = new Store();
  service = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress());
});
afterEach(async () => { store.close(); await chain.provider.send('evm_revert', [snapshot]); });

async function signed(overrides: Partial<Payment> = {}, signer = chain.payer) {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = {
    paymentId: id(randomBytes(16).toString('hex')), payer: chain.payer.address, payee: chain.payee.address,
    token: await chain.token.getAddress(), amount: '125000000',
    nonce: (await chain.router.nonces(chain.payer.address)).toString(),
    deadline: String(block!.timestamp + 3600), ...overrides
  };
  return { payment, signature: await signer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
async function direct(input: Awaited<ReturnType<typeof signed>>) {
  return chain.router.connect(chain.relayer).settle.staticCall(input.payment, input.signature);
}
async function settled(input: Awaited<ReturnType<typeof signed>>) {
  const accepted = await service.accept(input);
  for (let i = 0; i < 5 && store.get(accepted.row.id)?.status !== 'settled'; i++) await service.tick();
  return store.get(accepted.row.id)!;
}

test('signed payment transfers exact token units and records balanced journal', async () => {
  const initial = await chain.token.balanceOf(chain.payer.address);
  const row = await settled(await signed());
  assert.equal(row.status, 'settled');
  assert.equal(await chain.token.balanceOf(chain.payer.address), initial - 125000000n);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  const journal: any = store.journals()[0];
  assert.equal(journal.amount, '125000000');
  assert.equal(journal.debit_account, chain.payer.address);
  assert.equal(journal.credit_account, chain.payee.address);
  assert.equal(store.journals().length, 1);
});
test('identical retry produces only one transfer and one journal', async () => {
  const input = await signed();
  await settled(input);
  assert.equal((await service.accept(input)).replay, true);
  await service.tick();
  assert.equal(store.journals().length, 1);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
});
test('idempotency key cannot silently change payment instructions', async () => {
  const input = await signed();
  await service.accept(input);
  const altered = await signed({ paymentId: input.payment.paymentId, amount: '1' });
  await assert.rejects(() => service.accept(altered), Conflict);
});
test('tampered signature cannot authorize a different amount', async () => {
  const input = await signed();
  input.payment.amount = '1';
  await assert.rejects(() => service.accept(input), /Signature/);
  await assert.rejects(() => direct(input));
});
test('another wallet cannot spend payer allowance', async () => {
  await assert.rejects(() => directSignedWrongSigner());
});
async function directSignedWrongSigner() { return direct(await signed({}, chain.payee)); }
test('signature cannot replay on another chain', async () => {
  const input = await signed();
  input.signature = await chain.payer.signTypedData(domain(31338, await chain.router.getAddress()), paymentTypes, input.payment);
  await assert.rejects(() => direct(input));
});
test('signature cannot replay against another router', async () => {
  const input = await signed();
  input.signature = await chain.payer.signTypedData(domain(31337, chain.payee.address), paymentTypes, input.payment);
  await assert.rejects(() => direct(input));
});
test('expired authorizations fail at API and contract boundaries', async () => {
  const input = await signed({ deadline: '1' });
  await assert.rejects(() => service.accept(input), /expired/);
  await assert.rejects(() => direct(input));
});
test('stale payer nonce cannot be reused with another payment ID', async () => {
  await settled(await signed());
  await assert.rejects(() => directWithNonceZero());
});
async function directWithNonceZero() { return direct(await signed({ nonce: '0' })); }
test('processed payment ID cannot be reused with a new nonce', async () => {
  const input = await signed();
  await settled(input);
  await assert.rejects(() => directReusedId(input.payment.paymentId));
});
async function directReusedId(paymentId: string) { return direct(await signed({ paymentId })); }
test('payer can invalidate outstanding authorizations', async () => {
  const input = await signed();
  await (await chain.router.connect(chain.payer).invalidateNonce(5)).wait();
  await assert.rejects(() => direct(input));
});
test('unauthorized relayer cannot execute a valid payment', async () => {
  const input = await signed();
  await assert.rejects(() => chain.router.connect(chain.payee).settle.staticCall(input.payment, input.signature));
});
test('non-admin cannot mint or alter risk policy', async () => {
  await assert.rejects(() => chain.token.connect(chain.payee).mint.staticCall(chain.payee.address, 1));
  await assert.rejects(() => chain.router.connect(chain.payee).setPolicy.staticCall(chain.token.target, 1, 1));
});
test('revoked payee eligibility rejects settlement without consuming nonce', async () => {
  const input = await signed();
  await (await chain.token.setAllowed(chain.payee.address, false)).wait();
  const accepted = await service.accept(input);
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'failed');
  assert.equal(await chain.router.nonces(chain.payer.address), 0n);
  assert.equal(store.journals().length, 0);
});
test('router emergency pause prevents settlement', async () => {
  const input = await signed();
  await (await chain.router.pause()).wait();
  await assert.rejects(() => direct(input));
});
test('token emergency pause prevents settlement', async () => {
  const input = await signed();
  await (await chain.token.pause()).wait();
  await assert.rejects(() => direct(input));
});
test('per-payment and daily limits enforce exact integer amounts', async () => {
  await assert.rejects(() => oversized());
  assert.equal((await settled(await signed({ amount: parseUnits('10000', 6).toString() }))).status, 'settled');
  assert.equal((await settled(await signed({ amount: parseUnits('10000', 6).toString() }))).status, 'settled');
  await assert.rejects(() => excessDaily());
});
async function oversized() { return direct(await signed({ amount: parseUnits('10000.000001', 6).toString() })); }
async function excessDaily() { return direct(await signed({ amount: parseUnits('5000.000001', 6).toString() })); }
test('daily allowance resets at UTC day boundary', async () => {
  await settled(await signed({ amount: parseUnits('10000', 6).toString() }));
  await settled(await signed({ amount: parseUnits('10000', 6).toString() }));
  await chain.provider.send('evm_increaseTime', [86400]);
  await chain.provider.send('evm_mine', []);
  assert.equal((await settled(await signed({ amount: parseUnits('10000', 6).toString() }))).status, 'settled');
});
test('allowance revocation rejects transfer without partial accounting', async () => {
  const input = await signed();
  await (await chain.token.connect(chain.payer).approve(chain.router.target, 0)).wait();
  await assert.rejects(() => direct(input));
  assert.equal(await chain.router.nonces(chain.payer.address), 0n);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
});
test('supply cap bounds issuer minting', async () => {
  await assert.rejects(() => chain.token.mint.staticCall(chain.payer.address, parseUnits('10000000', 6)));
});
test('zero and self-payments are rejected', async () => {
  await assert.rejects(async () => direct(await signed({ amount: '0' })));
  await assert.rejects(async () => direct(await signed({ payee: chain.payer.address })));
});
test('integer input validation rejects fractional, negative and overflowing base units', async () => {
  const { payment } = await signed();
  for (const amount of ['1.5', '-1', '01', (2n ** 256n).toString()]) {
    assert.equal(paymentSchema.safeParse({ ...payment, amount }).success, false);
  }
});
test('worker recovers transaction persisted before first broadcast', async () => {
  const input = await signed(), accepted = await service.accept(input);
  const request = await chain.router.connect(chain.relayer).settle.populateTransaction(input.payment, input.signature);
  const raw = await chain.relayer.signTransaction(await chain.relayer.populateTransaction(request));
  store.broadcast(accepted.row.id, raw, keccak256(raw));
  const restarted = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress());
  await restarted.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
  assert.equal(store.journals().length, 1);
});
test('lost response after broadcast is recovered using the same transaction hash', async () => {
  const input = await signed(), accepted = await service.accept(input);
  const request = await chain.router.connect(chain.relayer).settle.populateTransaction(input.payment, input.signature);
  const raw = await chain.relayer.signTransaction(await chain.relayer.populateTransaction(request));
  store.broadcast(accepted.row.id, raw, keccak256(raw));
  await (await chain.provider.broadcastTransaction(raw)).wait();
  await service.tick();
  await service.tick();
  assert.equal(store.journals().length, 1);
});
test('confirmation threshold delays journal finalization', async () => {
  const cautious = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress(), 2);
  const accepted = await cautious.accept(await signed());
  await cautious.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'broadcast');
  assert.equal(store.journals().length, 0);
  await chain.provider.send('evm_mine', []);
  await cautious.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
});
for (const reportedStatus of [0, 1]) {
  test('wrong-hash status ' + reportedStatus + ' receipt preserves the mined reservation until genuine evidence recovers', async () => {
    let inconsistent = true;
    const faultyProvider = {
      getTransactionReceipt: async (hash: string) => {
        const receipt = await chain.provider.getTransactionReceipt(hash);
        return receipt && inconsistent ? { ...receipt, hash: '0x' + 'ab'.repeat(32), status: reportedStatus } : receipt;
      },
      broadcastTransaction: chain.provider.broadcastTransaction.bind(chain.provider),
      getBlockNumber: chain.provider.getBlockNumber.bind(chain.provider),
      getBlock: chain.provider.getBlock.bind(chain.provider)
    };
    const recovering = new PaymentService(store, faultyProvider as unknown as JsonRpcProvider,
      chain.relayer, chain.router, 31337, await chain.router.getAddress());
    const first = (await service.accept(await signed())).row;
    const second = (await service.accept(await signed({ nonce: '1' }))).row;
    await recovering.tick();
    const reservation = store.get(first.id)!;
    assert.equal(reservation.status, 'broadcast');
    assert.equal(reservation.tx_hash, keccak256(reservation.raw_tx!));
    assert.equal(store.get(second.id)!.status, 'queued');
    assert.equal(store.get(second.id)!.raw_tx, null);
    assert.equal(store.journals().length, 0);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    await recovering.tick();
    assert.deepEqual(store.get(first.id), reservation);
    assert.equal(store.get(second.id)!.raw_tx, null);
    inconsistent = false;
    await recovering.tick();
    assert.equal(store.get(first.id)!.status, 'settled');
    assert.equal(store.get(first.id)!.tx_hash, reservation.tx_hash);
    assert.equal(store.get(first.id)!.raw_tx, reservation.raw_tx);
    assert.equal(store.get(second.id)!.status, 'settled');
    assert.equal(store.journals().length, 2);
    assert.equal(store.events().filter(event => event.action === 'failed' || event.action === 'review').length, 0);
    assert.equal(store.events().filter(event => event.action === 'settled').length, 2);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 250000000n);
    assert.equal(await chain.router.nonces(chain.payer.address), 2n);
    assert.deepEqual((await recovering.reconcile()).exceptions, []);
  });
}
test('reconciliation detects removal of a previously settled block', async () => {
  const beforePayment = await chain.provider.send('evm_snapshot', []);
  const row = await settled(await signed());
  assert.equal((await service.reconcile()).exceptions.length, 0);
  await chain.provider.send('evm_revert', [beforePayment]);
  const result = await service.reconcile();
  assert.deepEqual(result.exceptions, [row.id]);
  assert.equal(store.get(row.id)!.status, 'review');
});
test('reconciliation flags a corrupt journal after genuine EVM settlement without reversing the transfer', async () => {
  const row = await settled(await signed());
  const balance = await chain.token.balanceOf(chain.payee.address);
  assert.deepEqual((await service.reconcile()).exceptions, []);
  store.db.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('1', row.id);
  const evidence = store.journal(row.id);
  const result = await service.reconcile();
  assert.equal(result.checked, 1);
  assert.deepEqual(result.exceptions, [row.id]);
  assert.equal(store.get(row.id)!.status, 'review');
  assert.deepEqual(store.journal(row.id), evidence);
  assert.equal(await chain.token.balanceOf(chain.payee.address), balance);
  assert.equal(await chain.router.nonces(chain.payer.address), 1n);
  assert.equal(store.events().filter(event => event.action === 'review').length, 1);
  await service.tick();
  assert.deepEqual((await service.reconcile()).exceptions, []);
  assert.equal(store.journals().length, 1);
  assert.equal(await chain.token.balanceOf(chain.payee.address), balance);
});
test('concurrent worker ticks do not settle a payment twice', async () => {
  const accepted = await service.accept(await signed());
  await Promise.all([service.tick(), service.tick(), service.tick()]);
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
  assert.equal(store.journals().length, 1);
});
test('sequence of varied transfers preserves supply and ledger conservation', async () => {
  let total = 0n;
  const supply = await chain.token.totalSupply();
  for (let i = 1; i <= 12; i++) {
    const amount = BigInt(i * i * 100003);
    total += amount;
    assert.equal((await settled(await signed({ amount: amount.toString() }))).status, 'settled');
  }
  const journalTotal = store.journals().reduce((sum, row: any) => sum + BigInt(row.amount), 0n);
  assert.equal(journalTotal, total);
  assert.equal(await chain.token.balanceOf(chain.payee.address), total);
  assert.equal(await chain.token.balanceOf(chain.payer.address) + total, parseUnits('100000', 6));
  assert.equal(await chain.token.totalSupply(), supply);
});
test('HTTP rejects missing authentication, hostile origin and spoofed host', async () => {
  const server = makeServer({ service, apiKey: 'test-key', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    assert.equal((await fetch(url + '/api/overview')).status, 401);
    assert.equal((await fetch(url + '/api/overview', { headers: { Authorization: 'Bearer test-key', Origin: 'https://attacker.example' } })).status, 403);
    const spoofed = await new Promise<number>(resolve => { const req = request(url + '/api/overview', { headers: { Host: 'attacker.example', Authorization: 'Bearer test-key' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    assert.equal(spoofed, 403);
    assert.equal((await fetch(url + '/api/bootstrap')).status, 401);
    assert.equal((await fetch(url + '/api/overview', { headers: { Authorization: 'Bearer test-key' } })).status, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('HTTP submission returns accepted then idempotent replay and hides signed raw transaction', async () => {
  const server = makeServer({ service, apiKey: 'test-key', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as any).port;
  const input = await signed();
  const options = { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify(input) };
  try {
    const accepted = await fetch(url + '/api/payments', options);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json() as any).payment.signature, undefined);
    await service.tick();
    assert.equal((await fetch(url + '/api/payments', options)).status, 200);
    assert.equal(store.journals().length, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});


