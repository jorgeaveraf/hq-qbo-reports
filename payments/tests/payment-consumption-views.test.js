const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContext() {
  const context = vm.createContext({});
  const projectDir = path.resolve(__dirname, '..');
  ['1.Config.js', '5.Deployment.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });
  return context;
}

test('consumption views expose the linked document number as column T without changing raw storage', () => {
  const context = loadContext();
  const plan = context.getPaymentConsumptionViewPlan();

  assert.equal(plan.modifiesBigQuery, false);
  assert.equal(plan.views.length, 2);

  const accumulated = plan.views.find(view => view.name === 'vw_payment_reports_accumulated');
  const latest = plan.views.find(view => view.name === 'vw_payment_report_latest');
  assert.ok(accumulated);
  assert.ok(latest);

  for (const view of [accumulated, latest]) {
    assert.equal(view.preservesRawVoidedRows, true);
    assert.match(view.sql, /FROM `qbo-gateway-reporting\.raw\.payment_snapshots`/);
    assert.match(
      view.sql,
      /LineAmountSigned,\n  LinkedTxnType,\n  LinkedTxnReferenceNumber,\n  LinkedTxnOpenBalance,/
    );
    assert.doesNotMatch(view.sql, /DELETE|TRUNCATE|DROP/i);
  }

  assert.match(accumulated.sql, /CREATE OR REPLACE VIEW `qbo-gateway-reporting\.views\.vw_payment_reports_accumulated`/);
  assert.doesNotMatch(accumulated.sql, /COALESCE\(IsVoided, FALSE\) = FALSE/);
  assert.match(latest.sql, /CREATE OR REPLACE VIEW `qbo-gateway-reporting\.views\.vw_payment_report_latest`/);
  assert.match(latest.sql, /COALESCE\(IsVoided, FALSE\) = FALSE/);
});

test('consumption view verification passes only for the filtered latest partition', () => {
  const context = loadContext();
  context.runBigQueryQuery_ = sql => {
    assert.match(sql, /INFORMATION_SCHEMA\.VIEWS/);
    assert.match(sql, /INFORMATION_SCHEMA\.COLUMNS/);
    assert.match(sql, /ordinal_position = 20/);
    assert.match(sql, /COUNTIF\(COALESCE\(IsVoided, FALSE\)\)/);
    return {
      rows: [{ f: [
        { v: 'true' },
        { v: 'true' },
        { v: 'true' },
        { v: '100' },
        { v: '100' },
        { v: '20' },
        { v: '20' },
        { v: '0' },
        { v: '2026-10-05' },
        { v: '2026-10-05' }
      ] }]
    };
  };

  const result = context.verifyPaymentConsumptionViews_();
  assert.equal(result.status, 'passed');
  assert.equal(result.latestExcludesVoided, true);
  assert.equal(result.documentNumberIsColumnT, true);
  assert.equal(result.accumulatedActualRowCount, 100);
  assert.equal(result.voidedRowCount, 0);
});

test('consumption view verification blocks refresh when voided rows are exposed', () => {
  const context = loadContext();
  context.runBigQueryQuery_ = () => ({
    rows: [{ f: [
      { v: 'true' },
      { v: 'false' },
      { v: 'true' },
      { v: '100' },
      { v: '100' },
      { v: '21' },
      { v: '20' },
      { v: '1' },
      { v: '2026-10-05' },
      { v: '2026-10-05' }
    ] }]
  });

  assert.throws(
    () => context.verifyPaymentConsumptionViews_(),
    /Payments consumption view validation failed/
  );
});

test('consumption view verification blocks refresh when the document number is not column T', () => {
  const context = loadContext();
  context.runBigQueryQuery_ = () => ({
    rows: [{ f: [
      { v: 'true' },
      { v: 'true' },
      { v: 'false' },
      { v: '100' },
      { v: '100' },
      { v: '20' },
      { v: '20' },
      { v: '0' },
      { v: '2026-10-05' },
      { v: '2026-10-05' }
    ] }]
  });

  assert.throws(
    () => context.verifyPaymentConsumptionViews_(),
    /Payments consumption view validation failed/
  );
});
