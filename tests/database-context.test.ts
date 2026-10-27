import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAddress, ZeroAddress } from 'ethers';
import { type DatabaseSync } from 'node:sqlite';
import { Store, type Status } from '../src/store.ts';
import { bindDatabaseContext, DatabaseContextError } from '../src/database-context.ts';

type Context = Parameters<typeof bindDatabaseContext>[1];
const context: Context = { chainId: 31337, genesisHash: '0x' + 'ab'.repeat(32),
  router: getAddress('0x' + 'cd'.repeat(20)), relayer: getAddress('0x' + 'ef'.repeat(20)) };
const messages = {
  input: 'Invalid database deployment context',
  legacy: 'Database contains unbound records; use a new DB_PATH and review legacy data separately',
  stored: 'Invalid stored database deployment context',
  mismatch: 'Database deployment context mismatch; use a separate DB_PATH',
  generic: 'Database deployment context could not be verified'
};
let store: Store;
beforeEach(() => { store = new Store(); });
afterEach(() => { store.close(); });

function exists(db: DatabaseSync) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='deployment_context'").get();
}
function rows(db: DatabaseSync) {
  const query = db.prepare('SELECT * FROM deployment_context');
  query.setReadBigInts(true);
  return query.all();
}
function records(db: DatabaseSync) {
  return { payments: db.prepare('SELECT * FROM payments').all(),
    journals: db.prepare('SELECT * FROM journals').all(), audit: db.prepare('SELECT * FROM audit').all() };
}
function totalChanges(db: DatabaseSync) {
  return db.prepare('SELECT total_changes() AS changes').get()!.changes;
}
function rejects(db: DatabaseSync, input: unknown, message: string) {
  assert.throws(() => bindDatabaseContext(db, input as Context),
    error => error instanceof DatabaseContextError && error.message === message);
}
function seed(status: Status = 'queued') {
  const row = store.accept({ paymentId: '0x' + '12'.repeat(32), payer: '0x' + '11'.repeat(20),
    payee: '0x' + '22'.repeat(20), token: '0x' + '33'.repeat(20), amount: '125000000',
    nonce: '0', deadline: '2000000000' }, 'context-test-fingerprint', 'context-test-signature').row;
  if (status === 'broadcast' || status === 'settled' || status === 'review')
    store.broadcast(row.id, 'context-test-signed-bytes', '0x' + '45'.repeat(32));
  if (status === 'settled') store.finalize(row.id, 1, '0x' + '67'.repeat(32));
  if (status === 'review') store.setStatus(row.id, 'review', 'Synthetic review');
  if (status === 'failed') store.setStatus(row.id, 'failed', 'Synthetic rejection');
  return row.id;
}
function stored(overrides: Record<string, unknown> = {}) {
  return { singleton: 1n, version: 1n, chain_id: BigInt(context.chainId),
    genesis_hash: context.genesisHash, router: context.router, relayer: context.relayer, ...overrides };
}
function looseTable(db: DatabaseSync, entries: Record<string, unknown>[]) {
  // A preexisting malformed metadata table may not have the new constraints.
  db.exec('CREATE TABLE deployment_context(singleton,version,chain_id,genesis_hash,router,relayer)');
  const insert = db.prepare('INSERT INTO deployment_context(singleton,version,chain_id,genesis_hash,router,relayer) VALUES(?,?,?,?,?,?)');
  for (const entry of entries) insert.run(entry.singleton as any, entry.version as any, entry.chain_id as any,
    entry.genesis_hash as any, entry.router as any, entry.relayer as any);
}

