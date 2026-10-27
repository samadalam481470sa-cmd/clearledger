import { test, beforeEach, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { acquireDatabaseOwnership, DatabaseOwnershipError } from '../src/database-ownership.ts';
import { Store } from '../src/store.ts';

type Ownership = ReturnType<typeof acquireDatabaseOwnership>;
type Reply = { type: string; message?: string; databasePath?: string; sidecarPath?: string };
interface Child {
  process: ChildProcess; closed: boolean;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  request(command: Record<string, string>): Promise<Reply>;
}
const messages = {
  file: 'Database ownership requires a regular file-backed DB_PATH',
  hardlink: 'Database ownership does not support hard-linked database files',
  sidecar: 'Invalid database ownership sidecar',
  busy: 'Database is already owned by another ClearLedger RPC process',
  generic: 'Database ownership could not be acquired'
};
const workRoot = resolve('../../work');
let directory: string;
let owners: Ownership[];
let children: Child[];
beforeEach(() => {
  mkdirSync(workRoot, { recursive: true });
  directory = mkdtempSync(join(workRoot, 'database-ownership-test-'));
  owners = []; children = [];
});
async function within<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Database ownership child checkpoint timed out')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}
async function kill(child: Child) {
  if (!child.closed && child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
  return await within(child.exited);
}
afterEach(async () => {
  const failures: unknown[] = [];
  for (const child of children) { try { await kill(child); } catch (error) { failures.push(error); } }
  for (const owner of owners) { try { owner.release(); } catch (error) { failures.push(error); } }
  if (children.every(child => child.closed) && failures.length === 0) {
    assert.equal(dirname(resolve(directory)), workRoot);
    assert.ok(directory.startsWith(join(workRoot, 'database-ownership-test-')));
    rmSync(directory, { recursive: true, force: true });
  }
  if (failures.length) throw new AggregateError(failures, 'Database ownership test cleanup failed');
});
function acquire(path = join(directory, 'ledger.sqlite')) {
  const owner = acquireDatabaseOwnership(path);
  owners.push(owner);
  return owner;
}
function rejects(path: string, message: string) {
  assert.throws(() => acquireDatabaseOwnership(path), error => error instanceof DatabaseOwnershipError && error.message === message);
}
function child() {
  const processChild = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/database-owner.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    env: { ...process.env, TSX_DISABLE_CACHE: '1', TEMP: directory, TMP: directory, TMPDIR: directory }
  });
  const handle: Child = {
    process: processChild, closed: false,
    exited: new Promise(resolveExit => processChild.once('close', (code, signal) => {
      handle.closed = true; resolveExit({ code, signal });
    })),
    request(command) {
      return within(new Promise<Reply>((resolveReply, reject) => {
        function finish(error?: Error, reply?: Reply) {
          processChild.off('message', received); processChild.off('error', failed); processChild.off('close', closed);
          if (error) reject(error); else resolveReply(reply!);
        }
        function received(reply: Reply) { finish(undefined, reply); }
        function failed() { finish(new Error('Database ownership fixture process failed')); }
        function closed() { finish(new Error('Database ownership fixture exited before replying')); }
        processChild.once('message', received); processChild.once('error', failed); processChild.once('close', closed);
        try { processChild.send(command, error => { if (error) failed(); }); }
        catch { failed(); }
      }));
    }
  };
  processChild.once('error', () => {});
  children.push(handle);
  return handle;
}
function symlinkOrSkip(t: TestContext, target: string, path: string) {
  try { symlinkSync(target, path, 'file'); return true; }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('Windows does not permit task-owned file symlinks for this account'); return false;
    }
    throw error;
  }
}

