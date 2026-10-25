export const PAGE_SIZE = 25;
export type PaymentStatus = 'queued' | 'broadcast' | 'settled' | 'failed' | 'review';
export type StatusFilter = PaymentStatus | 'all';
export interface Payment {
  paymentId: string; payer: string; payee: string; token: string;
  amount: string; nonce: string; deadline: string;
}
export interface PaymentRow {
  id: string; status: PaymentStatus; tx_hash: string | null; created_at: string;
  block_number: number | null; error: string | null; payment: Payment;
}
export interface JournalRow {
  payment_id: string; token: string; debit_account: string; credit_account: string;
  amount: string; tx_hash: string; block_number: number; block_hash: string;
}
export interface Overview {
  mode: string; chainId: number; router: string; currency?: string; payer?: string;
  payee?: string; token?: string; validators?: number; consensus?: string;
  perPaymentLimit?: string; dailyLimit?: string; confirmations: number;
  block: { number: number; hash: string; timestamp: number } | null;
  payments: PaymentRow[]; journals: JournalRow[];
  audit: { sequence: number; action: string; at: string; payment_id: string; detail: string }[];
}
export interface AssetTotal {
  token: string; settledPayments: number; settledBaseUnits: string;
  reviewPayments: number; reviewBaseUnits: string;
}
export interface CursorPage<T> { items: T[]; nextCursor: string | null }
export interface PagerState<T> extends CursorPage<T> {
  page: number; loading: boolean; error: string;
}

export function pagePath(collection: 'payments' | 'journals', cursor?: string, status: StatusFilter = 'all') {
  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== undefined) query.set('cursor', cursor);
  if (collection === 'payments' && status !== 'all') query.set('status', status);
  return collection + '?' + query.toString();
}

export function formatAssetAmount(amount: string, token: string, overview?: Pick<Overview, 'mode' | 'token'>) {
  if (overview?.mode !== 'demo' || !overview.token ||
    token.toLowerCase() !== overview.token.toLowerCase() || !/^\d+$/.test(amount))
    return { value: amount, unit: 'base units' };
  const n = BigInt(amount), fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return { value: (n / 1000000n).toString() + (fraction ? '.' + fraction : '.00'), unit: 'dUSD' };
}

// Cursor history belongs to one collection/filter/authentication context. Create a
// fresh pager when that context changes; dispose prevents obsolete completions.
export class CursorPager<T> {
  private history: (string | undefined)[] = [undefined];
  private current?: AbortController;
  private version = 0;
  private disposed = false;
  private view: PagerState<T> = { items: [], nextCursor: null, page: 1, loading: false, error: '' };
  constructor(private readonly loader: (cursor: string | undefined, signal: AbortSignal) => Promise<CursorPage<T>>,
    private readonly onChange: (state: PagerState<T>) => void) {}
  get state() { return this.view; }
  private publish(state: PagerState<T>) { this.view = state; this.onChange(state); }
  refresh() { return this.load([undefined]); }
  reload() { return this.view.loading ? Promise.resolve(false) : this.load([...this.history]); }
  next() {
    return this.view.loading || !this.view.nextCursor ? Promise.resolve(false) :
      this.load([...this.history, this.view.nextCursor]);
  }
  previous() {
    return this.view.loading || this.history.length < 2 ? Promise.resolve(false) :
      this.load(this.history.slice(0, -1));
  }
  dispose() { this.disposed = true; this.version++; this.current?.abort(); }
  private async load(history: (string | undefined)[]) {
    if (this.disposed) return false;
    const version = ++this.version;
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    this.publish({ ...this.view, loading: true, error: '' });
    try {
      const page = await this.loader(history[history.length - 1], controller.signal);
      if (this.disposed || version !== this.version) return false;
      if (!Array.isArray(page.items) || page.items.length > PAGE_SIZE ||
        (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor ||
          page.nextCursor.length > 512 || history.includes(page.nextCursor))))
        throw new Error('Server returned an invalid cursor page');
      this.history = history;
      this.publish({ ...page, page: history.length, loading: false, error: '' });
      return true;
    } catch (e) {
      if (this.disposed || version !== this.version) return false;
      this.publish({ ...this.view, loading: false, error: e instanceof Error ? e.message : 'Unable to load this page' });
      return false;
    } finally {
      if (version === this.version) this.current = undefined;
    }
  }
}
