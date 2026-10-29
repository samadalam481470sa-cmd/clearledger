import { DatabaseSync } from 'node:sqlite';
import { paymentKey, type Payment } from './payment.ts';

export type Status = 'queued' | 'broadcast' | 'settled' | 'failed' | 'review';
export interface RecordRow {
  id: string; fingerprint: string; payload: string; signature: string; status: Status;
  raw_tx: string | null; tx_hash: string | null; block_number: number | null;
  block_hash: string | null; error: string | null; created_at: string; updated_at: string;
}
export class Conflict extends Error {}
export class PaginationError extends Error {}
export class StateTransitionError extends Error {}
export class JournalIntegrityError extends Error {
  constructor() { super('Stored journal data is invalid; totals are unavailable'); }
}
interface PageOptions { limit?: number; cursor?: string; status?: Status }
interface Cursor { version: 1; kind: 'payments' | 'journals'; status: Status | null; upper: number; before: number }
interface JournalRow {
  payment_id: string; token: string; debit_account: string; credit_account: string;
  amount: string; tx_hash: string; block_number: number; block_hash: string;
}
function numericRow<T>(row: unknown): T {
  if (row === undefined) return row as T;
  // SQLite integers can exceed JS's safe range. Read them without throwing,
  // then leave oversized numbers unsafe for provenance validation. This does
  // not rewrite the exact integer stored in SQLite.
  return Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value])) as T;
}
function pageSize(limit = 50) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PaginationError('Page limit must be an integer from 1 to 100');
  return limit;
}
function decodeCursor(text: string, kind: Cursor['kind'], status: Status | null): Cursor {
  try {
    if (!text || text.length > 512 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const bytes = Buffer.from(text, 'base64url');
    if (bytes.toString('base64url') !== text) throw new Error();
    const c = JSON.parse(bytes.toString('utf8'));
    if (c.version !== 1 || c.kind !== kind || c.status !== status ||
      !Number.isSafeInteger(c.upper) || !Number.isSafeInteger(c.before) ||
      c.upper < 0 || c.before < 1 || c.before > c.upper + 1) throw new Error();
    return c;
  } catch { throw new PaginationError('Invalid cursor for this collection and status filter'); }
}
function packPage<T>(rows: (T & { cursor_rowid: number })[], size: number, cursor: Cursor) {
  const visible = rows.slice(0, size);
  const nextCursor = rows.length > size ? Buffer.from(JSON.stringify({ ...cursor,
    before: visible[visible.length - 1].cursor_rowid })).toString('base64url') : null;
  return { items: visible.map(({ cursor_rowid, ...row }) => row as T), nextCursor };
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
        signature TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN
          ('queued','broadcast','settled','failed','review')),
        raw_tx TEXT, tx_hash TEXT, block_number INTEGER, block_hash TEXT, error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journals (
        payment_id TEXT PRIMARY KEY REFERENCES payments(id), token TEXT NOT NULL,
        debit_account TEXT NOT NULL, credit_account TEXT NOT NULL, amount TEXT NOT NULL,
        tx_hash TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, payment_id TEXT NOT NULL,
        action TEXT NOT NULL, at TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payments_status_order ON payments(status);
    `);
  }
  get(id: string): RecordRow | undefined {
    const query = this.db.prepare('SELECT * FROM payments WHERE id = ?');
    query.setReadBigInts(true);
    return numericRow<RecordRow | undefined>(query.get(id));
  }
  journal(id: string): JournalRow | undefined {
    const query = this.db.prepare('SELECT * FROM journals WHERE payment_id = ?');
    query.setReadBigInts(true);
    return numericRow<JournalRow | undefined>(query.get(id));
  }
  private transaction<T>(change: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = change();
      this.db.exec('COMMIT');
      return result;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  private requireRow(id: string) {
    const row = this.get(id);
    if (!row) throw new StateTransitionError('Unknown payment');
    return row;
  }
  accept(p: Payment, fingerprint: string, signature: string) {
    return this.transaction(() => {
      const id = paymentKey(p), existing = this.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Conflict('Payment ID already has different instructions');
        return { row: existing, replay: true };
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO payments(id,fingerprint,payload,signature,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, fingerprint, JSON.stringify(p), signature, 'queued', now, now);
      this.audit(id, 'accepted', 'Signed payment queued');
      return { row: this.requireRow(id), replay: false };
    });
  }
  audit(id: string, action: string, detail: string) {
    this.db.prepare('INSERT INTO audit(payment_id,action,at,detail) VALUES(?,?,?,?)')
      .run(id, action, new Date().toISOString(), detail);
  }
  broadcast(id: string, raw: string, hash: string) {
    this.transaction(() => {
      const row = this.requireRow(id);
      if (row.status === 'broadcast' && row.raw_tx === raw && row.tx_hash === hash) return;
      if (row.status !== 'queued' || row.raw_tx !== null || row.tx_hash !== null)
        throw new StateTransitionError('Payment cannot reserve a new broadcast');
      this.db.prepare("UPDATE payments SET status='broadcast',raw_tx=?,tx_hash=?,updated_at=? WHERE id=? AND status='queued'")
        .run(raw, hash, new Date().toISOString(), id);
      this.audit(id, 'broadcast-prepared', hash);
    });
  }
  setStatus(id: string, status: 'failed' | 'review', error: string) {
    this.transaction(() => {
      const row = this.requireRow(id), detail = error.slice(0, 500);
      if (row.status === status && row.error === detail) return;
      const allowed = status === 'failed' ? ['queued', 'broadcast'] : ['broadcast', 'settled'];
      if (!allowed.includes(row.status) || (row.status === 'queued' &&
        (row.raw_tx !== null || row.tx_hash !== null)))
        throw new StateTransitionError('Payment cannot enter ' + status);
      this.db.prepare('UPDATE payments SET status=?,error=?,updated_at=? WHERE id=?')
        .run(status, detail, new Date().toISOString(), id);
      this.audit(id, status, detail);
    });
  }
  finalize(id: string, blockNumber: number, blockHash: string) {
    this.transaction(() => {
      const row = this.requireRow(id);
      if (!['broadcast', 'settled'].includes(row.status) || !row.tx_hash || !row.raw_tx)
        throw new StateTransitionError('No eligible broadcast transaction');
      const p: Payment = JSON.parse(row.payload);
      const journal = this.journal(id);
      if (journal && (journal.token !== p.token || journal.debit_account !== p.payer ||
        journal.credit_account !== p.payee || journal.amount !== p.amount || journal.tx_hash !== row.tx_hash ||
        journal.block_number !== blockNumber || journal.block_hash !== blockHash))
        throw new StateTransitionError('Settlement conflicts with the existing journal');
      if (row.status === 'settled') {
        if (!journal || row.block_number !== blockNumber || row.block_hash !== blockHash)
          throw new StateTransitionError('Settlement retry does not match recorded provenance');
        return;
      }
      if (!journal) this.db.prepare('INSERT INTO journals VALUES(?,?,?,?,?,?,?,?)')
        .run(id, p.token, p.payer, p.payee, p.amount, row.tx_hash, blockNumber, blockHash);
      this.db.prepare("UPDATE payments SET status='settled',block_number=?,block_hash=?,error=NULL,updated_at=? WHERE id=?")
        .run(blockNumber, blockHash, new Date().toISOString(), id);
      this.audit(id, 'settled', row.tx_hash);
    });
  }
  list(limit = 100): RecordRow[] {
    const query = this.db.prepare('SELECT * FROM payments ORDER BY rowid DESC LIMIT ?');
    query.setReadBigInts(true);
    return query.all(limit).map(row => numericRow<RecordRow>(row));
  }
  private cursor(kind: Cursor['kind'], options: PageOptions) {
    const status = options.status ?? null;
    if (status !== null && !['queued', 'broadcast', 'settled', 'failed', 'review'].includes(status))
      throw new PaginationError('Invalid payment status');
    if (options.cursor !== undefined) return decodeCursor(options.cursor, kind, status);
    const maximum = this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS maximum FROM ' + kind).get()!.maximum;
    const upper = Number(maximum);
    if (!Number.isSafeInteger(upper + 1)) throw new PaginationError('Collection exceeds supported cursor range');
    return { version: 1 as const, kind, status, upper, before: upper + 1 };
  }
  pagePayments(options: PageOptions = {}) {
    const size = pageSize(options.limit), cursor = this.cursor('payments', options);
    const args: (string | number)[] = [cursor.upper, cursor.before];
    if (cursor.status) args.push(cursor.status);
    args.push(size + 1);
    const query = this.db.prepare('SELECT *,rowid AS cursor_rowid FROM payments WHERE rowid<=? AND rowid<?' +
      (cursor.status ? ' AND status=?' : '') + ' ORDER BY rowid DESC LIMIT ?');
    query.setReadBigInts(true);
    const rows = query.all(...args).map(row => numericRow<RecordRow & { cursor_rowid: number }>(row));
    return packPage<RecordRow>(rows, size, cursor);
  }
  pageJournals(options: Omit<PageOptions, 'status'> = {}) {
    const size = pageSize(options.limit), cursor = this.cursor('journals', options);
    const query = this.db.prepare('SELECT *,rowid AS cursor_rowid FROM journals WHERE rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT ?');
    query.setReadBigInts(true);
    const rows = query.all(cursor.upper, cursor.before, size + 1).map(row => numericRow<JournalRow & { cursor_rowid: number }>(row));
    return packPage<JournalRow>(rows, size, cursor);
  }
  assetTotals() {
    const assets = new Map<string, { token: string; settledPayments: number; settledBaseUnits: bigint; reviewPayments: number; reviewBaseUnits: bigint }>();
    // Check posting relationships and read eligible rows in one SQLite snapshot.
    // An unjournaled review without recorded inclusion remains a valid state.
    for (const record of this.db.prepare(`
      SELECT 'invalid' AS kind,NULL AS token,NULL AS amount,NULL AS status
      WHERE EXISTS (
        SELECT 1 FROM payments p
        WHERE (p.status='settled' OR (p.status='review' AND
          (p.block_number IS NOT NULL OR p.block_hash IS NOT NULL)))
          AND NOT EXISTS (SELECT 1 FROM journals j WHERE j.payment_id=p.id)
      ) OR EXISTS (
        SELECT 1 FROM journals j LEFT JOIN payments p ON p.id=j.payment_id
        WHERE p.id IS NULL OR p.status IS NULL OR p.status NOT IN ('settled','review')
      )
      UNION ALL
      SELECT 'asset',j.token,j.amount,p.status
      FROM journals j JOIN payments p ON p.id=j.payment_id
      WHERE p.status IN ('settled','review')
    `).iterate()) {
      if (record.kind === 'invalid') throw new JournalIntegrityError();
      // A malformed included row invalidates the whole report. Coercion could
      // turn missing/negative/nondecimal amounts into plausible transfer volume.
      if (typeof record.token !== 'string' || !/^0x[0-9a-fA-F]{40}(?![\s\S])/.test(record.token) ||
        record.token === '0x' + '0'.repeat(40) || typeof record.amount !== 'string' ||
        !/^[1-9][0-9]{0,77}(?![\s\S])/.test(record.amount)) throw new JournalIntegrityError();
      const amount = BigInt(record.amount);
      if (amount >= 2n ** 256n) throw new JournalIntegrityError();
      const token = record.token.toLowerCase();
      const total = assets.get(token) ?? { token, settledPayments: 0, settledBaseUnits: 0n, reviewPayments: 0, reviewBaseUnits: 0n };
      if (record.status === 'settled') { total.settledPayments++; total.settledBaseUnits += amount; }
      else { total.reviewPayments++; total.reviewBaseUnits += amount; }
      assets.set(token, total);
    }
    return [...assets.values()].sort((a, b) => a.token.localeCompare(b.token)).map(t => ({ ...t,
      settledBaseUnits: t.settledBaseUnits.toString(), reviewBaseUnits: t.reviewBaseUnits.toString() }));
  }
  pending(): RecordRow[] {
    // A durable signed transaction reserves the relayer nonce even before RPC sees it.
    // Recover broadcasts first; rowid preserves acceptance order without wall-clock ties.
    const query = this.db.prepare("SELECT * FROM payments WHERE status IN ('queued','broadcast') ORDER BY CASE status WHEN 'broadcast' THEN 0 ELSE 1 END,rowid");
    query.setReadBigInts(true);
    return query.all().map(row => numericRow<RecordRow>(row));
  }
  journals(limit?: number) {
    const query = this.db.prepare('SELECT * FROM journals ORDER BY rowid DESC' + (limit === undefined ? '' : ' LIMIT ?'));
    query.setReadBigInts(true);
    return (limit === undefined ? query.all() : query.all(pageSize(limit))).map(row => numericRow<JournalRow>(row));
  }
  events() { return this.db.prepare('SELECT sequence,payment_id,action,at,detail FROM audit ORDER BY sequence DESC LIMIT 100').all(); }
  close() { this.db.close(); }
}