test('one owner excludes same-process contenders while normal Store accounting still commits', () => {
  const owner = acquire();
  assert.equal(owner.databasePath, realpathSync(join(directory, 'ledger.sqlite')));
  assert.equal(owner.sidecarPath, owner.databasePath + '.worker-lock.sqlite');
  rejects(owner.databasePath, messages.busy);
  const store = new Store(owner.databasePath);
  try {
    const row = store.accept({ paymentId: '0x' + '12'.repeat(32), payer: '0x' + '11'.repeat(20),
      payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000', nonce: '0',
      deadline: '2000000000' }, 'synthetic-ownership-fingerprint', 'synthetic-ownership-signature').row;
    store.broadcast(row.id, 'synthetic-owned-raw', '0x' + '45'.repeat(32));
    store.finalize(row.id, 1, '0x' + '67'.repeat(32));
    assert.equal(store.get(row.id)!.status, 'settled');
    assert.equal(store.journals().length, 1); assert.equal(store.events().length, 3);
    rejects(owner.databasePath, messages.busy);
  } finally { store.close(); }
});

test('release is idempotent and permits immediate reacquisition without replacing the persistent sidecar', () => {
  const owner = acquire();
  const identity = statSync(owner.sidecarPath).ino;
  owner.release(); owner.release();
  assert.equal(existsSync(owner.sidecarPath), true);
  const next = acquire(owner.databasePath);
  assert.equal(statSync(next.sidecarPath).ino, identity);
  owner.release(); // A stale release handle cannot unlock the later owner.
  rejects(next.databasePath, messages.busy);
});

test('a real child owner excludes both parent and independent child until graceful release', { timeout: 15000 }, async () => {
  const path = join(directory, 'ledger.sqlite');
  const holder = child();
  const first = await holder.request({ type: 'acquire', path });
  assert.equal(first.type, 'acquired');
  rejects(path, messages.busy);
  const contender = child();
  assert.deepEqual(await contender.request({ type: 'acquire', path }), { type: 'refused', message: messages.busy });
  assert.deepEqual(await within(contender.exited), { code: 1, signal: null });
  assert.equal(holder.process.exitCode, null);
  rejects(path, messages.busy);
  assert.deepEqual(await holder.request({ type: 'release' }), { type: 'released' });
  assert.deepEqual(await within(holder.exited), { code: 0, signal: null });
  const owner = acquire(path);
  assert.equal(owner.sidecarPath, first.sidecarPath);
});

test('a refused same-process acquisition does not release the owner OS lock to another process', { timeout: 10000 }, async () => {
  const owner = acquire();
  rejects(owner.databasePath, messages.busy);
  rejects(owner.databasePath, messages.busy);
  const contender = child();
  assert.deepEqual(await contender.request({ type: 'acquire', path: owner.databasePath }),
    { type: 'refused', message: messages.busy });
  assert.deepEqual(await within(contender.exited), { code: 1, signal: null });
  rejects(owner.databasePath, messages.busy);
});

test('SIGKILL releases the OS lock and another child acquires without stale-lock deletion', { timeout: 15000 }, async () => {
  const path = join(directory, 'ledger.sqlite');
  const holder = child();
  const first = await holder.request({ type: 'acquire', path });
  assert.equal(first.type, 'acquired');
  const identity = statSync(first.sidecarPath!).ino;
  const result = await kill(holder);
  assert.ok(result.signal === 'SIGKILL' || result.code !== 0, 'Expected actual abrupt process termination');
  assert.equal(existsSync(first.sidecarPath!), true);
  const replacement = child();
  const acquired = await replacement.request({ type: 'acquire', path });
  assert.equal(acquired.type, 'acquired');
  assert.equal(acquired.sidecarPath, first.sidecarPath);
  assert.equal(statSync(acquired.sidecarPath!).ino, identity);
  rejects(path, messages.busy);
  assert.deepEqual(await replacement.request({ type: 'release' }), { type: 'released' });
  assert.deepEqual(await within(replacement.exited), { code: 0, signal: null });
});

test('a canonical dot-segment alias cannot acquire a second sidecar', () => {
  const owner = acquire();
  mkdirSync(join(directory, 'nested'));
  rejects(join(directory, 'nested', '..', 'ledger.sqlite'), messages.busy);
  rejects(resolve(directory, '.', 'ledger.sqlite'), messages.busy);
  assert.equal(owner.sidecarPath, realpathSync(owner.databasePath) + '.worker-lock.sqlite');
});

