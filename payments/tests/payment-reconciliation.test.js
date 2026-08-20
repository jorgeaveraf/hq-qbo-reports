const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPaymentsContext() {
  const context = vm.createContext({});
  const projectDir = path.resolve(__dirname, '..');

  ['1.Config.js', '3.Functions.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });

  return context;
}

function line(amount, linkedTxnType = 'Invoice') {
  return {
    RecordType: 'LINE',
    LineAmountSigned: amount,
    LinkedTxnType: linkedTxnType
  };
}

test('reproduces payment 47532: a zero-cash payment may apply only a credit', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: '47532',
    TotalAmount: 0,
    UnappliedAmount: 0,
    IsVoided: false
  };

  assert.doesNotThrow(() => {
    context.validatePaymentReconciliation_(header, [line(-596.92, 'CreditMemo')]);
  });
});

test('treats a linked Check as a negative payment adjustment', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: 'check-adjustment',
    TotalAmount: 67.33,
    UnappliedAmount: 0,
    IsVoided: false
  };

  assert.equal(context.getPaymentLineSign_('Check'), -1);
  assert.doesNotThrow(() => {
    context.validatePaymentReconciliation_(header, [
      line(100, 'Invoice'),
      line(-32.67, 'Check')
    ]);
  });
});

test('resolves a JournalEntry direction from the payment reconciliation', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: '70429',
    TotalAmount: 2221.2,
    UnappliedAmount: 0,
    IsVoided: false
  };
  const rows = [{
    RecordType: 'LINE',
    LineAmountRaw: 2221.2,
    LineAmountSigned: -2221.2,
    LinkedTxnType: 'JournalEntry'
  }];

  context.resolvePaymentLineSigns_(header, rows);

  assert.equal(rows[0].LineAmountSigned, 2221.2);
  assert.doesNotThrow(() => context.validatePaymentReconciliation_(header, rows));
});

test('supports a bidirectional linked Expense', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: 'expense-linked-payment',
    TotalAmount: 226.64,
    UnappliedAmount: 0,
    IsVoided: false
  };
  const rows = [{
    RecordType: 'LINE',
    LineAmountRaw: 226.64,
    LineAmountSigned: -226.64,
    LinkedTxnType: 'Expense'
  }];

  context.resolvePaymentLineSigns_(header, rows);

  assert.equal(rows[0].LineAmountSigned, 226.64);
  assert.doesNotThrow(() => context.validatePaymentReconciliation_(header, rows));
});

test('retries transient gateway failures and returns the successful response', () => {
  const context = loadPaymentsContext();
  const statuses = [500, 429, 200];
  const sleeps = [];
  context.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => 'test-api-key' })
  };
  context.UrlFetchApp = {
    fetch: () => {
      const status = statuses.shift();
      return {
        getResponseCode: () => status,
        getContentText: () => status === 200 ? '{"ok":true}' : '{"message":"temporary"}'
      };
    }
  };
  context.Utilities = { sleep: delay => sleeps.push(delay) };
  context.Logger = { log: () => {} };

  const result = context.fetchJsonOrThrow_('https://example.invalid', 'test request');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: true });
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(statuses.length, 0);
});

test('does not retry a non-transient gateway response', () => {
  const context = loadPaymentsContext();
  let fetchCount = 0;
  context.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => 'test-api-key' })
  };
  context.UrlFetchApp = {
    fetch: () => {
      fetchCount++;
      return {
        getResponseCode: () => 400,
        getContentText: () => '{"message":"bad request"}'
      };
    }
  };
  context.Utilities = { sleep: () => assert.fail('400 responses must not be retried') };
  context.Logger = { log: () => {} };

  assert.throws(
    () => context.fetchJsonOrThrow_('https://example.invalid', 'test request'),
    /HTTP 400 after 1 attempt/
  );
  assert.equal(fetchCount, 1);
});

test('still rejects an active payment whose amounts do not reconcile', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: 'active-mismatch',
    TotalAmount: 0,
    UnappliedAmount: 0,
    IsVoided: false
  };

  assert.throws(
    () => context.validatePaymentReconciliation_(header, [line(-596.92)]),
    /Payment reconciliation failed/
  );
});

test('rejects a voided payment whose header still carries value', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: 'invalid-void',
    TotalAmount: 10,
    UnappliedAmount: 0,
    IsVoided: true
  };

  assert.throws(
    () => context.validatePaymentReconciliation_(header, [line(10)]),
    /Voided payment contains non-zero header amounts/
  );
});

test('allows a zeroed voided payment to retain historical application lines', () => {
  const context = loadPaymentsContext();
  const header = {
    PaymentId: 'voided-with-history',
    TotalAmount: 0,
    UnappliedAmount: 0,
    IsVoided: true
  };

  assert.doesNotThrow(() => {
    context.validatePaymentReconciliation_(header, [line(25)]);
  });
});
