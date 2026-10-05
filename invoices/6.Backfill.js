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

/***********************
 * Missing weekly history backfill (2026)
 ***********************/

const INVOICE_WEEKLY_HISTORY_BACKFILL = {
  planVersion: '2026-weekly-history-v1',
  statePropertyKey: 'QBO_INVOICE_WEEKLY_HISTORY_BACKFILL_2026',
  workerHandler: 'processInvoiceWeeklyHistoryBackfill2026',
  startWeek: '2026-01-05',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500,
  emptyEvidencePrefix: 'QBO_INVOICE_WEEKLY_HISTORY_EMPTY_2026_'
};

function buildInvoiceWeeklyHistoryRange_(snapshotWeek) {
  const monday = safeParseDate_(snapshotWeek);
  if (!monday || monday.getUTCDay() !== 1) {
    throw new Error('Invoice weekly history SnapshotWeek must be Monday: ' + snapshotWeek);
  }
  const dateFrom = formatUtcDate_(monday);
  const dateTo = formatUtcDate_(new Date(monday.getTime() + 6 * 86400000));
  return {
    snapshotDate: formatUtcDate_(new Date(monday.getTime() + 7 * 86400000)),
    snapshotWeek: dateFrom, dateFrom: dateFrom, dateTo: dateTo,
    periodKey: dateFrom + '|' + dateTo
  };
}

function buildInvoiceWeeklyHistoryExpectedWeeks_(referenceIsoDate) {
  const lastClosedWeek = getPreviousCompletedWeekRange_(referenceIsoDate).snapshotWeek;
  const end = safeParseDate_(lastClosedWeek);
  const weeks = [];
  for (let week = safeParseDate_(INVOICE_WEEKLY_HISTORY_BACKFILL.startWeek);
       week.getTime() <= end.getTime();
       week = new Date(week.getTime() + 7 * 86400000)) {
    weeks.push(formatUtcDate_(week));
  }
  return weeks;
}

function readInvoiceCanonicalWeeklyHistory_(startWeek, endWeek) {
  const table = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const result = runBigQuerySingleRowQuery_([
    "SELECT TO_JSON_STRING(ARRAY_AGG(STRUCT(FORMAT_DATE('%F', SnapshotWeek) AS week, client_ids) ORDER BY SnapshotWeek)) AS coverage FROM (",
    "SELECT SnapshotWeek, ARRAY_AGG(DISTINCT ClientId ORDER BY ClientId) AS client_ids",
    'FROM `' + table + '`',
    "WHERE SnapshotWeek BETWEEN DATE '" + startWeek + "' AND DATE '" + endWeek + "'",
    '  AND EXTRACT(DAYOFWEEK FROM SnapshotWeek) = 2',
    '  AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '  AND DateFrom = SnapshotWeek',
    '  AND DateTo = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)',
    'GROUP BY SnapshotWeek)'
  ].join('\n'));
  const coverage = {};
  JSON.parse(String(result.coverage || '[]')).forEach(item => { coverage[item.week] = item.client_ids || []; });
  return coverage;
}

function planInvoiceWeeklyHistoryBackfill2026_(referenceIsoDate, expectedClientIds, completedEmptyClients) {
  const expectedWeeks = buildInvoiceWeeklyHistoryExpectedWeeks_(referenceIsoDate);
  const expectedIds = Array.from(new Set((expectedClientIds || []).map(String))).sort();
  if (!expectedIds.length) throw new Error('Invoice weekly history planner requires expected client IDs.');
  if (!expectedWeeks.length) return { expectedWeeks: [], expectedClientIds: expectedIds, coverage: {}, missingWeeks: [], jobs: [] };
  const coverage = readInvoiceCanonicalWeeklyHistory_(
    expectedWeeks[0], expectedWeeks[expectedWeeks.length - 1]
  );
  const jobs = expectedWeeks.map(week => {
    const present = {};
    (coverage[week] || []).concat(completedEmptyClients && completedEmptyClients[week] || [])
      .forEach(id => { present[id] = true; });
    return { snapshotWeek: week, missingClientIds: expectedIds.filter(id => !present[id]) };
  }).filter(job => job.missingClientIds.length);
  return {
    expectedWeeks: expectedWeeks,
    expectedClientIds: expectedIds, coverage: coverage,
    missingWeeks: jobs.map(job => job.snapshotWeek), jobs: jobs
  };
}

