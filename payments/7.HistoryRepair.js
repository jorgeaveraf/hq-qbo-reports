/***********************
 * Payments 2026 historical week repair
 *
 * Rebuilds only 2026-01-05 through 2026-07-19 from Payment.TxnDate. The
 * current/raw slice is backed up, the rebuilt rows are validated in staging,
 * and the production replacement is a single BigQuery transaction. Rows on
 * and after 2026-07-20 are fingerprinted and must remain unchanged.
 ***********************/

function paymentHistoryRepairTable_(tableId) {
  return [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, tableId].join('.');
}

function paymentHistoryRepairWeekEnd_() {
  return normalizePaymentSnapshotRange_({
    dateFrom: PAYMENT_HISTORY_REPAIR_CONFIG.endDate,
    dateTo: PAYMENT_HISTORY_REPAIR_CONFIG.endDate
  }).snapshotWeek;
}

function paymentHistoryRepairJobId_(operationId, kind, clientId) {
  return [
    'payment_history_repair_2026',
    String(operationId || '').replace(/[^A-Za-z0-9_]/g, ''),
    String(kind || '').replace(/[^A-Za-z0-9_]/g, ''),
    clientId ? sha256Hex_(clientId).slice(0, 16) : ''
  ].filter(Boolean).join('_');
}

function paymentHistoryRepairQueryJob_(jobId, query) {
  let job = getPaymentBackfillBigQueryJobIfExists_(jobId);
  if (!job) {
    job = BigQuery.Jobs.insert({
      jobReference: { projectId: BQ_CONFIG.projectId, jobId },
      configuration: { query: { query, useLegacySql: false } }
    }, BQ_CONFIG.projectId);
  }
  return waitForBigQueryJob_(job.jobReference, 120000);
}

function paymentHistoryRepairScalarRow_(result) {
  return result && result.rows && result.rows[0] && result.rows[0].f
    ? result.rows[0].f.map(cell => cell && cell.v !== undefined ? cell.v : null)
    : [];
}

function getPaymentHistoryRepairStats_(tableName, predicate) {
  const result = runBigQueryQuery_([
    'WITH scoped AS (',
    '  SELECT *',
    '  FROM `' + tableName + '`',
    '  WHERE ' + predicate,
    '), duplicate_keys AS (',
    '  SELECT COUNT(*) AS duplicate_key_count',
    '  FROM (',
    '    SELECT idempotency_key',
    '    FROM scoped',
    '    GROUP BY idempotency_key',
    '    HAVING idempotency_key IS NULL OR TRIM(idempotency_key) = \'\' OR COUNT(*) > 1',
    '  )',
    ')',
    'SELECT',
    '  COUNT(*) AS row_count,',
    "  COUNT(DISTINCT IF(RecordType = 'HEADER', CONCAT(ClientId, '|', PaymentId), NULL)) AS payment_count,",
    '  COUNT(DISTINCT ClientId) AS client_count,',
    '  COUNT(DISTINCT SnapshotWeek) AS week_count,',
    '  COUNTIF(SnapshotWeek != DATE_TRUNC(TxnDate, WEEK(MONDAY))) AS invalid_week_count,',
    '  COUNTIF(',
    '    DateFrom != SnapshotWeek',
    '    OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)',
    '    OR SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '  ) AS invalid_date_count,',
    '  (SELECT duplicate_key_count FROM duplicate_keys) AS duplicate_key_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(scoped))) AS STRING), '0') AS fingerprint,",
    '  CAST(MIN(SnapshotWeek) AS STRING) AS min_snapshot_week,',
    '  CAST(MAX(SnapshotWeek) AS STRING) AS max_snapshot_week,',
    '  COUNTIF(COALESCE(IsVoided, FALSE)) AS voided_row_count',
    'FROM scoped'
  ].join('\n'));
  const values = paymentHistoryRepairScalarRow_(result);
  return {
    rowCount: Number(values[0] || 0),
    paymentCount: Number(values[1] || 0),
    clientCount: Number(values[2] || 0),
    weekCount: Number(values[3] || 0),
    invalidWeekCount: Number(values[4] || 0),
    invalidDateCount: Number(values[5] || 0),
    duplicateKeyCount: Number(values[6] || 0),
    fingerprint: String(values[7] || '0'),
    minSnapshotWeek: values[8] || null,
    maxSnapshotWeek: values[9] || null,
    voidedRowCount: Number(values[10] || 0)
  };
}

