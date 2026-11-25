const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContext() {
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      sleep: () => {}
    },
    Logger: { log: () => {} }
  });
  const root = path.resolve(__dirname, '..');
  for (const file of ['invoices/1.Config.js', 'invoices/3.Functions.js', 'invoices/7.RollingReconciliation.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return context;
}

test('stages one client and one week, then checkpoints the next unit', () => {
  const context = loadContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-11-23');
  const state = {
    plan, clientIds: ['a', 'b'], jobIndex: 0, completedJobs: 0,
    expectedRowCount: 0, expectedInvoiceCount: 0,
    currentStage: 'staging', configurationHash: 'hash', stageTableId: 'stage'
  };
  let requestedWeek;
  let staged;
  let deleteQuery;
  context.loadInvoiceEntityConfiguration_ = () => ({ configuration: { configuration_hash: 'hash' } });
  context.fetchClients_ = () => ({ a: { id: 'a' }, b: { id: 'b' } });
  context.buildInvoiceRollingClientSnapshot_ = (client, week) => {
    requestedWeek = week.firstPeriod.snapshotWeek;
    assert.equal(client.id, 'a');
    return { rows: [{ idempotency_key: 'key' }], invoiceCount: 1,
      sourceInvoiceCount: 1, schemaBaselineUpdate: null };
  };
  context.validateInvoiceRollingSnapshotRows_ = () => ({ status: 'passed' });
  context.buildInvoiceBigQueryRows_ = rows => rows;
  context.runBigQuerySingleRowQuery_ = sql => { deleteQuery = sql; return {}; };
  context.loadInvoiceRollingStagingChunks_ = (rows, table, token, limit, append) => {
    staged = { rows, table, append };
  };
  context.persistInvoiceSchemaBaselineUpdates_ = () => {};

  context.stageInvoiceRollingJob_(state);
  assert.equal(requestedWeek, plan.firstPeriod.snapshotWeek);
  assert.match(deleteQuery, /DELETE FROM `[^`]+stage`/);
  assert.match(deleteQuery, /ClientId IN \('a'\)/);
  assert.equal(staged.table, 'stage');
  assert.equal(staged.append, true);
  assert.equal(state.jobIndex, 1);
  assert.equal(state.expectedRowCount, 1);
  assert.equal(state.currentStage, 'staging');
});

test('publishes the staged scope only after count and uniqueness checks pass', () => {
  const context = loadContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-11-23', 1);
  const state = { plan, clientIds: ['a', 'b'], stageTableId: 'stage', configurationHash: 'hash',
    expectedRowCount: 2, currentStage: 'publish' };
  const queries = [];
  context.loadInvoiceEntityConfiguration_ = () => ({ configuration: { configuration_hash: 'hash' } });
  context.runBigQuerySingleRowQuery_ = sql => {
    queries.push(sql);
    if (queries.length === 1) return { row_count: 2, distinct_key_count: 2, out_of_scope_count: 0 };
    if (queries.length === 2) return { duplicate_invoice_week_count: 0 };
    return {};
  };
  context.buildInvoiceMartInsertSql_ = scope => 'INSERT MART WHERE ' + scope;

  context.publishInvoiceRollingStage_(state);
  assert.equal(queries.length, 3);
  assert.match(queries[2], /^BEGIN TRANSACTION;/);
  assert.match(queries[2], /INSERT MART WHERE invoices\.SnapshotWeek/);
  assert.match(queries[2], /COMMIT TRANSACTION;/);
  assert.equal(state.currentStage, 'validation');
});

test('refuses publication when a staged retry left duplicate rows', () => {
  const context = loadContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-11-23', 1);
  const state = { plan, clientIds: ['a'], stageTableId: 'stage', configurationHash: 'hash',
    expectedRowCount: 2, currentStage: 'publish' };
  let calls = 0;
  context.loadInvoiceEntityConfiguration_ = () => ({ configuration: { configuration_hash: 'hash' } });
  context.runBigQuerySingleRowQuery_ = () => {
    calls++;
    return { row_count: 3, distinct_key_count: 2, out_of_scope_count: 0 };
  };
  assert.throws(() => context.publishInvoiceRollingStage_(state), /failed row, key or scope validation/);
  assert.equal(calls, 1);
  assert.equal(state.currentStage, 'publish');
});

test('recovers a timed-out execution without resetting its client/week checkpoint', () => {
  const context = loadContext();
  const state = {
    operationId: 'run-1', status: 'running', currentStage: 'staging',
    jobIndex: 47, updatedAt: new Date(Date.now() - 3600000).toISOString()
  };
  let scheduled = 0;
  context.readInvoiceRollingWorkerState_ = () => state;
  context.ScriptApp = { getProjectTriggers: () => [] };
  context.scheduleInvoiceRollingWorker_ = () => { scheduled++; };
  const result = context.recoverInvoiceRollingReconciliation();
  assert.equal(result.status, 'rescheduled');
  assert.equal(scheduled, 1);
  assert.equal(state.jobIndex, 47);
});

test('worker checkpoints every staged unit before scheduling the next run', () => {
  const context = loadContext();
  const state = {
    status: 'pending', currentStage: 'staging',
    plan: { periods: [{}] }, clientIds: ['a', 'b', 'c'],
    jobIndex: 0, completedJobs: 0, attempts: 0
  };
  const checkpoints = [];
  let scheduled = 0;
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.deleteInvoiceRollingWorkerTriggers_ = () => {};
  context.readInvoiceRollingWorkerState_ = () => state;
  context.persistInvoiceRollingWorkerState_ = value => checkpoints.push(value.jobIndex);
  context.stageInvoiceRollingJob_ = value => {
    value.jobIndex++;
    value.completedJobs++;
    if (value.jobIndex === 3) value.currentStage = 'publish';
  };
  context.scheduleInvoiceRollingWorker_ = () => { scheduled++; };

  context.processInvoiceRollingReconciliation();
  assert.equal(state.jobIndex, 3);
  assert.deepEqual(checkpoints, [0, 1, 2, 3, 3]);
  assert.equal(state.status, 'pending');
  assert.equal(scheduled, 1);
});

test('client/week staging appends to the persistent run table', () => {
  const context = loadContext();
  let loadConfig;
  context.Utilities.newBlob = value => ({ getBytes: () => Array.from(Buffer.from(value)) });
  context.BigQuery = { Jobs: { insert: request => {
    loadConfig = request.configuration.load;
    return { jobReference: { projectId: 'qbo-gateway-reporting', jobId: 'load-1' } };
  } } };
  context.waitForBigQueryJob_ = () => ({
    jobReference: { jobId: 'load-1' }, status: { state: 'DONE' }
  });
  context.loadInvoiceRollingStagingChunks_([{ ClientId: 'a' }], 'stage', 'token', null, true);
  assert.equal(loadConfig.destinationTable.tableId, 'stage');
  assert.equal(loadConfig.createDisposition, 'CREATE_NEVER');
  assert.equal(loadConfig.writeDisposition, 'WRITE_APPEND');
});
