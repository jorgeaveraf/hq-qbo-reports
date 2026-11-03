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

test('P&L refresh discovers monthly extracts even when cached targets omit them', () => {
  const context = loadPnlContext();
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'profit-and-loss/5.Deployment.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'profit-and-loss/5.Deployment.js' });
  const spreadsheet = { getId: () => 'report-sheet' };
  const cached = { spreadsheetId: 'report-sheet', reports: {
    profit_and_loss: { dataSourceSheets: ['weekly'], extracts: ['P&L_weekly_extract'] },
    profit_and_loss_by_class: { dataSourceSheets: ['class-weekly'], extracts: ['P&L_byClass_weekly_extract'] }
  } };
  context.__propertyValues[vm.runInContext('PNL_OPERATIONAL_DEPLOYMENT.connectedSheetTargetsProperty', context)] = JSON.stringify(cached);
  context.discoverPnlConnectedSheetTargets_ = () => ({
    spreadsheetId: 'report-sheet', reports: {
      profit_and_loss: { dataSourceSheets: ['weekly', 'monthly'], extracts: ['P&L_weekly_extract', 'P&L_monthly_extract'] },
      profit_and_loss_by_class: { dataSourceSheets: ['class-weekly', 'class-monthly'], extracts: ['P&L_byClass_weekly_extract', 'P&L_byClass_monthly_extract'] }
    }
  });
  const result = context.loadOrDiscoverPnlConnectedSheetTargets_(spreadsheet);
  assert.equal(result.reports.profit_and_loss.extracts.includes('P&L_monthly_extract'), true);
  assert.equal(JSON.parse(context.__propertyValues[
    vm.runInContext('PNL_OPERATIONAL_DEPLOYMENT.connectedSheetTargetsProperty', context)
  ]).reports.profit_and_loss_by_class.extracts.includes('P&L_byClass_monthly_extract'), true);
});

test('plans 12 closed P&L weeks and already-due intersecting months without external calls', () => {
  const context = loadPnlContext();
  let externalCalls = 0;
  context.runPnlBigQueryQuery_ = () => { externalCalls++; };
  context.fetchProfitAndLossReport_ = () => { externalCalls++; };
  const plan = context.getPnlRollingReconciliationPlan('2026-10-19');
  assert.equal(plan.strategy, 'rolling_closed_weeks_and_due_months');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startWeek, '2026-07-27');
  assert.equal(plan.endWeek, '2026-10-12');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.periods.length, 12);
  assert.deepEqual(Array.from(plan.monthlyPeriods, period => period.snapshotWeek), [
    '2026-07-01', '2026-08-01', '2026-09-01'
  ]);
  assert.equal(plan.jobs.length, 30);
  assert.equal(plan.jobs.filter(job => job.variant === 'normal').length, 15);
  assert.equal(plan.jobs.filter(job => job.variant === 'by_class').length, 15);
  assert.equal(plan.jobs.filter(job => job.snapshotType === 'WEEKLY').length, 24);
  assert.equal(plan.jobs.filter(job => job.snapshotType === 'MONTHLY').length, 6);
  assert.equal(externalCalls, 0);
});

test('does not plan a monthly rebuild before its normal day-10 snapshot date', () => {
  const context = loadPnlContext();
  const beforeDueDate = context.buildPnlRollingReconciliationPlan_('2026-10-05');
  assert.doesNotMatch(
    JSON.stringify(beforeDueDate.monthlyPeriods), /2026-09-01/,
    'September must not be created before October 10'
  );
  const onDueDate = context.buildPnlRollingReconciliationPlan_('2026-10-10');
  assert.match(JSON.stringify(onDueDate.monthlyPeriods), /2026-09-01/);
});

