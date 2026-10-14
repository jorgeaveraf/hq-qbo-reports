const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBalanceContext() {
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
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js',
    'balance-sheet/5.Deployment.js',
    'balance-sheet/6.Backfill.js',
    'balance-sheet/7.RollingReconciliation.js'
  ].forEach(file => vm.runInContext(
    fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }
  ));
  context.__propertyValues = propertyValues;
  return context;
}

test('plans 12 closed Balance Sheet weeks without external calls', () => {
  const context = loadBalanceContext();
  let externalCalls = 0;
  context.runBalanceBigQueryQuery_ = () => { externalCalls++; };
  context.fetchBalanceSheet_ = () => { externalCalls++; };
  const plan = context.getBalanceRollingReconciliationPlan('2026-10-19');
  assert.equal(plan.strategy, 'rolling_closed_weeks');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startWeek, '2026-07-27');
  assert.equal(plan.endWeek, '2026-10-12');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.periods.length, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.periods.at(-1))), {
    snapshotType: 'WEEKLY', snapshotWeek: '2026-10-12',
    asOfDate: '2026-10-18', snapshotDate: '2026-10-19'
  });
  assert.equal(externalCalls, 0);
});

test('weekly cadence starts rolling reconciliation and monthly keeps its existing path', () => {
  const context = loadBalanceContext();
  context.resolveBalanceSnapshotRange_ = event => event.range;
  context.startBalanceRollingReconciliation = () => ({ mode: 'rolling' });
  context.runBalanceSnapshotRange_ = range => ({ mode: 'existing', range });
  assert.equal(context.snapshotBalanceSheetToBigQuery({
    range: { snapshotType: 'WEEKLY' }
  }).mode, 'rolling');
  assert.equal(context.snapshotBalanceSheetToBigQuery({
    range: { snapshotType: 'MONTHLY' }
  }).mode, 'existing');
});

test('rolling retry processes only failed Balance Sheet clients', () => {
  const context = loadBalanceContext();
  const state = {
    configurationHash: 'hash', expectedClientIds: ['existing', 'missing'],
    currentClientIds: null, retriedClientCount: 0
  };
  context.loadBalanceEntityConfiguration_ = () => ({
    configuration: { configuration_hash: 'hash' }
  });
  const requested = [];
  context.executeBalanceSheetBigQuerySnapshot_ = (_loaded, options) => {
    requested.push(Array.from(options.clientIds));
    assert.equal(options.forceClientScope, true);
    assert.equal(options.returnPartialResult, true);
    if (requested.length === 1) return {
      lineRowCount: 10, clientCount: 2, verification: { status: 'passed' },
      clientFailures: [{ clientId: 'missing', error: 'temporary' }]
    };
    return {
      lineRowCount: 4, clientCount: 1, verification: { status: 'passed' }, clientFailures: []
    };
  };
  context.persistBalanceRollingState_ = () => 0;
  const range = context.buildBalanceRollingReconciliationPlan_('2026-10-19').periods[0];
  assert.throws(() => context.executeBalanceRollingWeek_(range, state), /entity failures/);
  assert.deepEqual(Array.from(state.currentClientIds), ['missing']);
  assert.equal(context.executeBalanceRollingWeek_(range, state).status, 'completed');
  assert.deepEqual(requested, [['existing', 'missing'], ['missing']]);
});

test('a successful Balance Sheet subset uses client replacement and preserves other clients', () => {
  const context = loadBalanceContext();
  let partitionReplaceCalled = false;
  let clientReplaceIds = null;
  context.buildBalanceSheetSnapshot_ = () => ({
    entityConfiguration: {}, snapshotType: 'WEEKLY', snapshotDate: '2026-10-19',
    snapshotWeek: '2026-10-12', requestedAsOfDate: '2026-10-18', clientCount: 1,
    successfulClientIds: ['missing-client'], clientFailures: [], rawRows: [{ ClientId: 'missing-client' }],
    lineRows: [{ ClientId: 'missing-client' }]
  });
  context.validateBalanceSheetBigQuerySchema_ = () => ({ status: 'passed' });
  context.replaceBalanceSheetSnapshotClients_ = snapshot => {
    clientReplaceIds = Array.from(snapshot.successfulClientIds);
    return { mode: 'successful_clients_replace', state: 'DONE' };
  };
  context.replaceBalanceSheetSnapshotPartition_ = () => {
    partitionReplaceCalled = true;
    return { state: 'DONE' };
  };
  context.verifyBalanceSheetSnapshotPartition_ = () => ({ status: 'passed' });
  context.executeBalanceSheetBigQuerySnapshot_(null, {
    clientIds: ['missing-client'], forceClientScope: true, returnPartialResult: true
  });
  assert.equal(partitionReplaceCalled, false);
  assert.deepEqual(clientReplaceIds, ['missing-client']);
});

