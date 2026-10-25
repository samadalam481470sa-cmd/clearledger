import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Wallet, id, parseEther, parseUnits, type JsonRpcProvider } from 'ethers';
import { createRpcProvider } from '../src/rpc.ts';
import { deploy } from '../src/chain.ts';
import { Store } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes } from '../src/payment.ts';
import { compile } from './compile.ts';
import { observeHalted, QuorumObservationError } from './quorum-observation.ts';

const CHAIN_ID = 20261024;
const COMPOSE_FILE = resolve('network/compose.yaml');
const PROJECT_NAME = 'clearledger-dev';
const PORTS = [8545, 8546, 8547, 8548];
const POLL_MS = 1000;
const TOTAL_BUDGET_MS = 10 * 60 * 1000;

interface Agreement { height: number; hash: string; heads: number[] }
interface GeneratedAddresses { chainId: number; deployer: string; validators: string[] }
class AcceptanceFailure extends Error {}
type StoppableValidator = 'validator3' | 'validator4';

function sameValidatorSet(actual: unknown, expected: string[]): boolean {
  if (!Array.isArray(actual) || actual.some(value => typeof value !== 'string')) return false;
  const normalized = actual.map(value => value.toLowerCase()).sort();
  return normalized.length === 4 && new Set(normalized).size === 4 &&
    normalized.join(',') === expected.map(value => value.toLowerCase()).sort().join(',');
}

async function compose(command: 'stop' | 'start', service: StoppableValidator) {
  // Restrict fault injection to these two services in this task's development project.
  await new Promise<void>((resolveCommand, reject) => {
    execFile('docker', ['compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE, command, service],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, error => {
        if (error) reject(new Error('Docker Compose ' + command + ' ' + service + ' failed'));
        else resolveCommand();
      });
  });
}

