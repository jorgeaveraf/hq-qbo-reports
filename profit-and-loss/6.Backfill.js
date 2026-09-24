/***********************
 * September 2026 incident backfill
 ***********************/

const PNL_INCIDENT_BACKFILL = {
  statePropertyKey: 'QBO_PNL_SEPTEMBER_2026_BACKFILL_STATE',
  workerHandler: 'processPnlSeptemberIncidentBackfill',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  jobs: [
    { variant: 'normal', range: { snapshotDate: '2026-09-14', snapshotWeek: '2026-09-07', dateFrom: '2026-09-07', dateTo: '2026-09-13', periodKey: '2026-09-07|2026-09-13' } },
    { variant: 'by_class', range: { snapshotDate: '2026-09-14', snapshotWeek: '2026-09-07', dateFrom: '2026-09-07', dateTo: '2026-09-13', periodKey: '2026-09-07|2026-09-13' } },
    { variant: 'normal', range: { snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14', dateFrom: '2026-09-14', dateTo: '2026-09-20', periodKey: '2026-09-14|2026-09-20' } },
    { variant: 'by_class', range: { snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14', dateFrom: '2026-09-14', dateTo: '2026-09-20', periodKey: '2026-09-14|2026-09-20' } }
  ]
};

function readPnlIncidentBackfillState_() {
  const value = PropertiesService.getScriptProperties().getProperty(PNL_INCIDENT_BACKFILL.statePropertyKey);
  return value ? JSON.parse(value) : null;
}

function persistPnlIncidentBackfillState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    PNL_INCIDENT_BACKFILL.statePropertyKey,
    JSON.stringify(state)
  );
}

function deletePnlIncidentBackfillTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_INCIDENT_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replacePnlIncidentBackfillSchedule_(delayMs) {
  deletePnlIncidentBackfillTriggers_();
  ScriptApp.newTrigger(PNL_INCIDENT_BACKFILL.workerHandler)
    .timeBased().after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validatePnlIncidentBackfillPreflight_() {
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    const deployment = readPnlDeploymentState_(variant);
    if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
      throw new Error('P&L deployment must finish before the incident backfill starts. Variant=' + variant);
    }
  });
  const spreadsheet = getPnlReportSpreadsheet_();
  getPnlConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getPnlConnectedSheetTargets_(spreadsheet, 'extracts');
  return {
    normal: loadPnlEntityConfiguration_(PNL_VARIANT_NORMAL),
    byClass: loadPnlEntityConfiguration_(PNL_VARIANT_BY_CLASS)
  };
}

function startPnlSeptemberIncidentBackfill() {
  const loaded = validatePnlIncidentBackfillPreflight_();
  const current = readPnlIncidentBackfillState_();
  if (current && current.status === 'completed') return current;
  if (current && ['pending', 'running'].includes(current.status)) {
    replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = current && current.status === 'failed' ? current : {
    operationId: Utilities.getUuid(), report: 'profit_and_loss',
    jobs: PNL_INCIDENT_BACKFILL.jobs, jobIndex: 0,
    currentStage: 'bigquery', results: [], createdAt: now
  };
  state.status = 'pending';
  state.updatedAt = now;
  state.completedAt = null;
  state.lastError = null;
  state.stageAttempts = 0;
  state.configuration = {
    normal: loaded.normal.configuration.configuration_hash,
    byClass: loaded.byClass.configuration.configuration_hash
  };
  persistPnlIncidentBackfillState_(state);
  replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.initialDelayMs);
  return state;
}

function executePnlIncidentBackfillJob_(job, state) {
  const variant = getPnlVariantConfig_(job.variant).variantKey;
  const loaded = loadPnlEntityConfiguration_(variant);
  const expectedHash = variant === PNL_VARIANT_NORMAL
    ? state.configuration.normal
    : state.configuration.byClass;
  if (loaded.configuration.configuration_hash !== expectedHash) {
    throw new Error('P&L entity configuration changed during the incident backfill. Variant=' + variant);
  }
  const result = executeProfitAndLossVariantSnapshot_(variant, loaded, { range: job.range });
  return {
    variant: variant, period: job.range, rowCount: result.rowCount,
    clientCount: result.clientCount,
    verification: result.verification && result.verification.status
  };
}

function processPnlSeptemberIncidentBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deletePnlIncidentBackfillTriggers_();
    const state = readPnlIncidentBackfillState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistPnlIncidentBackfillState_(state);
    replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      state.results.push(executePnlIncidentBackfillJob_(state.jobs[state.jobIndex], state));
      state.jobIndex += 1;
      state.stageAttempts = 0;
      if (state.jobIndex >= state.jobs.length) state.currentStage = 'data_source_sheets';
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = refreshPnlConnectedSheetsStage_('data_source_sheets');
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      state.extracts = refreshPnlConnectedSheetsStage_('extracts');
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported P&L incident backfill stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistPnlIncidentBackfillState_(state);
    if (state.status === 'completed') deletePnlIncidentBackfillTriggers_();
    else replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readPnlIncidentBackfillState_();
    if (state) {
      state.lastError = String(error && error.message || error);
      state.status = Number(state.stageAttempts || 0) < PNL_INCIDENT_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistPnlIncidentBackfillState_(state);
      if (state.status === 'pending') replacePnlIncidentBackfillSchedule_(PNL_INCIDENT_BACKFILL.failureRetryDelayMs);
      else deletePnlIncidentBackfillTriggers_();
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