function getPaymentHistoryRepairScopeStats_(tableName) {
  return getPaymentHistoryRepairStats_(tableName, [
    "SnapshotWeek >= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.startDate + "'",
    "AND SnapshotWeek <= DATE '" + paymentHistoryRepairWeekEnd_() + "'"
  ].join('\n'));
}

function getPaymentHistoryRepairProtectedStats_() {
  return getPaymentHistoryRepairStats_(PAYMENT_BIGQUERY_TABLE,
    "SnapshotWeek >= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.protectedStartDate + "'");
}

function getPaymentHistoryRepairBoundaryCollisions_() {
  const result = runBigQueryQuery_([
    'SELECT COUNT(*) AS collision_count',
    'FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE TxnDate >= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.startDate + "'",
    "  AND TxnDate <= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.endDate + "'",
    '  AND NOT (',
    "    SnapshotWeek >= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.startDate + "'",
    "    AND SnapshotWeek <= DATE '" + paymentHistoryRepairWeekEnd_() + "'",
    '  )'
  ].join('\n'));
  return Number(paymentHistoryRepairScalarRow_(result)[0] || 0);
}

function getPaymentHistoryRepairExistingClientIds_() {
  const result = runBigQueryQuery_([
    'SELECT DISTINCT ClientId',
    'FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek >= DATE '" + PAYMENT_HISTORY_REPAIR_CONFIG.startDate + "'",
    "  AND SnapshotWeek <= DATE '" + paymentHistoryRepairWeekEnd_() + "'",
    'ORDER BY ClientId'
  ].join('\n'));
  return (result.rows || []).map(row => String(row.f[0].v || '')).filter(Boolean);
}

function getPaymentHistoryRepairClients_() {
  const loadedConfiguration = loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loadedConfiguration);
  const clients = Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) =>
      String(left.entityAlias || '').localeCompare(String(right.entityAlias || '')) ||
      String(left.name || '').localeCompare(String(right.name || ''))
    )
    .map(client => ({
      id: String(client.id || '').trim(),
      name: String(client.name || '').trim(),
      entity: String(client.entity || '').trim(),
      entityAlias: String(client.entityAlias || '').trim()
    }));
  if (!clients.length) {
    throw new Error('No authorized Payments clients are available for history repair.');
  }
  return { loadedConfiguration, clients };
}

/**
 * Read-only production planner. It does not create Script Properties,
 * triggers, tables, or BigQuery mutations.
 */
function getPaymentHistoryRepairPlan2026() {
  const plan = planPaymentBackfill_({
    startDate: PAYMENT_HISTORY_REPAIR_CONFIG.startDate,
    endDate: PAYMENT_HISTORY_REPAIR_CONFIG.endDate,
    today: addPaymentBackfillDays_(PAYMENT_HISTORY_REPAIR_CONFIG.endDate, 1)
  });
  const clientContext = getPaymentHistoryRepairClients_();
  const configuredIds = clientContext.clients.map(client => client.id);
  const existingIds = getPaymentHistoryRepairExistingClientIds_();
  const configuredLookup = {};
  configuredIds.forEach(clientId => { configuredLookup[clientId] = true; });
  const unconfiguredHistoricalClientIds = existingIds.filter(clientId => !configuredLookup[clientId]);
  const affected = getPaymentHistoryRepairScopeStats_(PAYMENT_BIGQUERY_TABLE);
  const protectedScope = getPaymentHistoryRepairProtectedStats_();
  const boundaryCollisionCount = getPaymentHistoryRepairBoundaryCollisions_();
  return {
    status: 'planned_read_only',
    modifiesBigQuery: false,
    createsState: false,
    createsTriggers: false,
    strategy: PAYMENT_HISTORY_REPAIR_CONFIG.strategy,
    startDate: plan.startDate,
    endDate: plan.horizonDate,
    snapshotWeekEnd: paymentHistoryRepairWeekEnd_(),
    protectedStartDate: PAYMENT_HISTORY_REPAIR_CONFIG.protectedStartDate,
    periodCount: plan.periodCount,
    periods: plan.periods.map(period => ({
      snapshotWeek: period.snapshotWeek,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo,
      snapshotDate: period.snapshotDate
    })),
    configuredClientCount: configuredIds.length,
    existingHistoricalClientCount: existingIds.length,
    unconfiguredHistoricalClientIds,
    boundaryCollisionCount,
    affected,
    protectedScope,
    stagingTable: paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId),
    backupTable: paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.backupTableId)
  };
}

