import { assetMetadataFor, assetRegistry, formatAssetAmount, type AssetContext, type AssetTotal, type PagerState } from './dashboard.ts';
import { type TotalsState } from './totals.ts';

/** Present one resource warning; known corruption never falls back to cached volume. */
export function AssetTotalsPanel({ state, overview }: { state: TotalsState; overview?: AssetContext | null }) {
  return <>
    {state.integrityError ? <div role="alert" className="banner danger">{state.integrityError}</div> :
      state.transportError && <div role="alert" className="banner danger">Asset totals could not refresh: {state.transportError}.{state.assets ? ' Showing the last received totals.' : ''}</div>}
    {state.assets ? <AssetVolumes assets={state.assets} overview={overview}/> :
      <section className="panel"><div className="empty">{state.integrityError
        ? 'Asset totals are unavailable. Verify journal data before using aggregate amounts.'
        : state.transportError ? 'Asset totals are unavailable.' : 'Loading asset volumes…'}</div></section>}
  </>;
}

interface AssetVolumesProps {
  assets: AssetTotal[];
  overview?: AssetContext | null;
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
        const metadata = assetMetadataFor(asset.token, overview);
        return <tr key={asset.token.toLowerCase()}>
          <td>{metadata && <strong className="asset-symbol">{metadata.symbol}</strong>}<code className="asset-address">{asset.token}</code>
            <small className="metadata-source">{metadata ? (metadata.source === 'configured' ? 'Configured' : 'Demo') +
              ' metadata · ' + metadata.decimals + ' decimals' : 'Exact base units · metadata unavailable'}</small></td>
          <td className="amount"><span className="exact-amount">{settled.value}</span> <small>{settled.unit}</small></td>
          <td className="amount review-amount"><span className="exact-amount">{review.value}</span> <small>{review.unit}</small></td>
          <td>{asset.settledPayments} settled<small>{asset.reviewPayments} in review</small></td>
        </tr>;
      })}</tbody></table></div>}
    <p className="asset-note">Transfer volumes are not wallet balances or reserves. Symbols and decimals come from explicit metadata for this chain. Unknown assets retain exact base units; prices are not inferred.</p>
  </section>;
}

/** The registry describes display precision, without claiming token verification. */
export function AssetMetadataRegistry({ overview }: { overview: AssetContext }) {
  const registry = assetRegistry(overview);
  return <section className="panel asset-registry" aria-labelledby="asset-registry-title">
    <div className="panel-heading"><div><h2 id="asset-registry-title">Asset display registry</h2>
      <p>Explicit symbols and decimals for this chain. Addresses identify each asset.</p></div>
      <span className="tag">CHAIN {overview.chainId ?? 'UNKNOWN'}</span></div>
    {registry.status === 'invalid' ? <div role="alert" className="page-error">Asset metadata is invalid. Amounts retain exact base units.</div> :
      registry.status === 'missing' ? <div className="empty">No explicit registry was supplied. Older demo responses use six decimals only for their known demo asset.</div> :
      registry.entries.length === 0 ? <div className="empty">No display metadata configured for this chain. Amounts retain exact base units.</div> :
      <div className="table-wrap"><table><thead><tr><th>SYMBOL / ASSET</th><th>DECIMALS</th><th>SOURCE</th></tr></thead>
        <tbody>{registry.entries.map(item => <tr key={item.token.toLowerCase()}><td><strong className="asset-symbol">{item.symbol}</strong>
          <code className="asset-address">{item.token}</code></td><td>{item.decimals}</td><td>{item.source === 'configured' ? 'Configured' : 'Demo'}</td></tr>)}</tbody></table></div>}
    <p className="asset-note">Display metadata does not establish token value, eligibility, balances, reserves, or authenticity.</p>
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
