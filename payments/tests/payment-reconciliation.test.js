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
