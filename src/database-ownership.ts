import { closeSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export class DatabaseOwnershipError extends Error {}
export interface DatabaseOwnership {
  readonly databasePath: string;
  readonly sidecarPath: string;
  release(): void;
}

function createIfMissing(path: string) {
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
function busy(error: unknown) {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && [5, 6].includes(code & 255);
}

/** One cooperating RPC process per canonical file, on a local filesystem. */
export function acquireDatabaseOwnership(path: string): DatabaseOwnership {
  let lock: DatabaseSync | undefined;
  try {
    if (typeof path !== 'string' || !path || path === ':memory:' || /^file:/i.test(path))
      throw new DatabaseOwnershipError('Database ownership requires a regular file-backed DB_PATH');
    // Do not open/close an existing file descriptor outside SQLite: on POSIX,
    // that can disturb advisory locks held by SQLite in this same process.
    createIfMissing(path);
    const databasePath = realpathSync(path);
    const file = statSync(databasePath);
    if (!file.isFile()) throw new DatabaseOwnershipError('Database ownership requires a regular file-backed DB_PATH');
    if (file.nlink !== 1) throw new DatabaseOwnershipError('Database ownership does not support hard-linked database files');
    const sidecarPath = databasePath + '.worker-lock.sqlite';
    createIfMissing(sidecarPath);
    const sidecar = lstatSync(sidecarPath);
    if (!sidecar.isFile() || sidecar.isSymbolicLink() || sidecar.nlink !== 1)
      throw new DatabaseOwnershipError('Invalid database ownership sidecar');
    lock = new DatabaseSync(sidecarPath);
    lock.exec('PRAGMA busy_timeout=0');
    const mode = lock.prepare('PRAGMA journal_mode=DELETE').get();
    if (mode?.journal_mode !== 'delete') throw new DatabaseOwnershipError('Invalid database ownership sidecar');
    // Hold an OS-backed SQLite transaction for the entire worker lifetime.
    // No TTL, PID reuse, stale-file deletion, or financial-table write lock.
    lock.exec('BEGIN EXCLUSIVE');
    const owned = lock;
    let transaction = true, closed = false;
    return { databasePath, sidecarPath, release() {
      if (closed) return;
      try {
        if (transaction) { owned.exec('ROLLBACK'); transaction = false; }
        owned.close(); closed = true;
      } catch { throw new DatabaseOwnershipError('Database ownership could not be released'); }
    } };
  } catch (error) {
    try { lock?.close(); } catch { /* Keep diagnostics fixed; process exit releases OS handles. */ }
    if (error instanceof DatabaseOwnershipError) throw error;
    throw new DatabaseOwnershipError(busy(error)
      ? 'Database is already owned by another ClearLedger RPC process'
      : 'Database ownership could not be acquired');
  }
}
