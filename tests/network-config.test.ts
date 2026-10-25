import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeRlp, Wallet, SigningKey } from 'ethers';
import { generateNetwork } from '../scripts/network.ts';

const data = resolve('data');
let directory: string;
beforeEach(() => {
  mkdirSync(data, { recursive: true });
  directory = mkdtempSync(join(data, 'network-config-test-'));
});
afterEach(() => {
  assert.equal(dirname(resolve(directory)), data);
  assert.ok(directory.startsWith(join(data, 'network-config-test-')));
  rmSync(directory, { recursive: true, force: true });
});

test('generated QBFT membership, node keys and permission files agree', () => {
  const target = join(directory, 'generated');
  const addresses = generateNetwork(target);
  assert.equal(new Set(addresses.validators).size, 4);
  const genesis = JSON.parse(readFileSync(join(target, 'genesis.json'), 'utf8'));
  assert.equal(genesis.config.chainId, 20261024);
  const fields = decodeRlp(genesis.extraData) as string[];
  assert.equal(fields.length, 5);
  assert.equal(fields[0].length, 66);
  assert.deepEqual(fields[1], addresses.validators.map(v => v.toLowerCase()));
  assert.equal(fields[3], '0x', 'Besu requires minimally encoded integer zero');
  const enodes: string[] = [];
  for (let i = 0; i < 4; i++) {
    const node = join(target, 'validator' + (i + 1));
    assert.deepEqual(JSON.parse(readFileSync(join(node, 'genesis.json'), 'utf8')), genesis);
    const key = '0x' + readFileSync(join(node, 'key'), 'utf8');
    assert.equal(new Wallet(key).address, addresses.validators[i]);
    enodes.push('enode://' + SigningKey.computePublicKey(key, false).slice(4) + '@172.28.77.' + (11 + i) + ':30303');
  }
  for (let i = 0; i < 4; i++) {
    const node = join(target, 'validator' + (i + 1));
    const permissions = readFileSync(join(node, 'permissions_config.toml'), 'utf8');
    const match = /^nodes-allowlist=(\[.*\])\n$/.exec(permissions);
    assert.ok(match, 'Permission file must be one valid TOML array setting with a real newline');
    assert.deepEqual(JSON.parse(match[1]), enodes);
    const peers = JSON.parse(readFileSync(join(node, 'static-nodes.json'), 'utf8'));
    assert.deepEqual(peers, enodes.filter((_, j) => i !== j));
  }
  const deployer = new Wallet(readFileSync(join(target, 'deployer.key'), 'utf8'));
  assert.equal(deployer.address, addresses.deployer);
  assert.ok(BigInt(genesis.alloc[deployer.address.toLowerCase().slice(2)].balance) > 0n);
});

test('regeneration refuses to replace existing validator and deployment identities', () => {
  const target = join(directory, 'generated');
  generateNetwork(target);
  const hash = (name: string) => createHash('sha256').update(readFileSync(join(target, name))).digest('hex');
  const names = ['deployer.key', 'genesis.json', ...Array.from({ length: 4 }, (_, i) => 'validator' + (i + 1) + '/key')];
  const before = names.map(hash);
  assert.throws(() => generateNetwork(target), /refusing to replace validator keys/);
  assert.deepEqual(names.map(hash), before);
});
