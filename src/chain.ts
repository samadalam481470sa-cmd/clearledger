import { readFileSync } from 'node:fs';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, parseUnits } from 'ethers';

export function artifact(name: string) {
  return JSON.parse(readFileSync('artifacts/' + name + '.json', 'utf8'));
}
export async function deploy(provider: JsonRpcProvider, admin: Wallet, relayer: Wallet, payer: Wallet, payee: Wallet) {
  const usd = artifact('DemoUSD'), settlement = artifact('SettlementRouter');
  const token: any = await new ContractFactory(usd.abi, usd.bytecode, admin)
    .deploy(admin.address, parseUnits('10000000', 6));
  await token.waitForDeployment();
  const router: any = await new ContractFactory(settlement.abi, settlement.bytecode, admin)
    .deploy(admin.address, relayer.address);
  await router.waitForDeployment();
  for (const account of [payer, payee]) await (await token.setAllowed(account.address, true)).wait();
  await (await token.mint(payer.address, parseUnits('100000', 6))).wait();
  await (await router.setPolicy(await token.getAddress(), parseUnits('10000', 6), parseUnits('25000', 6))).wait();
  await (await token.connect(payer).approve(await router.getAddress(), parseUnits('100000', 6))).wait();
  return { token, router };
}

export function connectRouter(address: string, signer: Wallet): any {
  return new Contract(address, artifact('SettlementRouter').abi, signer);
}

