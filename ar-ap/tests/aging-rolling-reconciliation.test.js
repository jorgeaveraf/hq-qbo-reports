const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadContext() {
  const context = vm.createContext({
    console,
    Utilities: {
      formatDate: date => date.toISOString().slice(0, 10),
      getUuid: () => 'uuid-1'
    },
    Logger: { log: () => {} }
  });
  const root = path.resolve(__dirname, '..');
  ['1.Config.js', '3.Functions.js', '5.Deployment.js', '6.Backfill.js', '7.RollingReconciliation.js']
    .forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }));
  return context;
}

function install(context, name, implementation) {
  context.__implementation = implementation;
  vm.runInContext(`${name} = __implementation`, context);
  delete context.__implementation;
}

test('planner exposes exactly the previous 12 completed Sunday snapshots', () => {
  const context = loadContext();
  const plan = context.getAgingRollingReconciliationPlan('2026-10-14');
  assert.equal(plan.strategy, 'rolling_closed_sundays');
  assert.equal(plan.periods.length, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.periods[0])), {
    snapshotWeek: '2026-07-20', snapshotDate: '2026-07-26', asOfDate: '2026-07-26'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(plan.periods.at(-1))), {
    snapshotWeek: '2026-10-05', snapshotDate: '2026-10-11', asOfDate: '2026-10-11'
  });
  plan.periods.forEach(period => {
    assert.equal(new Date(period.snapshotDate + 'T00:00:00Z').getUTCDay(), 0);
    assert.equal(new Date(period.snapshotWeek + 'T00:00:00Z').getUTCDay(), 1);
  });
});

test('public planner is read-only', () => {
  const context = loadContext();
  let touched = false;
  context.PropertiesService = { getScriptProperties: () => { touched = true; throw new Error('state'); } };
  context.ScriptApp = { newTrigger: () => { touched = true; throw new Error('trigger'); } };
  context.BigQuery = { Jobs: { query: () => { touched = true; throw new Error('query'); } } };
  assert.equal(context.getAgingRollingReconciliationPlan('2026-10-14').weekCount, 12);
  assert.equal(touched, false);
});

test('subset deployment initializes only requested clients and disables stale cleanup', () => {
  const context = loadContext();
  install(context, 'validateAgingEntityConfiguration_', value => value);
  install(context, 'getAgingSnapshotClients_', () => ({
    selection: { source: 'test', configuration: {
      report_key: 'aging', configuration_version: 1, configuration_hash: 'hash', entities: [{}]
    } },
    clients: [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  }));
  install(context, 'buildAgingEntityConfigurationSummary_', () => ({}));
  install(context, 'validateAgingBigQuerySchema_', () => ({ status: 'passed' }));
  install(context, 'persistAgingBigQueryCheckpoint_', () => ({}));
  const checkpoint = context.initializeAgingBigQueryCheckpoint_({
    operation_id: 'op', configuration_version: 1, configuration_hash: 'hash',
    configuration: {}, source: 'test', selected_client_ids: ['b'],
    range: { snapshotDate: '2026-10-11', snapshotWeek: '2026-10-05' }
  });
  assert.deepEqual(Array.from(checkpoint.clients, item => item.id), ['b']);
  assert.equal(checkpoint.is_client_subset, true);
});

test('failed clients are selected for a subset retry while successful totals are retained', () => {
  const context = loadContext();
  const state = {
    plan: { periods: [{ snapshotDate: '2026-10-11', snapshotWeek: '2026-10-05' }] },
    jobIndex: 0, configurationHash: 'hash', childOperationId: 'child-1',
    currentClientIds: null, currentRetryCount: 0,
    currentAccum: [0, 0, 0, 0, 0, 0], retriedClientCount: 0
  };
  install(context, 'loadAgingEntityConfiguration_', () => ({ configuration: { configuration_hash: 'hash' } }));
  install(context, 'readAgingDeploymentState_', () => ({
    operation_id: 'child-1', status: 'failed', last_error: 'one client failed'
  }));
  install(context, 'readAgingBigQueryCheckpoint_', () => ({
    operation_id: 'child-1', row_count: 5, unique_row_count: 5,
    report_row_counts: { AR: 3, AP: 2 }, open_amount_cents: { AR: 1000, AP: 2000 },
    clients: [{ id: 'a' }, { id: 'b' }], successful_client_ids: ['a'],
    client_failures: [{ clientId: 'b' }], current_client: null
  }));

  const result = context.advanceAgingRollingJob_(state);
  assert.equal(result.reason, 'failed_clients_selected_for_retry');
  assert.deepEqual(Array.from(state.currentClientIds), ['b']);
  assert.deepEqual(Array.from(state.currentAccum), [5, 5, 3, 2, 1000, 2000]);
  assert.equal(state.childOperationId, null);
});

test('final validation rejects bad coverage before refresh stages', () => {
  const context = loadContext();
  const state = {
    plan: { weekCount: 12, startDate: '2026-07-26', endDate: '2026-10-11' },
    completedCount: 12,
    expectedByDate: { '2026-10-11': [1, 1, 1, 0, 100, 0] },
    outsideWindowBaseline: { rowCount: 5, rowFingerprint: 'abc' }
  };
  let call = 0;
  install(context, 'runAgingBigQueryQuery_', () => {
    call++;
    if (call === 1) return {
      schema: { fields: [
        'row_count', 'actual_week_count', 'unique_row_count', 'ar_row_count', 'ap_row_count',
        'ar_open_amount', 'ap_open_amount', 'noncanonical_date_count',
        'invalid_report_type_count', 'invalid_bucket_count'
      ].map(name => ({ name })) },
      rows: [{ f: ['1', '1', '0', '1', '0', '1', '0', '0', '0', '0'].map(v => ({ v })) }]
    };
    return {
      schema: { fields: [{ name: 'row_count' }, { name: 'row_fingerprint' }] },
      rows: [{ f: [{ v: '5' }, { v: 'abc' }] }]
    };
  });
  assert.throws(() => context.validateAgingRollingReconciliation_(state), /final validation failed/);
});

test('final validation accepts a completed zero-row week proven by worker state', () => {
  const context = loadContext();
  const expectedByDate = {};
  context.buildAgingRollingReconciliationPlan_('2026-10-14').periods.forEach(period => {
    expectedByDate[period.snapshotDate] = [0, 0, 0, 0, 0, 0];
  });
  const state = {
    plan: context.buildAgingRollingReconciliationPlan_('2026-10-14'),
    completedCount: 12,
    expectedByDate,
    outsideWindowBaseline: { rowCount: 5, rowFingerprint: 'abc' }
  };
  let call = 0;
  install(context, 'runAgingBigQueryQuery_', () => {
    call++;
    if (call === 1) return {
      schema: { fields: [
        'row_count', 'actual_week_count', 'unique_row_count', 'ar_row_count', 'ap_row_count',
        'ar_open_amount', 'ap_open_amount', 'noncanonical_date_count',
        'invalid_report_type_count', 'invalid_bucket_count'
      ].map(name => ({ name })) },
      rows: [{ f: Array(10).fill(null).map(() => ({ v: '0' })) }]
    };
    return {
      schema: { fields: [{ name: 'row_count' }, { name: 'row_fingerprint' }] },
      rows: [{ f: [{ v: '5' }, { v: 'abc' }] }]
    };
  });

  const validation = context.validateAgingRollingReconciliation_(state);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.evidencedWeekCount, 12);
  assert.equal(validation.expectedNonEmptyWeekCount, 0);
  assert.equal(validation.actualWeekCount, 0);
});

