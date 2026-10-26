import { keccak256, type JsonRpcProvider, type Wallet, type TypedDataDomain, type TransactionReceipt } from 'ethers';
import { digest, domain, paymentKey, paymentSchema, submissionSchema, type Payment } from './payment.ts';
import { Store, type RecordRow } from './store.ts';

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
function sameHash(actual: unknown, expected: string): boolean {
  return isHash(actual) && actual.toLowerCase() === expected.toLowerCase();
}

export class PaymentService {
  readonly signingDomain: TypedDataDomain;
  private running = false;
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
      for (const row of this.store.pending()) {
        // One process and one relayer. A pending broadcast blocks subsequent nonce allocation.
        if (row.status === 'queued') await this.prepare(row);
        const current = this.store.get(row.id)!;
        if (current.status === 'broadcast') {
          try { await this.confirm(current); }
          catch { break; } // RPC outages preserve signed bytes for a safe retry.
          if (this.store.get(row.id)!.status === 'broadcast') break;
        }
      }
    } finally { this.running = false; }
  }

  private async prepare(row: RecordRow) {
    const p: Payment = JSON.parse(row.payload);
    try {
      await this.router.settle.staticCall(p, row.signature);
    } catch (e: any) {
      // A transport failure is not a deterministic contract rejection.
      // ethers also labels some node/transport failures as CALL_EXCEPTION with no
      // revert data. Keep those queued rather than inventing a terminal rejection.
      if (e.code !== 'CALL_EXCEPTION' || typeof e.data !== 'string' || e.data.length <= 2) throw e;
      this.store.setStatus(row.id, 'failed', e.shortMessage ?? 'Contract rejected payment');
      return;
    }
    const request = await this.router.settle.populateTransaction(p, row.signature);
    const complete = await this.relayer.populateTransaction(request);
    const raw = await this.relayer.signTransaction(complete);
    // Persist BEFORE sending. Restart can retransmit exactly the same signed transaction.
    this.store.broadcast(row.id, raw, keccak256(raw));
  }

  private async confirm(row: RecordRow) {
    if (!isHash(row.tx_hash)) return;
    let receipt = await this.provider.getTransactionReceipt(row.tx_hash);
    if (!receipt) {
      try { await this.provider.broadcastTransaction(row.raw_tx!); }
      catch { /* already known, connection loss, or uncertain outcome: inspect hash */ }
      receipt = await this.provider.getTransactionReceipt(row.tx_hash);
    }
    // Inconsistent RPC evidence cannot consume a durable reservation or release
    // its nonce priority. Both success and revert decisions need the same
    // transaction identity, canonical inclusion, and configured depth checks.
    if (!receipt || !sameHash(receipt.hash, row.tx_hash) ||
      !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0 ||
      !isHash(receipt.blockHash) || (receipt.status !== 0 && receipt.status !== 1) ||
      (receipt.status === 1 && !Array.isArray(receipt.logs))) return;
    const latest = await this.provider.getBlockNumber();
    if (!Number.isSafeInteger(latest) || latest < receipt.blockNumber ||
      latest - receipt.blockNumber < this.confirmations - 1) return;
    const canonical = await this.provider.getBlock(receipt.blockNumber);
    if (!canonical || canonical.number !== receipt.blockNumber || !sameHash(canonical.hash, receipt.blockHash)) return;
    if (receipt.status === 0) {
      this.store.setStatus(row.id, 'failed', 'Transaction reverted on chain');
      return;
    }
    const p: Payment = JSON.parse(row.payload);
    if (!this.matchesSettlement(p, receipt)) {
      this.store.setStatus(row.id, 'review', 'Receipt does not contain the expected settlement event');
      return;
    }
    this.store.finalize(row.id, receipt.blockNumber, receipt.blockHash);
  }

  private matchesSettlement(p: Payment, receipt: TransactionReceipt): boolean {
    return Array.isArray(receipt.logs) && receipt.logs.some(log => {
      try {
        if (log.address.toLowerCase() !== this.routerAddress.toLowerCase()) return false;
        const event = this.router.interface.parseLog(log);
        return event?.name === 'PaymentSettled' && event.args.paymentId === p.paymentId &&
          event.args.payer === p.payer && event.args.payee === p.payee &&
          event.args.token === p.token && event.args.amount.toString() === p.amount &&
          event.args.nonce.toString() === p.nonce;
      } catch { return false; }
    });
  }

  async reconcile() {
    let checked = 0;
    const exceptions: string[] = [];
    let cursor: string | undefined;
    do {
      // Materialize each page before RPC awaits and status changes. The cursor
      // freezes insertion range; a fresh reconciliation starts a fresh scan.
      const page = this.store.pagePayments({ status: 'settled', limit: 100, cursor });
      for (const row of page.items) {
        checked++;
        let p: Payment | undefined;
        try {
          const parsed = paymentSchema.safeParse(JSON.parse(row.payload));
          if (parsed.success) p = parsed.data;
        } catch { /* Invalid persisted JSON is an integrity exception. */ }
        let matches = false;
        if (p && paymentKey(p) === row.id &&
          typeof row.tx_hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(row.tx_hash) &&
          typeof row.block_hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(row.block_hash) &&
          Number.isSafeInteger(row.block_number) && row.block_number! >= 0) {
          // RPC errors abort the scan; unavailable transport is not evidence of corruption.
          const receipt = await this.provider.getTransactionReceipt(row.tx_hash);
          const block = await this.provider.getBlock(row.block_number!);
          // Read the projection after the RPC awaits, and retain it unchanged on review.
          const journal = this.store.journal(row.id);
          matches = !!receipt && receipt.status === 1 && sameHash(receipt.hash, row.tx_hash) &&
            receipt.blockNumber === row.block_number && sameHash(receipt.blockHash, row.block_hash) &&
            !!block && block.number === row.block_number && sameHash(block.hash, row.block_hash) &&
            !!journal && journal.payment_id === row.id && journal.token === p.token &&
            journal.debit_account === p.payer && journal.credit_account === p.payee &&
            journal.amount === p.amount && journal.tx_hash === row.tx_hash &&
            journal.block_number === row.block_number && journal.block_hash === row.block_hash &&
            this.matchesSettlement(p, receipt);
        }
        if (!matches) {
          exceptions.push(row.id);
          this.store.setStatus(row.id, 'review', 'Recorded settlement no longer matches canonical receipt and journal');
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { checked, exceptions, at: new Date().toISOString() };
  }

  publicRow(row: RecordRow) {
    const { raw_tx, signature, fingerprint, payload, ...safe } = row;
    return { ...safe, payment: JSON.parse(payload) as Payment };
  }
}



