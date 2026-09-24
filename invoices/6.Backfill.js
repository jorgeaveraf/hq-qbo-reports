/***********************
 * September 2026 incident backfill
 ***********************/

const INVOICE_INCIDENT_BACKFILL = {
  statePropertyKey: 'QBO_INVOICE_SEPTEMBER_2026_BACKFILL_STATE',
  workerHandler: 'processInvoiceSeptemberIncidentBackfill',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  periods: [
    { snapshotDate: '2026-09-14', snapshotWeek: '2026-09-07', dateFrom: '2026-09-07', dateTo: '2026-09-13', periodKey: '2026-09-07|2026-09-13' },
    { snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14', dateFrom: '2026-09-14', dateTo: '2026-09-20', periodKey: '2026-09-14|2026-09-20' }
  ]
};

function readInvoiceIncidentBackfillState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    INVOICE_INCIDENT_BACKFILL.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistInvoiceIncidentBackfillState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    INVOICE_INCIDENT_BACKFILL.statePropertyKey,
    JSON.stringify(state)
  );
}

function replaceInvoiceIncidentBackfillSchedule_(delayMs) {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === INVOICE_INCIDENT_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(INVOICE_INCIDENT_BACKFILL.workerHandler)
    .timeBased().after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function deleteInvoiceIncidentBackfillTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === INVOICE_INCIDENT_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function validateInvoiceIncidentBackfillPreflight_() {
  const deployment = readInvoiceDeploymentState_();
  if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
    throw new Error('Invoice deployment must finish before the incident backfill starts.');
  }
  const spreadsheet = getInvoiceReportSpreadsheet_();
  getInvoiceConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getInvoiceConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadInvoiceEntityConfiguration_();
}

function startInvoiceSeptemberIncidentBackfill() {
  const loaded = validateInvoiceIncidentBackfillPreflight_();
  const current = readInvoiceIncidentBackfillState_();
  if (current && current.status === 'completed') return current;
  if (current && ['pending', 'running'].includes(current.status)) {
    replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = current && current.status === 'failed' ? current : {
    operationId: Utilities.getUuid(),
    report: 'invoices',
    periods: INVOICE_INCIDENT_BACKFILL.periods,
    periodIndex: 0,
    currentStage: 'bigquery',
    results: [],
    createdAt: now
  };
  state.status = 'pending';
  state.updatedAt = now;
  state.completedAt = null;
  state.lastError = null;
  state.stageAttempts = 0;
  state.configurationVersion = loaded.configuration.configuration_version;
  state.configurationHash = loaded.configuration.configuration_hash;
  persistInvoiceIncidentBackfillState_(state);
  replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.initialDelayMs);
  return state;
}

function executeInvoiceIncidentBackfillPeriod_(period, state) {
  const loaded = loadInvoiceEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('Invoice entity configuration changed during the incident backfill.');
  }
  const result = executeInvoiceBigQuerySnapshot_(loaded, { range: period });
  return {
    period: period,
    status: result.status || 'completed',
    rowCount: result.sourceRowCount,
    successfulClientCount: (result.successfulClientIds || []).length,
    verification: result.verification && result.verification.status
  };
}

function processInvoiceSeptemberIncidentBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteInvoiceIncidentBackfillTriggers_();
    const state = readInvoiceIncidentBackfillState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistInvoiceIncidentBackfillState_(state);
    replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const period = state.periods[state.periodIndex];
      state.results.push(executeInvoiceIncidentBackfillPeriod_(period, state));
      state.periodIndex += 1;
      state.stageAttempts = 0;
      if (state.periodIndex >= state.periods.length) state.currentStage = 'data_source_sheets';
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = refreshInvoiceConnectedSheetsStage_('data_source_sheets');
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      state.extracts = refreshInvoiceConnectedSheetsStage_('extracts');
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Invoice incident backfill stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistInvoiceIncidentBackfillState_(state);
    if (state.status === 'completed') deleteInvoiceIncidentBackfillTriggers_();
    else replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readInvoiceIncidentBackfillState_();
    if (state) {
      state.lastError = String(error && error.message || error);
      state.status = Number(state.stageAttempts || 0) < INVOICE_INCIDENT_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistInvoiceIncidentBackfillState_(state);
      if (state.status === 'pending') {
        replaceInvoiceIncidentBackfillSchedule_(INVOICE_INCIDENT_BACKFILL.failureRetryDelayMs);
      } else {
        deleteInvoiceIncidentBackfillTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
