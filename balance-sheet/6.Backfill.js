/***********************
 * September 2026 incident backfill
 ***********************/

const BALANCE_INCIDENT_BACKFILL = {
  planVersion: '2026-09-23-balance-gap-v2',
  statePropertyKey: 'QBO_BALANCE_SEPTEMBER_2026_BACKFILL_STATE',
  workerHandler: 'processBalanceSeptemberIncidentBackfill',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  jobs: [
    { snapshotDate: '2026-09-17', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-18', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-19', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-20', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] }
  ]
};

function readBalanceIncidentBackfillState_() {
  const value = PropertiesService.getScriptProperties().getProperty(BALANCE_INCIDENT_BACKFILL.statePropertyKey);
  return value ? JSON.parse(value) : null;
}

function persistBalanceIncidentBackfillState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    BALANCE_INCIDENT_BACKFILL.statePropertyKey,
    JSON.stringify(state)
  );
}

function deleteBalanceIncidentBackfillTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === BALANCE_INCIDENT_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceBalanceIncidentBackfillSchedule_(delayMs) {
  deleteBalanceIncidentBackfillTriggers_();
  ScriptApp.newTrigger(BALANCE_INCIDENT_BACKFILL.workerHandler)
    .timeBased().after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validateBalanceIncidentBackfillPreflight_() {
  const deployment = readBalanceDeploymentState_();
  if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
    throw new Error('Balance Sheet deployment must finish before the incident backfill starts.');
  }
  const spreadsheet = getBalanceReportSpreadsheet_();
  getBalanceConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getBalanceConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadBalanceEntityConfiguration_();
}

function startBalanceSeptemberIncidentBackfill() {
  const loaded = validateBalanceIncidentBackfillPreflight_();
  const current = readBalanceIncidentBackfillState_();
  const currentPlanMatches = current && current.planVersion === BALANCE_INCIDENT_BACKFILL.planVersion;
  if (currentPlanMatches && current.status === 'completed') return current;
  if (currentPlanMatches && ['pending', 'running'].includes(current.status)) {
    replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = currentPlanMatches && current.status === 'failed' ? current : {
    operationId: Utilities.getUuid(), report: 'balance_sheet',
    planVersion: BALANCE_INCIDENT_BACKFILL.planVersion,
    jobs: BALANCE_INCIDENT_BACKFILL.jobs,
    jobIndex: 0, currentStage: 'bigquery', results: [], createdAt: now
  };
  state.status = 'pending';
  state.updatedAt = now;
  state.completedAt = null;
  state.lastError = null;
  state.stageAttempts = 0;
  state.configurationVersion = loaded.configuration.configuration_version;
  state.configurationHash = loaded.configuration.configuration_hash;
  persistBalanceIncidentBackfillState_(state);
  replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.initialDelayMs);
  return state;
}

function resolveBalanceIncidentAsOfDate_(snapshotDate, clientIds) {
  const excludedClients = buildBalanceClientScopeSql_(clientIds || []);
  const result = runBalanceBigQueryQuery_([
    "SELECT FORMAT_DATE('%F', AsOfDate) AS as_of_date, COUNT(DISTINCT ClientId) AS client_count",
    'FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    "WHERE SnapshotDate = DATE '" + snapshotDate + "'",
    excludedClients ? '  AND ClientId NOT IN (' + excludedClients + ')' : null,
    'GROUP BY AsOfDate',
    'ORDER BY client_count DESC, as_of_date DESC',
    'LIMIT 1'
  ].filter(line => line !== null).join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const value = result.rows && result.rows.length && result.rows[0].f[0]
    ? String(result.rows[0].f[0].v || '').trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Balance Sheet incident backfill cannot resolve the existing partition as-of date for ' + snapshotDate + '.');
  }
  return value;
}

function executeBalanceIncidentBackfillSnapshot_(job, state) {
  const loaded = loadBalanceEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('Balance Sheet entity configuration changed during the incident backfill.');
  }
  const asOfDate = resolveBalanceIncidentAsOfDate_(job.snapshotDate, job.clientIds);
  const result = executeBalanceSheetBigQuerySnapshot_(
    loaded,
    {
      snapshotDate: job.snapshotDate,
      asOfDate: asOfDate,
      clientIds: job.clientIds,
      forceClientScope: true,
      requireAsOfDateMatch: true
    }
  );
  return {
    snapshotDate: result.snapshotDate, snapshotWeek: result.snapshotWeek,
    requestedAsOfDate: asOfDate, clientIds: job.clientIds,
    rowCount: result.lineRowCount, clientCount: result.clientCount,
    successfulClientCount: (result.successfulClientIds || []).length,
    verification: result.verification && result.verification.status
  };
}

function processBalanceSeptemberIncidentBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteBalanceIncidentBackfillTriggers_();
    const state = readBalanceIncidentBackfillState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistBalanceIncidentBackfillState_(state);
    replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      state.results.push(executeBalanceIncidentBackfillSnapshot_(state.jobs[state.jobIndex], state));
      state.jobIndex += 1;
      state.stageAttempts = 0;
      if (state.jobIndex >= state.jobs.length) state.currentStage = 'data_source_sheets';
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = refreshBalanceConnectedSheetsStage_('data_source_sheets');
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      state.extracts = refreshBalanceConnectedSheetsStage_('extracts');
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Balance Sheet incident backfill stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistBalanceIncidentBackfillState_(state);
    if (state.status === 'completed') deleteBalanceIncidentBackfillTriggers_();
    else replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readBalanceIncidentBackfillState_();
    if (state) {
      state.lastError = String(error && error.message || error);
      state.status = Number(state.stageAttempts || 0) < BALANCE_INCIDENT_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistBalanceIncidentBackfillState_(state);
      if (state.status === 'pending') replaceBalanceIncidentBackfillSchedule_(BALANCE_INCIDENT_BACKFILL.failureRetryDelayMs);
      else deleteBalanceIncidentBackfillTriggers_();
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