test('an empty database gets one strict public context and a same-identity restart performs no writes', () => {
  bindDatabaseContext(store.db, context);
  assert.equal(rows(store.db).length, 1);
  assert.deepEqual({ ...rows(store.db)[0] }, { singleton: 1n, version: 1n, chain_id: BigInt(context.chainId),
    genesis_hash: context.genesisHash, router: context.router, relayer: context.relayer });
  assert.equal(store.db.prepare("SELECT strict FROM pragma_table_list WHERE name='deployment_context'").get()!.strict, 1);
  assert.deepEqual(records(store.db), { payments: [], journals: [], audit: [] });
  const before = rows(store.db), changes = totalChanges(store.db);
  bindDatabaseContext(store.db, { ...context, genesisHash: '0x' + 'AB'.repeat(32),
    router: context.router.toLowerCase(), relayer: context.relayer.toLowerCase() });
  assert.deepEqual(rows(store.db), before);
  assert.equal(totalChanges(store.db), changes, 'Same identity must not rewrite metadata or audit');
});

test('a bound database with payment history can restart under exactly the same deployment', () => {
  bindDatabaseContext(store.db, context);
  seed('settled');
  const before = { context: rows(store.db), records: records(store.db) }, changes = totalChanges(store.db);
  bindDatabaseContext(store.db, context);
  assert.deepEqual({ context: rows(store.db), records: records(store.db) }, before);
  assert.equal(totalChanges(store.db), changes);
});

for (const [field, value] of [
  ['chainId', 31338], ['genesisHash', '0x' + '56'.repeat(32)],
  ['router', getAddress('0x' + '78'.repeat(20))], ['relayer', getAddress('0x' + '90'.repeat(20))]
] as const) {
  test('changing ' + field + ' refuses the bound database without replacing context or financial rows', () => {
    bindDatabaseContext(store.db, context); seed('settled');
    const before = { context: rows(store.db), records: records(store.db) };
    rejects(store.db, { ...context, [field]: value }, messages.mismatch);
    assert.deepEqual({ context: rows(store.db), records: records(store.db) }, before);
  });
}

for (const [description, input] of [
  ['null', null], ['array', []], ['string', 'private-input-sentinel'], ['empty object', {}],
  ['zero chain', { ...context, chainId: 0 }], ['negative chain', { ...context, chainId: -1 }],
  ['fractional chain', { ...context, chainId: 1.5 }],
  ['unsafe chain', { ...context, chainId: Number.MAX_SAFE_INTEGER + 1 }],
  ['NaN chain', { ...context, chainId: NaN }], ['infinite chain', { ...context, chainId: Infinity }],
  ['text chain', { ...context, chainId: '31337' }],
  ['zero genesis', { ...context, genesisHash: '0x' + '00'.repeat(32) }],
  ['short genesis', { ...context, genesisHash: '0x1234' }],
  ['nonhex genesis', { ...context, genesisHash: '0x' + 'zz'.repeat(32) }],
  ['genesis newline', { ...context, genesisHash: context.genesisHash + '\n' }],
  ['zero router', { ...context, router: ZeroAddress }], ['zero relayer', { ...context, relayer: ZeroAddress }],
  ['invalid router', { ...context, router: 'private-router-sentinel' }],
  ['short relayer', { ...context, relayer: '0x1234' }],
  ['bad checksum', { ...context, router: '0x52908400098527886e0F7030069857D2E4169EE7' }]
] as const) {
  test('invalid caller context (' + description + ') fails with a fixed error before creating metadata', () => {
    rejects(store.db, input, messages.input);
    assert.equal(exists(store.db), false);
    assert.deepEqual(records(store.db), { payments: [], journals: [], audit: [] });
  });
}

for (const property of ['rpcUrl', 'apiKey', 'privateKey', 'version', 'source']) {
  test('caller-supplied ' + property + ' is rejected rather than persisted or echoed', () => {
    rejects(store.db, { ...context, [property]: 'private-input-sentinel' }, messages.input);
    assert.equal(exists(store.db), false);
  });
}

