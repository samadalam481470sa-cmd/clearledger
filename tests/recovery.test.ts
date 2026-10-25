import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { id, keccak256, parseUnits, Transaction } from 'ethers';
import { compile } from '../scripts/compile.ts';
import { localChain } from '../scripts/local-chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes, type Payment } from '../src/payment.ts';

let chain: Awaited<ReturnType<typeof localChain>>;
let snapshot: string;
let directory: string;
let store: Store;
let service: PaymentService;
const dataRoot = resolve('data');
before(async () => { compile(); chain = await localChain(); mkdirSync(dataRoot, { recursive: true }); });
after(async () => { await chain.close(); });
beforeEach(async () => {
  snapshot = await chain.provider.send('evm_snapshot', []);
  directory = mkdtempSync(join(dataRoot, 'recovery-test-'));
  store = new Store(join(directory, 'journal.sqlite'));
  service = makeService();
});
afterEach(async () => {
  store.close();
  await chain.provider.send('evm_revert', [snapshot]);
  // Delete only the freshly generated test directory, never a computed ancestor.
  assert.equal(dirname(resolve(directory)), dataRoot);
  assert.ok(directory.startsWith(join(dataRoot, 'recovery-test-')));
  rmSync(directory, { recursive: true, force: true });
});
function makeService() {
  return new PaymentService(store, chain.provider, chain.relayer, chain.router, 31337, String(chain.router.target));
}
async function signed(overrides: Partial<Payment> = {}, payer = chain.payer, payee = chain.payee) {
  const block = await chain.provider.getBlock('latest');
  const payment: Payment = {
    paymentId: id(randomBytes(16).toString('hex')), payer: payer.address, payee: payee.address,
    token: String(chain.token.target), amount: '125000000',
    nonce: String(await chain.router.nonces(payer.address)), deadline: String(block!.timestamp + 3600), ...overrides
  };
  return { payment, signature: await payer.signTypedData(service.signingDomain, paymentTypes, payment) };
}
async function crashAt(phase: string, paymentId: string) {
  store.close();
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/recovery-worker.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-2000); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = new Promise<void>((resolveReady, reject) => {
      child.on('message', (message: any) => {
        if (message.checkpoint) resolveReady();
        else if (message.error) reject(new Error(message.error));
      });
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Worker exited before checkpoint: ' + code + ' ' + stderr)));
      timer = setTimeout(() => reject(new Error('Worker checkpoint timed out')), 20000);
    });
    child.send({ db: join(directory, 'journal.sqlite'), rpc: chain.provider._getConnection().url,
      key: chain.relayer.privateKey, router: String(chain.router.target), phase, paymentId });
    await ready;
  } finally {
    clearTimeout(timer);
    // An OS termination deliberately skips SQLite.close() and all JS cleanup.
    const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
    child.kill('SIGKILL');
    if (child.exitCode === null && child.signalCode === null) await exited;
    store = new Store(join(directory, 'journal.sqlite'));
    service = makeService();
  }
}

for (const phase of ['before-broadcast', 'after-broadcast', 'after-finalize']) {
  test('file-backed recovery after process termination ' + phase, { timeout: 30000 }, async () => {
    const input = await signed();
    const accepted = await service.accept(input);
    await crashAt(phase, accepted.row.id);
    const recovered = store.get(accepted.row.id)!;
    assert.equal(recovered.status, phase === 'after-finalize' ? 'settled' : 'broadcast');
    assert.ok(recovered.raw_tx && recovered.tx_hash);
    assert.equal(keccak256(recovered.raw_tx), recovered.tx_hash);
    if (phase === 'before-broadcast') assert.equal(await chain.token.balanceOf(chain.payee.address), 0n);
    else assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
    await service.tick();
    await service.tick();
    assert.equal(store.get(accepted.row.id)!.status, 'settled');
    assert.equal(store.get(accepted.row.id)!.tx_hash, recovered.tx_hash);
    assert.equal(store.journals().length, 1);
    assert.equal(store.events().filter(e => e.action === 'settled').length, 1);
    assert.equal(await chain.router.nonces(chain.payer.address), 1n);
    assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  });
}

