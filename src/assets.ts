import { getAddress, isAddress, ZeroAddress } from 'ethers';
import { z } from 'zod';
import { ASSET_SYMBOL_PATTERN, MAX_ASSET_METADATA, type AssetMetadata } from '../shared/asset-metadata.ts';

const metadataSchema = z.object({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  token: z.string().refine(isAddress).transform(getAddress).refine(address => address !== ZeroAddress),
  symbol: z.string().regex(ASSET_SYMBOL_PATTERN),
  decimals: z.number().int().min(0).max(255)
}).strict();
const registrySchema = z.array(metadataSchema).max(MAX_ASSET_METADATA);

function configuredEntries(input: unknown): AssetMetadata[] {
  const entries = registrySchema.parse(input);
  const keys = entries.map(entry => entry.chainId + ':' + entry.token.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new Error('Duplicate asset');
  return entries.map(entry => ({ ...entry, source: 'configured' }));
}

export function parseAssetMetadata(json: string | undefined): AssetMetadata[] {
  if (json === undefined) return [];
  try { return configuredEntries(JSON.parse(json)); }
  catch { throw new Error('Invalid ASSET_METADATA configuration'); }
}

export function activeAssetMetadata(entries: AssetMetadata[], chainId: number, demoToken?: string): AssetMetadata[] {
  try {
    if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid chain');
    // Revalidate embedding callers as well as environment configuration. Only
    // the server creates demo descriptors; callers cannot assert that source.
    const configured = configuredEntries(entries.map(({ source, ...entry }) => {
      if (source !== 'configured') throw new Error('Invalid source');
      return entry;
    }));
    const active = configured.filter(entry => entry.chainId === chainId);
    if (demoToken !== undefined) {
      const demo = metadataSchema.parse({ chainId, token: demoToken, symbol: 'dUSD', decimals: 6 });
      if (active.some(entry => entry.token.toLowerCase() === demo.token.toLowerCase())) throw new Error('Demo collision');
      active.unshift({ ...demo, source: 'demo' });
    }
    if (active.length > MAX_ASSET_METADATA) throw new Error('Registry exceeds limit');
    return active;
  } catch { throw new Error('Invalid asset metadata for this server'); }
}
