import { getBytes, hexlify, isHexString, keccak256, type Log } from 'ethers';

export function computeReceiptLogsBloom(logs: readonly Pick<Log, 'address' | 'topics'>[]): string | undefined {
  const bloom = new Uint8Array(256);
  for (const log of logs) {
    // EVM LOG0 through LOG4 permit at most four topics per log.
    if (!isHexString(log?.address, 20) || !Array.isArray(log.topics) || log.topics.length > 4) return;
    for (const topic of log.topics) if (!isHexString(topic, 32)) return;

    // Ethereum's receipt bloom hashes each emitter and topic into three bit positions.
    for (const value of [log.address, ...log.topics]) {
      const digest = getBytes(keccak256(value));
      for (let offset = 0; offset < 6; offset += 2) {
        const bit = ((digest[offset] << 8) | digest[offset + 1]) & 0x7ff;
        bloom[bloom.length - 1 - (bit >> 3)] |= 1 << (bit & 7);
      }
    }
  }
  return hexlify(bloom);
}
