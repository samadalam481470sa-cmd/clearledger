import { mkdirSync } from 'node:fs';
import { Wallet } from 'ethers';
import { connectRouter } from './chain.ts';
import { Store } from './store.ts';
import { PaymentService } from './service.ts';
import { makeServer } from './http.ts';
import { createRpcProvider } from './rpc.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error('Set environment variable ' + name);
  return value;
}
const provider = createRpcProvider(required('RPC_URL'), Number(process.env.RPC_TIMEOUT_MS ?? '5000'));
const network = await provider.getNetwork();
const chainId = Number(required('CHAIN_ID'));
if (network.chainId !== BigInt(chainId)) throw new Error('Chain ID mismatch');
const relayer = new Wallet(required('RELAYER_PRIVATE_KEY'), provider);
const address = required('ROUTER_ADDRESS');
if (await provider.getCode(address) === '0x') throw new Error('Router contract is missing');
const router = connectRouter(address, relayer);
if (!await router.hasRole(await router.SETTLER_ROLE(), relayer.address)) throw new Error('Relayer lacks settlement role');
const apiKey = required('API_KEY');
if (apiKey.length < 32) throw new Error('API_KEY must have at least 32 characters');
mkdirSync('data', { recursive: true });
const store = new Store(process.env.DB_PATH ?? 'data/clearledger.sqlite');
const service = new PaymentService(store, provider, relayer, router, chainId, address, Number(process.env.CONFIRMATIONS ?? '2'));
const port = Number(process.env.PORT ?? '4317');
const server = makeServer({ service, apiKey, port, mode: 'rpc' });
server.listen(port, '127.0.0.1', () => console.log('ClearLedger RPC mode: http://127.0.0.1:' + port));
const timer = setInterval(() => void service.tick().catch(() => console.error('Worker waiting for RPC recovery')), 1000);
process.on('SIGINT', () => { clearInterval(timer); server.close(); provider.destroy(); store.close(); process.exit(0); });

