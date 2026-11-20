import { Wallet } from 'ethers';
import { createRpcProvider } from '../../src/rpc.ts';
import { connectRouter } from '../../src/chain.ts';
import { Store } from '../../src/store.ts';
import { PaymentService } from '../../src/service.ts';

type Start = { type: 'start'; db: string; rpc: string; key: string; router: string;
  chainId?: number; confirmations?: number };
type Command = Start | { type: 'tick'; id: number; paymentId?: string } | { type: 'shutdown'; id: number };

// Test-only worker. Parent drives sequential ticks over IPC; no interval can be
// orphaned. The ephemeral signing key is never in argv, a fixture, or a log.
let provider: ReturnType<typeof createRpcProvider> | undefined;
let store: Store | undefined;
let service: PaymentService | undefined;
let busy = false;
let ticks = 0;

function cleanup() {
  provider?.destroy(); provider = undefined;
  store?.close(); store = undefined;
}
process.once('disconnect', () => { cleanup(); process.exit(0); });
process.on('message', async (command: Command) => {
  if (busy) { process.send?.({ type: 'fatal', reason: 'Concurrent worker command rejected' }); return; }
  busy = true;
  try {
    if (command.type === 'start') {
      if (service) throw new Error('Worker already initialized');
      const chainId = command.chainId ?? 31337, confirmations = command.confirmations ?? 1;
      if (!Number.isSafeInteger(chainId) || chainId < 1 ||
        !Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('Invalid worker settings');
      provider = createRpcProvider(command.rpc, 3000);
      if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw new Error('Unexpected test chain');
      const relayer = new Wallet(command.key, provider);
      store = new Store(command.db);
      service = new PaymentService(store, provider, relayer, connectRouter(command.router, relayer), chainId, command.router, confirmations);
      process.send?.({ type: 'ready' });
    } else if (command.type === 'tick') {
      if (!service || !store) throw new Error('Worker not initialized');
      await service.tick();
      const snapshot = command.paymentId === undefined ? undefined : (() => {
        const row = store!.get(command.paymentId!);
        if (!row) throw new Error('Requested worker record is unavailable');
        const rows = (sql: string) => store!.db.prepare(sql).all().map(item => ({ ...item }));
        return { row, payments: rows('SELECT * FROM payments ORDER BY rowid'),
          journals: rows('SELECT * FROM journals ORDER BY rowid'),
          audit: rows('SELECT * FROM audit ORDER BY sequence'),
          sequence: rows('SELECT * FROM sqlite_sequence ORDER BY name') };
      })();
      process.send?.({ type: 'tick', id: command.id, ticks: ++ticks, ...(snapshot ? { snapshot } : {}) });
    } else {
      cleanup();
      process.send?.({ type: 'shutdown', id: command.id }, undefined, undefined, () => process.exit(0));
    }
  } catch {
    // An ethers error can include transaction data. Send only a fixed diagnostic.
    process.send?.({ type: 'fatal', reason: 'Outage test worker command failed' });
    cleanup();
    process.exitCode = 1;
    process.disconnect();
  } finally { busy = false; }
});
