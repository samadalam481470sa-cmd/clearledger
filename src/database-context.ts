import { type DatabaseSync } from 'node:sqlite';
import { getAddress, isAddress, ZeroAddress, ZeroHash } from 'ethers';
import { z } from 'zod';

export interface DatabaseContext {
  chainId: number;
  genesisHash: string;
  router: string;
  relayer: string;
}
export class DatabaseContextError extends Error {}

const address = z.string().refine(isAddress).transform(getAddress).refine(value => value !== ZeroAddress);
const contextSchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  genesisHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase())
    .refine(value => value !== ZeroHash),
  router: address,
  relayer: address
}).strict();

function inputContext(input: DatabaseContext): DatabaseContext {
  try { return contextSchema.parse(input); }
  catch { throw new DatabaseContextError('Invalid database deployment context'); }
}
function storedContext(row: Record<string, unknown>): DatabaseContext {
  try {
    if (row.singleton !== 1n || row.version !== 1n || typeof row.chain_id !== 'bigint' ||
      row.chain_id < 1n || row.chain_id > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    const result = contextSchema.parse({ chainId: Number(row.chain_id), genesisHash: row.genesis_hash,
      router: row.router, relayer: row.relayer });
    if (result.genesisHash !== row.genesis_hash || result.router !== row.router || result.relayer !== row.relayer)
      throw new Error();
    return result;
  } catch { throw new DatabaseContextError('Invalid stored database deployment context'); }
}

/** Bind an initialized Store before its RPC CLI can serve requests or dispatch payments. */
export function bindDatabaseContext(db: DatabaseSync, input: DatabaseContext): void {
  const expected = inputContext(input);
  let began = false;
  try {
    db.exec('BEGIN IMMEDIATE'); began = true;
    db.exec(`CREATE TABLE IF NOT EXISTS deployment_context (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      version INTEGER NOT NULL CHECK(version = 1),
      chain_id INTEGER NOT NULL CHECK(chain_id > 0 AND chain_id <= 9007199254740991),
      genesis_hash TEXT NOT NULL, router TEXT NOT NULL, relayer TEXT NOT NULL
    ) STRICT`);
    const query = db.prepare('SELECT singleton,version,chain_id,genesis_hash,router,relayer FROM deployment_context');
    query.setReadBigInts(true);
    let rows = query.all();
    if (rows.length > 1) throw new DatabaseContextError('Invalid stored database deployment context');
    if (rows.length === 0) {
      const occupied = db.prepare(`SELECT EXISTS(SELECT 1 FROM payments) OR
        EXISTS(SELECT 1 FROM journals) OR EXISTS(SELECT 1 FROM audit) AS occupied`).get()!.occupied;
      if (occupied) throw new DatabaseContextError(
        'Database contains unbound records; use a new DB_PATH and review legacy data separately');
      db.prepare('INSERT INTO deployment_context(singleton,version,chain_id,genesis_hash,router,relayer) VALUES(1,1,?,?,?,?)')
        .run(expected.chainId, expected.genesisHash, expected.router, expected.relayer);
      rows = query.all();
    }
    if (rows.length !== 1) throw new DatabaseContextError('Invalid stored database deployment context');
    const existing = storedContext(rows[0]);
    if (existing.chainId !== expected.chainId || existing.genesisHash !== expected.genesisHash ||
      existing.router !== expected.router || existing.relayer !== expected.relayer)
      throw new DatabaseContextError('Database deployment context mismatch; use a separate DB_PATH');
    db.exec('COMMIT'); began = false;
  } catch (error) {
    // Never roll back a caller-owned transaction if BEGIN itself failed.
    if (began) { try { db.exec('ROLLBACK'); } catch { /* Preserve the fixed refusal diagnostic. */ } }
    if (error instanceof DatabaseContextError) throw error;
    throw new DatabaseContextError('Database deployment context could not be verified');
  }
}
