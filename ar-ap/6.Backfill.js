/***********************
 * September 2026 incident backfill
 ***********************/

const AGING_INCIDENT_BACKFILL = {
  statePropertyKey: 'QBO_AGING_SEPTEMBER_2026_BACKFILL_STATE',
  workerHandler: 'processAgingSeptemberIncidentBackfill',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  childPollDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  snapshotDates: ['2026-09-14', '2026-09-21']
};

function readAgingIncidentBackfillState_() {
  const value = PropertiesService.getScriptProperties().getProperty(AGING_INCIDENT_BACKFILL.statePropertyKey);
  return value ? JSON.parse(value) : null;
}

function persistAgingIncidentBackfillState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    AGING_INCIDENT_BACKFILL.statePropertyKey,
    JSON.stringify(state)
  );
}

function deleteAgingIncidentBackfillTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === AGING_INCIDENT_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceAgingIncidentBackfillSchedule_(delayMs) {
  deleteAgingIncidentBackfillTriggers_();
  ScriptApp.newTrigger(AGING_INCIDENT_BACKFILL.workerHandler)
    .timeBased().after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validateAgingIncidentBackfillPreflight_() {
  const deployment = readAgingDeploymentState_();
  if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
    throw new Error('AR/AP deployment must finish before the incident backfill starts.');
  }
  const spreadsheet = getAgingReportSpreadsheet_();
  getAgingConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getAgingConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadAgingEntityConfiguration_();
}

function startAgingSeptemberIncidentBackfill() {
  const loaded = validateAgingIncidentBackfillPreflight_();
  const current = readAgingIncidentBackfillState_();
  if (current && current.status === 'completed') return current;
  if (current && ['pending', 'running'].includes(current.status)) {
    replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = current && current.status === 'failed' ? current : {
    operationId: Utilities.getUuid(), report: 'ar_ap',
    snapshotDates: AGING_INCIDENT_BACKFILL.snapshotDates,
    snapshotIndex: 0, currentStage: 'bigquery', results: [], createdAt: now
  };
  state.status = 'pending';
  state.updatedAt = now;
  state.completedAt = null;
  state.lastError = null;
  state.stageAttempts = 0;
  state.configurationVersion = loaded.configuration.configuration_version;
  state.configurationHash = loaded.configuration.configuration_hash;
  persistAgingIncidentBackfillState_(state);
  replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.initialDelayMs);
  return state;
}

function advanceAgingIncidentBackfillSnapshot_(state) {
  const snapshotDate = state.snapshotDates[state.snapshotIndex];
  const loaded = loadAgingEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('AR/AP entity configuration changed during the incident backfill.');
  }
  if (!state.childOperationId) {
    const queued = queueAgingConfigurationDeployment_(
      { request_id: Utilities.getUuid() },
      loaded.configuration,
      {
        source: 'september_2026_incident_backfill',
        range: { snapshotDate: snapshotDate },
        skipOutputSheets: true
      }
    );
    state.childOperationId = queued.operationId;
    return { waiting: true };
  }
  const deployment = readAgingDeploymentState_();
  if (!deployment || deployment.operation_id !== state.childOperationId) {
    throw new Error('AR/AP incident child deployment state is missing or was replaced.');
  }
  if (deployment.status === 'failed') {
    state.childOperationId = null;
    throw new Error('AR/AP incident child deployment failed: ' + String(deployment.last_error || 'unknown'));
  }
  if (deployment.status !== 'completed') return { waiting: true };
  state.results.push({
    snapshotDate: snapshotDate,
    snapshotWeek: deployment.range && deployment.range.snapshotWeek,
    operationId: deployment.operation_id,
    status: deployment.status
  });
  state.snapshotIndex += 1;
  state.childOperationId = null;
  return { waiting: false };
}

function advanceAgingBackfillConnectedSheetsStage_(state, stage) {
  const existing = state.connectedSheetRefresh && state.connectedSheetRefresh.stage === stage
    ? state.connectedSheetRefresh : null;
  const result = refreshAgingConnectedSheetsStage_(stage, null, {
    allowPending: true,
    refresh: !existing,
    startedAt: existing && existing.startedAt,
    baselineRefreshedAt: existing && existing.baselineRefreshedAt
  });
  if (result.status === 'pending') {
    if (Date.now() - Date.parse(result.startedAt) >= 30 * 60 * 1000) {
      throw new Error('AR/AP Connected Sheets stage timed out: ' + stage);
    }
    state.connectedSheetRefresh = {
      stage, startedAt: result.startedAt, baselineRefreshedAt: result.baselineRefreshedAt
    };
    state.stageAttempts = 0;
    return null;
  }
  state.connectedSheetRefresh = null;
  return result;
}

function processAgingSeptemberIncidentBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteAgingIncidentBackfillTriggers_();
    const state = readAgingIncidentBackfillState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistAgingIncidentBackfillState_(state);
    replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const progress = advanceAgingIncidentBackfillSnapshot_(state);
      state.stageAttempts = 0;
      if (progress.waiting) {
        state.status = 'pending';
        state.updatedAt = new Date().toISOString();
        persistAgingIncidentBackfillState_(state);
        replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.childPollDelayMs);
        return state;
      }
      if (state.snapshotIndex >= state.snapshotDates.length) state.currentStage = 'data_source_sheets';
    } else if (state.currentStage === 'data_source_sheets') {
      const refresh = advanceAgingBackfillConnectedSheetsStage_(state, 'data_source_sheets');
      if (refresh) {
        state.dataSourceSheets = refresh;
        state.currentStage = 'extracts';
        state.stageAttempts = 0;
      }
    } else if (state.currentStage === 'extracts') {
      const refresh = advanceAgingBackfillConnectedSheetsStage_(state, 'extracts');
      if (refresh) {
        state.extracts = refresh;
        state.currentStage = 'completed';
        state.status = 'completed';
        state.completedAt = new Date().toISOString();
        state.stageAttempts = 0;
      }
    } else {
      throw new Error('Unsupported AR/AP incident backfill stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistAgingIncidentBackfillState_(state);
    if (state.status === 'completed') deleteAgingIncidentBackfillTriggers_();
    else replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readAgingIncidentBackfillState_();
    if (state) {
      state.lastError = String(error && error.message || error);
      state.status = Number(state.stageAttempts || 0) < AGING_INCIDENT_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistAgingIncidentBackfillState_(state);
      if (state.status === 'pending') replaceAgingIncidentBackfillSchedule_(AGING_INCIDENT_BACKFILL.failureRetryDelayMs);
      else deleteAgingIncidentBackfillTriggers_();
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
