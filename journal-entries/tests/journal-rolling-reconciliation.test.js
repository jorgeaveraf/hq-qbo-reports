const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadJournalRollingContext() {
  const propertyValues = {};
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    SpreadsheetApp: { getActiveSpreadsheet: () => null },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) })
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => propertyValues[key] || null,
      setProperty: (key, value) => { propertyValues[key] = value; },
      deleteProperty: key => { delete propertyValues[key]; }
    }) },
    Logger: { log: () => {} },
    console
  });
  const root = path.resolve(__dirname, '../..');
  [
    'journal-entries/1.Config.js',
    'journal-entries/3.Functions.js',
    'journal-entries/5.Deployment.js',
    'journal-entries/6.Backfill.js',
    'journal-entries/7.RollingReconciliation.js'
  ].forEach(file => vm.runInContext(
    fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }
  ));
  context.__propertyValues = propertyValues;
  return context;
}

test('public Journal planner returns exactly 12 closed canonical weeks without side effects', () => {
  const context = loadJournalRollingContext();
  let externalCalls = 0;
  context.runBigQueryQuery_ = () => { externalCalls++; };
  context.fetchJournalReport_ = () => { externalCalls++; };
  const plan = context.getJournalRollingReconciliationPlan('2026-10-19');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startWeek, '2026-07-27');
  assert.equal(plan.endWeek, '2026-10-12');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.periods.length, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.periods[0])), {
    snapshotDate: '2026-08-03', snapshotWeek: '2026-07-27',
    dateFrom: '2026-07-27', dateTo: '2026-08-02',
    periodKey: '2026-07-27|2026-08-02'
  });
  assert.equal(externalCalls, 0);
});

test('weekly Journal entry point starts rolling reconciliation', () => {
  const context = loadJournalRollingContext();
  context.startJournalRollingReconciliation = () => ({ mode: 'rolling' });
  assert.equal(context.snapshotJournalEntriesToBigQuery().mode, 'rolling');
});

test('subset checkpoint never schedules stale cleanup outside the requested clients', () => {
  const context = loadJournalRollingContext();
  let selectedIds = null;
  context.normalizeJournalLoadedEntityConfiguration_ = value => value;
  context.getJournalSnapshotClients_ = (_loaded, clientIds) => {
    selectedIds = Array.from(clientIds);
    return [{ id: 'missing', name: 'Missing', entityAlias: 'entity' }];
  };
  context.buildJournalEntityConfigurationSummary_ = () => ({ hash: 'hash' });
  context.validateJournalBigQuerySchema_ = () => ({ status: 'passed' });
  context.persistJournalBigQueryCheckpoint_ = () => ({ byteCount: 1 });
  const checkpoint = context.initializeJournalBigQueryCheckpoint_({
    operation_id: 'op', configuration_version: 1, configuration_hash: 'hash',
    period: {
      snapshotDate: '2026-10-19', snapshotWeek: '2026-10-12',
      dateFrom: '2026-10-12', dateTo: '2026-10-18',
      periodKey: '2026-10-12|2026-10-18'
    }
  }, { source: 'test', configuration: {} }, { clientIds: ['missing'] });
  assert.deepEqual(selectedIds, ['missing']);
  assert.equal(checkpoint.scope_mode, 'subset');
  assert.equal(checkpoint.stale_cleanup_job_id, null);
  assert.equal(checkpoint.stale_cleanup_completed, true);
  assert.match(context.buildJournalClientDeleteQuery_('2026-10-12', 'missing'), /ClientId = 'missing'/);
});

test('rolling retry requests only failed clients and leaves successful clients out of retry scope', () => {
  const context = loadJournalRollingContext();
  const plan = context.buildJournalRollingReconciliationPlan_('2026-10-19');
  const state = {
    operationId: 'op', configurationVersion: 1, configurationHash: 'hash',
    plan, jobIndex: 0, currentClientIds: null, retryGeneration: 0,
    jobAttempts: 0, lastResult: null
  };
  context.loadJournalEntityConfiguration_ = () => ({
    source: 'test', configuration: { configuration_hash: 'hash' }
  });
  const requested = [];
  context.executeJournalBigQueryContinuationStage_ = (_child, _loaded, options) => {
    requested.push(Array.from(options.clientIds));
    if (requested.length === 1) {
      return {
        status: 'completed_with_entity_errors', rowCount: 10, clientCount: 2,
        clientFailures: [{ clientId: 'missing', error: 'temporary' }]
      };
    }
    return {
      status: 'completed', rowCount: 4, clientCount: 1,
      verification: { status: 'passed' }, clientFailures: []
    };
  };
  context.deleteJournalBigQueryCheckpoint_ = () => true;
  assert.equal(context.executeJournalRollingJob_(state).status, 'retry_required');
  assert.deepEqual(Array.from(state.currentClientIds), ['missing']);
  assert.equal(context.executeJournalRollingJob_(state).status, 'completed');
  assert.deepEqual(requested, [[], ['missing']]);
});

