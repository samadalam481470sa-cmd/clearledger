import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ContractFactory, Wallet, id, keccak256, parseEther, parseUnits, Transaction, type JsonRpcProvider } from 'ethers';
import { createRpcProvider } from '../src/rpc.ts';
import { deploy } from '../src/chain.ts';
import { Store, type RecordRow } from '../src/store.ts';
import { PaymentService } from '../src/service.ts';
import { paymentTypes } from '../src/payment.ts';
import { bindDatabaseContext } from '../src/database-context.ts';
import { acquireDatabaseOwnership, DatabaseOwnershipError } from '../src/database-ownership.ts';
import { compile } from './compile.ts';
import { observeHalted, QuorumObservationError } from './quorum-observation.ts';
import { compileTestWallet } from '../tests/fixtures/compile-wallet.ts';
import { startCli, type CliHandle } from '../tests/fixtures/cli-server.ts';

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
interface LedgerSnapshot {
  row: RecordRow;
  payments: Record<string, unknown>[];
  journals: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  sequence: Record<string, unknown>[];
  context: Record<string, unknown>[];
  schema: Record<string, unknown>[];
}

function ledgerSnapshot(db: DatabaseSync, paymentId: string): LedgerSnapshot {
  // One read transaction observes a committed logical checkpoint across every table.
  db.exec('BEGIN');
  try {
    const rows = (sql: string) => db.prepare(sql).all().map(item => ({ ...item }));
    const payments = rows('SELECT * FROM payments ORDER BY rowid');
    const row = payments.find(item => item.id === paymentId) as unknown as RecordRow | undefined;
    assert.ok(row, 'Checkpoint payment is unavailable');
    const snapshot = { row, payments, journals: rows('SELECT * FROM journals ORDER BY rowid'),
      audit: rows('SELECT * FROM audit ORDER BY sequence'),
      sequence: rows('SELECT * FROM sqlite_sequence ORDER BY name'),
      context: rows('SELECT * FROM deployment_context ORDER BY singleton'),
      schema: rows('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name') };
    db.exec('COMMIT');
    return snapshot;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

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
  // Keep acceptance data in a new task-owned directory, separate from generated keys.
  const ledgerDirectory = mkdtempSync(join(resolve('network/generated'), 'acceptance-ledger-'));
  const ledgerPath = join(ledgerDirectory, 'journal.sqlite');
  let store = new Store(ledgerPath), storeOpen = true;
  const providers = PORTS.map(port => createRpcProvider('http://127.0.0.1:' + port, 3000));
  const cliHandles: CliHandle[] = [];
  const closedCliHandles = new Set<CliHandle>();
  let observer: DatabaseSync | undefined;

  function closeStore() {
    if (storeOpen) { store.close(); storeOpen = false; }
  }
  function closeObserver() {
    if (observer) { observer.close(); observer = undefined; }
  }
  function registerCli(handle: CliHandle) {
    cliHandles.push(handle);
    void handle.exited.then(() => { closedCliHandles.add(handle); });
  }
  function requireLiveCli(handle: CliHandle) {
    if (closedCliHandles.has(handle) || handle.child.exitCode !== null || handle.child.signalCode !== null)
      throw new AcceptanceFailure('RPC CLI exited before completing recovery');
  }
  function requireCliOwnership() {
    let unexpected: ReturnType<typeof acquireDatabaseOwnership>;
    try { unexpected = acquireDatabaseOwnership(ledgerPath); }
    catch (error) {
      assert.ok(error instanceof DatabaseOwnershipError);
      assert.equal(error.message, 'Database is already owned by another ClearLedger RPC process');
      return;
    }
    unexpected.release();
    assert.fail('A live RPC CLI must retain database ownership');
  }
  function requireReleasedOwnership() {
    const ownership = acquireDatabaseOwnership(ledgerPath);
    ownership.release();
  }
  async function cliRequest<T>(handle: CliHandle, path: '/api/overview' | '/api/reconcile', method = 'GET'): Promise<T> {
    requireLiveCli(handle);
    const response = await fetch(handle.url + path, { method,
      headers: { Authorization: 'Bearer ' + handle.apiKey }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200, 'Authenticated RPC CLI request must succeed');
    const result = await response.json() as T;
    requireLiveCli(handle);
    return result;
  }
  async function verifyCliConfiguration(handle: CliHandle, routerAddress: string) {
    const overview = await cliRequest<{ mode: string; chainId: number; router: string; confirmations: number;
      block: { number: number; hash: string } | null }>(handle, '/api/overview');
    assert.equal(overview.mode, 'rpc');
    assert.equal(overview.chainId, CHAIN_ID);
    assert.equal(overview.confirmations, 2);
    assert.equal(overview.router, routerAddress);
    assert.ok(overview.block?.hash && overview.block.number > 0, 'RPC CLI must serve a ready chain overview');
  }

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

  async function quietPair(label: string, validators: string[]): Promise<Agreement> {
    let quiet: { height: number; hash: string; since: number } | undefined;
    return poll(label, async () => {
      try {
        const sample = await agreement(providers.slice(0, 2), validators);
        if (!sample || sample.heads.some(height => height !== sample.height)) { quiet = undefined; return; }
        if (!quiet || quiet.height !== sample.height || quiet.hash !== sample.hash)
          quiet = { height: sample.height, hash: sample.hash, since: Date.now() };
        return Date.now() - quiet.since >= 8000 ? sample : undefined;
      } catch (error) { quiet = undefined; throw error; }
    }, 45000);
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
    const routerAddress = await router.getAddress();
    const genesis = await bounded('deployment genesis binding', () => provider.getBlock(0), 10000);
    assert.ok(genesis?.hash && genesis.number === 0, 'Deployment genesis is unavailable');
    bindDatabaseContext(store.db, { chainId: CHAIN_ID, genesisHash: genesis.hash,
      router: routerAddress, relayer: relayer.address });
    let service = new PaymentService(store, provider, relayer, router, CHAIN_ID, routerAddress, 2);
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
    const baseline = await quietPair(phase, generated.validators);

    phase = 'pending payment without quorum';
    const laterAmount = parseUnits('37.5', 6);
    const laterBlock = await bounded(phase, () => provider.getBlock('latest'), 10000);
    assert.ok(laterBlock, 'Latest block is unavailable');
    const laterPayment = { ...payment, paymentId: id(randomBytes(24).toString('hex')),
      amount: laterAmount.toString(), nonce: '1', deadline: String(laterBlock.timestamp + 3600) };
    const laterSignature = await payer.signTypedData(service.signingDomain, paymentTypes, laterPayment);
    const laterAccepted = await bounded(phase, () => service.accept({ payment: laterPayment, signature: laterSignature }), 10000);
    assert.equal(laterAccepted.row.status, 'queued', 'Parent must hand off an undispatched payment');
    assert.equal(laterAccepted.row.raw_tx, null);
    assert.equal(laterAccepted.row.tx_hash, null);
    const beforeWorker = ledgerSnapshot(store.db, laterAccepted.row.id);
    const relayerNonceBeforeCrash = await bounded(phase,
      () => provider.getTransactionCount(relayer.address, 'latest'), 10000);
    closeStore();

    phase = 'autonomous RPC CLI reservation and broadcast without quorum';
    const cliOptions = { db: ledgerPath, rpc: 'http://127.0.0.1:' + PORTS[0], key: relayer.privateKey,
      router: routerAddress, chainId: CHAIN_ID, confirmations: 2, onSpawn: registerCli };
    const writer = await bounded(phase, () => startCli(cliOptions), 25000);
    const writerPid = writer.child.pid;
    assert.ok(writerPid && writerPid !== process.pid, 'RPC writer must run in a distinct process');
    await bounded('writer RPC CLI configuration and readiness', () => verifyCliConfiguration(writer, routerAddress), 10000);
    requireCliOwnership();
    // Store constructors mutate schema and PRAGMAs, so observe both CLI lifetimes natively read-only.
    observer = new DatabaseSync(ledgerPath, { readOnly: true });
    const dispatched = await poll(phase, async () => {
      requireLiveCli(writer);
      const snapshot = ledgerSnapshot(observer!, laterAccepted.row.id);
      if (snapshot.row.status === 'failed' || snapshot.row.status === 'review')
        throw new AcceptanceFailure('RPC writer payment entered ' + snapshot.row.status + ' state');
      return snapshot.row.status === 'broadcast' && snapshot.row.raw_tx && snapshot.row.tx_hash ? snapshot : undefined;
    }, 30000);
    assert.ok(dispatched.row.raw_tx && dispatched.row.tx_hash, 'RPC CLI must persist a native reservation');
    const pendingHash = dispatched.row.tx_hash, pendingRaw = dispatched.row.raw_tx;
    assert.equal(keccak256(pendingRaw), pendingHash);
    const archivedTransaction = Transaction.from(pendingRaw);
    assert.equal(archivedTransaction.chainId, BigInt(CHAIN_ID));
    assert.equal(archivedTransaction.nonce, relayerNonceBeforeCrash);
    await poll('both live nodes accepted the pending transaction', async () => {
      requireLiveCli(writer);
      const transactions = await Promise.all(pair.map(node => node.getTransaction(pendingHash)));
      if (transactions.some(transaction => !transaction)) return;
      assert.ok(transactions.every(transaction => transaction!.hash === pendingHash && transaction!.blockNumber === null),
        'Quorum-loss transaction must be pending on both live nodes');
      return true;
    }, 20000);
    // This is an observed committed checkpoint, not an acknowledgement from a fixture worker.
    const checkpoint = ledgerSnapshot(observer, laterAccepted.row.id);
    assert.deepEqual(checkpoint, dispatched, 'No-quorum dispatch must leave the committed reservation unchanged');
    assert.deepEqual(checkpoint.journals, beforeWorker.journals, 'Dispatch must retain the first settlement journal');
    assert.deepEqual(checkpoint.payments.filter(row => row.id !== laterAccepted.row.id),
      beforeWorker.payments.filter(row => row.id !== laterAccepted.row.id));
    assert.deepEqual(checkpoint.context, beforeWorker.context, 'RPC startup must retain the deployment binding');

    phase = 'forced RPC writer termination and autonomous CLI restart';
    requireLiveCli(writer);
    await bounded('RPC writer SIGKILL and confirmed close', () => writer.kill(), 6000);
    const writerExit = await writer.exited;
    assert.equal(writerExit.signal, 'SIGKILL', 'RPC writer must terminate without its shutdown path');
    assert.deepEqual(ledgerSnapshot(observer, laterAccepted.row.id), checkpoint,
      'Writer termination must preserve every payment, journal, audit, sequence and deployment-context row');
    requireReleasedOwnership();
    const restarted = await bounded(phase, () => startCli({ ...cliOptions, apiKey: writer.apiKey }), 25000);
    const restartedPid = restarted.child.pid;
    assert.ok(restartedPid && restartedPid !== writerPid && restartedPid !== process.pid,
      'Recovery must use a new RPC CLI process');
    await bounded('restarted RPC CLI configuration and readiness',
      () => verifyCliConfiguration(restarted, routerAddress), 10000);
    requireCliOwnership();
    assert.deepEqual(ledgerSnapshot(observer, laterAccepted.row.id), checkpoint,
      'CLI restart without quorum must retain the complete committed checkpoint');

    phase = 'two-validator quorum observation';
    const halted = await bounded(phase, () => observeHalted(async () => {
      requireLiveCli(restarted);
      const sample = await agreement(pair, generated.validators);
      if (!sample) throw new AcceptanceFailure('Surviving RPC nodes do not agree');
      const [receipts, transactions, balance, nonce] = await Promise.all([
        Promise.all(pair.map(node => node.getTransactionReceipt(pendingHash))),
        Promise.all(pair.map(node => node.getTransaction(pendingHash))),
        token.balanceOf(payee.address), router.nonces(payer.address)
      ]);
      assert.ok(receipts.every(receipt => receipt === null), 'No-quorum transaction unexpectedly has a receipt');
      assert.ok(transactions.every(transaction => transaction?.hash === pendingHash && transaction.blockNumber === null),
        'The original transaction must remain pending on both live nodes');
      assert.deepEqual(ledgerSnapshot(observer!, laterAccepted.row.id), checkpoint,
        'Autonomous CLI quorum loss changed the reservation, journals, audit, sequence or deployment context');
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
      requireLiveCli(restarted);
      const row = ledgerSnapshot(observer!, laterAccepted.row.id).row;
      if (row.status === 'failed' || row.status === 'review')
        throw new AcceptanceFailure('Recovered payment entered ' + row.status + ' state');
      return row.status === 'settled' ? row : undefined;
    }, 60000);
    assert.equal(laterSettled.tx_hash, pendingHash, 'Recovery must settle the original transaction');
    assert.equal(laterSettled.raw_tx, pendingRaw, 'Recovery must retain original signed bytes');
    assert.equal(await token.balanceOf(payee.address), amount + laterAmount, 'Recovered transfer balance mismatch');
    assert.equal(await router.nonces(payer.address), 2n, 'Recovered payer nonce mismatch');
    const recoveredReconciliation = await bounded('RPC CLI recovered receipt reconciliation',
      () => cliRequest<{ checked: number; exceptions: unknown[] }>(restarted, '/api/reconcile', 'POST'), 15000);
    assert.equal(recoveredReconciliation.checked, 2);
    assert.deepEqual(recoveredReconciliation.exceptions, []);
    const relayerNonceAfterCrash = await bounded(phase,
      () => provider.getTransactionCount(relayer.address, 'latest'), 10000);
    assert.equal(relayerNonceAfterCrash, relayerNonceBeforeCrash + 1, 'Crash recovery must consume exactly one native nonce');
    const recoveredCheckpoint = ledgerSnapshot(observer, laterAccepted.row.id);
    assert.equal(recoveredCheckpoint.journals.length, 2, 'Recovered payment must add exactly one journal');
    assert.equal(recoveredCheckpoint.audit.filter(event => event.payment_id === laterAccepted.row.id && event.action === 'settled').length, 1);
    assert.deepEqual(recoveredCheckpoint.context, checkpoint.context);
    requireLiveCli(restarted);
    requireCliOwnership();
    await bounded('restarted RPC CLI stop and confirmed close', () => restarted.kill(), 6000);
    const restartedExit = await restarted.exited;
    assert.equal(restartedExit.signal, 'SIGKILL');
    assert.deepEqual(ledgerSnapshot(observer, laterAccepted.row.id), recoveredCheckpoint);
    closeObserver();
    requireReleasedOwnership();
    // Resume manual wallet acceptance only after both actual CLI writers have closed.
    assert.ok(cliHandles.every(handle => closedCliHandles.has(handle)), 'Parent must not reopen beside a live CLI');
    store = new Store(ledgerPath); storeOpen = true;
    service = new PaymentService(store, provider, relayer, router, CHAIN_ID, routerAddress, 2);
    assert.deepEqual(ledgerSnapshot(store.db, laterAccepted.row.id), recoveredCheckpoint,
      'Parent reopen must retain the autonomous CLI recovery checkpoint');
    console.log(JSON.stringify({ check: 'rpc-cli-crash-recovery', fileBacked: true,
      writerPid, recoveryPid: restartedPid, writerExitSignal: writerExit.signal,
      recoveryExitSignal: restartedExit.signal, checkpointRetained: true, deploymentContextRetained: true,
      ownershipVerified: true, ownershipReleasedAfterClose: true, chainId: CHAIN_ID, confirmations: 2,
      autonomousRecovery: true, originalReservation: true, transactionHash: pendingHash, nativeNonceBefore: relayerNonceBeforeCrash,
      nativeNonceAfter: relayerNonceAfterCrash, journalEntries: 2, settledAudits: 1,
      reconciliationChecked: recoveredReconciliation.checked, reconciliationExceptions: recoveredReconciliation.exceptions.length }));
    console.log(JSON.stringify({ check: 'post-quorum-settlement', settledBaseUnits: laterAmount.toString(),
      transactionHash: laterSettled.tx_hash, block: laterSettled.block_number, journalEntries: 2 }));

    phase = 'all-validator restart and catch-up';
    await bounded(phase, () => compose('start', 'validator4'), 30000);
    possiblyStopped.delete('validator4');
    const recovered = await poll(phase, () => agreement(providers, generated.validators));
    assert.ok(recovered.height >= laterSettled.block_number!, 'Restarted validator did not catch up');
    console.log(JSON.stringify({ check: 'validator-recovery', ...recovered }));

    phase = 'contract-wallet fixture deployment and approval';
    const fixture = compileTestWallet(); // Acceptance-only, never a production artifact.
    const walletFunding = parseUnits('100', 6), walletAmount = parseUnits('12.5', 6);
    const contractWallet: any = await bounded(phase, async () => {
      const wallet: any = await new ContractFactory(fixture.abi, fixture.bytecode, payer).deploy(payer.address);
      await wallet.waitForDeployment();
      const address = await wallet.getAddress();
      await (await token.setAllowed(address, true)).wait();
      await (await token.mint(address, walletFunding)).wait();
      await (await wallet.execute(await token.getAddress(), token.interface.encodeFunctionData('approve',
        [await router.getAddress(), walletFunding]))).wait();
      await (await wallet.setRequiredCaller(await router.getAddress())).wait();
      return wallet;
    }, 90000);
    const walletAddress = await contractWallet.getAddress();
    phase = 'contract-wallet two-validator stop and block drain';
    possiblyStopped.add('validator4');
    await bounded(phase, () => compose('stop', 'validator4'), 30000);
    possiblyStopped.add('validator3');
    await bounded(phase, () => compose('stop', 'validator3'), 30000);
    const walletBaseline = await quietPair(phase, generated.validators);

    phase = 'pending ERC-1271 wallet settlement without quorum';
    const walletBlock = await bounded(phase, () => provider.getBlock('latest'), 10000);
    assert.ok(walletBlock, 'Wallet payment block is unavailable');
    const walletPayment = { ...payment, paymentId: id(randomBytes(24).toString('hex')),
      payer: walletAddress, amount: walletAmount.toString(), nonce: '0', deadline: String(walletBlock.timestamp + 3600) };
    const walletSignature = await payer.signTypedData(service.signingDomain, paymentTypes, walletPayment);
    const walletDigest = await bounded(phase, () => router.hashPayment(walletPayment), 10000);
    assert.equal(await bounded(phase, () => contractWallet.isValidSignature.staticCall(walletDigest, walletSignature), 10000),
      '0xffffffff', 'Direct owner call must fail the router-caller requirement');
    const walletAccepted = await bounded(phase,
      () => service.accept({ payment: walletPayment, signature: walletSignature }), 10000);
    const walletRelayerNonce = await bounded(phase, () => provider.getTransactionCount(relayer.address, 'latest'), 10000);
    await bounded(phase, () => service.tick(), 20000);
    const walletPending = store.get(walletAccepted.row.id)!;
    assert.equal(walletPending.status, 'broadcast', 'No-quorum wallet payment must retain its reservation');
    assert.ok(walletPending.raw_tx && walletPending.tx_hash, 'Wallet transaction provenance is required');
    const walletPendingRaw = walletPending.raw_tx, walletPendingHash = walletPending.tx_hash;
    await poll('both live nodes accepted the wallet transaction', async () => {
      const transactions = await Promise.all(pair.map(node => node.getTransaction(walletPendingHash)));
      if (transactions.some(transaction => !transaction)) return;
      assert.ok(transactions.every(transaction => transaction!.hash === walletPendingHash && transaction!.blockNumber === null),
        'Wallet transaction must be pending on both live nodes');
      return true;
    }, 20000);
    const walletProjection = () => JSON.stringify({ payments: store.list(), journals: store.journals(), audit: store.events(),
      changes: store.db.prepare('SELECT total_changes() AS count').get()!.count });
    const heldWalletProjection = walletProjection();
    phase = 'contract-wallet quorum observation';
    const walletHalted = await bounded(phase, () => observeHalted(async () => {
      await service.tick();
      const sample = await agreement(pair, generated.validators);
      if (!sample) throw new AcceptanceFailure('Surviving RPC nodes do not agree during wallet quorum loss');
      const [receipts, transactions, payeeBalance, walletBalance, walletNonce, payerNonce, processed, relayerNonce] = await Promise.all([
        Promise.all(pair.map(node => node.getTransactionReceipt(walletPendingHash))),
        Promise.all(pair.map(node => node.getTransaction(walletPendingHash))),
        token.balanceOf(payee.address), token.balanceOf(walletAddress), router.nonces(walletAddress),
        router.nonces(payer.address), router.processed(walletAddress, walletPayment.paymentId),
        provider.getTransactionCount(relayer.address, 'latest')
      ]);
      assert.ok(receipts.every(receipt => receipt === null), 'Wallet transaction gained a receipt without quorum');
      assert.ok(transactions.every(transaction => transaction?.hash === walletPendingHash && transaction.blockNumber === null),
        'Wallet transaction must remain pending on both live nodes');
      assert.ok(walletProjection() === heldWalletProjection, 'Wallet quorum loss changed the reservation, journals or audit');
      assert.equal(store.journals().length, 2);
      assert.equal(payeeBalance, amount + laterAmount);
      assert.equal(walletBalance, walletFunding);
      assert.equal(walletNonce, 0n);
      assert.equal(payerNonce, 2n);
      assert.equal(processed, false);
      assert.equal(relayerNonce, walletRelayerNonce);
      return sample;
    }, walletBaseline), 45000);
    console.log(JSON.stringify({ check: 'erc1271-quorum-loss', stoppedServices: ['validator3', 'validator4'],
      height: walletHalted.height, hash: walletHalted.hash, observedMs: walletHalted.elapsedMs,
      observations: walletHalted.observations, pendingTransactionHash: walletPendingHash, journalEntries: 2,
      walletBaseUnits: walletFunding.toString(), payeeBaseUnits: (amount + laterAmount).toString(), payerNonce: 0 }));

    phase = 'restore three-validator quorum for contract wallet';
    await bounded(phase, () => compose('start', 'validator3'), 30000);
    possiblyStopped.delete('validator3');
    const walletRestored = await poll(phase, async () => {
      const sample = await agreement(providers.slice(0, 3), generated.validators);
      return sample && sample.height >= walletBaseline.height + 2 ? sample : undefined;
    }, 300000);
    phase = 'settle original contract-wallet reservation after quorum restoration';
    const walletSettled = await poll(phase, async () => {
      await service.tick();
      const row = store.get(walletAccepted.row.id)!;
      if (row.status === 'failed' || row.status === 'review')
        throw new AcceptanceFailure('Contract-wallet payment entered ' + row.status + ' state');
      return row.status === 'settled' ? row : undefined;
    }, 60000);
    assert.equal((await bounded(phase,
      () => service.accept({ payment: walletPayment, signature: walletSignature }), 10000)).replay, true);
    await bounded(phase, () => service.tick(), 10000);
    assert.equal(walletSettled.tx_hash, walletPendingHash, 'Wallet recovery must settle the original hash');
    assert.equal(walletSettled.raw_tx, walletPendingRaw, 'Wallet recovery must retain the original signed bytes');
    assert.equal(await provider.getTransactionCount(relayer.address, 'latest'), walletRelayerNonce + 1,
      'Wallet recovery must consume one native nonce');
    const walletJournal = store.journal(walletAccepted.row.id)!;
    assert.equal(walletJournal.debit_account, walletAddress, 'Journal must debit the contract wallet');
    assert.equal(walletJournal.credit_account, payee.address);
    assert.equal(walletJournal.amount, walletAmount.toString());
    assert.equal(walletJournal.tx_hash, walletSettled.tx_hash);
    assert.equal(store.journals().length, 3, 'Wallet replay must not create another journal');
    assert.equal(store.events().filter(event => event.payment_id === walletAccepted.row.id && event.action === 'settled').length, 1);
    const expectedPayee = amount + laterAmount + walletAmount, expectedWallet = walletFunding - walletAmount;
    assert.equal(await token.balanceOf(payee.address), expectedPayee);
    assert.equal(await token.balanceOf(walletAddress), expectedWallet);
    assert.equal(await router.nonces(walletAddress), 1n);
    console.log(JSON.stringify({ check: 'erc1271-settlement', wallet: walletAddress, settledBaseUnits: walletAmount.toString(),
      transactionHash: walletSettled.tx_hash, block: walletSettled.block_number, journalEntries: 3,
      payeeBaseUnits: expectedPayee.toString(), walletBaseUnits: expectedWallet.toString(), payerNonce: 1 }));

    phase = 'all-validator contract-wallet catch-up';
    await bounded(phase, () => compose('start', 'validator4'), 30000);
    possiblyStopped.delete('validator4');
    const walletRecovered = await poll(phase, async () => {
      const sample = await agreement(providers, generated.validators);
      return sample && sample.height >= walletSettled.block_number! ? sample : undefined;
    });
    console.log(JSON.stringify({ check: 'erc1271-quorum-recovery', transactionHash: walletPendingHash,
      originalReservation: true, block: walletSettled.block_number, threeNodeRecoveryHeight: walletRestored.height,
      journalEntries: 3, ...walletRecovered }));

    phase = 'queued contract-wallet authorization revocation';
    const revokedPayment = { ...walletPayment, paymentId: id(randomBytes(24).toString('hex')),
      amount: parseUnits('1.25', 6).toString(), nonce: '1' };
    const revokedSignature = await payer.signTypedData(service.signingDomain, paymentTypes, revokedPayment);
    const nonceBeforeRevocation = await bounded(phase, () => relayer.getNonce('pending'), 10000);
    const revokedAccepted = await bounded(phase,
      () => service.accept({ payment: revokedPayment, signature: revokedSignature }), 10000);
    assert.equal(revokedAccepted.row.status, 'queued');
    assert.equal(revokedAccepted.row.raw_tx, null);
    const revocationReceipt = await bounded(phase, async () => (await contractWallet.setRevoked(true)).wait(), 30000);
    assert.ok(revocationReceipt, 'Wallet revocation must be mined before worker preparation');
    assert.equal(await bounded(phase,
      () => router.isValidPaymentSignature(revokedPayment, revokedSignature), 10000), false);
    await bounded(phase, () => service.tick(), 20000);
    await bounded(phase, () => service.tick(), 10000);
    const revokedRow = store.get(revokedAccepted.row.id)!;
    assert.equal(revokedRow.status, 'failed', 'Revoked queued authorization must fail preflight');
    assert.equal(revokedRow.raw_tx, null, 'Revoked authorization must not sign a native transaction');
    assert.equal(revokedRow.tx_hash, null);
    assert.equal(store.journal(revokedRow.id), undefined);
    assert.equal(store.journals().length, 3);
    assert.equal(store.events().filter(event => event.payment_id === revokedRow.id && event.action === 'failed').length, 1);
    assert.equal(await bounded(phase, () => relayer.getNonce('pending'), 10000), nonceBeforeRevocation);
    const reconciliation = await bounded(phase, () => service.reconcile(), 15000);
    assert.equal(reconciliation.checked, 3);
    assert.deepEqual(reconciliation.exceptions, []);

    phase = 'all-validator contract-wallet state agreement';
    const walletAgreement = await poll(phase, async () => {
      const sample = await agreement(providers, generated.validators);
      return sample && sample.height >= revocationReceipt.blockNumber ? sample : undefined;
    });
    await bounded(phase, () => Promise.all(providers.map(async node => {
      const nodeToken: any = token.connect(node), nodeRouter: any = router.connect(node);
      const tag = { blockTag: walletAgreement.height };
      assert.equal(await nodeToken.balanceOf(payee.address, tag), expectedPayee);
      assert.equal(await nodeToken.balanceOf(walletAddress, tag), expectedWallet);
      assert.equal(await nodeRouter.nonces(walletAddress, tag), 1n);
      assert.equal(await nodeRouter.nonces(payer.address, tag), 2n);
      assert.equal(await nodeRouter.processed(walletAddress, walletPayment.paymentId, tag), true);
      assert.equal(await nodeRouter.processed(walletAddress, revokedPayment.paymentId, tag), false);
      assert.equal(await nodeRouter.isValidPaymentSignature(revokedPayment, revokedSignature, tag), false);
    })), 20000);
    console.log(JSON.stringify({ check: 'erc1271-revocation', failedBeforeBroadcast: true, journalEntries: 3,
      payerNonce: 1, relayerNonceUnchanged: true, reconciliationChecked: reconciliation.checked,
      reconciliationExceptions: reconciliation.exceptions.length, ...walletAgreement }));
    console.log(JSON.stringify({ result: 'passed', elapsedMs: Date.now() - started,
      checks: ['four-validator-agreement', 'signed-settlement', 'one-validator-failure',
        'two-validator-quorum-loss', 'quorum-restoration', 'rpc-cli-crash-recovery', 'post-quorum-settlement', 'validator-recovery',
        'erc1271-quorum-loss', 'erc1271-settlement', 'erc1271-quorum-recovery', 'erc1271-revocation'] }));
  } catch (error) {
    // Avoid dumping transaction arguments, generated keys, or wallet objects into CI logs.
    const reason = error instanceof AcceptanceFailure || error instanceof QuorumObservationError ? ' (' + error.message + ')' : '';
    throw new Error('Besu acceptance failed during ' + phase + reason + '; inspect the validator logs');
  } finally {
    for (const handle of cliHandles) {
      try { await handle.kill(); }
      catch {
        console.error('Cleanup could not confirm RPC CLI termination; ledger retained');
        process.exitCode = 1;
        // Only these registered task children and their pipes may be detached.
        handle.child.unref(); handle.child.stdout?.destroy(); handle.child.stderr?.destroy();
      }
    }
    try { closeObserver(); }
    catch { console.error('Cleanup could not close the read-only ledger observer; ledger retained'); process.exitCode = 1; }
    if (cliHandles.some(handle => !closedCliHandles.has(handle))) {
      // An unconfirmed autonomous writer must not regain quorum against the retained ledger.
      console.error('Cleanup skipped validator restoration because RPC CLI termination is unconfirmed; ledger retained');
      process.exitCode = 1;
    } else {
      for (const validator of possiblyStopped) {
        try { await compose('start', validator); }
        catch { console.error('Cleanup could not restart clearledger-dev ' + validator); process.exitCode = 1; }
      }
    }
    for (const provider of providers) provider.destroy();
    try { closeStore(); }
    catch { console.error('Cleanup could not close the acceptance ledger; ledger retained'); process.exitCode = 1; }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verifyNetwork().catch(error => { console.error(error.message); process.exitCode = 1; });
}
