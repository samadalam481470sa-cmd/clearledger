import { JsonRpcProvider, Wallet } from 'ethers';
import { Store } from '../../src/store.ts';
import { PaymentService } from '../../src/service.ts';
import { connectRouter } from '../../src/chain.ts';

// Test-only worker. Ephemeral signing keys arrive by IPC, never command-line
// arguments or fixture files. The parent terminates this process without cleanup.
type Input = {
  db: string; rpc: string; key: string; router: string;
  phase: 'before-broadcast' | 'after-broadcast' | 'after-finalize' | 'inside-transaction';
  paymentId: string;
};
class Checkpoint extends Error {}
function checkpoint() { process.send?.({ checkpoint: true }); }
process.once('message', async (input: Input) => {
  const provider = new JsonRpcProvider(input.rpc, undefined, { cacheTimeout: -1 });
  const relayer = new Wallet(input.key, provider);
  class InterruptedStore extends Store {
    override broadcast(id: string, raw: string, hash: string) {
      super.broadcast(id, raw, hash);
      if (input.phase === 'before-broadcast') throw new Checkpoint();
    }
  }
  const store = new InterruptedStore(input.db);
  try {
    if (input.phase === 'inside-transaction') {
      store.db.exec('BEGIN IMMEDIATE');
      store.db.prepare("UPDATE payments SET status='failed',error='uncommitted' WHERE id=?").run(input.paymentId);
      store.audit(input.paymentId, 'uncommitted', 'Must roll back after termination');
      checkpoint();
    } else {
      if (input.phase === 'after-broadcast') {
        const broadcast = provider.broadcastTransaction.bind(provider);
        provider.broadcastTransaction = async raw => {
          const sent = await broadcast(raw);
          await sent.wait();
          checkpoint();
          // Parent kills us before any confirmation/journal write can execute.
          return await new Promise<never>(() => {});
        };
      }
      const router = connectRouter(input.router, relayer);
      const service = new PaymentService(store, provider, relayer, router, 31337, input.router);
      try { await service.tick(); }
      catch (e) { if (!(e instanceof Checkpoint)) throw e; }
      if (input.phase !== 'after-broadcast') checkpoint();
    }
    setInterval(() => {}, 1000);
  } catch (e: any) {
    process.send?.({ error: e.shortMessage ?? e.message ?? 'Worker failed' });
    process.exitCode = 1;
    provider.destroy();
    store.close();
    process.disconnect();
  }
});