function readPaymentHistoryRepairState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    PAYMENT_HISTORY_REPAIR_CONFIG.statePropertyKey
  );
  if (!serialized) return null;
  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('State is not an object.');
    }
    if (!String(state.operation_id || '').trim()) throw new Error('Missing operation_id.');
    return state;
  } catch (error) {
    throw new Error('Invalid Payments history repair state: ' + error.message);
  }
}

function persistPaymentHistoryRepairState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PAYMENT_HISTORY_REPAIR_CONFIG.maxStateBytes) {
    throw new Error('Payments history repair state exceeds the Script Property limit. Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    PAYMENT_HISTORY_REPAIR_CONFIG.statePropertyKey,
    serialized
  );
  return { byteCount };
}

function summarizePaymentHistoryRepairState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operation_id,
    strategy: state.strategy,
    status: state.status,
    currentStage: state.current_stage,
    startDate: state.start_date,
    endDate: state.end_date,
    protectedStartDate: state.protected_start_date,
    totalClientCount: state.total_client_count,
    processedClientCount: state.processed_client_count,
    totalPaymentCount: state.total_payment_count,
    totalRowCount: state.total_row_count,
    periodCountWithData: Object.keys(state.data_periods || {}).length,
    lastClient: state.last_client || null,
    validation: state.final_validation || null,
    updatedAt: state.updated_at,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null
  };
}

function replacePaymentHistoryRepairSchedule_(delayMs) {
  const existing = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === PAYMENT_HISTORY_REPAIR_CONFIG.workerHandler
  );
  existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  const delay = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(PAYMENT_HISTORY_REPAIR_CONFIG.workerHandler)
    .timeBased().after(delay).create();
  return { triggerId: trigger.getUniqueId(), delayMs: delay, previousTriggersDeleted: existing.length };
}

function deletePaymentHistoryRepairTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === PAYMENT_HISTORY_REPAIR_CONFIG.workerHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function assertPaymentHistoryRepairCanStart_() {
  assertPaymentDeploymentIdleForBackfill_();
  const backfill = readPaymentBackfillState_();
  if (backfill && ['pending', 'running'].includes(backfill.status)) {
    throw new Error('The existing Payments backfill must finish before history repair.');
  }
}

function startPaymentHistoryRepair2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Payments history repair starter is busy.');
  try {
    assertPaymentHistoryRepairCanStart_();
    validatePaymentBackfillConnectedSheetsPreflight_();
    const current = readPaymentHistoryRepairState_();
    if (current && ['pending', 'running'].includes(current.status)) {
      replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.continuationDelayMs);
      return summarizePaymentHistoryRepairState_(current, false);
    }
    const plan = getPaymentHistoryRepairPlan2026();
    if (plan.unconfiguredHistoricalClientIds.length) {
      throw new Error(
        'History repair cannot safely replace clients missing from current configuration: ' +
        plan.unconfiguredHistoricalClientIds.join(', ')
      );
    }
    if (plan.boundaryCollisionCount !== 0) {
      throw new Error(
        'History repair found TxnDate rows outside the replacement partitions. Count=' +
        plan.boundaryCollisionCount
      );
    }
    const clientContext = getPaymentHistoryRepairClients_();
    const now = new Date().toISOString();
    const state = {
      schema_version: '1.0',
      strategy: PAYMENT_HISTORY_REPAIR_CONFIG.strategy,
      operation_id: Utilities.getUuid(),
      configuration_version: clientContext.loadedConfiguration.configuration.configuration_version,
      configuration_hash: clientContext.loadedConfiguration.configuration.configuration_hash,
      status: 'pending',
      current_stage: 'backup',
      current_attempts: 0,
      start_date: PAYMENT_HISTORY_REPAIR_CONFIG.startDate,
      end_date: PAYMENT_HISTORY_REPAIR_CONFIG.endDate,
      snapshot_week_end: paymentHistoryRepairWeekEnd_(),
      protected_start_date: PAYMENT_HISTORY_REPAIR_CONFIG.protectedStartDate,
      clients: clientContext.clients,
      total_client_count: clientContext.clients.length,
      next_client_index: 0,
      processed_client_count: 0,
      current_client: null,
      total_source_payment_count: 0,
      total_payment_count: 0,
      total_row_count: 0,
      total_page_count: 0,
      data_periods: {},
      affected_before: plan.affected,
      protected_before: plan.protectedScope,
      last_client: null,
      final_validation: null,
      stages: {
        backup: 'pending',
        stage_clients: 'pending',
        validate_stage: 'pending',
        cutover: 'pending',
        final_validation: 'pending',
        data_source_sheets: 'pending',
        extracts: 'pending'
      },
      created_at: now,
      loaded_at: now,
      updated_at: now,
      completed_at: null,
      last_error: null
    };
    persistPaymentHistoryRepairState_(state);
    replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.initialDelayMs);
    return summarizePaymentHistoryRepairState_(state, true);
  } finally {
    lock.releaseLock();
  }
}