test('a symlink alias resolves to the same financial file and cannot bypass its owner', t => {
  const owner = acquire();
  const alias = join(directory, 'alias.sqlite');
  if (!symlinkOrSkip(t, owner.databasePath, alias)) return;
  rejects(alias, messages.busy);
  owner.release();
  const next = acquire(alias);
  assert.equal(next.databasePath, owner.databasePath);
  assert.equal(next.sidecarPath, owner.sidecarPath);
});

test('new database and sidecar files use private POSIX modes', {
  skip: process.platform === 'win32' ? 'Windows file mode bits do not establish POSIX permission enforcement' : false
}, () => {
  const owner = acquire();
  assert.equal(statSync(owner.databasePath).mode & 0o777, 0o600);
  assert.equal(statSync(owner.sidecarPath).mode & 0o777, 0o600);
});

test('acquiring an existing financial file never truncates its contents', () => {
  const path = join(directory, 'existing.sqlite');
  const original = Buffer.from('task-owned-existing-financial-file-sentinel');
  writeFileSync(path, original);
  const owner = acquire(path);
  assert.ok(readFileSync(path).equals(original), 'Ownership acquisition modified the financial file');
  owner.release();
  assert.ok(readFileSync(path).equals(original), 'Ownership release modified the financial file');
});

for (const [name, path] of [
  ['memory', ':memory:'], ['memory URI', 'file:task-owned-memory?mode=memory'],
  ['file URI', 'file:///task-owned-secret-path.sqlite'], ['uppercase URI', 'FILE:task-owned.sqlite'], ['empty', '']
]) {
  test('non-file DB_PATH (' + name + ') is refused with a fixed diagnostic', () => rejects(path, messages.file));
}
test('a directory cannot act as the financial database', () => rejects(directory, messages.file));

test('hard-linked financial files are refused for both path aliases', () => {
  const path = join(directory, 'ledger.sqlite'), alias = join(directory, 'hardlink.sqlite');
  writeFileSync(path, ''); linkSync(path, alias);
  rejects(path, messages.hardlink); rejects(alias, messages.hardlink);
  assert.equal(existsSync(path + '.worker-lock.sqlite'), false);
});

test('a directory sidecar is refused without replacing it', () => {
  const path = join(directory, 'ledger.sqlite'), sidecar = path + '.worker-lock.sqlite';
  writeFileSync(path, ''); mkdirSync(sidecar);
  rejects(path, messages.sidecar);
  assert.equal(statSync(sidecar).isDirectory(), true);
});
test('a hard-linked sidecar is refused without modifying either file', () => {
  const path = join(directory, 'ledger.sqlite'), sidecar = path + '.worker-lock.sqlite';
  writeFileSync(path, '');
  const other = join(directory, 'other.sqlite'); writeFileSync(other, 'task-owned-sidecar-sentinel'); linkSync(other, sidecar);
  rejects(path, messages.sidecar);
  assert.equal(readFileSync(other, 'utf8'), 'task-owned-sidecar-sentinel');
  assert.equal(statSync(sidecar).nlink, 2);
});
test('a symlink sidecar is refused without following or altering its target', t => {
  const path = join(directory, 'ledger.sqlite'), sidecar = path + '.worker-lock.sqlite';
  writeFileSync(path, '');
  const target = join(directory, 'target.sqlite'); writeFileSync(target, 'task-owned-symlink-target-sentinel');
  if (!symlinkOrSkip(t, target, sidecar)) return;
  rejects(path, messages.sidecar);
  assert.equal(readFileSync(target, 'utf8'), 'task-owned-symlink-target-sentinel');
});

test('non-SQLite sidecar contents are refused with a fixed generic error and remain unchanged', () => {
  const path = join(directory, 'ledger.sqlite'), sidecar = path + '.worker-lock.sqlite';
  writeFileSync(path, '');
  const original = Buffer.from('task-owned-non-SQLite-private-diagnostic-sentinel');
  writeFileSync(sidecar, original);
  rejects(path, messages.generic);
  assert.ok(readFileSync(sidecar).equals(original), 'Failed ownership acquisition modified the invalid sidecar');
  assert.equal(statSync(sidecar).nlink, 1);
});

test('a missing parent refuses acquisition without exposing its input path', () => {
  rejects(join(directory, 'uncreated-parent', 'private-path-sentinel.sqlite'), messages.generic);
});
