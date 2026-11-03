const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('Invoice extract refresh waits for completion without requesting it twice', () => {
  const properties = new Map();
  let refreshCount = 0;
  let executionState = 'RUNNING';
  let refreshedAt = new Date('2026-10-26T08:00:00Z');
  const target = {
    name: 'Invoice_weekly_extract', type: 'extract',
    refresh: () => { refreshCount++; },
    getStatus: () => ({
      getExecutionState: () => executionState,
      getErrorCode: () => 'NONE',
      getErrorMessage: () => null,
      getLastExecutionTime: () => null,
      getLastRefreshedTime: () => refreshedAt,
      isTruncated: () => false
    })
  };
  const context = vm.createContext({
    Logger: { log: () => {} },
    SpreadsheetApp: { enableBigQueryExecution: () => {} },
    Utilities: { newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    }) }
  });
  const root = path.resolve(__dirname, '..');
  for (const file of ['invoices/1.Config.js', 'invoices/5.Deployment.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  context.getInvoiceConnectedSheetTargets_ = () => [target];
  const stage = { status: 'processing', attempts: 1, refreshRequestedAt: new Date().toISOString() };
  const state = { operationId: 'test-operation', reportKey: 'invoices', stages: { extracts: stage } };
  context.persistInvoiceDeploymentState_(state);
  const spreadsheet = {};
  assert.equal(context.refreshInvoiceConnectedSheetsStage_('extracts', spreadsheet, state).status, 'pending');
  assert.equal(refreshCount, 1);
  executionState = 'SUCCESS';
  refreshedAt = new Date(Date.now() + 1000);
  assert.equal(context.refreshInvoiceConnectedSheetsStage_('extracts', spreadsheet, state).status, 'passed');
  assert.equal(refreshCount, 1);
});

test('Invoice weekly refresh remains queued when a configuration deployment is active', () => {
  const properties = new Map();
  let nextId = 0;
  const context = vm.createContext({
    Logger: { log: () => {} },
    Utilities: {
      getUuid: () => 'operation-' + (++nextId),
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) })
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value)
    }) }
  });
  const root = path.resolve(__dirname, '..');
  for (const file of ['invoices/1.Config.js', 'invoices/5.Deployment.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  context.ensureInvoiceDeploymentRecoveryTrigger_ = () => {};
  context.scheduleInvoiceDeploymentWorker_ = () => {};
  const active = {
    operationId: 'configuration-operation', reportKey: 'invoices',
    status: 'processing', currentStage: 'extracts'
  };
  context.persistInvoiceDeploymentState_(active);
  assert.equal(
    context.queueInvoiceWeeklySheetRefresh_({ status: 'passed' }, { status: 'passed' }).status,
    'queued_after_current'
  );
  const deferred = context.readInvoiceDeploymentState_();
  assert.ok(deferred.weeklyRefreshRequestedAt);
  deferred.status = 'completed';
  context.persistInvoiceDeploymentState_(deferred);
  assert.equal(context.queueDeferredInvoiceWeeklySheetRefresh_(deferred).status, 'queued');
  const next = context.readInvoiceDeploymentState_();
  assert.notEqual(next.operationId, active.operationId);
  assert.equal(next.currentStage, 'data_source_sheets');
});
