import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { ContractFactory, id, keccak256, parseUnits } from 'ethers';
import { compileTestWallet } from './fixtures/compile-wallet.ts';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { makeServer } from '../src/http.ts';
import { domain, paymentTypes, submissionSchema, type Payment } from '../src/payment.ts';

// Real EVM tests use a deliberately adversarial test wallet. They do not claim
// compatibility with Safe, a multisig implementation, or a production signer.
let chain: Awaited<ReturnType<typeof localChain>>;
let wallet: any;
let walletAddress: string;
let store: Store;
let service: PaymentService;
let snapshot: string;

before(async () => {
  compile();
  chain = await localChain();
  const artifact = compileTestWallet();
  wallet = await new ContractFactory(artifact.abi, artifact.bytecode, chain.payer).deploy(chain.payer.address);
  await wallet.waitForDeployment();
  walletAddress = await wallet.getAddress();
  await (await chain.token.setAllowed(walletAddress, true)).wait();
  await (await chain.token.mint(walletAddress, parseUnits('1000', 6))).wait();
  await (await wallet.execute(await chain.token.getAddress(), chain.token.interface.encodeFunctionData('approve',
    [await chain.router.getAddress(), parseUnits('1000', 6)]))).wait();
});
after(async () => { await chain?.close(); });
beforeEach(async () => {
  snapshot = await chain.provider.send('evm_snapshot', []);
  store = new Store();
  service = new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, await chain.router.getAddress());
});
afterEach(async () => { store?.close(); await chain.provider.send('evm_revert', [snapshot]); });

async function signed(overrides: Partial<Payment> = {}, signer = chain.payer) {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = { paymentId: id(randomBytes(16).toString('hex')), payer: walletAddress,
    payee: chain.payee.address, token: await chain.token.getAddress(), amount: '125000000',
    nonce: String(await chain.router.nonces(walletAddress)), deadline: String(block!.timestamp + 3600), ...overrides };
  return { payment, signature: await signer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
async function settle(input: Awaited<ReturnType<typeof signed>>) {
  const accepted = await service.accept(input);
  for (let i = 0; i < 5 && ['queued', 'broadcast'].includes(store.get(accepted.row.id)!.status); i++) await service.tick();
  return store.get(accepted.row.id)!;
}
async function rejected(input: Awaited<ReturnType<typeof signed>>) {
  assert.equal(await chain.router.isValidPaymentSignature(input.payment, input.signature), false);
  await assert.rejects(() => service.accept(input));
  await assert.rejects(() => chain.router.connect(chain.relayer).settle.staticCall(input.payment, input.signature));
  assert.equal(store.journals().length, 0);
  assert.equal(await chain.token.balanceOf(walletAddress), parseUnits('1000', 6));
  assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
  assert.equal(await chain.router.nonces(walletAddress), 0n);
}

test('a contract-wallet owner authorization settles exact units and produces one reconciled journal', async () => {
  const input = await signed();
  assert.equal(await chain.router.isValidPaymentSignature(input.payment, input.signature), true);
  const row = await settle(input);
  assert.equal(row.status, 'settled');
  assert.equal(await chain.token.balanceOf(walletAddress), parseUnits('875', 6));
  assert.equal(await chain.token.balanceOf(chain.payee.address), parseUnits('125', 6));
  assert.equal(await chain.router.nonces(walletAddress), 1n);
  assert.equal(store.journals().length, 1);
  assert.equal(store.journals()[0].debit_account, walletAddress);
  assert.equal((await service.accept(input)).replay, true);
  await service.tick();
  assert.equal(store.journals().length, 1);
  assert.deepEqual((await service.reconcile()).exceptions, []);
});

test('the wrong wallet owner cannot authorize a contract payer', async () => { await rejected(await signed({}, chain.payee)); });
test('a changed contract-wallet payment amount invalidates the original owner signature', async () => {
  const input = await signed(); input.payment.amount = '125000001'; await rejected(input);
});
for (const wrong of ['chain', 'router'] as const) {
  test('contract owner signature cannot cross a different ' + wrong + ' domain', async () => {
    const input = await signed();
    input.signature = await chain.payer.signTypedData(
      domain(wrong === 'chain' ? 31338 : 31337, wrong === 'router' ? chain.payee.address : await chain.router.getAddress()),
      paymentTypes, input.payment);
    await rejected(input);
  });
}

test('live wallet revocation rejects acceptance and an identical API replay', async () => {
  const input = await signed();
  const accepted = await service.accept(input);
  await (await wallet.setRevoked(true)).wait();
  await rejected(input);
  assert.equal(store.get(accepted.row.id)!.status, 'queued');
  assert.equal(store.get(accepted.row.id)!.signature, input.signature);
});

test('POST replay revalidates a revoked wallet while authenticated GET history remains available', async () => {
  const server = makeServer({ service, apiKey: 'contract-wallet-http-test', port: 0, mode: 'rpc' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  const input = await signed();
  const headers = { Authorization: 'Bearer contract-wallet-http-test', 'Content-Type': 'application/json' };
  try {
    const submit = () => fetch(url + '/api/payments', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal((await submit()).status, 202);
    await (await wallet.setRevoked(true)).wait();
    assert.equal((await submit()).status, 422);
    const response = await fetch(url + '/api/payments', { headers });
    assert.equal(response.status, 200);
    const page = await response.json() as any;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].payment.paymentId, input.payment.paymentId);
    assert.equal(page.items[0].status, 'queued');
    assert.equal(page.items[0].signature, undefined);
    assert.equal(store.get(page.items[0].id)!.signature, input.signature);
    assert.equal(store.events().filter(event => event.action === 'accepted').length, 1);
  } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())); }
});

