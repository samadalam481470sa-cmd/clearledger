export const MAX_ASSET_METADATA = 100;
// Require the actual end of input; JavaScript's $ alone permits a final newline.
export const ASSET_SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,15}(?![\s\S])/;

export interface AssetMetadata {
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  source: 'configured' | 'demo';
}
