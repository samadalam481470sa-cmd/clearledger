import ganache from 'ganache';
import memdown from 'memdown';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { deploy } from '../src/chain.ts';

export async function localChain() {
  const secrets = Array.from({ length: 4 }, () => Wallet.createRandom().privateKey);
  const chain = ganache.server({
    database: { db: memdown() },
    chain: { chainId: 31337, hardfork: 'shanghai' },
    wallet: { accounts: secrets.map(secretKey => ({ secretKey, balance: '0x' + parseEther('1000').toString(16) })) },
    logging: { quiet: true }, miner: { instamine: 'eager' }
  });
  await chain.listen(0, '127.0.0.1');
  const port = (chain.address() as any).port;
  const provider = new JsonRpcProvider('http://127.0.0.1:' + port, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  const [admin, relayer, payer, payee] = secrets.map(k => new Wallet(k, provider));
  const { token, router } = await deploy(provider, admin, relayer, payer, payee);
  return { chain, provider, admin, relayer, payer, payee, token, router,
    close: async () => { provider.destroy(); await chain.close(); } };
}


