const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHistoryRepairContext() {
  const properties = {};
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      newBlob: value => ({ getBytes: () => Buffer.from(String(value)) }),
      getUuid: () => '00000000-0000-4000-8000-000000000000'
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: key => properties[key] || null,
        setProperty: (key, value) => { properties[key] = value; }
      })
    }
  });
  const projectDir = path.resolve(__dirname, '..');
  ['1.Config.js', '3.Functions.js', '5.Deployment.js', '6.Backfill.js', '7.HistoryRepair.js']
    .forEach(fileName => {
      vm.runInContext(
        fs.readFileSync(path.join(projectDir, fileName), 'utf8'),
        context,
        { filename: fileName }
      );
    });
  context.__properties = properties;
  return context;
}

function stats(overrides = {}) {
  return {
    rowCount: 100,
    paymentCount: 40,
    clientCount: 2,
    weekCount: 28,
    invalidWeekCount: 0,
    invalidDateCount: 0,
    duplicateKeyCount: 0,
    fingerprint: '12345',
    minSnapshotWeek: '2026-01-05',
    maxSnapshotWeek: '2026-07-13',
    voidedRowCount: 2,
    ...overrides
  };
}

test('read-only repair planner targets exactly the 28 canonical weeks from January 5 through July 19', () => {
  const context = loadHistoryRepairContext();
  context.getPaymentHistoryRepairClients_ = () => ({
    loadedConfiguration: { configuration: {} },
    clients: [{ id: 'a' }, { id: 'b' }]
  });
  context.getPaymentHistoryRepairExistingClientIds_ = () => ['a', 'b'];
  context.getPaymentHistoryRepairScopeStats_ = () => stats({ invalidWeekCount: 5881 });
  context.getPaymentHistoryRepairProtectedStats_ = () => stats({
    rowCount: 200,
    fingerprint: 'protected'
  });
  context.getPaymentHistoryRepairBoundaryCollisions_ = () => 0;

  const plan = context.getPaymentHistoryRepairPlan2026();

  assert.equal(plan.status, 'planned_read_only');
  assert.equal(plan.modifiesBigQuery, false);
  assert.equal(plan.createsState, false);
  assert.equal(plan.createsTriggers, false);
  assert.equal(plan.startDate, '2026-01-05');
  assert.equal(plan.endDate, '2026-07-19');
  assert.equal(plan.periodCount, 28);
  assert.equal(plan.periods[0].snapshotWeek, '2026-01-05');
  assert.equal(plan.periods[27].snapshotWeek, '2026-07-13');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.unconfiguredHistoricalClientIds)), []);
});

test('cutover replaces only the affected SnapshotWeek partitions in one transaction', () => {
  const context = loadHistoryRepairContext();
  let capturedQuery = null;
  context.paymentHistoryRepairQueryJob_ = (jobId, query) => {
    capturedQuery = query;
    return { jobReference: { jobId } };
  };

  const result = context.cutoverPaymentHistoryRepair_({
    operation_id: 'op-1',
    start_date: '2026-01-05',
    snapshot_week_end: '2026-07-13'
  });

  assert.equal(result.status, 'completed');
  assert.match(capturedQuery, /BEGIN TRANSACTION/);
  assert.match(capturedQuery, /SnapshotWeek >= DATE '2026-01-05'/);
  assert.match(capturedQuery, /SnapshotWeek <= DATE '2026-07-13'/);
  assert.doesNotMatch(capturedQuery, /TxnDate\s*[<>]=/);
  assert.doesNotMatch(capturedQuery, /2026-07-20/);
  assert.match(capturedQuery, /COMMIT TRANSACTION/);
});

test('staging validation rejects duplicates before production cutover', () => {
  const context = loadHistoryRepairContext();
  context.getPaymentHistoryRepairScopeStats_ = () => stats({ duplicateKeyCount: 1 });

  assert.throws(
    () => context.validatePaymentHistoryRepairStage_({
      total_row_count: 100,
      total_payment_count: 40,
      data_periods: Object.fromEntries(
        Array.from({ length: 28 }, (_, index) => ['week-' + index, true])
      )
    }),
    /staging final validation failed/
  );
});

