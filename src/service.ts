import { getBigInt, keccak256, Transaction, type JsonRpcProvider, type Wallet, type TypedDataDomain, type TransactionReceipt, type Block } from 'ethers';
import { digest, domain, paymentKey, paymentSchema, submissionSchema, type Payment } from './payment.ts';
import { Store, type RecordRow } from './store.ts';

// A fresh daily-spend slot can cost 17,100 gas more than an update (EIP-2200/2929).
const DAILY_SPEND_GAS_ALLOWANCE = 20_000n;
const EMPTY_LOGS_BLOOM = '0x' + '00'.repeat(256);

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function sameHash(actual: unknown, expected: string): boolean {
  return isHash(actual) && actual.toLowerCase() === expected.toLowerCase();
}
function matchesCanonicalPosition(receipt: TransactionReceipt, block: Block | null): boolean {
  if (!block || block.number !== receipt.blockNumber || !sameHash(block.hash, receipt.blockHash) ||
    !Number.isSafeInteger(receipt.index) || receipt.index < 0) return false;
  const transactions = block.transactions;
  return Array.isArray(transactions) && sameHash(transactions[receipt.index], receipt.hash);
}

interface ReconciliationResult { checked: number; exceptions: string[]; at: string }
export class ReconciliationEvidenceUnavailable extends Error {}
export class ReconciliationReceiptUnavailable extends ReconciliationEvidenceUnavailable {}

