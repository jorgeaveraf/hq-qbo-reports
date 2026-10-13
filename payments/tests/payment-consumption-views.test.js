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

test('latest view hides voided payments without changing raw storage', () => {
  const context = loadContext();
  const plan = context.getPaymentConsumptionViewPlan();

  assert.equal(plan.modifiesBigQuery, false);
  assert.equal(plan.views.length, 1);
  assert.equal(plan.views[0].preservesRawVoidedRows, true);
  assert.match(plan.views[0].sql, /CREATE OR REPLACE VIEW `qbo-gateway-reporting\.views\.vw_payment_report_latest`/);
  assert.match(plan.views[0].sql, /FROM `qbo-gateway-reporting\.raw\.payment_snapshots`/);
  assert.match(plan.views[0].sql, /COALESCE\(IsVoided, FALSE\) = FALSE/);
  assert.doesNotMatch(plan.views[0].sql, /DELETE|TRUNCATE|DROP/i);
});

test('consumption view verification passes only for the filtered latest partition', () => {
  const context = loadContext();
  context.runBigQueryQuery_ = sql => {
    assert.match(sql, /INFORMATION_SCHEMA\.VIEWS/);
    assert.match(sql, /COUNTIF\(COALESCE\(IsVoided, FALSE\)\)/);
    return {
      rows: [{ f: [
        { v: 'true' },
        { v: 'true' },
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
  assert.equal(result.excludesVoided, true);
  assert.equal(result.voidedRowCount, 0);
});

test('consumption view verification blocks refresh when voided rows are exposed', () => {
  const context = loadContext();
  context.runBigQueryQuery_ = () => ({
    rows: [{ f: [
      { v: 'true' },
      { v: 'false' },
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
