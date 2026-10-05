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

/***********************
 * Missing weekly history backfill (2026)
 ***********************/

const BALANCE_WEEKLY_HISTORY_BACKFILL = {
  planVersion: '2026-weekly-history-v1',
  statePropertyKey: 'QBO_BALANCE_WEEKLY_HISTORY_BACKFILL_2026',
  workerHandler: 'processBalanceWeeklyHistoryBackfill2026',
  startWeek: '2026-01-05',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildBalanceWeeklyHistoryRange_(snapshotWeek) {
  const monday = parseIsoDateUtc_(snapshotWeek);
  if (monday.getUTCDay() !== 1) {
    throw new Error('Balance Sheet weekly history SnapshotWeek must be Monday: ' + snapshotWeek);
  }
  return {
    snapshotType: BALANCE_SNAPSHOT_TYPE_WEEKLY,
    snapshotWeek: formatUtcDate_(monday),
    asOfDate: formatUtcDate_(new Date(monday.getTime() + 6 * 86400000)),
    snapshotDate: formatUtcDate_(new Date(monday.getTime() + 7 * 86400000))
  };
}

function buildBalanceWeeklyHistoryExpectedWeeks_(referenceIsoDate) {
  const lastClosedWeek = getBalanceWeeklySnapshotRange_(referenceIsoDate).snapshotWeek;
  const end = parseIsoDateUtc_(lastClosedWeek);
  const weeks = [];
  for (let week = parseIsoDateUtc_(BALANCE_WEEKLY_HISTORY_BACKFILL.startWeek);
       week.getTime() <= end.getTime();
       week = new Date(week.getTime() + 7 * 86400000)) {
    weeks.push(formatUtcDate_(week));
  }
  return weeks;
}

function parseBalanceWeeklyHistoryCoverage_(queryResult) {
  const coverage = {};
  (queryResult && queryResult.rows || []).forEach(row => {
    const values = row.f || [];
    const week = String(values[0] && values[0].v || '');
    const ids = String(values[1] && values[1].v || '').split(',').filter(Boolean);
    if (week) coverage[week] = ids;
  });
  return coverage;
}

function readBalanceCanonicalWeeklyHistory_(startWeek, endWeek) {
  return parseBalanceWeeklyHistoryCoverage_(runBalanceBigQueryQuery_([
    "SELECT FORMAT_DATE('%F', SnapshotWeek), STRING_AGG(DISTINCT ClientId, ',' ORDER BY ClientId)",
    'FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    "WHERE SnapshotWeek BETWEEN DATE '" + startWeek + "' AND DATE '" + endWeek + "'",
    "  AND COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
    '  AND EXTRACT(DAYOFWEEK FROM SnapshotWeek) = 2',
    '  AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '  AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)',
    'GROUP BY SnapshotWeek ORDER BY SnapshotWeek'
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId));
}

function planBalanceWeeklyHistoryBackfill2026_(referenceIsoDate, expectedClientIds) {
  const expectedWeeks = buildBalanceWeeklyHistoryExpectedWeeks_(referenceIsoDate);
  const expectedIds = Array.from(new Set((expectedClientIds || []).map(String))).sort();
  if (!expectedIds.length) throw new Error('Balance Sheet weekly history planner requires expected client IDs.');
  if (!expectedWeeks.length) return { expectedWeeks: [], expectedClientIds: expectedIds, coverage: {}, missingWeeks: [], jobs: [] };
  const coverage = readBalanceCanonicalWeeklyHistory_(
    expectedWeeks[0], expectedWeeks[expectedWeeks.length - 1]
  );
  const jobs = expectedWeeks.map(week => {
    const present = {};
    (coverage[week] || []).forEach(id => { present[id] = true; });
    return { snapshotWeek: week, missingClientIds: expectedIds.filter(id => !present[id]) };
  }).filter(job => job.missingClientIds.length);
  return {
    expectedWeeks: expectedWeeks,
    expectedClientIds: expectedIds,
    coverage: coverage,
    missingWeeks: jobs.map(job => job.snapshotWeek),
    jobs: jobs
  };
}

function getBalanceWeeklyHistoryBackfillPlan2026(referenceIsoDate) {
  const loaded = loadBalanceEntityConfiguration_();
  const selection = resolveBalanceEntitySelection_(null, loaded);
  return planBalanceWeeklyHistoryBackfill2026_(referenceIsoDate, Object.keys(selection.clientsById));
}

function captureBalanceWeeklyHistoryBaseline_(cutoffIso) {
  const result = runBalanceBigQueryQuery_([
    'SELECT COUNT(*), BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t)))',
    'FROM `' + BALANCE_SNAPSHOT_TABLE + '` t',
    "WHERE SnapshotWeek >= DATE '" + BALANCE_WEEKLY_HISTORY_BACKFILL.startWeek + "'",
    "  AND LoadedAt < TIMESTAMP '" + cutoffIso + "'"
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const values = result.rows && result.rows[0] ? result.rows[0].f : [];
  return String(values[0] && values[0].v || '0') + '|' + String(values[1] && values[1].v || '0');
}

function validateBalanceWeeklyHistoryBackfill2026_(state) {
  const plan = planBalanceWeeklyHistoryBackfill2026_(null, state.expectedClientIds);
  if (plan.jobs.length) throw new Error('Balance Sheet final coverage validation failed: ' + JSON.stringify(plan.jobs));
  if (captureBalanceWeeklyHistoryBaseline_(state.createdAt) !== state.preexistingBaseline) {
    throw new Error('Balance Sheet preexisting-period fingerprint changed.');
  }
  const result = runBalanceBigQueryQuery_([
    'SELECT',
    '  (SELECT COUNTIF(EXTRACT(DAYOFWEEK FROM SnapshotWeek) != 2 OR SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY) OR AsOfDate != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY))',
    '   FROM `qbo-gateway-reporting.views.vw_weekly_balance_sheet_metrics`',
    "   WHERE SnapshotWeek >= DATE '" + BALANCE_WEEKLY_HISTORY_BACKFILL.startWeek + "') AS invalid_view_count,",
    '  (SELECT COUNT(*) - COUNT(DISTINCT CONCAT(ClientId, "|", CAST(SnapshotDate AS STRING), "|", LineType, "|", AccountPath, "|", COALESCE(AccountId, ""), "|", NormalizedCategory, "|", CAST(Amount AS STRING)))',
    '   FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    "   WHERE SnapshotWeek >= DATE '" + BALANCE_WEEKLY_HISTORY_BACKFILL.startWeek + "'",
    "     AND COALESCE(SnapshotType,'WEEKLY')='WEEKLY'",
    '     AND EXTRACT(DAYOFWEEK FROM SnapshotWeek)=2',
    '     AND SnapshotDate=DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '     AND AsOfDate=DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS duplicate_count'
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const values = result.rows && result.rows[0] ? result.rows[0].f : [];
  if (Number(values[0] && values[0].v || 0) || Number(values[1] && values[1].v || 0)) {
    throw new Error('Balance Sheet final canonical/duplicate validation failed.');
  }
  return { status: 'passed', expectedWeekCount: plan.expectedWeeks.length, preexistingBaseline: state.preexistingBaseline };
}

function readBalanceWeeklyHistoryState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    BALANCE_WEEKLY_HISTORY_BACKFILL.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistBalanceWeeklyHistoryState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > BALANCE_WEEKLY_HISTORY_BACKFILL.maxStateBytes) {
    throw new Error('Balance Sheet weekly history state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    BALANCE_WEEKLY_HISTORY_BACKFILL.statePropertyKey, serialized
  );
}

function deleteBalanceWeeklyHistoryTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === BALANCE_WEEKLY_HISTORY_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceBalanceWeeklyHistorySchedule_(delayMs) {
  deleteBalanceWeeklyHistoryTriggers_();
  ScriptApp.newTrigger(BALANCE_WEEKLY_HISTORY_BACKFILL.workerHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validateBalanceWeeklyHistoryPreflight_() {
  const deployment = readBalanceDeploymentState_();
  if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
    throw new Error('Balance Sheet deployment must finish before the weekly history backfill starts.');
  }
  const incident = readBalanceIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('Balance Sheet incident backfill must finish before the weekly history backfill starts.');
  }
  validateBalanceCanonicalWeeklyView_();
  const spreadsheet = getBalanceReportSpreadsheet_();
  getBalanceConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getBalanceConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadBalanceEntityConfiguration_();
}

function validateBalanceCanonicalWeeklyView_() {
  const result = runBalanceBigQueryQuery_([
    'SELECT view_definition',
    'FROM `' + BQ_CONFIG.projectId + '.views.INFORMATION_SCHEMA.VIEWS`',
    "WHERE table_name = 'vw_weekly_balance_sheet_metrics'"
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const definition = String(result.rows && result.rows[0] && result.rows[0].f[0].v || '');
  const required = [
    'EXTRACT(DAYOFWEEK FROM SnapshotWeek) = 2',
    'SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    'AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)'
  ];
  if (!definition || required.some(fragment => definition.indexOf(fragment) === -1)) {
    throw new Error(
      'Deploy the canonical Balance Sheet weekly view before starting the weekly history backfill.'
    );
  }
  return { status: 'passed', view: 'vw_weekly_balance_sheet_metrics' };
}

function startBalanceWeeklyHistoryBackfill2026() {
  const loaded = validateBalanceWeeklyHistoryPreflight_();
  const plan = getBalanceWeeklyHistoryBackfillPlan2026();
  const current = readBalanceWeeklyHistoryState_();
  if (current && current.planVersion === BALANCE_WEEKLY_HISTORY_BACKFILL.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'balance_sheet',
    planVersion: BALANCE_WEEKLY_HISTORY_BACKFILL.planVersion,
    status: plan.missingWeeks.length ? 'pending' : 'completed',
    weeks: plan.missingWeeks, weekIndex: 0, expectedClientIds: plan.expectedClientIds,
    currentStage: plan.missingWeeks.length ? 'bigquery' : 'completed',
    completedCount: 0, skippedCount: 0, lastResult: null,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    createdAt: now, updatedAt: now, preexistingBaseline: captureBalanceWeeklyHistoryBaseline_(now),
    completedAt: plan.missingWeeks.length ? null : now,
    lastError: null, stageAttempts: 0
  };
  persistBalanceWeeklyHistoryState_(state);
  if (state.status === 'pending') {
    replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.initialDelayMs);
  } else {
    deleteBalanceWeeklyHistoryTriggers_();
  }
  return state;
}

function executeBalanceWeeklyHistoryWeek_(snapshotWeek, state) {
  const coverage = readBalanceCanonicalWeeklyHistory_(snapshotWeek, snapshotWeek);
  const present = {}; (coverage[snapshotWeek] || []).forEach(id => { present[id] = true; });
  const missingClientIds = state.expectedClientIds.filter(id => !present[id]);
  if (!missingClientIds.length) {
    return { status: 'skipped_existing', snapshotWeek: snapshotWeek };
  }
  const loaded = loadBalanceEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('Balance Sheet entity configuration changed during the weekly history backfill.');
  }
  const range = buildBalanceWeeklyHistoryRange_(snapshotWeek);
  const result = executeBalanceSheetBigQuerySnapshot_(loaded, {
    snapshotType: range.snapshotType,
    snapshotDate: range.snapshotDate,
    snapshotWeek: range.snapshotWeek,
    asOfDate: range.asOfDate,
    requireAsOfDateMatch: true,
    clientIds: missingClientIds,
    forceClientScope: true
  });
  return {
    status: result.status, range: range, lineRowCount: result.lineRowCount,
    clientCount: result.clientCount, verification: result.verification && result.verification.status
  };
}

function processBalanceWeeklyHistoryBackfill2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteBalanceWeeklyHistoryTriggers_();
    const state = readBalanceWeeklyHistoryState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistBalanceWeeklyHistoryState_(state);
    replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const result = executeBalanceWeeklyHistoryWeek_(state.weeks[state.weekIndex], state);
      if (result.status === 'skipped_existing') state.skippedCount += 1;
      else state.completedCount += 1;
      state.lastResult = result;
      state.weekIndex += 1;
      state.stageAttempts = 0;
      if (state.weekIndex >= state.weeks.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validateBalanceWeeklyHistoryBackfill2026_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'data_source_sheets') {
      refreshBalanceConnectedSheetsStage_('data_source_sheets');
      state.dataSourceSheets = { status: 'completed' };
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      refreshBalanceConnectedSheetsStage_('extracts');
      state.extracts = { status: 'completed' };
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Balance Sheet weekly history stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistBalanceWeeklyHistoryState_(state);
    if (state.status === 'completed') deleteBalanceWeeklyHistoryTriggers_();
    else replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readBalanceWeeklyHistoryState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.stageAttempts || 0) < BALANCE_WEEKLY_HISTORY_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistBalanceWeeklyHistoryState_(state);
      if (state.status === 'pending') {
        replaceBalanceWeeklyHistorySchedule_(BALANCE_WEEKLY_HISTORY_BACKFILL.failureRetryDelayMs);
      } else {
        deleteBalanceWeeklyHistoryTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