test('client assembly rejects an out-of-period transaction before BigQuery replacement', () => {
  const context = loadJournalRollingContext();
  context.fetchJournalReport_ = () => ({ rows: [], columnMap: {} });
  context.normalizeJournalReport_ = () => ({
    transactionCount: 1,
    rows: [{ transactionId: 'late', transactionDate: '2026-10-19' }]
  });
  assert.throws(() => context.buildJournalClientSnapshot_(
    { id: 'client', name: 'Client', entityAlias: 'entity' },
    {
      snapshotDate: '2026-10-19', snapshotWeek: '2026-10-12',
      dateFrom: '2026-10-12', dateTo: '2026-10-18'
    },
    '2026-10-19T00:00:00.000Z'
  ), /outside the requested period/);
});

test('journal fetch fails closed when an explicitly returned Rows.Row is not an array', () => {
  const context = loadJournalRollingContext();
  context.fetchJsonOrThrow_ = () => ({
    client_id: 'client', environment: 'prod',
    data: {
      Header: {
        ReportName: 'JournalReport', StartPeriod: '2026-10-12',
        EndPeriod: '2026-10-18', Currency: 'USD'
      },
      Columns: { Column: [
        'tx_date', 'txn_type', 'doc_num', 'name', 'memo',
        'account_name', 'debt_amt', 'credit_amt'
      ].map(key => ({ MetaData: [{ Name: 'ColKey', Value: key }] })) },
      Rows: { Row: { malformed: true } }
    }
  });
  assert.throws(
    () => context.fetchJournalReport_('client', '2026-10-12', '2026-10-18'),
    /Rows\.Row to be an array/
  );
});

test('final validation rejects bad dates, duplicates, imbalance, and outside-window drift', () => {
  const context = loadJournalRollingContext();
  const plan = context.buildJournalRollingReconciliationPlan_('2026-10-19');
  context.loadJournalEntityConfiguration_ = () => ({
    configuration: { configuration_hash: 'hash' }
  });
  context.runBigQueryQuery_ = () => ({
    schema: { fields: [
      { name: 'actual_week_count' }, { name: 'noncanonical_row_count' },
      { name: 'transaction_outside_period_count' }, { name: 'missing_key_count' },
      { name: 'duplicate_key_count' }, { name: 'imbalanced_client_week_count' },
      { name: 'cross_week_duplicate_count' }
    ] },
    rows: [{ f: [
      { v: '12' }, { v: '1' }, { v: '1' }, { v: '0' }, { v: '1' }, { v: '1' }, { v: '1' }
    ] }]
  });
  context.readJournalRollingOutsideFingerprint_ = () => ({
    rowCount: 11, distinctKeyCount: 11, rowFingerprint: 'changed'
  });
  assert.throws(() => context.validateJournalRollingReconciliation_({
    plan, completedCount: 12, configurationHash: 'hash',
    outsideWindowBaseline: { rowCount: 10, distinctKeyCount: 10, rowFingerprint: 'original' }
  }), /final validation failed/);
});

