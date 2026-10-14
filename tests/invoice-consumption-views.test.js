const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContext() {
  const context = vm.createContext({ Logger: { log: () => {} } });
  const root = path.resolve(__dirname, '..');
  ['invoices/1.Config.js', 'invoices/5.Deployment.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  });
  return context;
}

test('invoice consumption deployment plan is read-only and preserves both existing projections', () => {
  const context = loadContext();
  let queryCount = 0;
  context.runBigQuerySingleRowQuery_ = () => { queryCount++; };
  const plan = context.getInvoiceConsumptionDeploymentPlan();
  assert.equal(plan.modifiesBigQuery, false);
  assert.equal(plan.schemaChanges.length, 2);
  assert.equal(plan.views.length, 2);
  assert.equal(queryCount, 0);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.views.map(view => view.name))),
    ['vw_invoice_reports', 'vw_latest_invoice_reports']
  );
  plan.views.forEach(view => {
    assert.match(view.sql, /NOT EXISTS/);
    assert.match(view.sql, /voided_headers\.RecordType = 'HEADER'/);
    assert.match(view.sql, /COALESCE\(voided_headers\.IsVoided, FALSE\)/);
    assert.match(view.sql, /invoices\.LoadedAt/);
    assert.doesNotMatch(view.sql, /invoices\.PrivateNote/);
  });
});

test('invoice view verification accepts matching active raw and visible row counts', () => {
  const context = loadContext();
  let sql = '';
  context.runBigQuerySingleRowQuery_ = query => {
    sql = query;
    return {
      views_exist: true,
      exclude_voided: true,
      history_actual_rows: 100,
      history_expected_rows: 100,
      latest_actual_rows: 20,
      latest_expected_rows: 20,
      visible_voided_rows: 0
    };
  };
  const result = context.verifyInvoiceConsumptionViews_();
  assert.equal(result.status, 'passed');
  assert.match(sql, /vw_invoice_reports/);
  assert.match(sql, /vw_latest_invoice_reports/);
  assert.match(sql, /visible_voided_rows/);
});

test('invoice view verification fails when a voided invoice remains visible', () => {
  const context = loadContext();
  context.runBigQuerySingleRowQuery_ = () => ({
    views_exist: true,
    exclude_voided: true,
    history_actual_rows: 101,
    history_expected_rows: 100,
    latest_actual_rows: 20,
    latest_expected_rows: 20,
    visible_voided_rows: 1
  });
  assert.throws(
    () => context.verifyInvoiceConsumptionViews_(),
    /Invoice consumption view validation failed/
  );
});

test('invoice schema appends void evidence without changing existing column order', () => {
  const context = loadContext();
  const names = JSON.parse(vm.runInContext(
    'JSON.stringify(INVOICE_BIGQUERY_SCHEMA.map(function (field) { return field.name; }))',
    context
  ));
  assert.deepEqual(names.slice(-3), ['Source', 'PrivateNote', 'IsVoided']);
});
