import { readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, parseUnits } from 'ethers';
import { deploy } from '../src/chain.ts';
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545', undefined, { cacheTimeout: -1 });
if ((await provider.getNetwork()).chainId !== 20261024n) throw new Error('Expected generated ClearLedger development chain');
const admin = new Wallet(readFileSync('network/generated/deployer.key', 'utf8').trim(), provider);
const relayer = new Wallet(Wallet.createRandom().privateKey, provider);
const payer = new Wallet(Wallet.createRandom().privateKey, provider);
const payee = new Wallet(Wallet.createRandom().privateKey, provider);
for (const account of [relayer, payer, payee]) {
  await (await admin.sendTransaction({ to: account.address, value: parseUnits('10', 18) })).wait();
}
const { token, router } = await deploy(provider, admin, relayer, payer, payee);
writeFileSync('network/generated/deployment.json', JSON.stringify({
  chainId: 20261024, token: await token.getAddress(), router: await router.getAddress(),
  relayer: relayer.address, payer: payer.address, payee: payee.address,
  relayerPrivateKey: relayer.privateKey, payerPrivateKey: payer.privateKey, payeePrivateKey: payee.privateKey
}, null, 2), { mode: 0o600 });
console.log('Contracts deployed. Local test credentials are in ignored network/generated/deployment.json.');
provider.destroy();