test('monthly rolling periods always rebuild complete calendar months', () => {
  const context = loadPnlContext();
  const periods = context.buildPnlRollingMonthlyPeriods_(
    '2026-07-27', '2026-10-18', '2026-10-19'
  );
  assert.deepEqual(JSON.parse(JSON.stringify(periods)), [
    {
      snapshotType: 'MONTHLY', snapshotDate: '2026-08-10', snapshotWeek: '2026-07-01',
      dateFrom: '2026-07-01', dateTo: '2026-07-31', periodKey: '2026-07-01|2026-07-31'
    },
    {
      snapshotType: 'MONTHLY', snapshotDate: '2026-09-10', snapshotWeek: '2026-08-01',
      dateFrom: '2026-08-01', dateTo: '2026-08-31', periodKey: '2026-08-01|2026-08-31'
    },
    {
      snapshotType: 'MONTHLY', snapshotDate: '2026-10-10', snapshotWeek: '2026-09-01',
      dateFrom: '2026-09-01', dateTo: '2026-09-30', periodKey: '2026-09-01|2026-09-30'
    }
  ]);
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
  const state = {
    plan,
    completedByVariant: {
      normal: { weekly: 12, monthly: 3 }, by_class: { weekly: 12, monthly: 3 }
    },
    outsideWindowBaseline: { normal: baseline, by_class: baseline }
  };
  context.getPnlBigQueryContract_ = variant => ({ tableName: 'p.raw.' + variant });
  context.runPnlBigQueryQuery_ = query => String(query).includes('actual_month_count') ? ({
    schema: { fields: [
      { name: 'actual_month_count' }, { name: 'noncanonical_row_count' }, { name: 'duplicate_key_count' }
    ] },
    rows: [{ f: [{ v: '3' }, { v: '0' }, { v: '0' }] }]
  }) : ({
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
    completedByVariant: {
      normal: { weekly: 12, monthly: 3 }, by_class: { weekly: 12, monthly: 3 }
    },
    outsideWindowBaseline: { normal: baseline, by_class: baseline }
  };
  context.getPnlBigQueryContract_ = variant => ({ tableName: 'p.raw.' + variant });
  context.runPnlBigQueryQuery_ = query => String(query).includes('actual_month_count') ? ({
    schema: { fields: [
      { name: 'actual_month_count' }, { name: 'noncanonical_row_count' }, { name: 'duplicate_key_count' }
    ] },
    rows: [{ f: [{ v: '3' }, { v: '0' }, { v: '0' }] }]
  }) : ({
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
  assert.equal(result.variants.normal.completedMonthCount, 3);
});

test('a still-running plan is resumed instead of being overwritten by a newer Monday', () => {
  const context = loadPnlContext();
  const current = {
    planVersion: '2026-pnl-rolling-v2', status: 'pending',
    plan: context.buildPnlRollingReconciliationPlan_('2026-10-12'), jobIndex: 7
  };
  let scheduled = 0;
  context.validatePnlRollingPreflight_ = () => ({});
  context.readPnlRollingState_ = () => current;
  context.replacePnlRollingSchedule_ = () => { scheduled++; };
  context.ensurePnlRollingRecoveryTrigger_ = () => {};
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
  context.ensurePnlRollingRecoveryTrigger_ = () => {};
  context.deletePnlRollingRecoveryTriggers_ = () => {};
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
    planVersion: '2026-pnl-rolling-v2', status: 'pending', currentStage: 'bigquery',
    jobIndex: 29, plan, currentClientIds: Array.from({ length: 16 }, (_, index) => 'c'.repeat(35) + index),
    completedCount: 29, retriedClientCount: 16,
    completedByVariant: {
      normal: { weekly: 12, monthly: 3 }, by_class: { weekly: 12, monthly: 2 }
    },
    configuration: { normal: 'a'.repeat(64), by_class: 'b'.repeat(64) },
    outsideWindowBaseline: {
      normal: { rowCount: 999999, distinctKeyCount: 999999, rowFingerprint: '-9223372036854775808' },
      by_class: { rowCount: 9999999, distinctKeyCount: 9999999, rowFingerprint: '9223372036854775807' }
    },
    lastResult: {
      status: 'completed', variant: 'by_class', snapshotType: 'MONTHLY', snapshotWeek: '2026-09-01',
      rowCount: 999999, clientCount: 16, verification: 'passed'
    },
    lastError: 'e'.repeat(1500), stageAttempts: 2,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z', completedAt: null
  };
  const bytes = context.persistPnlRollingState_(state);
  assert.ok(bytes < 8500, 'serialized state was ' + bytes + ' bytes');
});

test('P&L final sheet checkpoints stay below the property limit', () => {
  const context = loadPnlContext();
  const plan = context.buildPnlRollingReconciliationPlan_('2026-11-03');
  const execution = name => ({
    name, type: 'extract', state: 'SUCCESS', errorCode: 'NONE', errorMessage: null,
    lastExecutionAt: '2026-11-03T21:38:57.000Z',
    lastRefreshedAt: '2026-11-03T21:38:57.000Z', truncated: false
  });
  const refresh = names => ({
    status: 'passed', reportKey: 'all', stage: 'extracts',
    refreshedObjectCount: names.length, executions: names.map(execution)
  });
  const state = {
    operationId: 'x'.repeat(36), report: 'profit_and_loss', planVersion: '2026-pnl-rolling-v2',
    status: 'completed', currentStage: 'completed', jobIndex: plan.jobs.length, plan,
    currentClientIds: null, completedCount: plan.jobs.length, retriedClientCount: 0,
    completedByVariant: { normal: { weekly: 12, monthly: 3 }, by_class: { weekly: 12, monthly: 3 } },
    configuration: { normal: 'a'.repeat(64), by_class: 'b'.repeat(64) },
    outsideWindowBaseline: {
      normal: { rowCount: 999999, distinctKeyCount: 999999, rowFingerprint: '-9223372036854775808' },
      by_class: { rowCount: 999999, distinctKeyCount: 999999, rowFingerprint: '9223372036854775807' }
    },
    finalValidation: { status: 'passed', variants: { normal: { outsideWindowUnchanged: true }, by_class: { outsideWindowUnchanged: true } } },
    lastResult: { status: 'completed', variant: 'by_class', snapshotType: 'MONTHLY', snapshotWeek: '2026-09-01', rowCount: 999999, clientCount: 16, verification: 'passed' },
    lastError: null, stageAttempts: 0, createdAt: '2026-11-03T20:00:00.000Z',
    updatedAt: '2026-11-03T21:38:57.000Z', completedAt: '2026-11-03T21:38:57.000Z'
  };
  const names = ['P&L_latest_extract', 'P&L_weekly_extract', 'P&L_monthly_extract',
    'P&L_byClass_weekly_extract', 'P&L_byClass_latest_extract', 'P&L_byClass_monthly_extract'];
  state.dataSourceSheets = context.summarizePnlRollingSheetRefresh_(refresh(names));
  state.extracts = context.summarizePnlRollingSheetRefresh_(refresh(names));
  assert.equal(state.extracts.refreshedObjectCount, 6);
  assert.equal(state.extracts.names.length, 6);
  const bytes = context.persistPnlRollingState_(state);
  assert.ok(bytes < 8500, 'serialized state was ' + bytes + ' bytes');
  state.dataSourceSheets = refresh(names);
  state.extracts = refresh(names);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 8500);
  assert.ok(context.persistPnlRollingState_(state) < 8500);
  assert.equal(state.dataSourceSheets.executions, undefined);
});

test('P&L finalization resumes only after successful validation and source refresh', () => {
  const context = loadPnlContext();
  const state = {
    status: 'failed', currentStage: 'extracts', stageAttempts: 3, lastError: 'state too large',
    operationId: 'operation', plan: { jobs: [{}, {}] }, completedCount: 2,
    finalValidation: { status: 'passed' }, dataSourceSheets: { status: 'passed' }
  };
  let scheduled = 0;
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.readPnlRollingState_ = () => state;
  context.persistPnlRollingState_ = () => 0;
  context.ensurePnlRollingRecoveryTrigger_ = () => {};
  context.replacePnlRollingSchedule_ = () => { scheduled++; };
  assert.equal(context.resumePnlRollingFinalization().status, 'scheduled');
  assert.equal(state.status, 'pending');
  assert.equal(state.stageAttempts, 0);
  assert.equal(scheduled, 1);
  state.status = 'failed';
  state.finalValidation.status = 'failed';
  assert.throws(() => context.resumePnlRollingFinalization(), /fully validated/);
});