test('signature-view RPC failure does not create a row/audit or rewrite an existing queued authorization', async () => {
  const failure = new Error('Synthetic signature-view RPC unavailable');
  const unavailable = { connect() { return this; },
    isValidPaymentSignature: { staticCall: async () => { throw failure; } } };
  const disconnected = new PaymentService(store, chain.provider, chain.relayer, unavailable,
    31337, await chain.router.getAddress());
  const input = await signed();
  await assert.rejects(() => disconnected.accept(input), error => error === failure);
  assert.equal(store.list().length, 0);
  assert.equal(store.events().length, 0);
  const accepted = await service.accept(input);
  const before = { row: store.get(accepted.row.id), audit: store.events() };
  await assert.rejects(() => disconnected.accept(input), error => error === failure);
  assert.deepEqual({ row: store.get(accepted.row.id), audit: store.events() }, before);
});

test('wallet revocation before first acceptance creates no queued instruction', async () => {
  const input = await signed();
  await (await wallet.setRevoked(true)).wait();
  await rejected(input);
  assert.equal(store.list().length, 0);
});

test('revocation after queueing is rechecked before raw transaction preparation', async () => {
  const input = await signed();
  const accepted = await service.accept(input);
  await (await wallet.setRevoked(true)).wait();
  await service.tick();
  const row = store.get(accepted.row.id)!;
  assert.equal(row.status, 'failed');
  assert.equal(row.raw_tx, null);
  assert.equal(store.journals().length, 0);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
  assert.equal(await chain.router.nonces(walletAddress), 0n);
});

test('revocation after raw signing still causes the on-chain execution to revert atomically', async () => {
  const input = await signed();
  const accepted = await service.accept(input);
  const request = await chain.router.connect(chain.relayer).settle.populateTransaction(input.payment, input.signature);
  const raw = await chain.relayer.signTransaction(await chain.relayer.populateTransaction(request));
  store.broadcast(accepted.row.id, raw, keccak256(raw));
  await (await wallet.setRevoked(true)).wait();
  for (let i = 0; i < 5 && store.get(accepted.row.id)!.status === 'broadcast'; i++) await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'failed');
  const receipt = await chain.provider.getTransactionReceipt(keccak256(raw));
  assert.equal(receipt!.status, 0);
  assert.equal(store.journals().length, 0);
  assert.equal(await chain.token.balanceOf(walletAddress), parseUnits('1000', 6));
  assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
  assert.equal(await chain.router.nonces(walletAddress), 0n);
});

for (const [mode, behavior] of [[1, 'wrong magic'], [2, 'short four-byte return'], [3, 'dirty selector padding'],
  [4, 'reverting validator'], [5, 'state-mutating validator']] as const) {
  test(behavior + ' cannot validate a contract-wallet signature', async () => {
    await (await wallet.setMode(mode)).wait();
    await rejected(await signed());
    assert.equal(await wallet.mutations(), 0n);
  });
}

test('wallet validation sees the same router caller during public view, API acceptance and settlement', async () => {
  await (await wallet.setRequiredCaller(await chain.router.getAddress())).wait();
  const input = await signed();
  const digest = await chain.router.hashPayment(input.payment);
  assert.equal(await wallet.isValidSignature.staticCall(digest, input.signature), '0xffffffff');
  assert.equal(await chain.router.isValidPaymentSignature(input.payment, input.signature), true);
  assert.equal((await settle(input)).status, 'settled');
});

test('a wallet-approved empty opaque signature is accepted and rechecked on-chain', async () => {
  const input = await signed();
  await (await wallet.approveEmpty(await chain.router.hashPayment(input.payment), true)).wait();
  input.signature = '0x';
  assert.equal(submissionSchema.safeParse(input).success, true);
  assert.equal((await settle(input)).status, 'settled');
  assert.equal(await chain.token.balanceOf(chain.payee.address), parseUnits('125', 6));
  assert.equal(store.journals().length, 1);
});

test('identical digest replay with a different valid signature retains the original queued signature', async () => {
  const input = await signed();
  const accepted = await service.accept(input);
  await (await wallet.approveEmpty(await chain.router.hashPayment(input.payment), true)).wait();
  await (await wallet.setMode(6)).wait();
  const replay = await service.accept({ payment: input.payment, signature: '0x' });
  assert.equal(replay.replay, true);
  assert.equal(store.get(accepted.row.id)!.signature, input.signature);
  // Replay does not replace persisted authorization. This newly revoked original
  // signature must fail rather than silently switching to the alternate one.
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'failed');
  assert.equal(store.journals().length, 0);
});

test('a valid padded magic word may be followed by additional return bytes', async () => {
  await (await wallet.setMode(7)).wait();
  const input = await signed();
  assert.equal(await chain.router.isValidPaymentSignature(input.payment, input.signature), true);
  assert.equal((await settle(input)).status, 'settled');
});

test('signature transport accepts zero to 4096 opaque bytes without an EOA length assumption', async () => {
  const input = await signed();
  assert.equal(submissionSchema.safeParse({ ...input, signature: '0x' }).success, true);
  assert.equal(submissionSchema.safeParse({ ...input, signature: '0x' + 'ab'.repeat(4096) }).success, true);
  assert.equal(submissionSchema.safeParse({ ...input, signature: '0x' + 'ab'.repeat(4097) }).success, false);
  assert.equal(submissionSchema.safeParse({ ...input, signature: '0x0' }).success, false);
});

test('the production compiler does not create a test-wallet artifact', () => {
  assert.equal(existsSync('artifacts/ContractWallet.json'), false);
});
