import { formatAssetAmount, type AssetContext, type Overview, type PaymentRow } from './dashboard.ts';

const short = (value?: string | null) => value ? value.slice(0, 8) + '…' + value.slice(-6) : 'Pending';
const invalidAuthorization = 'Stored payment data is invalid; verify the original authorization';
type HistoryContext = AssetContext & Partial<Pick<Overview, 'payer' | 'payee'>>;

export interface ReceiptSnapshot { row: PaymentRow; capturedAt: string }

/** A missing authorization never borrows an amount or route from other records. */
export function PaymentHistoryRow({ row, overview, onOpen }: {
  row: PaymentRow; overview: HistoryContext; onOpen: () => void;
}) {
  const payment = row.payment;
  const amount = payment ? formatAssetAmount(payment.amount, payment.token, overview) : null;
  const isDemo = overview.mode === 'demo' && Boolean(overview.token);
  return <tr>
    <td>{payment ? <strong className="mono" title={row.id}>{short(payment.paymentId)}</strong> : <>
      <strong>Authorization unavailable</strong>
      <small className="mono">{row.id}</small>
      <small role="alert" className="error">{invalidAuthorization}</small>
      <small className="mono">{row.tx_hash ?? 'Not broadcast'}</small>
    </>}<small>{new Date(row.created_at).toLocaleString()}</small></td>
    <td>{payment ? <>
      <strong>{isDemo && overview.payer === payment.payer ? 'Treasury' : short(payment.payer)} <span className="muted">→</span> {isDemo && overview.payee === payment.payee ? 'Merchant' : short(payment.payee)}</strong>
      <small className="mono">{short(payment.payer)} → {short(payment.payee)}</small>
    </> : <strong>Route unavailable</strong>}</td>
    <td className="amount">{amount && payment ? <>
      <span className="exact-amount">{amount.value}</span> <small>{amount.unit}</small>
      <small className="mono" title={payment.token}>{short(payment.token)}</small>
    </> : <><span className="exact-amount">Amount unavailable</span><small>Token unavailable</small></>}</td>
    <td><span className={'status ' + row.status}><i/>{row.status}</span></td>
    <td className="mono">{row.block_number ?? '—'}</td>
    <td><button className="text-button" onClick={onOpen}>Receipt ↗</button></td>
  </tr>;
}

/** Render stored row metadata even when the original authorization is unavailable. */
export function PaymentReceiptSnapshot({ snapshot, overview, onClose }: {
  snapshot: ReceiptSnapshot; overview?: AssetContext | null; onClose: () => void;
}) {
  const { row, capturedAt } = snapshot;
  const payment = row.payment;
  const amount = payment ? formatAssetAmount(payment.amount, payment.token, overview) : null;
  const details = [
    ['Record ID', row.id], ['Asset', payment?.token ?? 'Token unavailable'],
    ['Payment ID', payment?.paymentId ?? 'Authorization unavailable'], ['Payer', payment?.payer ?? 'Route unavailable'],
    ['Payee', payment?.payee ?? 'Route unavailable'], ['Transaction', row.tx_hash ?? 'Not broadcast'],
    ['Block', String(row.block_number ?? 'Pending')], ['Authorization nonce', payment?.nonce ?? 'Authorization unavailable']
  ];
  return <div className="overlay"><section className="modal receipt" role="dialog" aria-modal="true" aria-labelledby="receipt-title">
    <button className="close" aria-label="Close receipt" onClick={onClose}>×</button>
    <div className="eyebrow">PAYMENT RECEIPT SNAPSHOT</div>
    <h2 id="receipt-title" className="exact-amount">{amount ? <>{amount.value} <small>{amount.unit}</small></> : 'Amount unavailable'}</h2>
    <span className={'status ' + row.status}><i/>{row.status}</span>
    {!payment && <p role="alert" className="error">{invalidAuthorization}</p>}
    <dl>{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="mono">{value}</dd></div>)}</dl>
    {row.error && <p className="error">{row.error}</p>}
    <p className="hint">Snapshot opened {new Date(capturedAt).toLocaleString()}. Status may change; refresh payment history and reopen to see the latest record. Reconcile checks recorded blocks against the chain.</p>
  </section></div>;
}
