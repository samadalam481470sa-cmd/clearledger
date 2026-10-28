import { type AssetTotal } from './dashboard.ts';

export const TOTALS_INTEGRITY_ERROR = 'Stored journal data is invalid; totals are unavailable';
export type TotalsReport = { assets: AssetTotal[]; integrityError?: never } |
  { assets: null; integrityError: typeof TOTALS_INTEGRITY_ERROR };
export interface TotalsState {
  assets: AssetTotal[] | null;
  integrityError: typeof TOTALS_INTEGRITY_ERROR | '';
  transportError: string;
}
type TotalsEvent = { type: 'report'; report: TotalsReport } |
  { type: 'transport-error'; error: unknown } | { type: 'reset' };

export function emptyTotals(): TotalsState { return { assets: null, integrityError: '', transportError: '' }; }

/** Known corruption invalidates cached numbers until a valid report replaces it. */
export function reduceTotals(state: TotalsState, event: TotalsEvent): TotalsState {
  if (event.type === 'reset') return emptyTotals();
  if (event.type === 'transport-error') return { ...state,
    transportError: event.error instanceof Error ? event.error.message : 'Unable to load asset volumes' };
  if (event.report.assets === null)
    return { assets: null, integrityError: TOTALS_INTEGRITY_ERROR, transportError: '' };
  return { assets: event.report.assets, integrityError: '', transportError: '' };
}

export function totalsCounts(state: TotalsState) {
  return { assets: state.assets?.length ?? null,
    completed: state.assets?.reduce((count, asset) => count + asset.settledPayments, 0) ?? null,
    review: state.assets?.reduce((count, asset) => count + asset.reviewPayments, 0) ?? null };
}