for (const status of ['queued', 'broadcast', 'settled', 'failed', 'review'] as const) {
  test('an unbound legacy ' + status + ' payment rejects adoption atomically', () => {
    seed(status);
    store.db.exec('DELETE FROM audit');
    const before = records(store.db);
    rejects(store.db, context, messages.legacy);
    assert.equal(exists(store.db), false, 'Refused legacy adoption must roll back context DDL');
    assert.deepEqual(records(store.db), before);
  });
}

test('journal-only legacy records reject adoption even when payments and audit are empty', () => {
  seed('settled');
  store.db.exec('PRAGMA foreign_keys=OFF; DELETE FROM payments; DELETE FROM audit');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM journals').get()!.count, 1);
  const before = records(store.db);
  rejects(store.db, context, messages.legacy);
  assert.equal(exists(store.db), false);
  assert.deepEqual(records(store.db), before);
});

test('audit-only legacy records reject adoption without silently attaching a deployment', () => {
  store.audit('legacy-reference', 'legacy-only', 'Synthetic historical record');
  const before = records(store.db);
  rejects(store.db, context, messages.legacy);
  assert.equal(exists(store.db), false);
  assert.deepEqual(records(store.db), before);
});

for (const [description, overrides] of [
  ['unsupported version', { version: 2n }], ['wrong singleton', { singleton: 2n }],
  ['missing version', { version: null }], ['text version', { version: '1' }],
  ['negative chain', { chain_id: -1n }], ['zero chain', { chain_id: 0n }],
  ['fractional chain', { chain_id: 31337.5 }], ['text chain', { chain_id: '31337' }],
  ['unsafe exact integer', { chain_id: 9007199254740993n }],
  ['uppercase genesis', { genesis_hash: '0x' + 'AB'.repeat(32) }],
  ['zero genesis', { genesis_hash: '0x' + '00'.repeat(32) }],
  ['short genesis', { genesis_hash: '0x1234' }], ['null genesis', { genesis_hash: null }],
  ['noncanonical router', { router: context.router.toLowerCase() }],
  ['invalid router', { router: 'private-router-sentinel' }],
  ['zero relayer', { relayer: ZeroAddress }], ['noncanonical relayer', { relayer: context.relayer.toLowerCase() }]
] as const) {
  test('malformed stored context (' + description + ') rejects without normalization or repair', () => {
    looseTable(store.db, [stored(overrides)]);
    const before = rows(store.db), changes = totalChanges(store.db);
    rejects(store.db, context, messages.stored);
    assert.deepEqual(rows(store.db), before);
    assert.equal(totalChanges(store.db), changes);
  });
}

test('a valid-looking context cannot hide additional stored rows', () => {
  looseTable(store.db, [stored(), stored({ singleton: 2n, genesis_hash: 'private-row-sentinel' })]);
  const before = rows(store.db);
  rejects(store.db, context, messages.stored);
  assert.deepEqual(rows(store.db), before);
});

test('a structurally broken context table fails closed rather than replacing its contents', () => {
  store.db.exec("CREATE TABLE deployment_context(private_field TEXT); INSERT INTO deployment_context VALUES('private-table-sentinel')");
  const before = store.db.prepare('SELECT * FROM deployment_context').all();
  rejects(store.db, context, messages.generic);
  assert.deepEqual(store.db.prepare('SELECT * FROM deployment_context').all(), before);
});

test('failure to begin binding does not roll back the caller transaction', () => {
  store.db.exec('BEGIN IMMEDIATE');
  store.audit('caller-owned', 'inside-caller-transaction', 'Caller must retain rollback ownership');
  rejects(store.db, context, messages.generic);
  assert.equal(store.db.isTransaction, true);
  assert.equal(store.events().length, 1);
  assert.equal(exists(store.db), false);
  store.db.exec('ROLLBACK');
  assert.equal(store.events().length, 0);
  bindDatabaseContext(store.db, context);
  assert.equal(rows(store.db).length, 1);
});

