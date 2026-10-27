import { mkdirSync } from 'node:fs';
import { Wallet } from 'ethers';
import { connectRouter } from './chain.ts';
import { Store } from './store.ts';
import { PaymentService } from './service.ts';
import { makeServer } from './http.ts';
import { createRpcProvider } from './rpc.ts';
import { createShutdown, startWorker } from './lifecycle.ts';
import { parseAssetMetadata } from './assets.ts';
import { bindDatabaseContext } from './database-context.ts';
import { acquireDatabaseOwnership } from './database-ownership.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('Set environment variable ' + name);
  return value;
}
const assetMetadata = parseAssetMetadata(process.env.ASSET_METADATA);
const provider = createRpcProvider(required('RPC_URL'), Number(process.env.RPC_TIMEOUT_MS ?? '5000'));
const network = await provider.getNetwork();
const chainId = Number(required('CHAIN_ID'));
if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid chain ID');
if (network.chainId !== BigInt(chainId)) throw new Error('Chain ID mismatch');
const relayer = new Wallet(required('RELAYER_PRIVATE_KEY'), provider);
const address = required('ROUTER_ADDRESS');
if (await provider.getCode(address) === '0x') throw new Error('Router contract is missing');
const router = connectRouter(address, relayer);
if (!await router.hasRole(await router.SETTLER_ROLE(), relayer.address)) throw new Error('Relayer lacks settlement role');
const apiKey = required('API_KEY');
if (apiKey.length < 32) throw new Error('API_KEY must have at least 32 characters');
const genesis = await provider.getBlock(0).catch(() => {
  provider.destroy();
  throw new Error('Could not verify chain genesis');
});
if (!genesis || genesis.number !== 0 || !genesis.hash) {
  provider.destroy();
  throw new Error('Could not verify chain genesis');
}
mkdirSync('data', { recursive: true });
const ownership = (() => {
  try { return acquireDatabaseOwnership(process.env.DB_PATH ?? 'data/clearledger.sqlite'); }
  catch (error) { provider.destroy(); throw error; }
})();
const store = (() => {
  let opened: Store | undefined;
  try {
    opened = new Store(ownership.databasePath);
    bindDatabaseContext(opened.db, { chainId, genesisHash: genesis.hash, router: address, relayer: relayer.address });
    return opened;
  } catch (error) {
    provider.destroy();
    // Release only after the financial connection is known to be closed. If
    // its constructor/close fails, retain ownership until this process exits.
    if (opened) { opened.close(); ownership.release(); }
    throw error;
  }
})();
const service = new PaymentService(store, provider, relayer, router, chainId, address, Number(process.env.CONFIRMATIONS ?? '2'));
const port = Number(process.env.PORT ?? '4317');
const server = makeServer({ service, apiKey, port, mode: 'rpc', assetMetadata });
server.listen(port, '127.0.0.1', () => {
  const boundPort = (server.address() as { port: number }).port;
  console.log('ClearLedger RPC mode: http://127.0.0.1:' + boundPort);
});
const worker = startWorker(() => service.tick(), { onError: () => console.error('Worker waiting for RPC recovery') });
const shutdown = createShutdown({
  stopWorker: () => worker.stop(),
  drainRequests: () => server.drainRequests(),
  closeServer: () => new Promise<void>((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeIdleConnections();
  }),
  closeResources: () => { provider.destroy(); store.close(); ownership.release(); }
});
let shuttingDown = false;
function onSignal() {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdown().then(result => {
    if (result === 'closed') process.exitCode = 0;
    else {
      console.error('ClearLedger shutdown could not finish safely; inspect durable state on restart');
      process.exit(1);
    }
  });
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

