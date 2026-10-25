import { Wallet } from 'ethers';
import { createRpcProvider } from '../../src/rpc.ts';
import { connectRouter } from '../../src/chain.ts';
import { Store } from '../../src/store.ts';
import { PaymentService } from '../../src/service.ts';

type Start = { type: 'start'; db: string; rpc: string; key: string; router: string };
type Command = Start | { type: 'tick' | 'shutdown'; id: number };

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
      provider = createRpcProvider(command.rpc, 3000);
      if ((await provider.getNetwork()).chainId !== 31337n) throw new Error('Unexpected test chain');
      const relayer = new Wallet(command.key, provider);
      store = new Store(command.db);
      service = new PaymentService(store, provider, relayer, connectRouter(command.router, relayer), 31337, command.router);
      process.send?.({ type: 'ready' });
    } else if (command.type === 'tick') {
      if (!service) throw new Error('Worker not initialized');
      await service.tick();
      process.send?.({ type: 'tick', id: command.id, ticks: ++ticks });
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
