import { acquireDatabaseOwnership, DatabaseOwnershipError } from '../../src/database-ownership.ts';

type Command = { type: 'acquire'; path: string } | { type: 'release' };
let ownership: ReturnType<typeof acquireDatabaseOwnership> | undefined;
function finish(message: Record<string, unknown>, code: number) {
  process.send?.(message, undefined, undefined, () => { process.exitCode = code; process.disconnect(); });
}
process.once('disconnect', () => {
  try { ownership?.release(); } catch { process.exitCode = 1; }
});
process.on('message', (command: Command) => {
  try {
    if (command.type === 'acquire') {
      if (ownership) throw new Error('Ownership fixture already initialized');
      ownership = acquireDatabaseOwnership(command.path);
      process.send?.({ type: 'acquired', databasePath: ownership.databasePath, sidecarPath: ownership.sidecarPath });
    } else {
      ownership?.release(); ownership = undefined;
      finish({ type: 'released' }, 0);
    }
  } catch (error) {
    finish({ type: 'refused', message: error instanceof DatabaseOwnershipError ? error.message : 'Ownership fixture operation failed' }, 1);
  }
});
