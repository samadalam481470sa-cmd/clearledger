import { keccak256, verifyTypedData, type JsonRpcProvider, type Wallet, type TypedDataDomain } from 'ethers';
import { digest, domain, paymentKey, paymentTypes, submissionSchema, type Payment } from './payment.ts';
import { Store, type RecordRow } from './store.ts';

export class PaymentService {
  readonly signingDomain: TypedDataDomain;
  private running = false;
  constructor(readonly store: Store, readonly provider: JsonRpcProvider,
    readonly relayer: Wallet, readonly router: any, readonly chainId: number,
    readonly routerAddress: string, readonly confirmations = 1) {
    if (!Number.isInteger(confirmations) || confirmations < 1) throw new Error('Invalid confirmation count');
    this.router = router.connect(relayer);
    this.signingDomain = domain(chainId, routerAddress);
  }

  async accept(body: unknown) {
    const { payment, signature } = submissionSchema.parse(body);
    // Externally owned account signatures; smart-contract wallet support is a roadmap item.
    const signer = verifyTypedData(this.signingDomain, paymentTypes, payment, signature);
    if (signer !== payment.payer) throw new Error('Signature does not authorize this payment');
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
    let receipt = await this.provider.getTransactionReceipt(row.tx_hash!);
    if (!receipt) {
      try { await this.provider.broadcastTransaction(row.raw_tx!); }
      catch { /* already known, connection loss, or uncertain outcome: inspect hash */ }
      receipt = await this.provider.getTransactionReceipt(row.tx_hash!);
    }
    if (!receipt) return;
    if (receipt.status !== 1) {
      this.store.setStatus(row.id, 'failed', 'Transaction reverted on chain');
      return;
    }
    const latest = await this.provider.getBlockNumber();
    if (latest - receipt.blockNumber + 1 < this.confirmations) return;
    const canonical = await this.provider.getBlock(receipt.blockNumber);
    if (!canonical || canonical.hash !== receipt.blockHash) return;
    const p: Payment = JSON.parse(row.payload);
    const matching = receipt.logs.some(log => {
      if (log.address.toLowerCase() !== this.routerAddress.toLowerCase()) return false;
      try {
        const event = this.router.interface.parseLog(log);
        return event?.name === 'PaymentSettled' && event.args.paymentId === p.paymentId &&
          event.args.payer === p.payer && event.args.payee === p.payee &&
          event.args.token === p.token && event.args.amount.toString() === p.amount &&
          event.args.nonce.toString() === p.nonce;
      } catch { return false; }
    });
    if (!matching) {
      this.store.setStatus(row.id, 'review', 'Receipt does not contain the expected settlement event');
      return;
    }
    this.store.finalize(row.id, receipt.blockNumber, receipt.blockHash);
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
        const receipt = await this.provider.getTransactionReceipt(row.tx_hash!);
        const block = row.block_number == null ? null : await this.provider.getBlock(row.block_number);
        if (!receipt || receipt.status !== 1 || receipt.blockHash !== row.block_hash ||
          !block || block.hash !== row.block_hash) {
          exceptions.push(row.id);
          this.store.setStatus(row.id, 'review', 'Canonical chain no longer matches recorded settlement');
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



