const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPnlContext() {
  const propertyValues = {};
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) }),
      sleep: () => {}
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => propertyValues[key] || null,
      setProperty: (key, value) => { propertyValues[key] = value; },
      deleteProperty: key => { delete propertyValues[key]; }
    }) },
    Logger: { log: () => {} },
    console
  });
  const root = path.resolve(__dirname, '..');
  [
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js',
    'profit-and-loss/6.Backfill.js',
    'profit-and-loss/7.RollingReconciliation.js'
  ].forEach(file => vm.runInContext(
    fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }
  ));
  context.__propertyValues = propertyValues;
  return context;
}

test('plans 12 closed P&L weeks for normal and by-class without external calls', () => {
  const context = loadPnlContext();
  let externalCalls = 0;
  context.runPnlBigQueryQuery_ = () => { externalCalls++; };
  context.fetchProfitAndLossReport_ = () => { externalCalls++; };
  const plan = context.getPnlRollingReconciliationPlan('2026-10-19');
  assert.equal(plan.strategy, 'rolling_closed_weeks');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startWeek, '2026-07-27');
  assert.equal(plan.endWeek, '2026-10-12');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.periods.length, 12);
  assert.equal(plan.jobs.length, 24);
  assert.equal(plan.jobs.filter(job => job.variant === 'normal').length, 12);
  assert.equal(plan.jobs.filter(job => job.variant === 'by_class').length, 12);
  assert.equal(externalCalls, 0);
});

test('weekly cadence starts rolling reconciliation while monthly cadence keeps its existing path', () => {
  const context = loadPnlContext();
  context.resolvePnlSnapshotRange_ = event => event.range;
  context.startPnlRollingReconciliation = () => ({ mode: 'rolling' });
  context.executeAllProfitAndLossReports_ = range => ({ mode: 'existing', range });
  assert.equal(context.snapshotAllProfitAndLossReports({
    range: { snapshotType: 'WEEKLY' }
  }).mode, 'rolling');
  assert.equal(context.snapshotAllProfitAndLossReports({
    range: { snapshotType: 'MONTHLY' }
  }).mode, 'existing');
});

test('rolling retry processes only failed clients and preserves successful clients', () => {
  const context = loadPnlContext();
  const plan = context.buildPnlRollingReconciliationPlan_('2026-10-19');
  const state = {
    plan,
    configuration: { normal: 'hash', by_class: 'hash' },
    currentClientIds: null,
    retriedClientCount: 0
  };
  context.getPnlVariantConfig_ = variant => ({ variantKey: variant });
  context.loadPnlEntityConfiguration_ = () => ({
    configuration: { configuration_hash: 'hash' }
  });
  context.resolvePnlEntitySelection_ = () => ({
    clients: [{ id: 'existing' }, { id: 'missing' }]
  });
  const requested = [];
  context.executeProfitAndLossVariantSnapshot_ = (_variant, _loaded, options) => {
    requested.push(Array.from(options.clientIds));
    if (requested.length === 1) return {
      rowCount: 10, clientCount: 2, verification: { status: 'passed' },
      clientFailures: [{ clientId: 'missing', error: 'temporary' }]
    };
    return {
      rowCount: 4, clientCount: 1, verification: { status: 'passed' }, clientFailures: []
    };
  };
  context.persistPnlRollingState_ = () => 0;
  const job = plan.jobs[0];
  assert.throws(() => context.executePnlRollingJob_(job, state), /entity failures/);
  assert.deepEqual(Array.from(state.currentClientIds), ['missing']);
  const result = context.executePnlRollingJob_(job, state);
  assert.equal(result.status, 'completed');
  assert.deepEqual(requested, [['existing', 'missing'], ['missing']]);
});

test('client-scoped P&L replacement does not delete existing clients outside the subset', () => {
  const context = loadPnlContext();
  let sql = '';
  context.getPnlBigQueryContract_ = () => ({ variant: 'normal', tableName: 'p.raw.pnl' });
  context.buildPnlBigQueryRows_ = rows => rows;
  context.runPnlBigQueryQuery_ = query => {
    sql = query;
    return { jobReference: { jobId: 'transaction' } };
  };
  context.waitForPnlBigQueryJob_ = () => {};
  context.BigQuery = {
    Jobs: { insert: request => ({ jobReference: request.jobReference }) },
    Tables: { remove: () => {} }
  };
  const range = {
    snapshotType: 'WEEKLY', snapshotWeek: '2026-10-12', snapshotDate: '2026-10-19',
    dateFrom: '2026-10-12', dateTo: '2026-10-18'
  };
  const row = {
    SnapshotType: 'WEEKLY', SnapshotWeek: '2026-10-12', ReportVariant: 'normal',
    ClientId: 'missing-client'
  };
  const result = context.replacePnlSnapshotScope_(range, [row], 'normal', ['missing-client']);
  assert.equal(result.mode, 'successful_clients_replace');
  assert.match(sql, /ClientId IN \('missing-client'\)/);
  assert.doesNotMatch(sql, /existing-client/);
});

test('a successful empty P&L client clears only its own stale rows', () => {
  const context = loadPnlContext();
  let sql = '';
  let stagingCalled = false;
  context.getPnlBigQueryContract_ = () => ({ variant: 'normal', tableName: 'p.raw.pnl' });
  context.buildPnlBigQueryRows_ = rows => rows;
  context.runPnlBigQueryQuery_ = query => {
    sql = query;
    return { jobReference: { jobId: 'transaction' } };
  };
  context.BigQuery = { Jobs: { insert: () => { stagingCalled = true; } }, Tables: { remove: () => {} } };
  const result = context.replacePnlSnapshotScope_({
    snapshotType: 'WEEKLY', snapshotWeek: '2026-10-12'
  }, [], 'normal', ['empty-client']);
  assert.equal(stagingCalled, false);
  assert.equal(result.rowCount, 0);
  assert.match(sql, /ClientId IN \('empty-client'\)/);
  assert.doesNotMatch(sql, /INSERT INTO/);
});