test('final validation preserves repeated rows already present in the QBO source', () => {
  const context = loadContext();
  const state = {
    plan: { weekCount: 1, startDate: '2026-10-11', endDate: '2026-10-11' },
    completedCount: 1,
    expectedByDate: { '2026-10-11': [3, 2, 3, 0, -90000, 0] },
    outsideWindowBaseline: { rowCount: 5, rowFingerprint: 'abc' }
  };
  let call = 0;
  install(context, 'runAgingBigQueryQuery_', () => {
    call++;
    if (call === 1) return {
      schema: { fields: [
        'row_count', 'actual_week_count', 'unique_row_count', 'ar_row_count', 'ap_row_count',
        'ar_open_amount', 'ap_open_amount', 'noncanonical_date_count',
        'invalid_report_type_count', 'invalid_bucket_count'
      ].map(name => ({ name })) },
      rows: [{ f: ['3', '1', '2', '3', '0', '-900', '0', '0', '0', '0'].map(v => ({ v })) }]
    };
    return {
      schema: { fields: [{ name: 'row_count' }, { name: 'row_fingerprint' }] },
      rows: [{ f: [{ v: '5' }, { v: 'abc' }] }]
    };
  });

  const validation = context.validateAgingRollingReconciliation_(state);
  assert.equal(validation.status, 'passed');
  assert.equal(validation.expectedRepeatedSourceRowCount, 1);
  assert.equal(validation.actualRepeatedSourceRowCount, 1);
  assert.equal(validation.sourceRepetitionPreserved, true);
});

test('final validation rejects repetitions that were not present in the QBO source', () => {
  const context = loadContext();
  const state = {
    plan: { weekCount: 1, startDate: '2026-10-11', endDate: '2026-10-11' },
    completedCount: 1,
    expectedByDate: { '2026-10-11': [3, 3, 3, 0, -90000, 0] },
    outsideWindowBaseline: { rowCount: 5, rowFingerprint: 'abc' }
  };
  let call = 0;
  install(context, 'runAgingBigQueryQuery_', () => {
    call++;
    if (call === 1) return {
      schema: { fields: [
        'row_count', 'actual_week_count', 'unique_row_count', 'ar_row_count', 'ap_row_count',
        'ar_open_amount', 'ap_open_amount', 'noncanonical_date_count',
        'invalid_report_type_count', 'invalid_bucket_count'
      ].map(name => ({ name })) },
      rows: [{ f: ['3', '1', '2', '3', '0', '-900', '0', '0', '0', '0'].map(v => ({ v })) }]
    };
    return {
      schema: { fields: [{ name: 'row_count' }, { name: 'row_fingerprint' }] },
      rows: [{ f: [{ v: '5' }, { v: 'abc' }] }]
    };
  });

  assert.throws(
    () => context.validateAgingRollingReconciliation_(state),
    /sourceRepetitionPreserved.*false/
  );
});