test('final validation blocks refresh evidence when the protected period changed', () => {
  const context = loadHistoryRepairContext();
  context.validatePaymentHistoryRepairStage_ = () => ({ status: 'passed', ...stats() });
  context.getPaymentHistoryRepairScopeStats_ = table =>
    table.includes('backup') ? stats({ fingerprint: 'before' }) : stats();
  context.getPaymentHistoryRepairProtectedStats_ = () => stats({
    rowCount: 201,
    fingerprint: 'changed'
  });
  context.getPaymentHistoryRepairBoundaryCollisions_ = () => 0;
  let viewValidationCalled = false;
  context.verifyPaymentConsumptionViews_ = () => {
    viewValidationCalled = true;
    return { status: 'passed' };
  };

  assert.throws(
    () => context.validatePaymentHistoryRepairFinal_({
      total_row_count: 100,
      total_payment_count: 40,
      data_periods: Object.fromEntries(
        Array.from({ length: 28 }, (_, index) => ['week-' + index, true])
      ),
      affected_before: stats({ fingerprint: 'before' }),
      protected_before: stats({ rowCount: 200, fingerprint: 'protected' })
    }),
    /final validation failed/
  );
  assert.equal(viewValidationCalled, false);
});

test('worker never refreshes Connected Sheets when final validation fails', () => {
  const context = loadHistoryRepairContext();
  let state = {
    operation_id: 'op-1',
    strategy: 'transaction_date_history_repair_v1',
    status: 'pending',
    current_stage: 'final_validation',
    current_attempts: 0,
    stages: { final_validation: 'pending' },
    clients: [],
    data_periods: {},
    total_client_count: 0,
    processed_client_count: 0,
    total_payment_count: 0,
    total_row_count: 0,
    created_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z'
  };
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  context.readPaymentHistoryRepairState_ = () => state;
  context.persistPaymentHistoryRepairState_ = next => { state = next; return { byteCount: 1 }; };
  context.replacePaymentHistoryRepairSchedule_ = () => ({});
  context.deletePaymentHistoryRepairTriggers_ = () => 0;
  context.assertPaymentDeploymentIdleForBackfill_ = () => {};
  context.validatePaymentHistoryRepairFinal_ = () => { throw new Error('fingerprint changed'); };
  let refreshCount = 0;
  context.refreshPaymentConnectedSheetsStage_ = () => {
    refreshCount++;
    return { status: 'passed', refreshedObjectCount: 1 };
  };

  assert.throws(
    () => context.processPaymentHistoryRepair2026(),
    /fingerprint changed/
  );
  assert.equal(refreshCount, 0);
  assert.equal(state.status, 'pending');
  assert.equal(state.current_stage, 'final_validation');
});

