import { DatabaseSync } from 'node:sqlite';
import { createShutdown, startWorker, type WorkerHandle } from '../../src/lifecycle.ts';

type Command = { type: 'start'; db: string } | { type: 'status' } | { type: 'release' };
let db: DatabaseSync | undefined;
let worker: WorkerHandle | undefined;
let release!: () => void;
let pending = false;
let resourcesClosed = false;
let shuttingDown = false;
process.once('disconnect', () => process.exit(1));

process.on('message', (command: Command) => {
  if (command.type === 'status') {
    process.send?.({ type: 'state', pending, resourcesClosed });
    return;
  }
  if (command.type === 'release') { release(); return; }
  if (db) throw new Error('Fixture already initialized');
  db = new DatabaseSync(command.db);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    CREATE TABLE signal_audit(action TEXT NOT NULL);
    CREATE TABLE signal_resources(closes INTEGER NOT NULL);
    INSERT INTO signal_resources VALUES(0);
  `);
  const gate = new Promise<void>(resolve => { release = resolve; });
  worker = startWorker(async () => {
    pending = true;
    await gate;
    db!.prepare('INSERT INTO signal_audit(action) VALUES(?)').run('tick-complete');
    pending = false;
  }, { intervalMs: 1000 });
  const shutdown = createShutdown({
    stopWorker: () => {
      process.send?.({ type: 'stop-started' });
      return worker!.stop();
    },
    drainRequests: async () => {},
    closeServer: async () => {},
    closeResources: () => {
      db!.exec('UPDATE signal_resources SET closes=closes+1');
      db!.close();
      db = undefined;
      resourcesClosed = true;
      process.send?.({ type: 'resources-closed' });
    },
    timeoutMs: 5000
  });
  const handleSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().then(result => {
      process.send?.({ type: 'shutdown-result', result }, undefined, undefined,
        () => process.exit(result === 'closed' ? 0 : 1));
    });
  };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);
  process.send?.({ type: 'ready' });
});