export class PaymentService {
  readonly signingDomain: TypedDataDomain;
  private running = false;
  private reconciling?: Promise<ReconciliationResult>;
  constructor(readonly store: Store, readonly provider: JsonRpcProvider,
    readonly relayer: Wallet, readonly router: any, readonly chainId: number,
    readonly routerAddress: string, readonly confirmations = 1) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('Invalid confirmation count');
    this.router = router.connect(relayer);
    this.signingDomain = domain(chainId, routerAddress);
  }

  async accept(body: unknown) {
    const { payment, signature } = submissionSchema.parse(body);
    // The router performs the same EOA/ERC-1271 check used during execution,
    // including its own caller context for contract-wallet validation.
    if (await this.router.isValidPaymentSignature.staticCall(payment, signature) !== true)
      throw new Error('Signature does not authorize this payment');
    const hash = digest(payment, this.signingDomain);
    const existing = this.store.get(paymentKey(payment));
    if (!existing) {
      const block = await this.provider.getBlock('latest');
      if (!block) throw new Error('Chain unavailable');
      if (BigInt(payment.deadline) < BigInt(block.timestamp)) throw new Error('Authorization expired');
      if (BigInt(payment.deadline) > BigInt(block.timestamp + 7 * 86400)) throw new Error('Deadline exceeds seven days');
    }
    return this.store.accept(payment, hash, signature);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const pending = this.store.pending();
      const reservedQueued = pending.some(row => row.status === 'queued' &&
        (row.raw_tx !== null || row.tx_hash !== null));
      for (const row of pending) {
        // One process and one relayer. A pending broadcast blocks subsequent nonce allocation.
        if (row.status === 'queued') {
          if (reservedQueued) throw new Error('Queued payment contains transaction reservation data; inspect durable state');
          await this.prepare(row);
        }
        const current = this.store.get(row.id)!;
        if (current.status === 'broadcast') {
          try { await this.confirm(current); }
          catch { break; } // RPC outages preserve signed bytes for a safe retry.
          if (this.store.get(row.id)!.status === 'broadcast') break;
        }
      }
    } finally { this.running = false; }
  }

  private storedPayment(row: RecordRow): Payment | undefined {
    let p: Payment | undefined;
    try {
      if (typeof row.payload === 'string') {
        const raw = JSON.parse(row.payload) as Record<keyof Payment, unknown>;
        const parsed = submissionSchema.safeParse({ payment: raw, signature: row.signature });
        if (parsed.success && paymentKey(parsed.data.payment) === row.id &&
          (Object.keys(parsed.data.payment) as (keyof Payment)[])
            .every(field => raw[field] === parsed.data.payment[field])) p = parsed.data.payment;
      }
    } catch { /* Keep parser/schema details and stored private fields out of diagnostics. */ }
    // Keep hashing and configuration failures separate from invalid stored evidence.
    if (!p || !isHash(row.fingerprint) || !sameHash(row.fingerprint, digest(p, this.signingDomain))) return;
    return p;
  }

  private async prepare(row: RecordRow) {
    const p = this.storedPayment(row);
    if (!p) {
      this.store.setStatus(row.id, 'failed',
        'Stored queued authorization is invalid; verify the original authorization and chain history');
      return;
    }
    try {
      await this.router.settle.staticCall(p, row.signature);
    } catch (e: any) {
      // A transport failure is not a deterministic contract rejection.
      // ethers also labels some node/transport failures as CALL_EXCEPTION.
      // Only nonempty complete hex bytes qualify as revert data; malformed
      // evidence stays queued rather than inventing a terminal rejection.
      if (e.code !== 'CALL_EXCEPTION' || typeof e.data !== 'string' ||
        !/^0x(?:[0-9a-fA-F]{2})+(?![\s\S])/.test(e.data)) throw e;
      this.store.setStatus(row.id, 'failed', e.shortMessage ?? 'Contract rejected payment');
      return;
    }
    const request = await this.router.settle.populateTransaction(p, row.signature);
    const complete = await this.relayer.populateTransaction(request);
    const estimate = getBigInt(complete.gasLimit ?? 0n);
    const feeCap = complete.maxFeePerGas ?? complete.gasPrice;
    if (estimate <= 0n || feeCap == null) throw new Error('Settlement gas budget is unavailable');
    const maxGasPrice = getBigInt(feeCap);
    if (maxGasPrice < 0n) throw new Error('Settlement gas budget is unavailable');
    const [head, balance] = await Promise.all([
      this.provider.getBlock('latest'),
      maxGasPrice > 0n ? this.provider.getBalance(this.relayer.address, 'pending') : null
    ]);
    if (!head || typeof head.gasLimit !== 'bigint') throw new Error('Settlement gas budget is unavailable');
    const affordable = balance === null ? head.gasLimit : balance / maxGasPrice;
    const ceiling = affordable < head.gasLimit ? affordable : head.gasLimit;
    if (ceiling < estimate) throw new Error('Settlement gas budget is unavailable');
    const padded = estimate + DAILY_SPEND_GAS_ALLOWANCE;
    const gasLimit = padded < ceiling ? padded : ceiling;
    const raw = await this.relayer.signTransaction({ ...complete, gasLimit });
    // Persist BEFORE sending. Restart can retransmit exactly the same signed transaction.
    this.store.broadcast(row.id, raw, keccak256(raw));
  }

  private storedEnvelopeMatches(row: RecordRow, p: Payment): boolean {
    if (!Number.isSafeInteger(this.chainId) || this.chainId < 1 || !isHash(row.tx_hash) ||
      typeof row.raw_tx !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(row.raw_tx) ||
      !sameHash(keccak256(row.raw_tx), row.tx_hash)) return false;
    try {
      const transaction = Transaction.from(row.raw_tx);
      // Ordinary signed calls only: blob/delegation envelopes have additional
      // effects that are not part of the persisted payment authorization.
      return [0, 1, 2].includes(transaction.type!) && transaction.isSigned() &&
        transaction.chainId === BigInt(this.chainId) &&
        transaction.from?.toLowerCase() === this.relayer.address.toLowerCase() &&
        transaction.to?.toLowerCase() === this.routerAddress.toLowerCase() && transaction.value === 0n &&
        transaction.data.toLowerCase() === this.router.interface.encodeFunctionData('settle', [p, row.signature]).toLowerCase();
    } catch { return false; }
  }

  private async confirm(row: RecordRow) {
    if (!isHash(row.tx_hash)) return;
    let receipt = await this.provider.getTransactionReceipt(row.tx_hash);
    // A receipt cannot resolve a reservation whose stored intent and signed bytes disagree.
    const p = this.storedPayment(row);
    if (!p || !this.storedEnvelopeMatches(row, p)) return;
    if (!receipt) {
      try { await this.provider.broadcastTransaction(row.raw_tx!); }
      catch { /* already known, connection loss, or uncertain outcome: inspect hash */ }
      receipt = await this.provider.getTransactionReceipt(row.tx_hash);
    }
    // Inconsistent RPC evidence cannot consume a durable reservation or release
    // its nonce priority. Both success and revert decisions need the same
    // transaction identity, canonical inclusion, and configured depth checks.
    if (!receipt || !sameHash(receipt.hash, row.tx_hash) ||
      !Number.isSafeInteger(receipt.index) || receipt.index < 0 ||
      !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
      !isHash(receipt.blockHash) || (receipt.status !== 0 && receipt.status !== 1) ||
      !Array.isArray(receipt.logs)) return;
    // A reverted top-level execution cannot leave receipt logs or bloom bits.
    if (receipt.status === 0 && (receipt.logs.length !== 0 || receipt.logsBloom !== EMPTY_LOGS_BLOOM)) return;
    const latest = await this.provider.getBlockNumber();
    if (!Number.isSafeInteger(latest) || latest < receipt.blockNumber ||
      latest - receipt.blockNumber < this.confirmations - 1) return;
    const canonical = await this.provider.getBlock(receipt.blockNumber);
    if (!matchesCanonicalPosition(receipt, canonical)) return;
    if (receipt.status === 0) {
      this.store.setStatus(row.id, 'failed', 'Transaction reverted on chain');
      return;
    }
    const evidence = this.settlementEvidence(p, receipt);
    if (evidence === 'inconsistent') return;
    if (evidence === 'missing') {
      this.store.setStatus(row.id, 'review', 'Receipt does not contain the expected settlement event');
      return;
    }
    this.store.finalize(row.id, receipt.blockNumber, receipt.blockHash);
  }

  private settlementEvidence(p: Payment, receipt: TransactionReceipt): 'matching' | 'inconsistent' | 'missing' {
    if (!Array.isArray(receipt.logs)) return 'missing';
    let found = false;
    for (const log of receipt.logs) {
      let matches = false;
      try {
        if (log.address.toLowerCase() !== this.routerAddress.toLowerCase()) continue;
        const event = this.router.interface.parseLog(log);
        matches = event?.name === 'PaymentSettled' && event.args.paymentId === p.paymentId &&
          event.args.payer === p.payer && event.args.payee === p.payee &&
          event.args.token === p.token && event.args.amount.toString() === p.amount &&
          event.args.nonce.toString() === p.nonce;
      } catch { continue; }
      if (!matches) continue;
      // A matching event must agree with the enclosing receipt. One
      // contradictory candidate makes the evidence inconsistent.
      const transactionIndex = receipt.index;
      if (log.transactionIndex !== transactionIndex ||
        (transactionIndex !== undefined && (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0)) ||
        !sameHash(log.transactionHash, receipt.hash) ||
        !Number.isSafeInteger(log.blockNumber) || log.blockNumber < 0 ||
        log.blockNumber !== receipt.blockNumber || !sameHash(log.blockHash, receipt.blockHash))
        return 'inconsistent';
      found = true;
    }
    return found ? 'matching' : 'missing';
  }

  reconcile(): Promise<ReconciliationResult> {
    if (!this.reconciling) {
      // Assign before scanning so even synchronous provider/Store reentry joins
      // this pass. Only this pass may clear its in-flight slot; no result is cached.
      const run: Promise<ReconciliationResult> = Promise.resolve()
        .then(() => this.scanReconciliation())
        .finally(() => { if (this.reconciling === run) this.reconciling = undefined; });
      this.reconciling = run;
    }
    return this.reconciling.then(result => ({ ...result, exceptions: [...result.exceptions] }));
  }

  private async scanReconciliation(): Promise<ReconciliationResult> {
    let checked = 0;
    const exceptions: string[] = [];
    let cursor: string | undefined;
    do {
      // Materialize each page before RPC awaits and status changes. The cursor
      // freezes insertion range; a fresh reconciliation starts a fresh scan.
      const page = this.store.pagePayments({ status: 'settled', limit: 100, cursor });
      for (const row of page.items) {
        checked++;
        const p = this.storedPayment(row);
        const envelopeMatches = p && this.storedEnvelopeMatches(row, p);
        const txHash = row.tx_hash;
        let matches = false;
        if (p && envelopeMatches && isHash(txHash) && isHash(row.block_hash) &&
          Number.isSafeInteger(row.block_number) && row.block_number! >= 0) {
          // RPC errors abort the scan; unavailable transport is not evidence of corruption.
          const receipt = await this.provider.getTransactionReceipt(txHash);
          const block = await this.provider.getBlock(row.block_number!);
          // Read the projection after the RPC awaits, and retain it unchanged on review.
          const journal = this.store.journal(row.id);
          const journalMatches = !!journal && journal.payment_id === row.id && journal.token === p.token &&
            journal.debit_account === p.payer && journal.credit_account === p.payee &&
            journal.amount === p.amount && journal.tx_hash === txHash &&
            journal.block_number === row.block_number && journal.block_hash === row.block_hash;
          // Positive block membership leaves a missing receipt inconclusive.
          if (receipt === null && journalMatches && block &&
            block.number === row.block_number && sameHash(block.hash, row.block_hash)) {
            const transactions = block.transactions;
            if (Array.isArray(transactions) && transactions.some(hash => sameHash(hash, txHash)))
              throw new ReconciliationReceiptUnavailable('Receipt unavailable for transaction listed in the canonical block');
          }
          matches = journalMatches && !!receipt && receipt.status === 1 && sameHash(receipt.hash, txHash) &&
            receipt.blockNumber === row.block_number && sameHash(receipt.blockHash, row.block_hash) &&
            Number.isSafeInteger(receipt.index) && receipt.index >= 0 &&
            (block === null || matchesCanonicalPosition(receipt, block)) &&
            this.settlementEvidence(p, receipt) === 'matching';
          if (matches && block === null)
            throw new ReconciliationEvidenceUnavailable('Canonical block unavailable for matching settlement receipt');
        }
        if (!matches) {
          exceptions.push(row.id);
          const error = !p
            ? 'Stored settlement authorization is inconsistent; verify the original authorization and chain history'
            : !envelopeMatches
              ? 'Stored settlement transaction is inconsistent; verify the original transaction and chain history'
              : 'Recorded settlement no longer matches canonical receipt and journal';
          this.store.setStatus(row.id, 'review', error);
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { checked, exceptions, at: new Date().toISOString() };
  }

  publicRow(row: RecordRow) {
    const safe = { id: row.id, status: row.status, tx_hash: row.tx_hash,
      block_number: row.block_number, block_hash: row.block_hash, error: row.error,
      created_at: row.created_at, updated_at: row.updated_at };
    try {
      if (typeof row.payload === 'string') {
        const parsed = paymentSchema.safeParse(JSON.parse(row.payload));
        if (parsed.success && paymentKey(parsed.data) === row.id)
          return { ...safe, payment: parsed.data };
      }
    } catch { /* A history read must not echo or repair invalid persisted payloads. */ }
    return { ...safe, payment: null,
      integrityError: 'Stored payment data is invalid; verify the original authorization' };
  }
}



