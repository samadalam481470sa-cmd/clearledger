import solc from 'solc';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function compile() {
  const sources = Object.fromEntries(readdirSync('contracts').filter(f => f.endsWith('.sol'))
    .map(f => [f, { content: readFileSync(resolve('contracts', f), 'utf8') }]));
  const result = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
  }), { import: (path: string) => {
    if (!path.startsWith('@openzeppelin/contracts/') || path.includes('..'))
      return { error: 'Import outside approved dependency' };
    try { return { contents: readFileSync(resolve('node_modules', path), 'utf8') }; }
    catch { return { error: 'Import not found: ' + path }; }
  } }));
  const errors = (result.errors ?? []).filter((e: any) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e: any) => e.formattedMessage).join('\n'));
  mkdirSync('artifacts', { recursive: true });
  for (const name of ['DemoUSD', 'SettlementRouter']) {
    const item = result.contracts[name + '.sol'][name];
    writeFileSync('artifacts/' + name + '.json', JSON.stringify({
      contractName: name, compiler: solc.version(), abi: item.abi,
      bytecode: '0x' + item.evm.bytecode.object
    }, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  compile();
  console.log('Compiled DemoUSD and SettlementRouter (Solidity 0.8.30, Paris EVM).');
}

