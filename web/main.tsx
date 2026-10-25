import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Payment = { paymentId: string; payer: string; payee: string; token: string; amount: string; nonce: string; deadline: string };
type Row = { id: string; status: string; tx_hash: string | null; created_at: string; block_number: number | null; error: string | null; payment: Payment };
type Overview = {
  mode: string; chainId: number; router: string; currency?: string; payer?: string; payee?: string; token?: string;
  validators?: number; consensus?: string; perPaymentLimit?: string; dailyLimit?: string; confirmations: number;
  block: { number: number; hash: string; timestamp: number } | null;
  payments: Row[]; journals: any[]; audit: { sequence: number; action: string; at: string; payment_id: string; detail: string }[];
};
const short = (v?: string | null) => v ? v.slice(0, 8) + '…' + v.slice(-6) : 'Pending';
const units = (s: string | bigint) => {
  const n = BigInt(s), whole = n / 1000000n, fraction = (n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
  return whole.toLocaleString() + (fraction ? '.' + fraction : '.00');
};
function App() {
  const [key, setKey] = useState(''), [manualKey, setManualKey] = useState('');
  const [data, setData] = useState<Overview | null>(null), [page, setPage] = useState('Overview');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [form, setForm] = useState(false), [amount, setAmount] = useState('250.00'), [selected, setSelected] = useState<Row | null>(null);
  const [filter, setFilter] = useState('all');
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch('/api/' + path, { method, headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Request failed');
    return result;
  }
  useEffect(() => {
    fetch('/api/bootstrap').then(r => r.ok ? r.json() : null).then(v => { if (v?.apiKey) setKey(v.apiKey); }).catch(() => setError('Cannot reach the local server'));
  }, []);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const refresh = async () => {
      try { const result = await api('overview'); if (alive) { setData(result); setError(''); } }
      catch (e: any) { if (alive) setError(e.message); }
    };
    void refresh();
    const timer = setInterval(refresh, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [key]);
  async function pay(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setNotice('');
    try {
      const result = await api('demo/payment', 'POST', { amount });
      setData(await api('overview')); setForm(false);
      setNotice(result.payment.status === 'failed' ? 'Payment rejected: ' + result.payment.error : 'Payment ' + result.payment.status + '. Open its receipt for details.');
    } catch (e: any) { setNotice(e.message); }
    finally { setBusy(false); }
  }
  async function reconcile() {
    setBusy(true);
    try { const r = await api('reconcile', 'POST'); setData(await api('overview')); setNotice('Reconciled ' + r.checked + ' settlements · ' + r.exceptions.length + ' exceptions.'); }
    catch (e: any) { setNotice(e.message); }
    finally { setBusy(false); }
  }
  const settled = data?.payments.filter(p => p.status === 'settled') ?? [];
  const volume = settled.reduce((sum, p) => sum + BigInt(p.payment.amount), 0n);
  const pending = data?.payments.filter(p => ['queued', 'broadcast'].includes(p.status)).length ?? 0;
  const exceptions = data?.payments.filter(p => ['review', 'failed'].includes(p.status)).length ?? 0;
  const rows = data?.payments.filter(p => filter === 'all' || p.status === filter) ?? [];

  return <div className="shell">
    <aside>
      <a className="brand" href="/" aria-label="ClearLedger home"><span className="brandmark">C<span>↗</span></span> ClearLedger<span className="branddot">.</span></a>
      <div className="workspace"><span className="workspace-icon">CL</span><div>Settlement workspace<small>Engineering portfolio</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <nav>{[['Overview', '◫'], ['Payments', '⇄'], ['Audit trail', '≡'], ['Network', '⬡']].map(([name, icon]) =>
        <button key={name} className={page === name ? 'active' : ''} onClick={() => setPage(name)}><span>{icon}</span>{name}{name === 'Payments' && <b>{data?.payments.length ?? 0}</b>}</button>)}</nav>
      <div className="side-bottom"><span className={'dot ' + (error ? 'offline' : '')}></span>{error ? 'Connection interrupted' : data ? 'Connected to local chain' : 'Connecting'}<small>Original application · Open-source rails</small></div>
      <div className="profile"><span>DEV</span><div>Developer environment<small>Test assets only</small></div></div>
    </aside>
    <div className="main">
      <header><div>Workspace <span>/</span> <strong>{page}</strong></div><div className="header-right"><span className="env">{data?.mode === 'rpc' ? 'RPC NETWORK' : 'LOCAL DEMO'}</span><span className="avatar">CL</span></div></header>
      <main>
        <div className="page-title"><div><div className="eyebrow">PAYMENTS, WITH PROOF.</div><h1>{page === 'Overview' ? 'Settlement overview' : page}</h1><p>Move value. Verify every step. Keep the books in sync.</p></div>
        <div className="actions"><button className="secondary" onClick={reconcile} disabled={busy || !data}>↻ Reconcile</button><button className="primary" onClick={() => { setForm(true); setNotice(''); }} disabled={data?.mode !== 'demo'}>+ New payment</button></div></div>
        {!key && <form className="login panel" onSubmit={e => { e.preventDefault(); setKey(manualKey); }}><h2>Connect to your API</h2><p>Enter the API token configured on the local server. It stays in this page’s memory.</p><input aria-label="API token" type="password" value={manualKey} onChange={e => setManualKey(e.target.value)}/><button className="primary">Connect</button></form>}
        {error && <div role="alert" className="banner danger">{error}</div>}
        {notice && <div role="status" className="banner">{notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}>×</button></div>}
        {data && <>
          {page === 'Overview' && <>
            <div className="stats">
              <div className="stat"><label>Settled volume <span>↗</span></label><strong>{units(volume)} <em>dUSD</em></strong><small>Across the latest {data.payments.length} payment records</small></div>
              <div className="stat"><label>Completed payments <span>✓</span></label><strong>{settled.length}<em> settlements</em></strong><small>Confirmed on chain and journaled</small></div>
              <div className="stat"><label>In flight <span>⇄</span></label><strong>{pending}<em> payments</em></strong><small>{exceptions ? exceptions + ' need attention' : 'No exceptions in this view'}</small></div>
              <div className="stat"><label>Latest block <span>⬡</span></label><strong>{data.block?.number.toLocaleString() ?? '—'}</strong><small><span className="dot"></span> Chain {data.chainId} · live RPC data</small></div>
            </div>
            <div className="overview-grid">
              <section className="panel flow"><div className="panel-heading"><div><h2>A payment you can trace</h2><p>From authorization to a balanced journal.</p></div><span className="tag">END-TO-END</span></div>
                <div className="flow-track">
                  {[['01', 'Authorize', 'EIP-712 signature'], ['02', 'Validate', 'Identity & limits'], ['03', 'Settle', 'Atomic token transfer'], ['04', 'Reconcile', 'Receipt → journal']].map(([n, title, description], i) => <React.Fragment key={n}><div className="flow-step"><span>{n}</span><strong>{title}</strong><small>{description}</small></div>{i < 3 && <span className="flow-arrow">→</span>}</React.Fragment>)}
                </div>
                <div className="flow-note"><span className="shield">◇</span><div><strong>Replay protection at two layers</strong><p>Idempotent API requests and on-chain nonces keep retries from moving funds twice.</p></div></div>
              </section>
              <section className="panel policy"><div className="panel-heading"><h2>Demo policy</h2><span className="dot"></span></div>
                <dl><div><dt>Per payment</dt><dd>{data.perPaymentLimit ?? 'See contract'} dUSD</dd></div><div><dt>Per payer / UTC day</dt><dd>{data.dailyLimit ?? 'See contract'} dUSD</dd></div><div><dt>Finalization threshold</dt><dd>{data.confirmations} block{data.confirmations > 1 ? 's' : ''}</dd></div><div><dt>Currency precision</dt><dd>6 decimals</dd></div></dl>
                <p className="policy-foot">Policy is enforced by the smart contracts. Demo tokens have no monetary value.</p>
              </section>
            </div>
          </>}
          {(page === 'Overview' || page === 'Payments') && <section className="panel payment-panel">
            <div className="panel-heading"><div><h2>{page === 'Overview' ? 'Recent payments' : 'Payment activity'}</h2><p>Signed instructions, recorded outcomes.</p></div><select aria-label="Filter payments by status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option>{['settled', 'queued', 'broadcast', 'failed', 'review'].map(s => <option key={s}>{s}</option>)}</select></div>
            <div className="table-wrap"><table><thead><tr><th>PAYMENT</th><th>ROUTE</th><th>AMOUNT</th><th>STATUS</th><th>BLOCK</th><th></th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>
              <td><strong className="mono">{short(row.payment.paymentId)}</strong><small>{new Date(row.created_at).toLocaleTimeString()}</small></td>
              <td><strong>{data.payer === row.payment.payer ? 'Treasury' : short(row.payment.payer)} <span className="muted">→</span> {data.payee === row.payment.payee ? 'Merchant' : short(row.payment.payee)}</strong><small className="mono">{short(row.payment.payer)} → {short(row.payment.payee)}</small></td>
              <td className="amount">{units(row.payment.amount)} <small>dUSD</small></td>
              <td><span className={'status ' + row.status}><i/>{row.status}</span></td><td className="mono">{row.block_number ?? '—'}</td>
              <td><button className="text-button" onClick={() => setSelected(row)}>Receipt ↗</button></td>
            </tr>)}</tbody></table>{rows.length === 0 && <div className="empty">No payments match this view.</div>}</div>
            <div className="table-footer">Showing up to 100 recent payment records<span>Updated every 2 seconds</span></div>
          </section>}
          {page === 'Audit trail' && <section className="panel"><div className="panel-heading"><div><h2>Payment lifecycle</h2><p>Local operational audit log, linked to on-chain transaction receipts.</p></div><span className="tag">{data.audit.length} EVENTS</span></div>
            <div className="timeline">{data.audit.map(e => <div key={e.sequence}><span className="timeline-dot"/><div><strong>{e.action.replaceAll('-', ' ')}</strong><p className="mono">{short(e.payment_id)} · {e.detail}</p></div><time>{new Date(e.at).toLocaleTimeString()}</time></div>)}</div>
          </section>}
          {page === 'Network' && <><div className="panel network-panel"><div className="panel-heading"><div><h2>Connected execution network</h2><p>Actual runtime information; the four-validator Besu network is a separate launch mode.</p></div><span className="tag">CHAIN {data.chainId}</span></div>
            <dl><div><dt>Runtime</dt><dd>{data.consensus ?? 'External EVM JSON-RPC'}</dd></div><div><dt>Development validators</dt><dd>{data.validators ?? 'Query your node operator'}</dd></div><div><dt>Settlement router</dt><dd className="mono">{data.router}</dd></div><div><dt>Latest block hash</dt><dd className="mono">{data.block?.hash}</dd></div><div><dt>Demo asset</dt><dd className="mono">{data.token ?? 'Configured per payment'}</dd></div></dl></div>
            <div className="network-cards"><section className="panel"><h2>Consensus foundation</h2><p>Besu 26.10.1 source is included under its upstream license. The network generator creates four independent validator keys for a local QBFT network.</p></section><section className="panel"><h2>Trust boundaries</h2><p>This prototype uses local test currency. Account eligibility is a demo control, not a KYC service. No real deposits, redemptions, or banking connections.</p></section></div></>}
          <footer><span className="footer-brand">ClearLedger</span><span>Built for verification. Designed to be understood.</span><span>Portfolio prototype · v0.1</span></footer>
        </>}
      </main>
    </div>
    {form && <div className="overlay" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="payment-title"><button className="close" aria-label="Close payment form" onClick={() => setForm(false)}>×</button><div className="eyebrow">LOCAL DEMO</div><h2 id="payment-title">Create a payment</h2><p>A temporary demo wallet signs and submits this payment on your local EVM.</p><form onSubmit={pay}><label>From</label><div className="account">Treasury <code>{short(data?.payer)}</code></div><label>To</label><div className="account">Merchant <code>{short(data?.payee)}</code></div><label htmlFor="amount">Amount in demo USD</label><div className="amount-input"><input id="amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} autoFocus required/><span>dUSD</span></div><p className="hint">Maximum 10,000 dUSD per payment. No real money moves.</p>{notice && <p role="alert">{notice}</p>}<button className="primary full" disabled={busy}>{busy ? 'Signing & settling…' : 'Sign and submit payment →'}</button></form></section></div>}
    {selected && <div className="overlay"><section className="modal receipt" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><button className="close" aria-label="Close receipt" onClick={() => setSelected(null)}>×</button><div className="eyebrow">PAYMENT RECEIPT</div><h2 id="receipt-title">{units(selected.payment.amount)} dUSD</h2><span className={'status ' + selected.status}><i/>{selected.status}</span><dl>{[['Payment ID', selected.payment.paymentId], ['Payer', selected.payment.payer], ['Payee', selected.payment.payee], ['Transaction', selected.tx_hash ?? 'Not broadcast'], ['Block', String(selected.block_number ?? 'Pending')], ['Authorization nonce', selected.payment.nonce]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value}</dd></div>)}</dl>{selected.error && <p className="error">{selected.error}</p>}<p className="hint">Receipt information comes from the local payment journal. Use Reconcile to check its recorded block against the chain.</p></section></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