test('an all-client failure can return a retryable partial result without writing BigQuery', () => {
  const context = loadBalanceContext();
  context.buildBalanceSheetSnapshot_ = () => ({
    entityConfiguration: {}, snapshotType: 'WEEKLY', snapshotDate: '2026-10-19',
    snapshotWeek: '2026-10-12', requestedAsOfDate: '2026-10-18', clientCount: 1,
    successfulClientIds: [], clientFailures: [{ clientId: 'a', error: 'timeout' }],
    rawRows: [], lineRows: []
  });
  context.validateBalanceSheetBigQuerySchema_ = () => { throw new Error('must not write'); };
  const result = context.executeBalanceSheetBigQuerySnapshot_(null, { returnPartialResult: true });
  assert.equal(result.status, 'completed_with_entity_errors');
  assert.equal(result.loadResult.mode, 'no_successful_clients');
  assert.deepEqual(Array.from(result.clientFailures).map(item => item.clientId), ['a']);
});

test('empty successful rows still create an empty typed staging table', () => {
  const context = loadBalanceContext();
  let tableCreated = 0;
  let loadStarted = 0;
  context.BigQuery = {
    Tables: {
      get: () => ({ schema: { fields: [{ name: 'ClientId', type: 'STRING' }] } }),
      insert: () => { tableCreated++; }
    },
    Jobs: { insert: () => { loadStarted++; } }
  };
  const result = context.loadBalanceRowsToStaging_('raw', 'source', 'stage', [], 'job');
  assert.equal(tableCreated, 1);
  assert.equal(loadStarted, 0);
  assert.equal(result.outputRows, 0);
});

test('canonical verification includes the full date tuple and ignores Amount as identity', () => {
  const context = loadBalanceContext();
  let sql = '';
  context.runBalanceBigQueryQuery_ = query => {
    sql = query;
    return { rows: [{ f: [{ v: '2' }, { v: '0' }, { v: '2' }] }] };
  };
  const result = context.verifyBalanceSheetSnapshotPartition_(
    '2026-10-19', '2026-10-12', '2026-10-18', 2, ['a'], 'WEEKLY'
  );
  assert.equal(result.status, 'passed');
  assert.match(sql, /SnapshotDate = DATE '2026-10-19'/);
  assert.match(sql, /SnapshotWeek = DATE '2026-10-12'/);
  assert.match(sql, /AsOfDate = DATE '2026-10-18'/);
  assert.doesNotMatch(sql, /CAST\(Amount AS STRING\)/);
});

test('client-scoped replacement preserves daily legacy rows sharing SnapshotDate', () => {
  const context = loadBalanceContext();
  const sql = context.buildBalanceAtomicReplaceSql_(
    'p.raw.balance', 'p.raw.stage', ['SnapshotDate', 'ClientId'],
    '2026-10-19', '2026-10-12', '2026-10-18', 'WEEKLY', "'client-a'"
  );
  assert.match(sql, /T\.SnapshotDate = DATE '2026-10-19'/);
  assert.match(sql, /T\.SnapshotWeek = DATE '2026-10-12'/);
  assert.match(sql, /T\.AsOfDate = DATE '2026-10-18'/);
  assert.match(sql, /T\.ClientId IN \('client-a'\)/);
});

test('final validation requires audit coverage and unchanged out-of-scope rows', () => {
  const context = loadBalanceContext();
  const plan = context.buildBalanceRollingReconciliationPlan_('2026-10-19');
  const baseline = {
    snapshots: { rowCount: 100, rowFingerprint: '1' },
    audit: { rowCount: 20, rowFingerprint: '2' }
  };
  const state = {
    plan, expectedClientIds: ['a', 'b'], completedCount: 12,
    createdAt: '2026-10-19T00:00:00.000Z', outsideScopeBaseline: baseline
  };
  context.runBalanceBigQueryQuery_ = () => ({
    schema: { fields: [
      { name: 'actual_line_week_count' }, { name: 'duplicate_line_count' },
      { name: 'covered_client_week_count' }, { name: 'duplicate_audit_count' },
      { name: 'processed_noncanonical_count' }
    ] },
    rows: [{ f: [{ v: '12' }, { v: '0' }, { v: '24' }, { v: '0' }, { v: '0' }] }]
  });
  context.readBalanceRollingOutsideFingerprints_ = () => baseline;
  assert.equal(context.validateBalanceRollingReconciliation_(state).status, 'passed');
  context.readBalanceRollingOutsideFingerprints_ = () => ({ ...baseline, snapshots: { rowCount: 99, rowFingerprint: '9' } });
  assert.throws(() => context.validateBalanceRollingReconciliation_(state), /final validation failed/);
});

