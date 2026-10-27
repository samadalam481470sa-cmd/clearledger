import { ASSET_SYMBOL_PATTERN, MAX_ASSET_METADATA, type AssetMetadata } from '../shared/asset-metadata.ts';

export const PAGE_SIZE = 25;
export type PaymentStatus = 'queued' | 'broadcast' | 'settled' | 'failed' | 'review';
export type StatusFilter = PaymentStatus | 'all';
export interface Payment {
  paymentId: string; payer: string; payee: string; token: string;
  amount: string; nonce: string; deadline: string;
}
export interface PaymentRow {
  id: string; status: PaymentStatus; tx_hash: string | null; created_at: string;
  block_number: number | null; error: string | null; payment: Payment | null;
  integrityError?: string;
}
export interface JournalRow {
  payment_id: string; token: string; debit_account: string; credit_account: string;
  amount: string; tx_hash: string; block_number: number; block_hash: string;
}
export interface Overview {
  mode: string; chainId: number; router: string; currency?: string; payer?: string;
  payee?: string; token?: string; validators?: number; consensus?: string;
  perPaymentLimit?: string; dailyLimit?: string; confirmations: number;
  assetMetadata?: AssetMetadata[];
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

export type AssetContext = Pick<Overview, 'mode' | 'token'> & Partial<Pick<Overview, 'chainId' | 'assetMetadata'>>;
interface AssetRegistry {
  status: 'missing' | 'invalid' | 'ready';
  entries: AssetMetadata[];
}
const addressPattern = /^0x[0-9a-fA-F]{40}(?![\s\S])/;
const metadataKeys = new Set(['chainId', 'token', 'symbol', 'decimals', 'source']);
const validAddress = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 42 && addressPattern.test(value) && value !== '0x' + '0'.repeat(40);

/** Validate received display metadata independently of the server configuration. */
export function assetRegistry(overview?: AssetContext | null): AssetRegistry {
  if (!overview || overview.assetMetadata === undefined) return { status: 'missing', entries: [] };
  const registry = overview.assetMetadata;
  if (!Number.isSafeInteger(overview.chainId) || overview.chainId! <= 0 ||
    !Array.isArray(registry) || registry.length > MAX_ASSET_METADATA)
    return { status: 'invalid', entries: [] };
  const seen = new Set<string>();
  for (const item of registry) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !metadataKeys.has(key)) ||
      !Number.isSafeInteger(item.chainId) || item.chainId <= 0 ||
      !validAddress(item.token) ||
      typeof item.symbol !== 'string' || !ASSET_SYMBOL_PATTERN.test(item.symbol) ||
      !Number.isInteger(item.decimals) || item.decimals < 0 || item.decimals > 255 ||
      (item.source !== 'configured' && item.source !== 'demo'))
      return { status: 'invalid', entries: [] };
    const key = item.chainId + ':' + item.token.toLowerCase();
    if (seen.has(key)) return { status: 'invalid', entries: [] };
    seen.add(key);
  }
  return { status: 'ready', entries: registry.filter(item => item.chainId === overview.chainId) };
}

export function assetMetadataFor(token: string, overview?: AssetContext | null):
  Pick<AssetMetadata, 'symbol' | 'decimals' | 'source'> | undefined {
  if (!validAddress(token)) return undefined;
  const registry = assetRegistry(overview);
  if (registry.status === 'ready')
    return registry.entries.find(item => item.token.toLowerCase() === token.toLowerCase());
  // Older demo responses did not include a registry. A present registry, even an
  // empty or invalid one, never authorizes this compatibility fallback.
  if (registry.status === 'missing' && overview?.mode === 'demo' && validAddress(overview.token) &&
    overview.token.toLowerCase() === token.toLowerCase())
    return { symbol: 'dUSD', decimals: 6, source: 'demo' };
  return undefined;
}

export function formatAssetAmount(amount: string, token: string, overview?: AssetContext | null) {
  const metadata = assetMetadataFor(token, overview);
  if (!metadata || typeof amount !== 'string' || !/^[0-9]+(?![\s\S])/.test(amount))
    return { value: amount, unit: 'base units' };
  const n = BigInt(amount);
  if (metadata.decimals === 0) return { value: n.toString(), unit: metadata.symbol };
  const scale = 10n ** BigInt(metadata.decimals);
  const fraction = (n % scale).toString().padStart(metadata.decimals, '0').replace(/0+$/, '');
  return { value: (n / scale).toString() + (fraction ? '.' + fraction : '.00'), unit: metadata.symbol };
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
