import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import solc from 'solc';

// Compile the adversarial test wallet in memory. Production artifacts exclude it.
export function compileTestWallet(): { abi: any; bytecode: string } {
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'ContractWallet.sol': { content: readFileSync('tests/fixtures/ContractWallet.sol', 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  }), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..')) return { error: 'Unapproved fixture import' };
    try { return { contents: readFileSync(resolve('node_modules', path), 'utf8') }; }
    catch { return { error: 'Fixture import not found' }; }
  } }));
  const errors = (result.errors ?? []).filter((error: any) => error.severity === 'error');
  if (errors.length) throw new Error(errors.map((error: any) => error.formattedMessage).join('\n'));
  const item = result.contracts['ContractWallet.sol'].ContractWallet;
  return { abi: item.abi, bytecode: '0x' + item.evm.bytecode.object };
}
