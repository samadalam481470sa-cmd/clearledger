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

const CHAIN_ID = 20261024;
const COMPOSE_FILE = resolve('network/compose.yaml');
const PROJECT_NAME = 'clearledger-dev';
const PORTS = [8545, 8546, 8547, 8548];
const POLL_MS = 1000;
const TOTAL_BUDGET_MS = 8 * 60 * 1000;

interface Agreement { height: number; hash: string; heads: number[] }
interface GeneratedAddresses { chainId: number; deployer: string; validators: string[] }
class AcceptanceFailure extends Error {}

function sameValidatorSet(actual: unknown, expected: string[]): boolean {
  if (!Array.isArray(actual) || actual.some(value => typeof value !== 'string')) return false;
  const normalized = actual.map(value => value.toLowerCase()).sort();
  return normalized.length === 4 && new Set(normalized).size === 4 &&
    normalized.join(',') === expected.map(value => value.toLowerCase()).sort().join(',');
}

async function compose(command: 'stop' | 'start') {
  // Never stop a whole Docker host, another project, or any service besides validator4.
  await new Promise<void>((resolveCommand, reject) => {
    execFile('docker', ['compose', '-p', PROJECT_NAME, '-f', COMPOSE_FILE, command, 'validator4'],
      { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }, error => {
        if (error) reject(new Error('Docker Compose ' + command + ' validator4 failed'));
        else resolveCommand();
      });
  });
}

/** Real-network acceptance only. This is never executed by the unit-test command. */
export async function verifyNetwork() {
  const started = Date.now();
  const deadline = started + TOTAL_BUDGET_MS;
  let phase = 'configuration';
  let validator4MayBeStopped = false;
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
    validator4MayBeStopped = true;
    await bounded(phase, () => compose('stop'), 30000);
    const stopHeight = await bounded(phase, () => provider.getBlockNumber(), 10000);
    const progressedHeight = await poll(phase, async () => {
      const height = await provider.getBlockNumber();
      return height >= stopHeight + 2 ? height : undefined;
    });
    const surviving = await poll('three surviving validators agree', () => agreement(providers.slice(0, 3), generated.validators));
    console.log(JSON.stringify({ check: 'one-validator-failure', stoppedService: 'validator4',
      fromHeight: stopHeight, progressedHeight, survivingAgreement: surviving.height }));

    phase = 'validator restart and catch-up';
    await bounded(phase, () => compose('start'), 30000);
    validator4MayBeStopped = false;
    const recovered = await poll(phase, () => agreement(providers, generated.validators));
    assert.ok(recovered.height >= progressedHeight, 'Restarted validator did not catch up');
    console.log(JSON.stringify({ check: 'validator-recovery', ...recovered }));
    console.log(JSON.stringify({ result: 'passed', elapsedMs: Date.now() - started,
      checks: ['four-validator-agreement', 'signed-settlement', 'one-validator-failure', 'validator-recovery'] }));
  } catch (error) {
    // Avoid dumping transaction arguments, generated keys, or wallet objects into CI logs.
    const reason = error instanceof AcceptanceFailure ? ' (' + error.message + ')' : '';
    throw new Error('Besu acceptance failed during ' + phase + reason + '; inspect the validator logs');
  } finally {
    if (validator4MayBeStopped) {
      try { await compose('start'); }
      catch { console.error('Cleanup could not restart clearledger-dev validator4'); process.exitCode = 1; }
    }
    for (const provider of providers) provider.destroy();
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyNetwork().catch(error => { console.error(error.message); process.exitCode = 1; });
}