test('failed final validation blocks Balance Sheet Connected Sheets refresh', () => {
  const context = loadBalanceContext();
  let refreshCount = 0;
  const state = {
    status: 'pending', currentStage: 'validation', stageAttempts: 0,
    plan: context.buildBalanceRollingReconciliationPlan_('2026-10-19'), updatedAt: null
  };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.ScriptApp = { getProjectTriggers: () => [] };
  context.readBalanceRollingState_ = () => state;
  context.persistBalanceRollingState_ = () => 0;
  context.replaceBalanceRollingSchedule_ = () => {};
  context.deleteBalanceRollingTriggers_ = () => {};
  context.validateBalanceRollingReconciliation_ = () => { throw new Error('validation failed'); };
  context.refreshBalanceConnectedSheetsStage_ = () => { refreshCount++; };
  assert.throws(() => context.processBalanceRollingReconciliation(), /validation failed/);
  assert.equal(refreshCount, 0);
});

test('configuration deployment uses a canonical weekly range instead of today', () => {
  const context = loadBalanceContext();
  context.validateBalanceEntityConfiguration_ = value => value;
  context.getBalanceWeeklySnapshotRange_ = () => ({
    snapshotType: 'WEEKLY', snapshotWeek: '2026-10-12',
    snapshotDate: '2026-10-19', asOfDate: '2026-10-18'
  });
  let options = null;
  context.executeBalanceSheetBigQuerySnapshot_ = (_loaded, received) => {
    options = received;
    return { status: 'completed' };
  };
  context.executeBalanceDeploymentStage_('bigquery', {
    configuration: { configuration_hash: 'hash' },
    configurationVersion: 'v1', configurationHash: 'hash'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(options)), {
    snapshotType: 'WEEKLY', snapshotDate: '2026-10-19', snapshotWeek: '2026-10-12',
    asOfDate: '2026-10-18', requireAsOfDateMatch: true
  });
});

test('an active Balance Sheet rolling plan is resumed without changing its window', () => {
  const context = loadBalanceContext();
  const current = {
    planVersion: '2026-balance-rolling-v1', status: 'pending',
    plan: context.buildBalanceRollingReconciliationPlan_('2026-10-12'), weekIndex: 7
  };
  let scheduled = 0;
  context.validateBalanceRollingPreflight_ = () => ({});
  context.readBalanceRollingState_ = () => current;
  context.replaceBalanceRollingSchedule_ = () => { scheduled++; };
  context.resolveBalanceEntitySelection_ = () => {
    throw new Error('a resumed plan must not select a new client set');
  };
  const result = context.startBalanceRollingReconciliation('2026-10-19');
  assert.equal(result, current);
  assert.equal(result.weekIndex, 7);
  assert.equal(result.plan.endWeek, '2026-10-05');
  assert.equal(scheduled, 1);
});

test('full productive Balance Sheet rolling state stays below Script Properties limit', () => {
  const context = loadBalanceContext();
  const plan = context.buildBalanceRollingReconciliationPlan_('2026-10-19');
  const ids = Array.from({ length: 20 }, (_, index) =>
    String(index).padStart(8, '0') + '-aaaa-bbbb-cccc-' + String(index).padStart(12, '0'));
  const state = {
    operationId: 'x'.repeat(36), report: 'balance_sheet',
    planVersion: '2026-balance-rolling-v1', status: 'pending', currentStage: 'bigquery',
    weekIndex: 11, plan, expectedClientIds: ids, currentClientIds: ids,
    completedCount: 11, retriedClientCount: 20,
    configurationVersion: 'v'.repeat(100), configurationHash: 'h'.repeat(64),
    outsideScopeBaseline: {
      snapshots: { rowCount: 9999999, rowFingerprint: '-9223372036854775808' },
      audit: { rowCount: 999999, rowFingerprint: '9223372036854775807' }
    },
    lastResult: { status: 'completed', snapshotWeek: '2026-10-05', rowCount: 999999,
      clientCount: 20, verification: 'passed' },
    lastError: 'e'.repeat(1500), stageAttempts: 2,
    createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    completedAt: null
  };
  const bytes = context.persistBalanceRollingState_(state);
  assert.ok(bytes < 8500, 'serialized state was ' + bytes + ' bytes');
});