test('SQLite rolls back a transaction interrupted by process termination', { timeout: 30000 }, async () => {
  const accepted = await service.accept(await signed());
  await crashAt('inside-transaction', accepted.row.id);
  assert.equal(store.get(accepted.row.id)!.status, 'queued');
  assert.equal(store.get(accepted.row.id)!.error, null);
  assert.equal(store.events().filter(e => e.action === 'uncommitted').length, 0);
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
  assert.equal(store.journals().length, 1);
});

test('persisted broadcast reserves its nonce ahead of queued work after clock rollback', async () => {
  const first = await signed({ paymentId: '0x' + 'ff'.repeat(32) });
  const acceptedFirst = await service.accept(first);
  const request = await chain.router.connect(chain.relayer).settle.populateTransaction(first.payment, first.signature);
  const raw = await chain.relayer.signTransaction(await chain.relayer.populateTransaction(request));
  store.broadcast(acceptedFirst.row.id, raw, keccak256(raw));
  await (await chain.token.mint(chain.payee.address, parseUnits('1000', 6))).wait();
  await (await chain.token.connect(chain.payee).approve(chain.router.target, parseUnits('1000', 6))).wait();
  const second = await signed({ paymentId: '0x' + '01'.repeat(32) }, chain.payee, chain.payer);
  const acceptedSecond = await service.accept(second);
  store.db.prepare('UPDATE payments SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', acceptedSecond.row.id);
  store.close();
  store = new Store(join(directory, 'journal.sqlite'));
  service = makeService();
  assert.deepEqual(store.pending().map(p => p.id), [acceptedFirst.row.id, acceptedSecond.row.id]);
  await service.tick();
  assert.equal(store.get(acceptedFirst.row.id)!.status, 'settled');
  assert.equal(store.get(acceptedSecond.row.id)!.status, 'settled');
  const firstNativeNonce = Transaction.from(store.get(acceptedFirst.row.id)!.raw_tx!).nonce;
  const secondNativeNonce = Transaction.from(store.get(acceptedSecond.row.id)!.raw_tx!).nonce;
  assert.equal(secondNativeNonce, firstNativeNonce + 1);
  assert.equal(store.journals().length, 2);
});

test('ambiguous RPC call exception leaves queued work retryable', async () => {
  const accepted = await service.accept(await signed());
  const unavailable: any = {
    connect() { return this; },
    settle: { staticCall: async () => { throw Object.assign(new Error('Upstream unavailable'), { code: 'CALL_EXCEPTION', data: null }); } }
  };
  const outage = new PaymentService(store, chain.provider, chain.relayer, unavailable, 31337, String(chain.router.target));
  await assert.rejects(() => outage.tick(), /Upstream unavailable/);
  assert.equal(store.get(accepted.row.id)!.status, 'queued');
  assert.equal(store.events().filter(e => e.action === 'failed').length, 0);
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
});

test('status and audit record roll back together if audit storage fails', async () => {
  const accepted = await service.accept(await signed());
  store.db.exec("CREATE TRIGGER reject_failure_audit BEFORE INSERT ON audit WHEN NEW.action='failed' BEGIN SELECT RAISE(ABORT,'simulated audit failure'); END");
  assert.throws(() => store.setStatus(accepted.row.id, 'failed', 'test rejection'), /simulated audit failure/);
  assert.equal(store.get(accepted.row.id)!.status, 'queued');
  assert.equal(store.get(accepted.row.id)!.error, null);
  store.db.exec('DROP TRIGGER reject_failure_audit');
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
});

test('journal and settlement status commit together when finalization is retried', async () => {
  const accepted = await service.accept(await signed());
  store.db.exec("CREATE TRIGGER reject_settlement_audit BEFORE INSERT ON audit WHEN NEW.action='settled' BEGIN SELECT RAISE(ABORT,'simulated disk failure'); END");
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'broadcast');
  assert.equal(store.journals().length, 0);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
  store.db.exec('DROP TRIGGER reject_settlement_audit');
  await service.tick();
  assert.equal(store.get(accepted.row.id)!.status, 'settled');
  assert.equal(store.journals().length, 1);
  assert.equal(await chain.token.balanceOf(chain.payee.address), 125000000n);
});
