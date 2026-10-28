import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssetMetadataRegistry, AssetVolumes, PageNavigation } from './views.tsx';
import { PaymentHistoryRow, PaymentReceiptSnapshot, type ReceiptSnapshot } from './payment-history.tsx';
import { startPolling } from './polling.ts';
import {
  CursorPager, PAGE_SIZE, assetRegistry, formatAssetAmount, pagePath,
  type AssetTotal, type CursorPage, type JournalRow, type Overview, type PagerState,
  type PaymentRow, type StatusFilter
} from './dashboard.ts';
import './style.css';

const short = (value?: string | null) => value ? value.slice(0, 8) + '…' + value.slice(-6) : 'Pending';
const emptyPage = <T,>(): PagerState<T> => ({ items: [], nextCursor: null, page: 1, loading: false, error: '' });
const chainContext = (overview: Overview) => String(overview.chainId) + ':' + overview.router.toLowerCase();
class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
interface RequestOptions { method?: string; body?: unknown; signal?: AbortSignal }

/** Each instance belongs to exactly one auth/network/filter context. */
function useHistory<T>(collection: 'payments' | 'journals', key: string, network: string,
  filter: StatusFilter, revision: number,
  request: <R>(path: string, options?: RequestOptions) => Promise<R>) {
  const [state, setState] = useState<PagerState<T>>(emptyPage);
  const [loadedContext, setLoadedContext] = useState('');
  const pager = useRef<CursorPager<T> | null>(null);
  const context = key + ':' + network + ':' + filter + ':' + revision;
  useEffect(() => {
    if (!key || !network) { setState(emptyPage<T>()); setLoadedContext(''); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const instance = new CursorPager<T>(
      (cursor, signal) => request<CursorPage<T>>(pagePath(collection, cursor, filter), { signal }),
      value => { if (active) setState(value); }
    );
    pager.current = instance;
    setLoadedContext(context);
    setState(emptyPage<T>());
    const refresh = async (initial = false) => {
      if (!active) return;
      if (initial) await instance.refresh();
      else if (instance.state.page === 1 && !instance.state.loading) await instance.reload();
      if (active) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh(true);
    return () => {
      active = false;
      clearTimeout(timer);
      instance.dispose();
      if (pager.current === instance) pager.current = null;
    };
  }, [collection, key, network, filter, revision, request]);
  return { state: loadedContext === context ? state : emptyPage<T>(), pager };
}

function App() {
  const [key, setKey] = useState(''), [manualKey, setManualKey] = useState('');
  const [data, setData] = useState<Overview | null>(null);
  const [assets, setAssets] = useState<AssetTotal[] | null>(null), [totalsError, setTotalsError] = useState('');
  const [page, setPage] = useState('Overview'), [filter, setFilter] = useState<StatusFilter>('all');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false), [amount, setAmount] = useState('250.00');
  const [uncertainPayment, setUncertainPayment] = useState(false);
  const [selected, setSelected] = useState<ReceiptSnapshot | null>(null);
  const [revision, setRevision] = useState(0);
  const [paymentRevision, setPaymentRevision] = useState(0), [journalRevision, setJournalRevision] = useState(0);
  const session = useRef(0), currentNetwork = useRef('');
  const posts = useRef(new Set<AbortController>());
  const overviewPoller = useRef<ReturnType<typeof startPolling> | null>(null);
  const totalsPoller = useRef<ReturnType<typeof startPolling> | null>(null);

  const request = useCallback(async <R,>(path: string, options: RequestOptions = {}): Promise<R> => {
    const response = await fetch('/api/' + path, {
      method: options.method ?? 'GET', signal: options.signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    let result: any;
    try { result = await response.json(); }
    catch { throw new ApiError('The server returned an unreadable response', response.status); }
    if (!response.ok) throw new ApiError(result.error ?? 'Request failed', response.status);
    return result as R;
  }, [key]);

  function changeToken(next: string) {
    session.current++;
    overviewPoller.current?.stop(); totalsPoller.current?.stop();
    for (const controller of posts.current) controller.abort();
    posts.current.clear();
    currentNetwork.current = '';
    setData(null); setAssets(null); setSelected(null); setForm(false);
    setError(''); setTotalsError(''); setNotice(''); setBusy(false); setUncertainPayment(false);
    setFilter('all'); setManualKey(''); setKey(next.trim());
    setRevision(value => value + 1);
    setPaymentRevision(value => value + 1); setJournalRevision(value => value + 1);
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController(), initialSession = session.current;
    fetch('/api/bootstrap', { signal: controller.signal }).then(response => response.ok ? response.json() : null)
      .then(value => { if (active && session.current === initialSession && value?.apiKey) changeToken(value.apiKey); })
      .catch(() => { if (active && !controller.signal.aborted) setError('Cannot reach the local server'); });
    return () => { active = false; controller.abort(); };
  }, []);

  // RPC-dependent metadata and local accounting refresh independently.
  useEffect(() => {
    if (!key) return;
    const activeSession = session.current;
    const instance = startPolling({
      load: signal => request<Overview>('overview', { signal }),
      onValue: overview => {
        if (session.current !== activeSession) return;
        const context = chainContext(overview);
        if (currentNetwork.current !== context) {
          currentNetwork.current = context;
          totalsPoller.current?.stop();
          setTotalsError('');
          setAssets(null); setSelected(null); setForm(false); setUncertainPayment(false);
        }
        setData(overview); setError('');
      },
      onError: error => {
        if (session.current === activeSession) setError(error instanceof Error ? error.message : 'Unable to refresh overview');
      }
    });
    overviewPoller.current = instance;
    return () => {
      instance.stop();
      if (overviewPoller.current === instance) overviewPoller.current = null;
    };
  }, [key, request, revision]);

  const network = data ? chainContext(data) : '';
  useEffect(() => {
    if (!key || !network) return;
    const activeSession = session.current;
    const instance = startPolling({
      load: signal => request<{ assets: AssetTotal[] }>('totals', { signal }),
      onValue: totals => {
        if (session.current !== activeSession || currentNetwork.current !== network) return;
        setAssets(totals.assets); setTotalsError('');
      },
      onError: error => {
        if (session.current === activeSession && currentNetwork.current === network)
          setTotalsError(error instanceof Error ? error.message : 'Unable to load asset volumes');
      }
    });
    totalsPoller.current = instance;
    return () => {
      instance.stop();
      if (totalsPoller.current === instance) totalsPoller.current = null;
    };
  }, [key, request, revision, network]);

  const payments = useHistory<PaymentRow>('payments', key, network, filter, paymentRevision, request);
  const journals = useHistory<JournalRow>('journals', key, network, 'all', journalRevision, request);

  useEffect(() => () => {
    session.current++;
    for (const controller of posts.current) controller.abort();
  }, []);

  function refreshReadResources() {
    overviewPoller.current?.stop(); totalsPoller.current?.stop();
    setRevision(value => value + 1);
  }
  function refreshLatest() {
    refreshReadResources();
    setPaymentRevision(value => value + 1); setJournalRevision(value => value + 1);
  }
  function refreshAfterMutation() {
    refreshReadResources();
    // New activity can update the latest page, but must not replace an older page.
    if (payments.pager.current?.state.page === 1) setPaymentRevision(value => value + 1);
    if (journals.pager.current?.state.page === 1) setJournalRevision(value => value + 1);
  }
  async function pay(event: React.FormEvent) {
    event.preventDefault();
    if (busy || uncertainPayment) return;
    const activeSession = session.current, activeNetwork = currentNetwork.current;
    const controller = new AbortController();
    posts.current.add(controller);
    setBusy(true); setNotice('');
    try {
      const result = await request<{ payment: PaymentRow }>('demo/payment', {
        method: 'POST', body: { amount }, signal: controller.signal
      });
      if (session.current !== activeSession || controller.signal.aborted) return;
      // Acknowledgement is reported before any independent read refresh can fail.
      setForm(false);
      if (currentNetwork.current !== activeNetwork) {
        setNotice('The connection changed during submission. Check the original network payment history before retrying.');
      } else {
        setNotice(result.payment.status === 'failed'
          ? 'Payment rejected: ' + (result.payment.error ?? 'Contract rejected the instruction')
          : 'Payment ' + result.payment.status + '. Open its receipt in payment history for details.');
      }
      refreshAfterMutation();
    } catch (e) {
      if (session.current !== activeSession || controller.signal.aborted) return;
      if (e instanceof ApiError && [400, 401, 403, 429].includes(e.status)) {
        setNotice(e.message);
      } else {
        setUncertainPayment(true);
        setNotice('Payment outcome is unknown. Check payment history and reconcile before retrying. ' +
          (e instanceof Error ? e.message : 'The response was lost.'));
      }
    } finally {
      posts.current.delete(controller);
      if (session.current === activeSession) setBusy(false);
    }
  }
  async function reconcile() {
    if (busy) return;
    const activeSession = session.current, activeNetwork = currentNetwork.current;
    const controller = new AbortController();
    posts.current.add(controller); setBusy(true);
    try {
      const result = await request<{ checked: number; exceptions: string[] }>('reconcile', {
        method: 'POST', signal: controller.signal
      });
      if (session.current !== activeSession || controller.signal.aborted) return;
      setNotice(currentNetwork.current !== activeNetwork
        ? 'The connection changed during reconciliation. The result belongs to the original network; reconcile the current connection again.'
        : 'Reconciled ' + result.checked + ' settlements · ' + result.exceptions.length + ' exceptions.');
      refreshAfterMutation();
    } catch (e) {
      if (session.current === activeSession && !controller.signal.aborted)
        setNotice('Reconciliation did not complete. ' + (e instanceof Error ? e.message : 'Try again after the connection recovers.'));
    } finally {
      posts.current.delete(controller);
      if (session.current === activeSession) setBusy(false);
    }
  }

  const completed = assets?.reduce((count, asset) => count + asset.settledPayments, 0);
  const review = assets?.reduce((count, asset) => count + asset.reviewPayments, 0);
  const isDemo = data?.mode === 'demo' && Boolean(data.token);
  const metadata = assetRegistry(data);
  const displayedPrecision = metadata.status === 'ready' && metadata.entries.length > 0 ? 'Configured per asset' :
    metadata.status === 'missing' && isDemo ? 'Demo asset: 6 decimals' : 'Exact base units';

  return <div className="shell">
    <aside>
      <a className="brand" href="/" aria-label="ClearLedger home"><span className="brandmark">C<span>↗</span></span> ClearLedger<span className="branddot">.</span></a>
      <div className="workspace"><span className="workspace-icon">CL</span><div>Settlement workspace<small>Engineering portfolio</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{[['Overview', '◫'], ['Payments', '⇄'], ['Journal', '▤'], ['Audit trail', '≡'], ['Network', '⬡']].map(([name, icon]) =>
        <button key={name} className={page === name ? 'active' : ''} onClick={() => setPage(name)}><span>{icon}</span>{name}</button>)}</nav>
      <div className="side-bottom"><span className={'dot ' + (error || !key ? 'offline' : '')}></span>{!key ? 'Disconnected' : error ? 'Connection interrupted' : data ? 'Connected to local chain' : 'Connecting'}<small>Original application · Open-source rails</small></div>
      <div className="profile"><span>DEV</span><div>Developer environment<small>Test assets only</small></div></div>
    </aside>
    <div className="main">
      <header><div>Workspace <span>/</span> <strong>{page}</strong></div><div className="header-right">
        {key && <button className="text-button" onClick={() => changeToken('')}>Disconnect / change token</button>}
        <span className="env">{data ? data.mode === 'rpc' ? 'RPC NETWORK' : 'LOCAL DEMO' : key ? 'CONNECTING' : 'DISCONNECTED'}</span><span className="avatar">CL</span></div></header>
      <main>
        <div className="page-title"><div><div className="eyebrow">PAYMENTS, WITH PROOF.</div><h1>{page === 'Overview' ? 'Settlement overview' : page}</h1><p>Move value. Verify every step. Keep the books in sync.</p></div>
          <div className="actions"><button className="secondary" onClick={refreshLatest} disabled={!key}>↻ Refresh latest</button><button className="secondary" onClick={reconcile} disabled={busy || !data}>Reconcile</button><button className="primary" onClick={() => { setForm(true); setNotice(''); setUncertainPayment(false); }} disabled={busy || !isDemo}>+ New payment</button></div></div>
        {(!key || (!data && error)) && <form className="login panel" onSubmit={event => { event.preventDefault(); changeToken(manualKey); }}><h2>Connect to your API</h2><p>Enter the API token configured on the local server. It stays in this page’s memory.</p><input aria-label="API token" type="password" value={manualKey} onChange={event => setManualKey(event.target.value)} required/><button className="primary">Connect</button></form>}
        {error && <div role="alert" className="banner danger">Overview could not refresh: {error}. {data ? 'Showing the last received overview.' : 'Change the token or retry the connection.'}</div>}
        {notice && <div role="status" className="banner">{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}>×</button></div>}
        {data && <>
          {page === 'Overview' && <>
            <div className="stats">
              <div className="stat"><label>Journaled assets <span>↗</span></label><strong>{assets?.length ?? '—'}</strong><small>Amounts stay separate by token below</small></div>
              <div className="stat"><label>Completed payments <span>✓</span></label><strong>{completed ?? '—'}<em> settlements</em></strong><small>Journaled records across all assets</small></div>
              <div className="stat"><label>In review <span>◇</span></label><strong>{review ?? '—'}<em> payments</em></strong><small>Excluded from settled asset volume</small></div>
              <div className="stat"><label>Latest block <span>⬡</span></label><strong>{data.block?.number.toLocaleString() ?? '—'}</strong><small><span className="dot"></span> Chain {data.chainId} · live RPC data</small></div>
            </div>
            {totalsError && <div role="alert" className="banner danger">Asset totals could not refresh: {totalsError}.{assets ? ' Showing the last received totals.' : ''}</div>}
            {assets ? <AssetVolumes assets={assets} overview={data}/> : <section className="panel"><div className="empty">{totalsError ? 'Asset totals are unavailable.' : 'Loading asset volumes…'}</div></section>}
            <div className="overview-grid">
              <section className="panel flow"><div className="panel-heading"><div><h2>A payment you can trace</h2><p>From authorization to a balanced journal.</p></div><span className="tag">END-TO-END</span></div>
                <div className="flow-track">
                  {[['01', 'Authorize', 'EIP-712 signature'], ['02', 'Validate', 'Eligibility & limits'], ['03', 'Settle', 'Atomic token transfer'], ['04', 'Reconcile', 'Receipt → journal']].map(([n, title, description], index) => <React.Fragment key={n}><div className="flow-step"><span>{n}</span><strong>{title}</strong><small>{description}</small></div>{index < 3 && <span className="flow-arrow">→</span>}</React.Fragment>)}
                </div>
                <div className="flow-note"><span className="shield">◇</span><div><strong>Replay protection at two layers</strong><p>Idempotent API requests and on-chain nonces keep retries from moving funds twice.</p></div></div>
              </section>
              <section className="panel policy"><div className="panel-heading"><h2>{isDemo ? 'Demo policy' : 'Contract policy'}</h2><span className="dot"></span></div>
                <dl><div><dt>Per payment</dt><dd>{isDemo ? (data.perPaymentLimit ?? 'See contract') + ' dUSD' : 'Read policy for the asset'}</dd></div><div><dt>Per payer / UTC day</dt><dd>{isDemo ? (data.dailyLimit ?? 'See contract') + ' dUSD' : 'Read policy for the asset'}</dd></div><div><dt>Finalization threshold</dt><dd>{data.confirmations} block{data.confirmations > 1 ? 's' : ''}</dd></div><div><dt>Displayed precision</dt><dd>{displayedPrecision}</dd></div></dl>
                <p className="policy-foot">{isDemo ? 'Demo tokens have no monetary value. Limits apply to the configured demo asset.' : 'Asset limits are enforced by the router. Token decimals and prices are not inferred.'}</p>
              </section>
            </div>
          </>}
          {(page === 'Overview' || page === 'Payments') && <section className="panel payment-panel" aria-labelledby="payments-title">
            <div className="panel-heading"><div><h2 id="payments-title">Payment history</h2><p>Signed instructions, recorded outcomes. Up to {PAGE_SIZE} records per page.</p></div><select aria-label="Filter payments by status" value={filter} onChange={event => setFilter(event.target.value as StatusFilter)}><option value="all">All statuses</option>{['settled', 'queued', 'broadcast', 'failed', 'review'].map(status => <option key={status}>{status}</option>)}</select></div>
            {payments.state.error && <div role="alert" className="page-error">Payment page could not refresh: {payments.state.error}. Existing rows are retained.</div>}
            <div className="table-wrap"><table><thead><tr><th>PAYMENT</th><th>ROUTE</th><th>ASSET / AMOUNT</th><th>STATUS</th><th>BLOCK</th><th></th></tr></thead><tbody>{payments.state.items.map(row =>
              <PaymentHistoryRow key={row.id} row={row} overview={data}
                onOpen={() => setSelected({ row, capturedAt: new Date().toISOString() })}/>
            )}</tbody></table>{payments.state.items.length === 0 && <div className="empty">{payments.state.loading ? 'Loading payment history…' : payments.state.error ? 'Payment history is unavailable.' : 'No payments match this view.'}</div>}</div>
            <PageNavigation state={payments.state} onNext={() => void payments.pager.current?.next()} onPrevious={() => void payments.pager.current?.previous()} onRefresh={() => { setPaymentRevision(value => value + 1); refreshReadResources(); }}/>
          </section>}
          {page === 'Journal' && <section className="panel payment-panel" aria-labelledby="journal-title">
            <div className="panel-heading"><div><h2 id="journal-title">Transfer journal</h2><p>Historical settlement provenance. Current payment status is shown in Payment history.</p></div><span className="tag">READ-ONLY RECORDS</span></div>
            {journals.state.error && <div role="alert" className="page-error">Journal page could not refresh: {journals.state.error}. Existing rows are retained.</div>}
            <div className="table-wrap"><table><thead><tr><th>PAYMENT / ASSET</th><th>DEBIT → CREDIT</th><th>AMOUNT</th><th>RECORDED TRANSACTION</th><th>RECORDED BLOCK</th></tr></thead><tbody>{journals.state.items.map(row => {
              const value = formatAssetAmount(row.amount, row.token, data);
              return <tr key={row.payment_id}>
                <td><strong className="mono" title={row.payment_id}>{short(row.payment_id)}</strong><small className="mono" title={row.token}>{short(row.token)}</small></td>
                <td className="mono" title={row.debit_account + ' → ' + row.credit_account}>{short(row.debit_account)} → {short(row.credit_account)}</td>
                <td className="amount"><span className="exact-amount">{value.value}</span> <small>{value.unit}</small></td>
                <td className="mono" title={row.tx_hash}>{short(row.tx_hash)}</td>
                <td className="mono">{row.block_number}<small title={row.block_hash}>{short(row.block_hash)}</small></td>
              </tr>;
            })}</tbody></table>{journals.state.items.length === 0 && <div className="empty">{journals.state.loading ? 'Loading transfer journal…' : journals.state.error ? 'Transfer journal is unavailable.' : 'No journal records yet.'}</div>}</div>
            <p className="journal-note">A journal row records what was finalized at the time. Reconcile detects later chain mismatches and flags the payment for review; this table does not invent a current journal status.</p>
            <PageNavigation state={journals.state} onNext={() => void journals.pager.current?.next()} onPrevious={() => void journals.pager.current?.previous()} onRefresh={() => { setJournalRevision(value => value + 1); refreshReadResources(); }}/>
          </section>}
          {page === 'Audit trail' && <section className="panel"><div className="panel-heading"><div><h2>Payment lifecycle</h2><p>Latest local operational events, linked to on-chain receipts.</p></div><span className="tag">{data.audit.length} RECENT EVENTS</span></div>
            <div className="timeline">{data.audit.map(event => <div key={event.sequence}><span className="timeline-dot"/><div><strong>{event.action.replaceAll('-', ' ')}</strong><p className="mono">{short(event.payment_id)} · {event.detail}</p></div><time>{new Date(event.at).toLocaleTimeString()}</time></div>)}</div>
          </section>}
          {page === 'Network' && <><div className="panel network-panel"><div className="panel-heading"><div><h2>Connected execution network</h2><p>Actual runtime information; the four-validator Besu network is a separate launch mode.</p></div><span className="tag">CHAIN {data.chainId}</span></div>
            <dl><div><dt>Runtime</dt><dd>{data.consensus ?? 'External EVM JSON-RPC'}</dd></div><div><dt>Development validators</dt><dd>{data.validators ?? 'Query your node operator'}</dd></div><div><dt>Settlement router</dt><dd className="mono">{data.router}</dd></div><div><dt>Latest block hash</dt><dd className="mono">{data.block?.hash}</dd></div><div><dt>Configured demo asset</dt><dd className="mono">{isDemo ? data.token : 'Asset specified by each payment'}</dd></div></dl></div>
            <AssetMetadataRegistry overview={data}/>
            <div className="network-cards"><section className="panel"><h2>Consensus foundation</h2><p>Besu 26.10.1 source is included under its upstream license. The network generator creates four independent validator keys for a local QBFT network.</p></section><section className="panel"><h2>Trust boundaries</h2><p>This prototype uses test assets. Account eligibility is a demo control. No real deposits, redemptions, or banking connections are configured.</p></section></div></>}
          <footer><span className="footer-brand">ClearLedger</span><span>Built for verification. Designed to be understood.</span><span>Portfolio prototype · v0.1</span></footer>
        </>}
      </main>
    </div>
    {form && isDemo && <div className="overlay" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="payment-title"><button className="close" aria-label="Close payment form" onClick={() => setForm(false)}>×</button><div className="eyebrow">LOCAL DEMO</div><h2 id="payment-title">Create a payment</h2><p>A temporary demo wallet signs and submits this payment on your local EVM.</p><form onSubmit={pay}><label>From</label><div className="account">Treasury <code>{short(data?.payer)}</code></div><label>To</label><div className="account">Merchant <code>{short(data?.payee)}</code></div><label htmlFor="amount">Amount in demo USD</label><div className="amount-input"><input id="amount" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} autoFocus required disabled={busy || uncertainPayment}/><span>dUSD</span></div><p className="hint">Maximum 10,000 dUSD per payment. No real money moves.</p>{notice && <p role="alert" className={uncertainPayment ? 'error' : ''}>{notice}</p>}<button className="primary full" disabled={busy || uncertainPayment}>{busy ? 'Signing & settling…' : 'Sign and submit payment →'}</button>{uncertainPayment && <button type="button" className="secondary full history-check" onClick={() => { setForm(false); setPage('Payments'); setFilter('all'); refreshLatest(); }}>Check payment history</button>}</form></section></div>}
    {selected && <PaymentReceiptSnapshot snapshot={selected} overview={data} onClose={() => setSelected(null)}/>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