test('an insert trigger failure rolls back all partial binding changes and keeps the original table', () => {
  bindDatabaseContext(store.db, context);
  store.db.exec(`DELETE FROM deployment_context;
    CREATE TRIGGER reject_context_insert BEFORE INSERT ON deployment_context
    BEGIN SELECT RAISE(ABORT,'private-trigger-sentinel'); END;`);
  const before = records(store.db);
  rejects(store.db, context, messages.generic);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(rows(store.db), []);
  assert.deepEqual(records(store.db), before);
  store.db.exec('DROP TRIGGER reject_context_insert');
  bindDatabaseContext(store.db, context);
  assert.equal(rows(store.db).length, 1);
});

test('an empty table coercing context integers to text cannot commit a partial binding', () => {
  store.db.exec(`CREATE TABLE deployment_context(singleton TEXT,version TEXT,chain_id TEXT,
    genesis_hash TEXT,router TEXT,relayer TEXT)`);
  rejects(store.db, context, messages.stored);
  assert.equal(store.db.isTransaction, false);
  assert.equal(exists(store.db), true, 'The preexisting table must remain for separate review');
  assert.deepEqual(rows(store.db), []);
  assert.deepEqual(records(store.db), { payments: [], journals: [], audit: [] });
  rejects(store.db, context, messages.stored);
  assert.deepEqual(rows(store.db), []);
});

test('an AFTER INSERT trigger changing a valid identity is detected before commit', () => {
  bindDatabaseContext(store.db, context);
  store.db.exec(`DELETE FROM deployment_context;
    CREATE TRIGGER change_context_identity AFTER INSERT ON deployment_context
    BEGIN UPDATE deployment_context SET genesis_hash='${'0x' + '56'.repeat(32)}'; END;`);
  rejects(store.db, context, messages.mismatch);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(rows(store.db), []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='change_context_identity'").get()!.count, 1);
  rejects(store.db, context, messages.mismatch);
  assert.deepEqual(rows(store.db), []);
  assert.deepEqual(records(store.db), { payments: [], journals: [], audit: [] });
});

test('an AFTER INSERT trigger creating another context row rolls back both inserted rows', () => {
  store.db.exec(`CREATE TABLE deployment_context(singleton INTEGER,version INTEGER,chain_id INTEGER,
    genesis_hash TEXT,router TEXT,relayer TEXT);
    CREATE TRIGGER duplicate_context_row AFTER INSERT ON deployment_context WHEN NEW.singleton=1
    BEGIN INSERT INTO deployment_context VALUES(2,NEW.version,NEW.chain_id,NEW.genesis_hash,NEW.router,NEW.relayer); END;`);
  rejects(store.db, context, messages.stored);
  assert.equal(store.db.isTransaction, false);
  assert.deepEqual(rows(store.db), []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name='duplicate_context_row'").get()!.count, 1);
  assert.deepEqual(records(store.db), { payments: [], journals: [], audit: [] });
});

test('deployment context survives a file-backed SQLite close and reopen', () => {
  const dataRoot = resolve('data');
  mkdirSync(dataRoot, { recursive: true });
  const directory = mkdtempSync(join(dataRoot, 'database-context-test-'));
  const path = join(directory, 'context.sqlite');
  let fileStore: Store | undefined;
  try {
    fileStore = new Store(path);
    bindDatabaseContext(fileStore.db, context);
    const before = rows(fileStore.db);
    fileStore.close(); fileStore = undefined;
    fileStore = new Store(path);
    assert.deepEqual(rows(fileStore.db), before);
    bindDatabaseContext(fileStore.db, context);
    rejects(fileStore.db, { ...context, chainId: 1 }, messages.mismatch);
    assert.deepEqual(rows(fileStore.db), before);
  } finally {
    fileStore?.close();
    assert.equal(dirname(resolve(directory)), dataRoot);
    assert.ok(directory.startsWith(join(dataRoot, 'database-context-test-')));
    rmSync(directory, { recursive: true, force: true });
  }
});
