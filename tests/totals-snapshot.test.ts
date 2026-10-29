import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { JournalIntegrityError, Store } from '../src/store.ts';
import { type Payment } from '../src/payment.ts';

const tokenA = '0x' + 'ab'.repeat(20), tokenB = '0x' + 'cd'.repeat(20);
const fixed = 'Stored journal data is invalid; totals are unavailable';
const scratch = resolve(process.cwd(), '../../work');

function post(store: Store, n: number, token: string, amount: string) {
  const payment: Payment = { paymentId: '0x' + String(n).padStart(64, '0'),
    payer: '0x' + '11'.repeat(20), payee: '0x' + '22'.repeat(20), token, amount,
    nonce: String(n - 1), deadline: '2000000000' };
  const id = store.accept(payment, 'synthetic-fingerprint-' + n, 'synthetic-signature').row.id;
  store.broadcast(id, 'synthetic-raw', '0x' + String(n + 10).padStart(64, '0'));
  store.finalize(id, n, '0x' + 'ee'.repeat(32));
  return id;
}
function rows(db: DatabaseSync, table: 'payments' | 'journals' | 'audit' | 'sqlite_sequence') {
  return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
}

for (const fault of ['missing journal', 'malformed amount'] as const) {
  test('one totals snapshot survives a committed interleaved ' + fault + ' until the next read', t => {
    mkdirSync(scratch, { recursive: true });
    const directory = mkdtempSync(join(scratch, 'totals-snapshot-'));
    assert.equal(dirname(resolve(directory)), scratch, 'Cleanup must stay in task-owned scratch');
    const path = join(directory, 'ledger.sqlite');
    let reader: Store | undefined, writer: DatabaseSync | undefined, passed = false;
    try {
      reader = new Store(path);
      const ids = new Map([[tokenA, post(reader, 1, tokenA, '125000000')],
        [tokenB, post(reader, 2, tokenB, '7000000')]]);
      writer = new DatabaseSync(path);
      assert.equal(reader.db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
      assert.equal(writer.prepare('PRAGMA journal_mode').get()!.journal_mode, 'wal');
      const expected = reader.assetTotals();
      assert.equal(expected.length, 2);
      const before = { payments: rows(reader.db, 'payments'), journals: rows(reader.db, 'journals'),
        audit: rows(reader.db, 'audit'), sequence: rows(reader.db, 'sqlite_sequence'),
        changes: reader.db.prepare('SELECT total_changes() AS n').get()!.n };
      const actualPrepare = reader.db.prepare.bind(reader.db);
      let preparations = 0, iterations = 0, yielded = 0, commits = 0;
      // Delegate the production SQL and native rows unchanged. Only pause the
      // consumer between native iterator yields to schedule another connection.
      const preparation = t.mock.method(reader.db, 'prepare', (sql: string) => {
        preparations++;
        const statement = actualPrepare(sql), actualIterate = statement.iterate.bind(statement);
        statement.iterate = function* () {
          iterations++;
          for (const row of actualIterate()) {
            yielded++;
            yield row;
            if (yielded === 1) {
              assert.equal(row.kind, 'asset');
              const victimToken = row.token === tokenA ? tokenB : tokenA;
              const victim = ids.get(victimToken)!;
              // Choose the other asset without depending on SQLite row order.
              assert.notEqual(victimToken, row.token);
              assert.equal(writer!.isTransaction, false);
              const change = fault === 'missing journal'
                ? writer!.prepare('DELETE FROM journals WHERE payment_id=?').run(victim)
                : writer!.prepare('UPDATE journals SET amount=? WHERE payment_id=?').run('private-invalid-amount', victim);
              assert.equal(Number(change.changes), 1);
              assert.equal(writer!.isTransaction, false, 'The second connection committed while the reader cursor remained active');
              if (fault === 'missing journal') assert.equal(rows(writer!, 'journals').length, 1);
              else assert.equal(writer!.prepare('SELECT amount FROM journals WHERE payment_id=?').get(victim)!.amount, 'private-invalid-amount');
              commits++;
            }
          }
          return undefined;
        };
        return statement;
      });
      let report: ReturnType<Store['assetTotals']>;
      try { report = reader.assetTotals(); }
      finally { preparation.mock.restore(); }
      assert.deepEqual({ preparations, iterations, yielded, commits },
        { preparations: 1, iterations: 1, yielded: 2, commits: 1 });
      assert.deepEqual(report, expected, 'The active read must retain both original assets after the other connection commits');
      assert.equal(reader.db.isTransaction, false);
      assert.equal(reader.db.prepare('SELECT total_changes() AS n').get()!.n, before.changes);
      assert.deepEqual(rows(reader.db, 'payments'), before.payments);
      assert.deepEqual(rows(reader.db, 'audit'), before.audit);
      assert.deepEqual(rows(reader.db, 'sqlite_sequence'), before.sequence);
      const committedJournals = rows(writer, 'journals');
      assert.notDeepEqual(committedJournals, before.journals);
      assert.deepEqual(rows(reader.db, 'journals'), committedJournals, 'A fresh statement sees the committed writer change');
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.throws(() => reader!.assetTotals(), error => error instanceof JournalIntegrityError && error.message === fixed);
        assert.equal(reader.db.isTransaction, false);
        assert.equal(reader.db.prepare('SELECT total_changes() AS n').get()!.n, before.changes);
        assert.deepEqual(rows(reader.db, 'journals'), committedJournals);
      }
      passed = true;
    } finally {
      // Attempt every close and preserve scratch if a check or close failed.
      const failures: unknown[] = [];
      try { writer?.close(); } catch (error) { failures.push(error); }
      try { reader?.close(); } catch (error) { failures.push(error); }
      if (passed && failures.length === 0) {
        assert.equal(dirname(resolve(directory)), scratch);
        rmSync(directory, { recursive: true, force: true });
      }
      if (failures.length) throw new AggregateError(failures, 'Could not close totals snapshot fixtures');
    }
  });
}