/** Real-network acceptance only. This is never executed by the unit-test command. */
export async function verifyNetwork() {
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  let phase = 'configuration';
  const possiblyStopped = new Set<StoppableValidator>();
  let lastProbeLog = 0;
  const providers = PORTS.map(port => createRpcProvider('http://127.0.0.1:' + port, 3000));
  const store = new Store();

  async function bounded<T>(label: string, operation: () => Promise<T>, timeoutMs: number): Promise<T> {
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new Error(label + ' exceeded acceptance time budget');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out')), remaining);
        })
      ]);
    } finally { clearTimeout(timer); }
  }

  async function poll<T>(label: string, probe: () => Promise<T | undefined>, timeoutMs = 90000): Promise<T> {
    const until = Math.min(Date.now() + timeoutMs, deadline);
    while (Date.now() < until) {
      try {
        const result = await bounded(label, probe, until - Date.now());
        if (result !== undefined) return result;
      } catch (error) {
        if (error instanceof AcceptanceFailure) throw error;
        if (Date.now() - lastProbeLog >= 10000) {
          lastProbeLog = Date.now();
          const detail = error as { code?: string; shortMessage?: string };
          console.log(JSON.stringify({ check: 'rpc-wait', phase: label,
            code: detail.code ?? 'unknown', reason: detail.shortMessage ?? 'RPC not ready' }));
        }
        // Startup, stopped peers, and temporary RPC failures are expected while polling.
      }
      const pause = Math.min(POLL_MS, until - Date.now());
      if (pause > 0) await new Promise(resolvePause => setTimeout(resolvePause, pause));
    }
    throw new Error(label + ' did not satisfy acceptance conditions within the timeout');
  }

  async function agreement(active: JsonRpcProvider[], validators: string[]): Promise<Agreement | undefined> {
    const networks = await Promise.all(active.map(provider => provider.getNetwork()));
    if (networks.some(network => network.chainId !== BigInt(CHAIN_ID))) return undefined;
    const heads = await Promise.all(active.map(provider => provider.getBlockNumber()));
    const height = Math.min(...heads);
    // Height zero proves only that genesis loaded; close head heights prove peer catch-up.
    if (height < 1 || Math.max(...heads) - height > 2) return undefined;
    const tag = '0x' + height.toString(16);
    const [blocks, memberships] = await Promise.all([
      Promise.all(active.map(provider => provider.getBlock(height))),
      Promise.all(active.map(provider => provider.send('qbft_getValidatorsByBlockNumber', [tag])))
    ]);
    const hash = blocks[0]?.hash;
    if (Date.now() - lastProbeLog >= 10000) {
      lastProbeLog = Date.now();
      console.log(JSON.stringify({ check: 'agreement-probe', heads,
        hashes: blocks.map(block => block?.hash), memberships }));
    }
    if (!hash || blocks.some(block => !block || block.hash !== hash) ||
      memberships.some(members => !sameValidatorSet(members, validators))) return undefined;
    return { height, hash, heads };
  }

  try {
    const generated = JSON.parse(readFileSync('network/generated/addresses.json', 'utf8')) as GeneratedAddresses;
    assert.equal(generated.chainId, CHAIN_ID, 'Generated chain ID mismatch');
    assert.equal(new Set(generated.validators.map(value => value.toLowerCase())).size, 4,
      'Four distinct generated validators are required');
    compile();

    phase = 'four-validator agreement';
    const initial = await poll(phase, () => agreement(providers, generated.validators));
    console.log(JSON.stringify({ check: 'four-validator-agreement', chainId: CHAIN_ID, ...initial }));

    phase = 'test-account funding and contract deployment';
    const provider = providers[0];
    const admin = new Wallet(readFileSync('network/generated/deployer.key', 'utf8').trim(), provider);
    assert.equal(admin.address.toLowerCase(), generated.deployer.toLowerCase(), 'Generated deployer mismatch');
    const [relayer, payer, payee] = Array.from({ length: 3 }, () => new Wallet(Wallet.createRandom().privateKey, provider));
    const { token, router } = await bounded(phase, async () => {
      for (const account of [relayer, payer, payee]) {
        await (await admin.sendTransaction({ to: account.address, value: parseEther('10') })).wait();
      }
      return await deploy(provider, admin, relayer, payer, payee);
    }, 150000);

    phase = 'signed demo settlement';
    const service = new PaymentService(store, provider, relayer, router, CHAIN_ID, await router.getAddress(), 2);
    const latest = await bounded(phase, () => provider.getBlock('latest'), 10000);
    assert.ok(latest, 'Latest block is unavailable');
    const amount = parseUnits('125', 6);
    const payment = {
      paymentId: id(randomBytes(24).toString('hex')), payer: payer.address, payee: payee.address,
      token: await token.getAddress(), amount: amount.toString(), nonce: '0',
      deadline: String(latest.timestamp + 3600)
    };
    const signature = await payer.signTypedData(service.signingDomain, paymentTypes, payment);
    const accepted = await bounded(phase, () => service.accept({ payment, signature }), 10000);
    const settled = await poll(phase, async () => {
      await service.tick();
      const row = store.get(accepted.row.id)!;
      if (row.status === 'failed' || row.status === 'review')
        throw new AcceptanceFailure('Demo payment entered ' + row.status + ' state');
      return row.status === 'settled' ? row : undefined;
    }, 60000);
    assert.equal(await token.balanceOf(payee.address), amount, 'Recipient balance mismatch');
    assert.equal(await router.nonces(payer.address), 1n, 'Payer nonce mismatch');
    assert.equal(store.journals().length, 1, 'Exactly one transfer journal is required');
    assert.deepEqual((await bounded('receipt reconciliation', () => service.reconcile(), 10000)).exceptions, []);
    console.log(JSON.stringify({ check: 'signed-settlement', settledBaseUnits: amount.toString(),
      journalEntries: 1, transactionHash: settled.tx_hash, block: settled.block_number }));

    phase = 'one-validator failure';
    possiblyStopped.add('validator4');
    await bounded(phase, () => compose('stop', 'validator4'), 30000);
    const stopHeight = await bounded(phase, () => provider.getBlockNumber(), 10000);
    const progressedHeight = await poll(phase, async () => {
      const height = await provider.getBlockNumber();
      return height >= stopHeight + 2 ? height : undefined;
    });
    const surviving = await poll('three surviving validators agree', () => agreement(providers.slice(0, 3), generated.validators));
    console.log(JSON.stringify({ check: 'one-validator-failure', stoppedService: 'validator4',
      fromHeight: stopHeight, progressedHeight, survivingAgreement: surviving.height }));

    phase = 'two-validator stop and in-flight block drain';
    possiblyStopped.add('validator3');
    await bounded(phase, () => compose('stop', 'validator3'), 30000);
    const pair = providers.slice(0, 2);
    let quiet: { height: number; hash: string; since: number } | undefined;
    const baseline = await poll(phase, async () => {
      try {
        const sample = await agreement(pair, generated.validators);
        if (!sample || sample.heads.some(height => height !== sample.height)) { quiet = undefined; return; }
        if (!quiet || quiet.height !== sample.height || quiet.hash !== sample.hash)
          quiet = { height: sample.height, hash: sample.hash, since: Date.now() };
        return Date.now() - quiet.since >= 8000 ? sample : undefined;
      } catch (error) { quiet = undefined; throw error; }
    }, 45000);

    phase = 'pending payment without quorum';
    const laterAmount = parseUnits('37.5', 6);
    const laterBlock = await bounded(phase, () => provider.getBlock('latest'), 10000);
    assert.ok(laterBlock, 'Latest block is unavailable');
    const laterPayment = { ...payment, paymentId: id(randomBytes(24).toString('hex')),
      amount: laterAmount.toString(), nonce: '1', deadline: String(laterBlock.timestamp + 3600) };
    const laterSignature = await payer.signTypedData(service.signingDomain, paymentTypes, laterPayment);
    const laterAccepted = await bounded(phase, () => service.accept({ payment: laterPayment, signature: laterSignature }), 10000);
    await bounded(phase, () => service.tick(), 20000);
    const pending = store.get(laterAccepted.row.id)!;
    assert.equal(pending.status, 'broadcast', 'No-quorum payment must have durable signed bytes');
    assert.ok(pending.tx_hash && pending.raw_tx, 'Pending transaction provenance is required');
    const pendingHash = pending.tx_hash, pendingRaw = pending.raw_tx;
    await poll('both live nodes accepted the pending transaction', async () => {
      const transactions = await Promise.all(pair.map(node => node.getTransaction(pendingHash)));
      if (transactions.some(transaction => !transaction)) return;
      assert.ok(transactions.every(transaction => transaction!.hash === pendingHash && transaction!.blockNumber === null),
        'Quorum-loss transaction must be pending on both live nodes');
      return true;
    }, 20000);

    phase = 'two-validator quorum observation';
    const halted = await bounded(phase, () => observeHalted(async () => {
      await service.tick();
      const sample = await agreement(pair, generated.validators);
      if (!sample) throw new AcceptanceFailure('Surviving RPC nodes do not agree');
      const [receipts, balance, nonce] = await Promise.all([
        Promise.all(pair.map(node => node.getTransactionReceipt(pendingHash))),
        token.balanceOf(payee.address), router.nonces(payer.address)
      ]);
      assert.ok(receipts.every(receipt => receipt === null), 'No-quorum transaction unexpectedly has a receipt');
      const row = store.get(laterAccepted.row.id)!;
      assert.equal(row.status, 'broadcast', 'No-quorum payment finalized prematurely');
      assert.equal(row.tx_hash, pendingHash, 'Pending transaction hash changed');
      assert.equal(row.raw_tx, pendingRaw, 'Pending signed bytes changed');
      assert.equal(store.journals().length, 1, 'No-quorum payment must not create a journal');
      assert.equal(balance, amount, 'Recipient balance changed without quorum');
      assert.equal(nonce, 1n, 'Payer nonce changed without quorum');
      return sample;
    }, baseline), 45000);
    console.log(JSON.stringify({ check: 'two-validator-quorum-loss', stoppedServices: ['validator3', 'validator4'],
      height: halted.height, hash: halted.hash, observedMs: halted.elapsedMs, observations: halted.observations,
      pendingTransactionHash: pendingHash, journalEntries: 1 }));

    phase = 'restore three-validator quorum';
    await bounded(phase, () => compose('start', 'validator3'), 30000);
    possiblyStopped.delete('validator3');
    const restored = await poll(phase, async () => {
      const sample = await agreement(providers.slice(0, 3), generated.validators);
      return sample && sample.height >= baseline.height + 2 ? sample : undefined;
    }, 300000);
    console.log(JSON.stringify({ check: 'quorum-restoration', ...restored }));

    phase = 'settle original pending transaction after quorum restoration';
    const laterSettled = await poll(phase, async () => {
      await service.tick();
      const row = store.get(laterAccepted.row.id)!;
      if (row.status === 'failed' || row.status === 'review')
        throw new AcceptanceFailure('Recovered payment entered ' + row.status + ' state');
      return row.status === 'settled' ? row : undefined;
    }, 60000);
    assert.equal(laterSettled.tx_hash, pendingHash, 'Recovery must settle the original transaction');
    assert.equal(laterSettled.raw_tx, pendingRaw, 'Recovery must retain original signed bytes');
    await bounded(phase, () => service.tick(), 10000);
    assert.equal(await token.balanceOf(payee.address), amount + laterAmount, 'Recovered transfer balance mismatch');
    assert.equal(await router.nonces(payer.address), 2n, 'Recovered payer nonce mismatch');
    assert.equal(store.journals().length, 2, 'Recovered payment must add exactly one journal');
    assert.deepEqual((await bounded('recovered receipt reconciliation', () => service.reconcile(), 10000)).exceptions, []);
    console.log(JSON.stringify({ check: 'post-quorum-settlement', settledBaseUnits: laterAmount.toString(),
      transactionHash: laterSettled.tx_hash, block: laterSettled.block_number, journalEntries: 2 }));

    phase = 'all-validator restart and catch-up';
    await bounded(phase, () => compose('start', 'validator4'), 30000);
    possiblyStopped.delete('validator4');
    const recovered = await poll(phase, () => agreement(providers, generated.validators));
    assert.ok(recovered.height >= laterSettled.block_number!, 'Restarted validator did not catch up');
    console.log(JSON.stringify({ check: 'validator-recovery', ...recovered }));
    console.log(JSON.stringify({ result: 'passed', elapsedMs: Date.now() - started,
      checks: ['four-validator-agreement', 'signed-settlement', 'one-validator-failure',
        'two-validator-quorum-loss', 'quorum-restoration', 'post-quorum-settlement', 'validator-recovery'] }));
  } catch (error) {
    // Avoid dumping transaction arguments, generated keys, or wallet objects into CI logs.
    const reason = error instanceof AcceptanceFailure || error instanceof QuorumObservationError ? ' (' + error.message + ')' : '';
    throw new Error('Besu acceptance failed during ' + phase + reason + '; inspect the validator logs');
  } finally {
    for (const validator of possiblyStopped) {
      try { await compose('start', validator); }
      catch { console.error('Cleanup could not restart clearledger-dev ' + validator); process.exitCode = 1; }
    }
    for (const provider of providers) provider.destroy();
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyNetwork().catch(error => { console.error(error.message); process.exitCode = 1; });
}
