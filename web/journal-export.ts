import type { JournalRow } from './dashboard.ts';

/**
 * Export only the journal rows that have already been retrieved for the visible
 * cursor page. Values are exact base-unit strings, not rounded currencies.
 * Every cell is quoted, and spreadsheet formula prefixes are neutralized.
 */
export function journalPageCsv(rows: readonly JournalRow[]): string {
  const columns = [
    'Payment ID', 'Token Address', 'Debit Account', 'Credit Account',
    'Amount (base units)', 'Transaction Hash', 'Block Number', 'Block Hash'
  ];
  const quote = (value: unknown): string => {
    const original = String(value ?? '');
    // CSV may be opened in Excel/Sheets. Neutralize formula execution while
    // keeping the recorded value legible and preserving quoted newlines.
    const text = /^[\s\u0000-\u001f]*[=+\-@]/u.test(original) ? "'" + original : original;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const data = rows.map(row => [
    row.payment_id, row.token, row.debit_account, row.credit_account,
    row.amount, row.tx_hash, row.block_number, row.block_hash
  ]);
  return [columns, ...data].map(row => row.map(quote).join(',')).join('\r\n') + '\r\n';
}