function resumePaymentHistoryRepair2026() {
  const state = readPaymentHistoryRepairState_();
  if (!state) throw new Error('No Payments history repair state exists.');
  if (state.status === 'completed') return summarizePaymentHistoryRepairState_(state, false);
  state.status = 'pending';
  state.current_attempts = 0;
  state.last_error = null;
  state.updated_at = new Date().toISOString();
  if (state.stages && state.current_stage) state.stages[state.current_stage] = 'pending';
  persistPaymentHistoryRepairState_(state);
  replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.initialDelayMs);
  return summarizePaymentHistoryRepairState_(state, true);
}

function getPaymentHistoryRepairStatus2026() {
  const state = readPaymentHistoryRepairState_();
  return state
    ? summarizePaymentHistoryRepairState_(state, false)
    : { status: 'not_started' };
}

function preparePaymentHistoryRepairTables_(state) {
  const backup = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.backupTableId);
  const stage = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  const query = [
    'CREATE TABLE IF NOT EXISTS `' + backup + '`',
    'PARTITION BY SnapshotWeek',
    'CLUSTER BY Entity, ClientId, PaymentId, RecordType',
    'AS SELECT * FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek >= DATE '" + state.start_date + "'",
    "  AND SnapshotWeek <= DATE '" + state.snapshot_week_end + "';",
    'CREATE TABLE IF NOT EXISTS `' + stage + '`',
    'LIKE `' + PAYMENT_BIGQUERY_TABLE + '`;',
    'TRUNCATE TABLE `' + stage + '`;'
  ].join('\n');
  const job = paymentHistoryRepairQueryJob_(
    paymentHistoryRepairJobId_(state.operation_id, 'prepare_a' + state.current_attempts),
    query
  );
  const backupStats = getPaymentHistoryRepairScopeStats_(backup);
  if (
    backupStats.rowCount !== state.affected_before.rowCount ||
    backupStats.fingerprint !== state.affected_before.fingerprint
  ) {
    throw new Error(
      'Payments history backup does not match the pre-repair source. Expected=' +
      JSON.stringify(state.affected_before) + ', actual=' + JSON.stringify(backupStats)
    );
  }
  return { jobId: job.jobReference && job.jobReference.jobId || null, backup: backupStats };
}

function deletePaymentHistoryRepairStageClient_(state, clientId) {
  const table = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  return paymentHistoryRepairQueryJob_(
    paymentHistoryRepairJobId_(
      state.operation_id,
      'stage_delete_a' + state.current_attempts,
      clientId
    ),
    [
      'DELETE FROM `' + table + '`',
      "WHERE ClientId = '" + escapePaymentBackfillBigQueryString_(clientId) + "'"
    ].join('\n')
  );
}