test('final validation scopes canonical Sundays and fingerprints all legacy captures', () => {
  const context = loadContext();
  const plan = context.buildAgingRollingReconciliationPlan_('2026-10-14');
  const expectedByDate = {};
  plan.periods.forEach(period => {
    expectedByDate[period.snapshotDate] = [0, 0, 0, 0, 0, 0];
  });
  const state = {
    plan,
    completedCount: 12,
    expectedByDate,
    outsideWindowBaseline: { rowCount: 150520, rowFingerprint: 'legacy' }
  };
  const queries = [];
  install(context, 'runAgingBigQueryQuery_', query => {
    queries.push(query);
    if (queries.length === 1) return {
      schema: { fields: [
        'row_count', 'actual_week_count', 'unique_row_count', 'ar_row_count', 'ap_row_count',
        'ar_open_amount', 'ap_open_amount', 'noncanonical_date_count',
        'invalid_report_type_count', 'invalid_bucket_count'
      ].map(name => ({ name })) },
      rows: [{ f: Array(10).fill(null).map(() => ({ v: '0' })) }]
    };
    return {
      schema: { fields: [{ name: 'row_count' }, { name: 'row_fingerprint' }] },
      rows: [{ f: [{ v: '150520' }, { v: 'legacy' }] }]
    };
  });

  assert.equal(context.validateAgingRollingReconciliation_(state).status, 'passed');
  assert.match(queries[0], /snapshot_date IN UNNEST\(GENERATE_DATE_ARRAY/);
  assert.match(queries[1], /snapshot_date NOT IN UNNEST\(GENERATE_DATE_ARRAY/);
  assert.doesNotMatch(queries[0], /snapshot_date BETWEEN/);
});

test('a final-validation failure blocks every Connected Sheets refresh', () => {
  const context = loadContext();
  const state = {
    status: 'pending', currentStage: 'validation', updatedAt: null,
    plan: { periods: [], weekCount: 12 }, expectedByDate: {}
  };
  let refreshCount = 0;
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  install(context, 'readAgingRollingState_', () => state);
  install(context, 'persistAgingRollingState_', () => 100);
  install(context, 'deleteAgingRollingTriggers_', () => {});
  install(context, 'replaceAgingRollingSchedule_', () => {});
  install(context, 'validateAgingRollingReconciliation_', () => {
    throw new Error('validation failed');
  });
  install(context, 'refreshAgingConnectedSheetsStage_', () => {
    refreshCount++;
    return { status: 'passed' };
  });

  assert.throws(() => context.processAgingRollingReconciliation(), /validation failed/);
  assert.equal(refreshCount, 0);
  assert.equal(state.status, 'failed');
});

test('productive rolling state stays below the Script Property safety limit', () => {
  const context = loadContext();
  const plan = context.buildAgingRollingReconciliationPlan_('2026-10-14');
  const expectedByDate = {};
  plan.periods.forEach(period => { expectedByDate[period.snapshotDate] = [999999, 999999, 500000, 499999, 99999999999, -99999999999]; });
  const state = {
    operationId: '12345678-1234-1234-1234-123456789012', report: 'ar_ap',
    planVersion: context.AGING_ROLLING_RECONCILIATION && context.AGING_ROLLING_RECONCILIATION.planVersion,
    status: 'pending', currentStage: 'bigquery', jobIndex: 11, plan,
    configurationHash: 'a'.repeat(64), childOperationId: 'b'.repeat(36),
    currentClientIds: Array.from({ length: 30 }, (_, index) => 'client-' + String(index).padStart(2, '0')),
    currentRetryCount: 3, currentAccum: [999999, 999999, 500000, 499999, 99999999999, -99999999999],
    expectedByDate, completedCount: 11, retriedClientCount: 30,
    outsideWindowBaseline: { rowCount: 99999999, rowFingerprint: '9'.repeat(20) },
    lastResult: { snapshotDate: '2026-10-04', snapshotWeek: '2026-09-28', rowCount: 999999, status: 'completed' },
    lastError: 'x'.repeat(1500), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  assert.ok(bytes < 8500, `state size ${bytes}`);
});

test('scheduled aging cadence delegates to rolling reconciliation', () => {
  const context = loadContext();
  install(context, 'startAgingRollingReconciliation', () => ({ status: 'rolling' }));
  assert.equal(context.snapshotAgingToBigQuery().status, 'rolling');
});