function getInvoiceWeeklyHistoryBackfillPlan2026(referenceIsoDate) {
  const loaded = loadInvoiceEntityConfiguration_();
  const plan = planInvoiceWeeklyHistoryBackfill2026_(referenceIsoDate, Object.keys(fetchClients_(loaded)));
  Logger.log(JSON.stringify({
    event: 'invoice_weekly_history_plan', expectedWeekCount: plan.expectedWeeks.length,
    expectedClientCount: plan.expectedClientIds.length, missingWeeks: plan.missingWeeks,
    jobs: plan.jobs.map(job => ({ snapshotWeek: job.snapshotWeek, missingClientCount: job.missingClientIds.length }))
  }));
  return plan;
}

function captureInvoiceWeeklyHistoryBaseline_(cutoffIso) {
  const table = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const result = runBigQuerySingleRowQuery_(['SELECT COUNT(*) AS row_count, BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS fingerprint',
    'FROM `' + table + '` t', "WHERE SnapshotWeek >= DATE '" + INVOICE_WEEKLY_HISTORY_BACKFILL.startWeek + "'",
    "  AND LoadedAt < TIMESTAMP '" + cutoffIso + "'"].join('\n'));
  return String(result.row_count || '0') + '|' + String(result.fingerprint || '0');
}

function validateInvoiceWeeklyHistoryBackfill2026_(state) {
  const plan = planInvoiceWeeklyHistoryBackfill2026_(
    null, state.expectedClientIds, readAllInvoiceWeeklyHistoryEmptyEvidence_(state)
  );
  if (plan.jobs.length) throw new Error('Invoice final coverage validation failed: ' + JSON.stringify(plan.jobs));
  if (captureInvoiceWeeklyHistoryBaseline_(state.createdAt) !== state.preexistingBaseline) {
    throw new Error('Invoice preexisting-period fingerprint changed.');
  }
  const table = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const result = runBigQuerySingleRowQuery_(['SELECT COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY) OR DateFrom != SnapshotWeek OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS invalid_count,',
    '  COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_count', 'FROM `' + table + '`',
    "WHERE SnapshotWeek >= DATE '" + INVOICE_WEEKLY_HISTORY_BACKFILL.startWeek + "'"].join('\n'));
  if (Number(result.invalid_count || 0) || Number(result.duplicate_count || 0)) {
    throw new Error('Invoice final canonical/duplicate validation failed.');
  }
  return { status: 'passed', expectedWeekCount: plan.expectedWeeks.length };
}

function readInvoiceWeeklyHistoryState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    INVOICE_WEEKLY_HISTORY_BACKFILL.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistInvoiceWeeklyHistoryState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > INVOICE_WEEKLY_HISTORY_BACKFILL.maxStateBytes) {
    throw new Error('Invoice weekly history state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    INVOICE_WEEKLY_HISTORY_BACKFILL.statePropertyKey, serialized
  );
}

function invoiceWeeklyHistoryEmptyEvidenceKey_(operationId, snapshotWeek) {
  return INVOICE_WEEKLY_HISTORY_BACKFILL.emptyEvidencePrefix +
    String(operationId).replace(/[^A-Za-z0-9]/g, '') + '_' + String(snapshotWeek).replace(/-/g, '');
}

function readInvoiceWeeklyHistoryEmptyEvidence_(state, snapshotWeek) {
  const value = PropertiesService.getScriptProperties().getProperty(
    invoiceWeeklyHistoryEmptyEvidenceKey_(state.operationId, snapshotWeek)
  );
  return value ? JSON.parse(value) : [];
}