test('final validation accepts a completed zero-row week proven by worker state', () => {
  const context = loadJournalRollingContext();
  const plan = context.buildJournalRollingReconciliationPlan_('2026-10-19');
  const baseline = { rowCount: 10, distinctKeyCount: 10, rowFingerprint: 'same' };
  context.loadJournalEntityConfiguration_ = () => ({
    configuration: { configuration_hash: 'hash' }
  });
  context.runBigQueryQuery_ = () => ({
    schema: { fields: [
      { name: 'actual_week_count' }, { name: 'noncanonical_row_count' },
      { name: 'transaction_outside_period_count' }, { name: 'missing_key_count' },
      { name: 'duplicate_key_count' }, { name: 'imbalanced_client_week_count' },
      { name: 'cross_week_duplicate_count' }
    ] },
    rows: [{ f: [
      { v: '11' }, { v: '0' }, { v: '0' }, { v: '0' }, { v: '0' }, { v: '0' }, { v: '0' }
    ] }]
  });
  context.readJournalRollingOutsideFingerprint_ = () => baseline;
  const result = context.validateJournalRollingReconciliation_({
    plan, completedCount: 12, configurationHash: 'hash', outsideWindowBaseline: baseline
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.actualWeekCount, 11);
  assert.equal(result.completedWeekCount, 12);
});

test('worker blocks both Connected Sheets refresh stages when final validation fails', () => {
  const context = loadJournalRollingContext();
  let refreshCount = 0;
  const state = {
    status: 'pending', currentStage: 'validation', jobIndex: 12,
    completedCount: 12, plan: context.buildJournalRollingReconciliationPlan_('2026-10-19'),
    stageAttempts: 2, updatedAt: null
  };
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.ScriptApp = { getProjectTriggers: () => [] };
  context.readJournalRollingState_ = () => state;
  context.persistJournalRollingState_ = () => 1;
  context.replaceJournalRollingSchedule_ = () => {};
  context.deleteJournalRollingTriggers_ = () => {};
  context.validateJournalRollingReconciliation_ = () => { throw new Error('validation failed'); };
  context.refreshJournalConnectedSheetsStage_ = () => { refreshCount++; };
  assert.throws(() => context.processJournalRollingReconciliation(), /validation failed/);
  assert.equal(refreshCount, 0);
  assert.equal(state.status, 'failed');
});

test('productive worst-case rolling state remains below Script Properties limit', () => {
  const context = loadJournalRollingContext();
  const plan = context.buildJournalRollingReconciliationPlan_('2026-10-19');
  const state = {
    operationId: 'x'.repeat(36), report: 'journal_entries',
    planVersion: '2026-journal-rolling-v1', status: 'pending', currentStage: 'bigquery',
    jobIndex: 11, completedCount: 11,
    currentClientIds: Array.from({ length: 20 }, (_, index) => 'c'.repeat(35) + index),
    retryGeneration: 2, jobAttempts: 2,
    stageAttempts: 2,
    configurationVersion: 999999, configurationHash: 'h'.repeat(64), plan,
    outsideWindowBaseline: {
      rowCount: 99999999, distinctKeyCount: 99999999,
      rowFingerprint: '-9223372036854775808'
    },
    lastResult: { status: 'retry_required', snapshotWeek: '2026-10-12', failedClientCount: 20 },
    lastError: 'e'.repeat(1500), createdAt: '2026-10-14T00:00:00.000Z',
    updatedAt: '2026-10-14T00:00:00.000Z', completedAt: null
  };
  const bytes = context.persistJournalRollingState_(state);
  assert.ok(bytes < 8500, 'serialized state was ' + bytes + ' bytes');
});

test('productive worst-case checkpoint remains below its Script Properties limit', () => {
  const context = loadJournalRollingContext();
  const clients = Array.from({ length: 16 }, (_, index) => ({
    id: 'c'.repeat(34) + String(index).padStart(2, '0'),
    name: 'Client name '.repeat(4) + index,
    entityAlias: 'entity_' + index
  }));
  const checkpoint = {
    schema_version: '1.0', operation_id: 'o'.repeat(36), configuration_version: 999,
    configuration_hash: 'h'.repeat(64),
    period: {
      snapshotDate: '2026-10-19', snapshotWeek: '2026-10-12',
      dateFrom: '2026-10-12', dateTo: '2026-10-18', periodKey: '2026-10-12|2026-10-18'
    },
    loaded_at: '2026-10-14T00:00:00.000Z', entity_configuration: {},
    schema_validation: {}, scope_mode: 'full', clients, next_client_index: 16,
    processed_client_count: 0, continuation_count: 20, total_transaction_count: 0,
    total_accounting_transaction_count: 0, total_row_count: 0,
    total_debit_cents: 0, total_credit_cents: 0, successful_client_ids: [],
    client_failures: clients.map(client => ({
      clientId: client.id, httpStatus: 500, error: 'e'.repeat(160)
    })),
    partition_cleared: true, clear_job_id: 'j'.repeat(200),
    stale_cleanup_job_id: 's'.repeat(200), stale_cleanup_completed: true,
    current_client: null, load_job_count: 0, query_job_count: 0,
    last_completed_client_id: null, last_job_id: null,
    created_at: '2026-10-14T00:00:00.000Z', updated_at: '2026-10-14T00:00:00.000Z'
  };
  const result = context.persistJournalBigQueryCheckpoint_(checkpoint);
  assert.ok(result.byteCount < 9000, 'serialized checkpoint was ' + result.byteCount + ' bytes');
});
