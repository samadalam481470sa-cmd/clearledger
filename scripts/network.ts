import { Wallet, encodeRlp, SigningKey } from 'ethers';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function generateNetwork(root = resolve('network/generated')) {
  if (existsSync(root)) throw new Error('network/generated already exists; refusing to replace validator keys');
  mkdirSync(root, { recursive: true });
  const validators = Array.from({ length: 4 }, () => Wallet.createRandom());
  const deployer = Wallet.createRandom();
  // Besu reads this round as an RLP integer: zero must use the minimal encoding.
  const extraData = encodeRlp([
    '0x' + '00'.repeat(32), validators.map(v => v.address.toLowerCase()), [], '0x', []
  ]);
  const genesis = {
    config: { chainId: 20261024, berlinBlock: 0, londonBlock: 0, zeroBaseFee: true,
      qbft: { blockperiodseconds: 2, epochlength: 30000, requesttimeoutseconds: 4 } },
    nonce: '0x0', timestamp: '0x0', extraData, gasLimit: '0x1c9c380',
    difficulty: '0x1', mixHash: '0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365',
    coinbase: '0x0000000000000000000000000000000000000000',
    alloc: { [deployer.address.toLowerCase().slice(2)]: { balance: '0x3635c9adc5dea00000' } }
  };
  const serialized = JSON.stringify(genesis, null, 2);
  writeFileSync(root + '/genesis.json', serialized);
  writeFileSync(root + '/deployer.key', deployer.privateKey, { mode: 0o600 });
  const enodes = validators.map((v, i) =>
    'enode://' + SigningKey.computePublicKey(v.privateKey, false).slice(4) + '@172.28.77.' + (11 + i) + ':30303');
  for (let i = 0; i < 4; i++) {
    const node = root + '/validator' + (i + 1);
    mkdirSync(node, { recursive: true });
    mkdirSync(node + '/data', { recursive: true });
    // One read-only config mount per node; no nested file mount inside a read-only directory.
    writeFileSync(node + '/genesis.json', serialized);
    writeFileSync(node + '/key', validators[i].privateKey.slice(2), { mode: 0o600 });
    writeFileSync(node + '/static-nodes.json', JSON.stringify(enodes.filter((_, j) => j !== i), null, 2));
    writeFileSync(node + '/permissions_config.toml', 'nodes-allowlist=' + JSON.stringify(enodes) + '\n');
  }
  const addresses = { chainId: 20261024, deployer: deployer.address, validators: validators.map(v => v.address) };
  writeFileSync(root + '/addresses.json', JSON.stringify(addresses, null, 2));
  return addresses;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateNetwork();
  console.log('Generated four validator identities in network/generated. Keys are ignored by Git.');
}