function loadPaymentHistoryRepairStageClient_(state, clientId, rows) {
  const jobId = paymentHistoryRepairJobId_(
    state.operation_id,
    'stage_load_a' + state.current_attempts,
    clientId
  );
  let job = getPaymentBackfillBigQueryJobIfExists_(jobId);
  if (!job) {
    if (!rows.length) return { status: { state: 'DONE' }, outputRows: 0 };
    rows.forEach((row, index) => validatePaymentBigQueryRow_(row, index));
    const blob = Utilities.newBlob(
      rows.map(row => JSON.stringify(row)).join('\n'),
      'application/octet-stream',
      jobId + '.ndjson'
    );
    job = BigQuery.Jobs.insert({
      jobReference: { projectId: BQ_CONFIG.projectId, jobId },
      configuration: {
        load: {
          destinationTable: {
            projectId: BQ_CONFIG.projectId,
            datasetId: BQ_CONFIG.rawDatasetId,
            tableId: PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId
          },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: 'WRITE_APPEND',
          schema: { fields: PAYMENT_BIGQUERY_SCHEMA }
        }
      }
    }, BQ_CONFIG.projectId, blob);
  }
  return waitForBigQueryJob_(job.jobReference, 120000);
}

function verifyPaymentHistoryRepairStageClient_(clientId, expected) {
  const table = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  const stats = getPaymentHistoryRepairStats_(table,
    "ClientId = '" + escapePaymentBackfillBigQueryString_(clientId) + "'");
  if (
    stats.rowCount !== Number(expected.rowCount || 0) ||
    stats.paymentCount !== Number(expected.paymentCount || 0) ||
    stats.invalidWeekCount !== 0 ||
    stats.invalidDateCount !== 0 ||
    stats.duplicateKeyCount !== 0
  ) {
    throw new Error(
      'Payments history staging verification failed. ClientId=' + clientId +
      ', expected=' + JSON.stringify(expected) + ', actual=' + JSON.stringify(stats)
    );
  }
  return { status: 'passed', ...stats };
}

function stagePaymentHistoryRepairClient_(state, client) {
  const loadedConfiguration = loadPaymentEntityConfiguration_();
  if (
    Number(loadedConfiguration.configuration.configuration_version) !== Number(state.configuration_version) ||
    String(loadedConfiguration.configuration.configuration_hash) !== String(state.configuration_hash)
  ) {
    throw new Error('Payments entity configuration changed during history repair.');
  }
  const plan = planPaymentBackfill_({
    startDate: state.start_date,
    endDate: state.end_date,
    today: addPaymentBackfillDays_(state.end_date, 1)
  });
  const snapshot = buildPaymentBackfillClientSnapshot_(client, plan, state.loaded_at);
  const deleteJob = deletePaymentHistoryRepairStageClient_(state, client.id);
  const loadJob = loadPaymentHistoryRepairStageClient_(state, client.id, snapshot.rows);
  const verification = verifyPaymentHistoryRepairStageClient_(client.id, {
    rowCount: snapshot.rows.length,
    paymentCount: snapshot.paymentCount
  });
  return {
    clientId: client.id,
    clientName: client.name,
    sourcePaymentCount: snapshot.sourcePaymentCount,
    paymentCount: snapshot.paymentCount,
    rowCount: snapshot.rows.length,
    pageCount: snapshot.pageCount,
    dataPeriods: Object.keys(snapshot.periodPaymentCounts).sort(),
    deleteJobId: deleteJob.jobReference && deleteJob.jobReference.jobId || null,
    loadJobId: loadJob.jobReference && loadJob.jobReference.jobId || null,
    verification
  };
}

function validatePaymentHistoryRepairStage_(state) {
  const table = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  const stats = getPaymentHistoryRepairScopeStats_(table);
  if (
    stats.rowCount !== Number(state.total_row_count || 0) ||
    stats.paymentCount !== Number(state.total_payment_count || 0) ||
    stats.weekCount !== Object.keys(state.data_periods || {}).length ||
    stats.invalidWeekCount !== 0 ||
    stats.invalidDateCount !== 0 ||
    stats.duplicateKeyCount !== 0
  ) {
    throw new Error(
      'Payments history staging final validation failed. Expected=' +
      JSON.stringify({
        rowCount: state.total_row_count,
        paymentCount: state.total_payment_count,
        weekCount: Object.keys(state.data_periods || {}).length
      }) + ', actual=' + JSON.stringify(stats)
    );
  }
  return { status: 'passed', ...stats };
}

