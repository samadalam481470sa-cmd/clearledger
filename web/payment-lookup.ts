import type { PaymentRow } from './dashboard.ts';

export interface PaymentLookupSnapshot { row: PaymentRow; capturedAt: string }
export interface PaymentLookupState {
  id: string;
  phase: 'idle' | 'loading' | 'found' | 'not-found' | 'error';
  error: string;
  snapshot: PaymentLookupSnapshot | null;
}

export const PAYMENT_LOOKUP_NOT_FOUND = 'No local record was found for this ID at the time of this lookup.';
const invalidId = 'Enter a canonical lowercase payer:payment ID.';
const invalidResponse = 'The server returned an invalid payment record';
const idPattern = /^0x[0-9a-f]{40}:0x[0-9a-f]{64}(?![\s\S])/;
const addressPattern = /^0x[0-9a-fA-F]{40}(?![\s\S])/;
const hashPattern = /^0x[0-9a-fA-F]{64}(?![\s\S])/;
const statuses = new Set(['queued', 'broadcast', 'settled', 'failed', 'review']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';

export function isPaymentLookupId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 109 && idPattern.test(value);
}

export function paymentLookupPath(id: string) { return 'payments/' + encodeURIComponent(id); }

/** Check renderable public fields and copy them; this is not signature or chain verification. */
function publicRecord(value: unknown, requestedId: string): PaymentRow {
  if (!record(value) || value.id !== requestedId || !statuses.has(String(value.status)) ||
    typeof value.status !== 'string' || !nullableString(value.tx_hash) ||
    (value.block_number !== null && (typeof value.block_number !== 'number' || !Number.isFinite(value.block_number))) ||
    !nullableString(value.error) || typeof value.created_at !== 'string' ||
    (value.integrityError !== undefined && typeof value.integrityError !== 'string'))
    throw new Error(invalidResponse);
  const payment = value.payment;
  if (payment !== null) {
    if (!record(payment) || typeof payment.paymentId !== 'string' || !hashPattern.test(payment.paymentId) ||
      typeof payment.payer !== 'string' ||
      !['payer', 'payee', 'token'].every(key => typeof payment[key] === 'string' && addressPattern.test(payment[key])) ||
      !['amount', 'nonce', 'deadline'].every(key => typeof payment[key] === 'string' &&
        /^(0|[1-9][0-9]{0,77})(?![\s\S])/.test(payment[key]) && BigInt(payment[key]) < 2n ** 256n) ||
      payment.payer.toLowerCase() + ':' + payment.paymentId.toLowerCase() !== requestedId)
      throw new Error(invalidResponse);
  }
  const result: PaymentRow = {
    id: requestedId, status: value.status as PaymentRow['status'], tx_hash: value.tx_hash as string | null,
    block_number: value.block_number as number | null, error: value.error as string | null,
    created_at: value.created_at,
    payment: payment === null ? null : {
      paymentId: payment.paymentId as string, payer: payment.payer as string, payee: payment.payee as string,
      token: payment.token as string, amount: payment.amount as string, nonce: payment.nonce as string,
      deadline: payment.deadline as string
    }
  };
  if (value.integrityError !== undefined) result.integrityError = value.integrityError as string;
  // These public API fields are not yet needed by the shared receipt's narrower type.
  if (value.block_hash === null || typeof value.block_hash === 'string')
    Object.assign(result, { block_hash: value.block_hash });
  if (typeof value.updated_at === 'string') Object.assign(result, { updated_at: value.updated_at });
  return result;
}

const copySnapshot = (snapshot: PaymentLookupSnapshot): PaymentLookupSnapshot => ({
  capturedAt: snapshot.capturedAt,
  row: { ...snapshot.row, payment: snapshot.row.payment ? { ...snapshot.row.payment } : null }
});
const copyState = (state: PaymentLookupState): PaymentLookupState => ({
  ...state, snapshot: state.snapshot ? copySnapshot(state.snapshot) : null
});

/** One explicit local lookup at a time, owned by one dashboard authentication/network context. */
export class PaymentLookup {
  private current?: AbortController;
  private generation = 0;
  private disposed = false;
  private view: PaymentLookupState = { id: '', phase: 'idle', error: '', snapshot: null };
  constructor(private readonly loader: (path: string, signal: AbortSignal) => Promise<PaymentRow>,
    private readonly onChange: (state: PaymentLookupState) => void,
    private readonly onFound?: (snapshot: PaymentLookupSnapshot) => void,
    private readonly now: () => Date = () => new Date()) {}
  get state() { return copyState(this.view); }
  private publish(state: PaymentLookupState) { this.view = state; this.onChange(copyState(state)); }
  private invalidate() { this.generation++; this.current?.abort(); this.current = undefined; }
  setInput(id: string) {
    if (this.disposed) return;
    this.invalidate();
    this.publish({ id, phase: 'idle', error: '', snapshot: null });
  }
  reset() { this.setInput(''); }
  dispose() { if (!this.disposed) { this.disposed = true; this.invalidate(); } }
  async find(): Promise<boolean> {
    if (this.disposed) return false;
    this.invalidate();
    const generation = this.generation, id = this.view.id;
    if (!isPaymentLookupId(id)) {
      this.publish({ id, phase: 'error', error: invalidId, snapshot: null });
      return false;
    }
    const controller = new AbortController();
    this.current = controller;
    const active = () => !this.disposed && generation === this.generation;
    this.publish({ id, phase: 'loading', error: '', snapshot: null });
    if (!active()) return false;
    try {
      const response = await this.loader(paymentLookupPath(id), controller.signal);
      if (!active()) return false;
      const snapshot = { row: publicRecord(response, id), capturedAt: this.now().toISOString() };
      this.publish({ id, phase: 'found', error: '', snapshot });
      if (active()) this.onFound?.(copySnapshot(snapshot));
      return active();
    } catch (error) {
      if (!active()) return false;
      const notFound = record(error) && error.status === 404;
      this.publish({ id, phase: notFound ? 'not-found' : 'error', snapshot: null,
        error: notFound ? PAYMENT_LOOKUP_NOT_FOUND : error instanceof Error ? error.message : 'Unable to look up this payment' });
      return false;
    } finally {
      if (active()) this.current = undefined;
    }
  }
}