function persistInvoiceWeeklyHistoryEmptyEvidence_(state, snapshotWeek, clientIds) {
  const value = JSON.stringify(Array.from(new Set(clientIds || [])).sort());
  const byteCount = unescape(encodeURIComponent(value)).length;
  if (byteCount > INVOICE_WEEKLY_HISTORY_BACKFILL.maxStateBytes) {
    throw new Error('Invoice empty-entity evidence exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    invoiceWeeklyHistoryEmptyEvidenceKey_(state.operationId, snapshotWeek), value
  );
}

function readAllInvoiceWeeklyHistoryEmptyEvidence_(state) {
  const evidence = {};
  (state.weeks || []).forEach(week => {
    const ids = readInvoiceWeeklyHistoryEmptyEvidence_(state, week);
    if (ids.length) evidence[week] = ids;
  });
  return evidence;
}

function deleteInvoiceWeeklyHistoryTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === INVOICE_WEEKLY_HISTORY_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceInvoiceWeeklyHistorySchedule_(delayMs) {
  deleteInvoiceWeeklyHistoryTriggers_();
  ScriptApp.newTrigger(INVOICE_WEEKLY_HISTORY_BACKFILL.workerHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validateInvoiceWeeklyHistoryPreflight_() {
  const incident = readInvoiceIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('Invoice incident backfill must finish before the weekly history backfill starts.');
  }
  return validateInvoiceIncidentBackfillPreflight_();
}

function startInvoiceWeeklyHistoryBackfill2026() {
  const loaded = validateInvoiceWeeklyHistoryPreflight_();
  const plan = getInvoiceWeeklyHistoryBackfillPlan2026();
  const current = readInvoiceWeeklyHistoryState_();
  if (current && current.planVersion === INVOICE_WEEKLY_HISTORY_BACKFILL.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'invoices',
    planVersion: INVOICE_WEEKLY_HISTORY_BACKFILL.planVersion,
    status: plan.missingWeeks.length ? 'pending' : 'completed',
    weeks: plan.missingWeeks, weekIndex: 0, expectedClientIds: plan.expectedClientIds,
    currentStage: plan.missingWeeks.length ? 'bigquery' : 'completed',
    completedCount: 0, skippedCount: 0, lastResult: null,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    createdAt: now, updatedAt: now, preexistingBaseline: captureInvoiceWeeklyHistoryBaseline_(now),
    completedAt: plan.missingWeeks.length ? null : now,
    lastError: null, stageAttempts: 0
  };
  persistInvoiceWeeklyHistoryState_(state);
  if (state.status === 'pending') {
    replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.initialDelayMs);
  } else {
    deleteInvoiceWeeklyHistoryTriggers_();
  }
  return state;
}

function executeInvoiceWeeklyHistoryWeek_(snapshotWeek, state) {
  const coverage = readInvoiceCanonicalWeeklyHistory_(snapshotWeek, snapshotWeek);
  const present = {}; (coverage[snapshotWeek] || []).forEach(id => { present[id] = true; });
  readInvoiceWeeklyHistoryEmptyEvidence_(state, snapshotWeek).forEach(id => { present[id] = true; });
  const missingClientIds = state.expectedClientIds.filter(id => !present[id]);
  if (!missingClientIds.length) {
    return { status: 'skipped_existing', snapshotWeek: snapshotWeek };
  }
  const loaded = loadInvoiceEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('Invoice entity configuration changed during the weekly history backfill.');
  }
  const period = buildInvoiceWeeklyHistoryRange_(snapshotWeek);
  const result = executeInvoiceBigQuerySnapshot_(loaded, {
    range: period, clientIds: missingClientIds, returnPartialResult: true
  });
  const afterCoverage = readInvoiceCanonicalWeeklyHistory_(snapshotWeek, snapshotWeek);
  const withRows = {}; (afterCoverage[snapshotWeek] || []).forEach(id => { withRows[id] = true; });
  const emptyIds = (result.successfulClientIds || []).filter(id => !withRows[id]);
  persistInvoiceWeeklyHistoryEmptyEvidence_(state, snapshotWeek,
    readInvoiceWeeklyHistoryEmptyEvidence_(state, snapshotWeek).concat(emptyIds));
  if ((result.clientFailures || []).length) {
    state.updatedAt = new Date().toISOString();
    persistInvoiceWeeklyHistoryState_(state);
    throw new Error('Invoice weekly history still has entity failures: ' + JSON.stringify(result.clientFailures));
  }
  return {
    status: result.status, period: period, rowCount: result.sourceRowCount,
    successfulClientCount: (result.successfulClientIds || []).length,
    verification: result.verification && result.verification.status
  };
}

function processInvoiceWeeklyHistoryBackfill2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteInvoiceWeeklyHistoryTriggers_();
    const state = readInvoiceWeeklyHistoryState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistInvoiceWeeklyHistoryState_(state);
    replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const result = executeInvoiceWeeklyHistoryWeek_(state.weeks[state.weekIndex], state);
      if (result.status === 'skipped_existing') state.skippedCount += 1;
      else state.completedCount += 1;
      state.lastResult = result;
      state.weekIndex += 1;
      state.stageAttempts = 0;
      if (state.weekIndex >= state.weeks.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validateInvoiceWeeklyHistoryBackfill2026_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'data_source_sheets') {
      refreshInvoiceConnectedSheetsStage_('data_source_sheets');
      state.dataSourceSheets = { status: 'completed' };
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      refreshInvoiceConnectedSheetsStage_('extracts');
      state.extracts = { status: 'completed' };
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Invoice weekly history stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistInvoiceWeeklyHistoryState_(state);
    if (state.status === 'completed') deleteInvoiceWeeklyHistoryTriggers_();
    else replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readInvoiceWeeklyHistoryState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.stageAttempts || 0) < INVOICE_WEEKLY_HISTORY_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistInvoiceWeeklyHistoryState_(state);
      if (state.status === 'pending') {
        replaceInvoiceWeeklyHistorySchedule_(INVOICE_WEEKLY_HISTORY_BACKFILL.failureRetryDelayMs);
      } else {
        deleteInvoiceWeeklyHistoryTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