function cutoverPaymentHistoryRepair_(state) {
  const stage = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  const query = [
    'BEGIN TRANSACTION;',
    'DELETE FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek >= DATE '" + state.start_date + "'",
    "  AND SnapshotWeek <= DATE '" + state.snapshot_week_end + "';",
    'INSERT INTO `' + PAYMENT_BIGQUERY_TABLE + '`',
    'SELECT * FROM `' + stage + '`;',
    'COMMIT TRANSACTION;'
  ].join('\n');
  const job = paymentHistoryRepairQueryJob_(
    paymentHistoryRepairJobId_(state.operation_id, 'cutover_a' + state.current_attempts),
    query
  );
  return { status: 'completed', jobId: job.jobReference && job.jobReference.jobId || null };
}

function validatePaymentHistoryRepairFinal_(state) {
  const stage = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.stagingTableId);
  const backup = paymentHistoryRepairTable_(PAYMENT_HISTORY_REPAIR_CONFIG.backupTableId);
  const staged = validatePaymentHistoryRepairStage_(state);
  const actual = getPaymentHistoryRepairScopeStats_(PAYMENT_BIGQUERY_TABLE);
  const backupStats = getPaymentHistoryRepairScopeStats_(backup);
  const protectedStats = getPaymentHistoryRepairProtectedStats_();
  const boundaryCollisionCount = getPaymentHistoryRepairBoundaryCollisions_();
  const rawMatchesStage =
    actual.rowCount === staged.rowCount &&
    actual.fingerprint === staged.fingerprint;
  const backupPreserved =
    backupStats.rowCount === state.affected_before.rowCount &&
    backupStats.fingerprint === state.affected_before.fingerprint;
  const protectedUnchanged =
    protectedStats.rowCount === state.protected_before.rowCount &&
    protectedStats.fingerprint === state.protected_before.fingerprint;
  if (
    !rawMatchesStage ||
    !backupPreserved ||
    !protectedUnchanged ||
    boundaryCollisionCount !== 0 ||
    actual.invalidWeekCount !== 0 ||
    actual.invalidDateCount !== 0 ||
    actual.duplicateKeyCount !== 0
  ) {
    throw new Error('Payments history final validation failed: ' + JSON.stringify({
      rawMatchesStage,
      backupPreserved,
      protectedUnchanged,
      boundaryCollisionCount,
      staged,
      actual,
      backup: backupStats,
      protectedScope: protectedStats
    }));
  }
  const consumptionViews = verifyPaymentConsumptionViews_();
  return {
    status: 'passed',
    rawMatchesStage,
    backupPreserved,
    protectedUnchanged,
    boundaryCollisionCount,
    affectedBefore: state.affected_before,
    affectedAfter: actual,
    staged,
    backup: backupStats,
    protectedBefore: state.protected_before,
    protectedAfter: protectedStats,
    consumptionViews
  };
}

function advancePaymentHistoryRepairStage_(state, nextStage) {
  state.stages[state.current_stage] = 'completed';
  state.current_stage = nextStage;
  state.current_attempts = 0;
  state.status = nextStage === 'completed' ? 'completed' : 'pending';
  if (nextStage === 'completed') state.completed_at = new Date().toISOString();
}

