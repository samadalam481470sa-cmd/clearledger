import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalPageCsv } from '../web/journal-export.ts';
import type { JournalRow } from '../web/dashboard.ts';

const hash = (byte: string) => '0x' + byte.repeat(64);

test('journal CSV keeps exact base-unit values and on-chain provenance', () => {
  const row: JournalRow = {
    payment_id: hash('a'), token: '0x' + '1'.repeat(40),
    debit_account: '0x' + '2'.repeat(40), credit_account: '0x' + '3'.repeat(40),
    amount: '90071992547409931234567890000000000',
    tx_hash: hash('b'), block_number: 12345, block_hash: hash('c')
  };
  const csv = journalPageCsv([row]);
  assert.ok(csv.startsWith('"Payment ID","Token Address"'));
  assert.ok(csv.endsWith('\r\n'));
  assert.equal(csv.trimEnd().split('\r\n').length, 2);
  assert.ok(csv.includes('"90071992547409931234567890000000000"'));
  assert.ok(csv.includes('"' + row.tx_hash + '"'));
  assert.ok(csv.includes('"12345"'));
  assert.ok(csv.includes('"' + row.block_hash + '"'));
  assert.ok(!csv.includes('9.007199'), 'Never round or convert base units to floating point');
});

test('journal CSV quotes hostile text and neutralizes spreadsheet formula prefixes', () => {
  const row: JournalRow = {
    payment_id: '=HYPERLINK("https://unsafe.invalid","click")',
    token: '@SUM(1,2)', debit_account: '  +CMD',
    credit_account: '\n-1+2', amount: '123', tx_hash: 'safe,with"quote',
    block_number: 9, block_hash: 'line\nsecond'
  };
  const csv = journalPageCsv([row]);
  assert.ok(csv.includes("'=HYPERLINK("), 'Leading formula must be escaped');
  assert.ok(csv.includes("'@SUM(1,2)"));
  assert.ok(csv.includes("'  +CMD"));
  assert.ok(csv.includes("'\n-1+2"));
  assert.ok(csv.includes('"safe,with""quote"'));
  assert.ok(csv.includes('"line\nsecond"'));
  assert.ok(!csv.includes(',"=HYPERLINK('), 'No unescaped formula-leading cell');
});

test('journal CSV without fetched records exports only its header', () => {
  assert.equal(journalPageCsv([]).trimEnd().split('\r\n').length, 1);
});