test('final validation rejects bad dates, duplicates, missing weeks, and outside-window drift', () => {
  const context = loadPnlContext();
  const plan = context.buildPnlRollingReconciliationPlan_('2026-10-19');
  const baseline = { rowCount: 10, distinctKeyCount: 10, rowFingerprint: '1' };
  const state = { plan, outsideWindowBaseline: { normal: baseline, by_class: baseline } };
  context.getPnlBigQueryContract_ = variant => ({ tableName: 'p.raw.' + variant });
  context.runPnlBigQueryQuery_ = () => ({
    schema: { fields: [
      { name: 'actual_week_count' }, { name: 'noncanonical_row_count' }, { name: 'duplicate_key_count' }
    ] },
    rows: [{ f: [{ v: '11' }, { v: '1' }, { v: '1' }] }]
  });
  context.readPnlRollingOutsideFingerprint_ = () => baseline;
  assert.throws(() => context.validatePnlRollingReconciliation_(state), /final validation failed/);
});

test('final validation accepts a processed zero-row week proven by the worker checkpoint', () => {
  const context = loadPnlContext();
  const plan = context.buildPnlRollingReconciliationPlan_('2026-10-19');
  const baseline = { rowCount: 10, distinctKeyCount: 10, rowFingerprint: '1' };
  const state = {
    plan,
    completedByVariant: { normal: 12, by_class: 12 },
    outsideWindowBaseline: { normal: baseline, by_class: baseline }
  };
  context.getPnlBigQueryContract_ = variant => ({ tableName: 'p.raw.' + variant });
  context.runPnlBigQueryQuery_ = () => ({
    schema: { fields: [
      { name: 'actual_week_count' }, { name: 'noncanonical_row_count' }, { name: 'duplicate_key_count' }
    ] },
    rows: [{ f: [{ v: '11' }, { v: '0' }, { v: '0' }] }]
  });
  context.readPnlRollingOutsideFingerprint_ = () => baseline;
  const result = context.validatePnlRollingReconciliation_(state);
  assert.equal(result.status, 'passed');
  assert.equal(result.variants.normal.actualWeekCount, 11);
  assert.equal(result.variants.normal.completedWeekCount, 12);
});

test('a still-running plan is resumed instead of being overwritten by a newer Monday', () => {
  const context = loadPnlContext();
  const current = {
    planVersion: '2026-pnl-rolling-v1', status: 'pending',
    plan: context.buildPnlRollingReconciliationPlan_('2026-10-12'), jobIndex: 7
  };
  let scheduled = 0;
  context.validatePnlRollingPreflight_ = () => ({});
  context.readPnlRollingState_ = () => current;
  context.replacePnlRollingSchedule_ = () => { scheduled++; };
  context.readPnlRollingOutsideFingerprint_ = () => {
    throw new Error('a resumed plan must not capture a new baseline');
  };
  const result = context.startPnlRollingReconciliation('2026-10-19');
  assert.equal(result, current);
  assert.equal(result.jobIndex, 7);
  assert.equal(scheduled, 1);
});

test('rolling worker blocks Connected Sheets refresh when final validation fails', () => {
  const context = loadPnlContext();
  let refreshCount = 0;
  const state = {
    status: 'pending', currentStage: 'validation', stageAttempts: 0,
    plan: context.buildPnlRollingReconciliationPlan_('2026-10-19'),
    outsideWindowBaseline: {}, updatedAt: null
  };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.ScriptApp = { getProjectTriggers: () => [] };
  context.readPnlRollingState_ = () => state;
  context.persistPnlRollingState_ = () => 0;
  context.replacePnlRollingSchedule_ = () => {};
  context.deletePnlRollingTriggers_ = () => {};
  context.validatePnlRollingReconciliation_ = () => { throw new Error('validation failed'); };
  context.refreshPnlConnectedSheetsStage_ = () => { refreshCount++; };
  assert.throws(() => context.processPnlRollingReconciliation(), /validation failed/);
  assert.equal(refreshCount, 0);
});

test('full productive P&L rolling state remains below the Script Properties limit', () => {
  const context = loadPnlContext();
  const plan = context.buildPnlRollingReconciliationPlan_('2026-10-19');
  const state = {
    operationId: 'x'.repeat(36), report: 'profit_and_loss',
    planVersion: '2026-pnl-rolling-v1', status: 'pending', currentStage: 'bigquery',
    jobIndex: 23, plan, currentClientIds: Array.from({ length: 16 }, (_, index) => 'c'.repeat(35) + index),
    completedCount: 23, retriedClientCount: 16, completedByVariant: { normal: 12, by_class: 11 },
    configuration: { normal: 'a'.repeat(64), by_class: 'b'.repeat(64) },
    outsideWindowBaseline: {
      normal: { rowCount: 999999, distinctKeyCount: 999999, rowFingerprint: '-9223372036854775808' },
      by_class: { rowCount: 9999999, distinctKeyCount: 9999999, rowFingerprint: '9223372036854775807' }
    },
    lastResult: {
      status: 'completed', variant: 'by_class', snapshotWeek: '2026-10-12',
      rowCount: 999999, clientCount: 16, verification: 'passed'
    },
    lastError: 'e'.repeat(1500), stageAttempts: 2,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', completedAt: null
  };
  const bytes = context.persistPnlRollingState_(state);
  assert.ok(bytes < 8500, 'serialized state was ' + bytes + ' bytes');
});