function processPaymentHistoryRepair2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.busyRetryDelayMs);
    return { status: 'deferred_lock_busy', retryScheduled: true };
  }
  try {
    let state = readPaymentHistoryRepairState_();
    if (!state) return { status: 'not_started' };
    if (['completed', 'failed'].includes(state.status)) {
      deletePaymentHistoryRepairTriggers_();
      return summarizePaymentHistoryRepairState_(state, false);
    }
    assertPaymentDeploymentIdleForBackfill_();
    if (state.status === 'running') {
      const updatedAt = Date.parse(state.updated_at || '');
      const ageSeconds = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 1000 : Infinity;
      if (ageSeconds < PAYMENT_HISTORY_REPAIR_CONFIG.staleRunningSeconds) {
        replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.busyRetryDelayMs);
        return { status: 'deferred_execution_running', currentStage: state.current_stage, retryScheduled: true };
      }
      state.status = 'pending';
      state.last_error = 'Recovered after a stale Payments history repair execution.';
    }

    state.status = 'running';
    state.current_attempts = Number(state.current_attempts || 0) + 1;
    state.stages[state.current_stage] = 'running';
    state.updated_at = new Date().toISOString();
    state.last_error = null;
    persistPaymentHistoryRepairState_(state);
    replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.watchdogDelayMs);

    if (state.current_stage === 'backup') {
      preparePaymentHistoryRepairTables_(state);
      advancePaymentHistoryRepairStage_(state, 'stage_clients');
    } else if (state.current_stage === 'stage_clients') {
      const client = state.clients[state.next_client_index];
      if (!client) {
        advancePaymentHistoryRepairStage_(state, 'validate_stage');
      } else {
        state.current_client = { index: state.next_client_index, id: client.id, name: client.name };
        persistPaymentHistoryRepairState_(state);
        const result = stagePaymentHistoryRepairClient_(state, client);
        state = readPaymentHistoryRepairState_();
        state.next_client_index++;
        state.processed_client_count++;
        state.total_source_payment_count += Number(result.sourcePaymentCount || 0);
        state.total_payment_count += Number(result.paymentCount || 0);
        state.total_row_count += Number(result.rowCount || 0);
        state.total_page_count += Number(result.pageCount || 0);
        result.dataPeriods.forEach(period => { state.data_periods[period] = true; });
        state.last_client = {
          id: result.clientId,
          name: result.clientName,
          paymentCount: result.paymentCount,
          rowCount: result.rowCount,
          verificationStatus: result.verification.status
        };
        state.current_client = null;
        state.current_attempts = 0;
        state.status = 'pending';
        state.stages.stage_clients = state.next_client_index >= state.clients.length
          ? 'completed'
          : 'pending';
        if (state.next_client_index >= state.clients.length) state.current_stage = 'validate_stage';
      }
    } else if (state.current_stage === 'validate_stage') {
      state.stage_validation = validatePaymentHistoryRepairStage_(state);
      advancePaymentHistoryRepairStage_(state, 'cutover');
    } else if (state.current_stage === 'cutover') {
      state.cutover = cutoverPaymentHistoryRepair_(state);
      advancePaymentHistoryRepairStage_(state, 'final_validation');
    } else if (state.current_stage === 'final_validation') {
      state.final_validation = validatePaymentHistoryRepairFinal_(state);
      advancePaymentHistoryRepairStage_(state, 'data_source_sheets');
    } else if (state.current_stage === 'data_source_sheets') {
      const result = refreshPaymentConnectedSheetsStage_('data_source_sheets');
      state.connected_sheets_sources = {
        status: result.status,
        refreshedObjectCount: result.refreshedObjectCount
      };
      advancePaymentHistoryRepairStage_(state, 'extracts');
    } else if (state.current_stage === 'extracts') {
      const result = refreshPaymentConnectedSheetsStage_('extracts');
      state.connected_sheets_extracts = {
        status: result.status,
        refreshedObjectCount: result.refreshedObjectCount
      };
      advancePaymentHistoryRepairStage_(state, 'completed');
    } else {
      throw new Error('Unsupported Payments history repair stage: ' + state.current_stage);
    }

    state.updated_at = new Date().toISOString();
    state.last_error = null;
    persistPaymentHistoryRepairState_(state);
    if (state.status === 'completed') {
      deletePaymentHistoryRepairTriggers_();
    } else {
      replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.continuationDelayMs);
    }
    return summarizePaymentHistoryRepairState_(state, false);
  } catch (error) {
    const state = readPaymentHistoryRepairState_();
    if (state) {
      const canRetry = Number(state.current_attempts || 0) <
        PAYMENT_HISTORY_REPAIR_CONFIG.maxAttemptsPerStage;
      state.status = canRetry ? 'pending' : 'failed';
      state.last_error = String(error && error.message || error);
      state.updated_at = new Date().toISOString();
      if (state.stages && state.current_stage) {
        state.stages[state.current_stage] = canRetry ? 'pending' : 'failed';
      }
      persistPaymentHistoryRepairState_(state);
      if (canRetry) {
        replacePaymentHistoryRepairSchedule_(PAYMENT_HISTORY_REPAIR_CONFIG.failureRetryDelayMs);
      } else {
        deletePaymentHistoryRepairTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
