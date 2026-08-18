const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadJournalContext() {
  const context = vm.createContext({
    Utilities: {
      formatDate(date) {
        return date.toISOString().slice(0, 10);
      }
    }
  });
  const projectDir = path.resolve(__dirname, '..');

  ['1.Config.js', '3.Functions.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });

  return context;
}

const columnMap = {
  tx_date: 0,
  txn_type: 1,
  doc_num: 2,
  name: 3,
  memo: 4,
  account_name: 5,
  debt_amt: 6,
  credit_amt: 7
};

function cells(values = {}) {
  return Object.keys(columnMap).map(key => {
    const source = values[key] || {};
    const cell = { value: source.value === undefined ? '' : source.value };
    if (source.id !== undefined) cell.id = source.id;
    return cell;
  });
}

function data(values) {
  return { type: 'Data', ColData: cells(values) };
}

function section(label, debit, credit) {
  return {
    type: 'Section',
    Summary: {
      ColData: cells({
        tx_date: { value: label },
        debt_amt: { value: debit },
        credit_amt: { value: credit }
      })
    }
  };
}

function report(rows) {
  return { columnMap, rows };
}

test('reproduces transaction 103460: zero-value placeholder may precede a normal accounting line', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-15' },
      txn_type: { value: 'Journal Entry', id: '103460' },
      memo: { value: 'zero-value placeholder' },
      debt_amt: { value: '0.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: '103460' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '100.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: '103460' },
      account_name: { value: 'Equity', id: 'equity' },
      credit_amt: { value: '100.00' }
    }),
    section('103460', '100.00', '100.00'),
    section('TOTAL', '100.00', '100.00')
  ]);

  const result = context.normalizeJournalReport_(journalReport);

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].accountName, 'Cash');
  assert.equal(result.rows[0].debitAmount, 100);
  assert.equal(result.rows[0].memoDescription, 'zero-value placeholder');
  assert.equal(result.rows[1].accountName, 'Equity');
  assert.equal(result.rows[1].creditAmount, 100);
});

test('still merges a genuine zero-value split row with its account continuation', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-15' },
      txn_type: { value: 'Journal Entry', id: 'split-zero' },
      memo: { value: 'split memo' },
      debt_amt: { value: '0.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: 'split-zero' },
      account_name: { value: 'Clearing', id: 'clearing' }
    }),
    section('split-zero', '0.00', '0.00'),
    section('TOTAL', '0.00', '0.00')
  ]);

  const result = context.normalizeJournalReport_(journalReport);

  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].accountName, 'Clearing');
  assert.equal(result.rows[0].memoDescription, 'split memo');
});

test('still rejects an unresolved split followed by another account-less amount row', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-15' },
      txn_type: { value: 'Journal Entry', id: 'invalid-split' },
      debt_amt: { value: '0.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: 'invalid-split' },
      debt_amt: { value: '10.00' }
    })
  ]);

  assert.throws(
    () => context.normalizeJournalReport_(journalReport),
    /Journal split row was not completed/
  );
});

test('reproduces transaction 47408: a balanced transaction may omit its summary section', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-15' },
      txn_type: { value: 'Journal Entry', id: '47408' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '25.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: '47408' },
      account_name: { value: 'Equity', id: 'equity' },
      credit_amt: { value: '25.00' }
    }),
    data({
      tx_date: { value: '2026-08-16' },
      txn_type: { value: 'Journal Entry', id: '47409' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '10.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: '47409' },
      account_name: { value: 'Equity', id: 'equity' },
      credit_amt: { value: '10.00' }
    }),
    section('47409', '10.00', '10.00'),
    section('TOTAL', '35.00', '35.00')
  ]);

  const result = context.normalizeJournalReport_(journalReport);

  assert.equal(result.transactionCount, 2);
  assert.equal(result.rows.length, 4);
});

test('still rejects an unbalanced transaction when its summary section is omitted', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-15' },
      txn_type: { value: 'Journal Entry', id: 'unbalanced' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '25.00' }
    }),
    data({
      tx_date: { value: '2026-08-16' },
      txn_type: { value: 'Journal Entry', id: 'next-transaction' },
      account_name: { value: 'Equity', id: 'equity' },
      credit_amt: { value: '25.00' }
    })
  ]);

  assert.throws(
    () => context.normalizeJournalReport_(journalReport),
    /Journal transaction unbalanced before source row 2 is not balanced/
  );
});

test('reproduces transaction 47583: a balanced final transaction may end without sections', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-16' },
      txn_type: { value: 'Journal Entry', id: '47583' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '40.00' }
    }),
    data({
      tx_date: { value: '0-00-00' },
      txn_type: { id: '47583' },
      account_name: { value: 'Equity', id: 'equity' },
      credit_amt: { value: '40.00' }
    })
  ]);

  const result = context.normalizeJournalReport_(journalReport);

  assert.equal(result.transactionCount, 1);
  assert.equal(result.rows.length, 2);
});

test('still rejects an unbalanced final transaction without sections', () => {
  const context = loadJournalContext();
  const journalReport = report([
    data({
      tx_date: { value: '2026-08-16' },
      txn_type: { value: 'Journal Entry', id: 'truncated-final' },
      account_name: { value: 'Cash', id: 'cash' },
      debt_amt: { value: '40.00' }
    })
  ]);

  assert.throws(
    () => context.normalizeJournalReport_(journalReport),
    /Journal transaction truncated-final at end of report is not balanced/
  );
});
