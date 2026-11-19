import type { Overview, PaymentRow } from './dashboard.ts';
import { requestWithTimeout } from './request.ts';

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

function demoAmountBaseUnits(amount: string) {
  const decimal = /^([0-9]{1,7})(?:\.([0-9]{1,6}))?(?![\s\S])/.exec(amount);
  return decimal && BigInt(decimal[1] + (decimal[2] ?? '').padEnd(6, '0')).toString();
}

export interface DemoPaymentAttempt {
  readonly request: Readonly<{ amount: string; paymentId: string }>;
  readonly recordId: string;
}

export function newDemoPaymentAttempt(amount: string, payer: string | undefined,
  fillRandom: (bytes: Uint8Array) => void = bytes => { crypto.getRandomValues(bytes); }): DemoPaymentAttempt {
  const baseUnits = demoAmountBaseUnits(amount);
  if (baseUnits === null) throw new Error('Enter a decimal amount with at most six decimal places');
  if (baseUnits === '0') throw new Error('Enter an amount greater than zero');
  if (!payer || !addressPattern.test(payer) || payer === '0x' + '00'.repeat(20))
    throw new Error('The demo payer address is unavailable');
  const random = new Uint8Array(32);
  fillRandom(random);
  const paymentId = '0x' + Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
  if (paymentId === '0x' + '00'.repeat(32)) throw new Error('The payment ID could not be generated');
  return { request: { amount, paymentId }, recordId: payer.toLowerCase() + ':' + paymentId };
}

/** Bound the client wait without changing the attempt or cancelling server-side work. */
export async function requestDemoPayment(attempt: DemoPaymentAttempt,
  send: (body: DemoPaymentAttempt['request'], signal: AbortSignal) => Promise<unknown>,
  parentSignal: AbortSignal, timeoutMs = 15_000): Promise<unknown> {
  return requestWithTimeout(signal => Promise.resolve().then(() => {
    if (signal.aborted) throw signal.reason;
    return send(attempt.request, signal);
  }), parentSignal, timeoutMs, 'Payment response timed out');
}

/** Acknowledge the returned record only when it agrees with the submitted demo transfer. */
export function demoPaymentSnapshot(response: unknown, amount: string,
  context: Pick<Overview, 'payer' | 'payee' | 'token'> & { recordId?: string }, now = new Date()): PaymentLookupSnapshot {
  if (!record(response) || !record(response.payment) || !isPaymentLookupId(response.payment.id) ||
    (context.recordId !== undefined && response.payment.id !== context.recordId))
    throw new Error(invalidResponse);
  const row = publicRecord(response.payment, response.payment.id);
  const payment = row.payment;
  if (!payment || payment.amount !== demoAmountBaseUnits(amount) ||
    payment.payer.toLowerCase() !== context.payer?.toLowerCase() ||
    payment.payee.toLowerCase() !== context.payee?.toLowerCase() ||
    payment.token.toLowerCase() !== context.token?.toLowerCase())
    throw new Error(invalidResponse);
  return { row, capturedAt: now.toISOString() };
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
    private readonly now: () => Date = () => new Date(),
    private readonly timeoutMs = 15_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)
      throw new RangeError('Lookup timeout must be an integer from 1 to 2147483647 milliseconds');
  }
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
      const response = await requestWithTimeout(signal => this.loader(paymentLookupPath(id), signal),
        controller.signal, this.timeoutMs, 'Payment lookup timed out. Try this ID again.');
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