test('successful final validation proves raw equals staging, backup is preserved, and later weeks are unchanged', () => {
  const context = loadHistoryRepairContext();
  context.validatePaymentHistoryRepairStage_ = () => ({ status: 'passed', ...stats() });
  context.getPaymentHistoryRepairScopeStats_ = table =>
    table.includes('backup') ? stats({ fingerprint: 'before' }) : stats();
  context.getPaymentHistoryRepairProtectedStats_ = () => stats({
    rowCount: 200,
    fingerprint: 'protected'
  });
  context.getPaymentHistoryRepairBoundaryCollisions_ = () => 0;
  context.verifyPaymentConsumptionViews_ = () => ({ status: 'passed' });

  const result = context.validatePaymentHistoryRepairFinal_({
    total_row_count: 100,
    total_payment_count: 40,
    data_periods: Object.fromEntries(
      Array.from({ length: 28 }, (_, index) => ['week-' + index, true])
    ),
    affected_before: stats({ fingerprint: 'before' }),
    protected_before: stats({ rowCount: 200, fingerprint: 'protected' })
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.rawMatchesStage, true);
  assert.equal(result.backupPreserved, true);
  assert.equal(result.protectedUnchanged, true);
  assert.equal(result.consumptionViews.status, 'passed');
});

test('worst production repair state stays below the 9 KB Script Property limit', () => {
  const context = loadHistoryRepairContext();
  const clients = Array.from({ length: 20 }, (_, index) => ({
    id: '12345678-1234-1234-1234-' + String(index).padStart(12, '0'),
    name: 'Production client with a deliberately long display name ' + index,
    entity: 'multiclient',
    entityAlias: 'entity_alias_' + index
  }));
  const periods = Object.fromEntries(
    Array.from({ length: 28 }, (_, index) => ['2026-week-' + index, true])
  );
  const state = {
    schema_version: '1.0',
    strategy: 'transaction_date_history_repair_v1',
    operation_id: '00000000-0000-4000-8000-000000000000',
    configuration_version: 999,
    configuration_hash: 'a'.repeat(64),
    status: 'pending',
    current_stage: 'final_validation',
    current_attempts: 2,
    start_date: '2026-01-05',
    end_date: '2026-07-19',
    snapshot_week_end: '2026-07-13',
    protected_start_date: '2026-07-20',
    clients,
    total_client_count: clients.length,
    next_client_index: clients.length,
    processed_client_count: clients.length,
    current_client: null,
    total_source_payment_count: 23601,
    total_payment_count: 23601,
    total_row_count: 50520,
    total_page_count: 250,
    data_periods: periods,
    affected_before: stats({ rowCount: 50520, paymentCount: 23601, fingerprint: '1'.repeat(20) }),
    protected_before: stats({ rowCount: 22452, paymentCount: 10790, fingerprint: '2'.repeat(20) }),
    last_client: { id: clients[19].id, name: clients[19].name, paymentCount: 1000, rowCount: 2200 },
    stage_validation: { status: 'passed', ...stats({ rowCount: 50520, paymentCount: 23601 }) },
    cutover: { status: 'completed', jobId: 'payment_history_repair_2026_cutover' },
    final_validation: {
      status: 'passed',
      rawMatchesStage: true,
      backupPreserved: true,
      protectedUnchanged: true,
      boundaryCollisionCount: 0,
      affectedBefore: stats({ rowCount: 50520, paymentCount: 23601, fingerprint: '1'.repeat(20) }),
      affectedAfter: stats({ rowCount: 48000, paymentCount: 23000, fingerprint: '3'.repeat(20) }),
      staged: { status: 'passed', ...stats({ rowCount: 48000, paymentCount: 23000, fingerprint: '3'.repeat(20) }) },
      backup: stats({ rowCount: 50520, paymentCount: 23601, fingerprint: '1'.repeat(20) }),
      protectedBefore: stats({ rowCount: 22452, paymentCount: 10790, fingerprint: '2'.repeat(20) }),
      protectedAfter: stats({ rowCount: 22452, paymentCount: 10790, fingerprint: '2'.repeat(20) }),
      consumptionViews: {
        status: 'passed',
        viewExists: true,
        excludesVoided: true,
        actualRowCount: 1475,
        expectedRowCount: 1475,
        voidedRowCount: 0,
        actualSnapshotWeek: '2026-10-05',
        expectedSnapshotWeek: '2026-10-05'
      }
    },
    stages: {
      backup: 'completed',
      stage_clients: 'completed',
      validate_stage: 'completed',
      cutover: 'completed',
      final_validation: 'pending',
      data_source_sheets: 'pending',
      extracts: 'pending'
    },
    created_at: '2026-10-13T00:00:00.000Z',
    loaded_at: '2026-10-13T00:00:00.000Z',
    updated_at: '2026-10-13T00:00:00.000Z',
    completed_at: null,
    last_error: null
  };

  const result = context.persistPaymentHistoryRepairState_(state);

  assert.ok(result.byteCount < 9000, 'serialized state was ' + result.byteCount + ' bytes');
  assert.ok(context.__properties.QBO_PAYMENT_HISTORY_REPAIR_2026_STATE);
});
