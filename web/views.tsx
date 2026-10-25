import { formatAssetAmount, type AssetTotal, type Overview, type PagerState } from './dashboard.ts';

interface AssetVolumesProps {
  assets: AssetTotal[];
  overview?: Pick<Overview, 'mode' | 'token'> | null;
}

/** Pure rendering: volumes stay separated by token and never imply balances. */
export function AssetVolumes({ assets, overview }: AssetVolumesProps) {
  return <section className="panel asset-volumes" aria-labelledby="asset-volumes-title">
    <div className="panel-heading"><div><h2 id="asset-volumes-title">Transfer volume by asset</h2>
      <p>Journaled volume across all records. Review amounts are separate from settled volume.</p></div>
      <span className="tag">{assets.length} ASSET{assets.length === 1 ? '' : 'S'}</span></div>
    {assets.length === 0 ? <div className="empty">No journaled assets yet.</div> :
      <div className="table-wrap"><table><thead><tr>
        <th>ASSET</th><th>SETTLED VOLUME</th><th>REVIEW VOLUME</th><th>PAYMENT COUNTS</th>
      </tr></thead><tbody>{assets.map(asset => {
        const settled = formatAssetAmount(asset.settledBaseUnits, asset.token, overview ?? undefined);
        const review = formatAssetAmount(asset.reviewBaseUnits, asset.token, overview ?? undefined);
        return <tr key={asset.token.toLowerCase()}>
          <td><code className="asset-address">{asset.token}</code></td>
          <td className="amount"><span className="exact-amount">{settled.value}</span> <small>{settled.unit}</small></td>
          <td className="amount review-amount"><span className="exact-amount">{review.value}</span> <small>{review.unit}</small></td>
          <td>{asset.settledPayments} settled<small>{asset.reviewPayments} in review</small></td>
        </tr>;
      })}</tbody></table></div>}
    <p className="asset-note">Transfer volumes are not wallet balances or reserves. Unknown assets retain exact base units; no decimals or prices are assumed.</p>
  </section>;
}

interface PageNavigationProps {
  state: Pick<PagerState<unknown>, 'page' | 'loading' | 'nextCursor'>;
  onNext: () => void;
  onPrevious: () => void;
  onRefresh: () => void;
}

export function PageNavigation({ state, onNext, onPrevious, onRefresh }: PageNavigationProps) {
  return <div className="table-footer page-navigation">
    <div><strong>Page {state.page}</strong><span>{state.loading ? 'Loading…' : state.page === 1 ? 'Latest page · refreshes every 5 seconds' : 'Historical page · automatic refresh paused'}</span></div>
    <div className="page-controls">
      <button className="secondary" onClick={onRefresh} disabled={state.loading}>↻ Refresh latest</button>
      <button className="secondary" onClick={onPrevious} disabled={state.loading || state.page <= 1}>← Newer</button>
      <button className="secondary" onClick={onNext} disabled={state.loading || !state.nextCursor}>Older →</button>
    </div>
  </div>;
}
