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

/***********************
 * Missing weekly history backfill (2026)
 ***********************/

const PNL_WEEKLY_HISTORY_BACKFILL = {
  planVersion: '2026-weekly-history-v1',
  statePropertyKey: 'QBO_PNL_WEEKLY_HISTORY_BACKFILL_2026',
  workerHandler: 'processPnlWeeklyHistoryBackfill2026',
  startWeek: '2026-01-05',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildPnlWeeklyHistoryRange_(snapshotWeek) {
  const monday = safeParseDate_(snapshotWeek);
  if (!monday || monday.getUTCDay() !== 1) {
    throw new Error('P&L weekly history SnapshotWeek must be Monday: ' + snapshotWeek);
  }
  const dateFrom = formatUtcDate_(monday);
  const dateTo = formatUtcDate_(new Date(monday.getTime() + 6 * 86400000));
  return {
    snapshotType: PNL_SNAPSHOT_TYPE_WEEKLY,
    snapshotDate: formatUtcDate_(new Date(monday.getTime() + 7 * 86400000)),
    snapshotWeek: dateFrom, dateFrom: dateFrom, dateTo: dateTo,
    periodKey: dateFrom + '|' + dateTo
  };
}

function buildPnlWeeklyHistoryExpectedWeeks_(referenceIsoDate) {
  const lastClosedWeek = getPreviousCompletedWeekRange_(referenceIsoDate).snapshotWeek;
  const end = safeParseDate_(lastClosedWeek);
  const weeks = [];
  for (let week = safeParseDate_(PNL_WEEKLY_HISTORY_BACKFILL.startWeek);
       week.getTime() <= end.getTime();
       week = new Date(week.getTime() + 7 * 86400000)) {
    weeks.push(formatUtcDate_(week));
  }
  return weeks;
}

function parsePnlWeeklyHistoryCoverage_(queryResult) {
  const coverage = {};
  (queryResult && queryResult.rows || []).forEach(row => {
    const values = row.f || [];
    const week = String(values[0] && values[0].v || '');
    if (week) coverage[week] = String(values[1] && values[1].v || '').split(',').filter(Boolean);
  });
  return coverage;
}

function readPnlCanonicalWeeklyHistory_(variant, startWeek, endWeek) {
  const contract = getPnlBigQueryContract_(variant);
  return parsePnlWeeklyHistoryCoverage_(runPnlBigQueryQuery_([
    "SELECT FORMAT_DATE('%F', SnapshotWeek), STRING_AGG(DISTINCT ClientId, ',' ORDER BY ClientId)",
    'FROM `' + contract.tableName + '`',
    "WHERE SnapshotWeek BETWEEN DATE '" + startWeek + "' AND DATE '" + endWeek + "'",
    "  AND COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
    '  AND EXTRACT(DAYOFWEEK FROM SnapshotWeek) = 2',
    '  AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '  AND DateFrom = SnapshotWeek',
    '  AND DateTo = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)',
    'GROUP BY SnapshotWeek ORDER BY SnapshotWeek'
  ].join('\n')));
}

function planPnlWeeklyHistoryBackfill2026_(referenceIsoDate, expectedClientIdsByVariant) {
  const expectedWeeks = buildPnlWeeklyHistoryExpectedWeeks_(referenceIsoDate);
  const expectedByVariant = expectedClientIdsByVariant || {};
  const plan = { expectedWeeks: expectedWeeks, expectedClientIds: {}, coverage: {}, missingWeeks: {}, jobs: [] };
  if (!expectedWeeks.length) return plan;
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    const expectedIds = Array.from(new Set((expectedByVariant[variant] || []).map(String))).sort();
    if (!expectedIds.length) throw new Error('P&L weekly history planner requires expected client IDs. Variant=' + variant);
    const coverage = readPnlCanonicalWeeklyHistory_(
      variant, expectedWeeks[0], expectedWeeks[expectedWeeks.length - 1]
    );
    const jobs = expectedWeeks.map(week => {
      const present = {};
      (coverage[week] || []).forEach(id => { present[id] = true; });
      return { variant: variant, snapshotWeek: week, missingClientIds: expectedIds.filter(id => !present[id]) };
    }).filter(job => job.missingClientIds.length);
    plan.expectedClientIds[variant] = expectedIds;
    plan.coverage[variant] = coverage;
    const missingWeeks = jobs.map(job => job.snapshotWeek);
    plan.missingWeeks[variant] = missingWeeks;
    Array.prototype.push.apply(plan.jobs, jobs);
  });
  return plan;
}

function getPnlWeeklyHistoryBackfillPlan2026(referenceIsoDate) {
  const expected = {};
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    const loaded = loadPnlEntityConfiguration_(variant);
    expected[variant] = resolvePnlEntitySelection_(variant, null, loaded).clients.map(client => client.id);
  });
  const plan = planPnlWeeklyHistoryBackfill2026_(referenceIsoDate, expected);
  Logger.log(JSON.stringify({
    event: 'pnl_weekly_history_plan', expectedWeekCount: plan.expectedWeeks.length,
    expectedClientCount: Object.keys(plan.expectedClientIds).reduce((out, variant) => {
      out[variant] = plan.expectedClientIds[variant].length; return out;
    }, {}), missingWeeks: plan.missingWeeks,
    jobs: plan.jobs.map(job => ({ variant: job.variant, snapshotWeek: job.snapshotWeek,
      missingClientCount: job.missingClientIds.length }))
  }));
  return plan;
}

function capturePnlWeeklyHistoryBaseline_(variant, cutoffIso) {
  const contract = getPnlBigQueryContract_(variant);
  const result = runPnlBigQueryQuery_(['SELECT COUNT(*), BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t)))',
    'FROM `' + contract.tableName + '` t',
    "WHERE SnapshotWeek >= DATE '" + PNL_WEEKLY_HISTORY_BACKFILL.startWeek + "'",
    "  AND LoadedAt < TIMESTAMP '" + cutoffIso + "'"].join('\n'));
  const values = result.rows && result.rows[0] ? result.rows[0].f : [];
  return String(values[0] && values[0].v || '0') + '|' + String(values[1] && values[1].v || '0');
}

function validatePnlWeeklyHistoryBackfill2026_(state) {
  const plan = planPnlWeeklyHistoryBackfill2026_(null, state.expectedClientIds);
  if (plan.jobs.length) throw new Error('P&L final coverage validation failed: ' + JSON.stringify(plan.jobs));
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    if (capturePnlWeeklyHistoryBaseline_(variant, state.createdAt) !== state.preexistingBaseline[variant]) {
      throw new Error('P&L preexisting-period fingerprint changed. Variant=' + variant);
    }
    const contract = getPnlBigQueryContract_(variant);
    const result = runPnlBigQueryQuery_(['SELECT COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY) OR DateFrom != SnapshotWeek OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)),',
      '  COUNT(*) - COUNT(DISTINCT idempotency_key)', 'FROM `' + contract.tableName + '`',
      "WHERE SnapshotWeek >= DATE '" + PNL_WEEKLY_HISTORY_BACKFILL.startWeek + "' AND COALESCE(SnapshotType,'WEEKLY')='WEEKLY'"].join('\n'));
    const values = result.rows && result.rows[0] ? result.rows[0].f : [];
    if (Number(values[0] && values[0].v || 0) || Number(values[1] && values[1].v || 0)) {
      throw new Error('P&L final canonical/duplicate validation failed. Variant=' + variant);
    }
  });
  return { status: 'passed', expectedWeekCount: plan.expectedWeeks.length };
}

function readPnlWeeklyHistoryState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    PNL_WEEKLY_HISTORY_BACKFILL.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistPnlWeeklyHistoryState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > PNL_WEEKLY_HISTORY_BACKFILL.maxStateBytes) {
    throw new Error('P&L weekly history state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    PNL_WEEKLY_HISTORY_BACKFILL.statePropertyKey, serialized
  );
}

function deletePnlWeeklyHistoryTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_WEEKLY_HISTORY_BACKFILL.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replacePnlWeeklyHistorySchedule_(delayMs) {
  deletePnlWeeklyHistoryTriggers_();
  ScriptApp.newTrigger(PNL_WEEKLY_HISTORY_BACKFILL.workerHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validatePnlWeeklyHistoryPreflight_() {
  const incident = readPnlIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('P&L incident backfill must finish before the weekly history backfill starts.');
  }
  return validatePnlIncidentBackfillPreflight_();
}

function startPnlWeeklyHistoryBackfill2026() {
  const loaded = validatePnlWeeklyHistoryPreflight_();
  const plan = getPnlWeeklyHistoryBackfillPlan2026();
  const current = readPnlWeeklyHistoryState_();
  if (current && current.planVersion === PNL_WEEKLY_HISTORY_BACKFILL.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'profit_and_loss',
    planVersion: PNL_WEEKLY_HISTORY_BACKFILL.planVersion,
    status: plan.jobs.length ? 'pending' : 'completed',
    jobs: plan.jobs.map(job => ({ variant: job.variant, snapshotWeek: job.snapshotWeek })), jobIndex: 0,
    expectedClientIds: plan.expectedClientIds,
    currentStage: plan.jobs.length ? 'bigquery' : 'completed',
    completedCount: 0, skippedCount: 0, lastResult: null,
    configuration: {
      normal: loaded.normal.configuration.configuration_hash,
      byClass: loaded.byClass.configuration.configuration_hash
    },
    createdAt: now, updatedAt: now,
    preexistingBaseline: {
      normal: capturePnlWeeklyHistoryBaseline_(PNL_VARIANT_NORMAL, now),
      by_class: capturePnlWeeklyHistoryBaseline_(PNL_VARIANT_BY_CLASS, now)
    },
    completedAt: plan.jobs.length ? null : now,
    lastError: null, stageAttempts: 0
  };
  persistPnlWeeklyHistoryState_(state);
  if (state.status === 'pending') {
    replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.initialDelayMs);
  } else {
    deletePnlWeeklyHistoryTriggers_();
  }
  return state;
}

function executePnlWeeklyHistoryJob_(job, state) {
  const variant = getPnlVariantConfig_(job.variant).variantKey;
  const coverage = readPnlCanonicalWeeklyHistory_(variant, job.snapshotWeek, job.snapshotWeek);
  const present = {}; (coverage[job.snapshotWeek] || []).forEach(id => { present[id] = true; });
  const missingClientIds = state.expectedClientIds[variant].filter(id => !present[id]);
  if (!missingClientIds.length) {
    return { status: 'skipped_existing', variant: variant, snapshotWeek: job.snapshotWeek };
  }
  const loaded = loadPnlEntityConfiguration_(variant);
  const expectedHash = variant === PNL_VARIANT_NORMAL
    ? state.configuration.normal : state.configuration.byClass;
  if (loaded.configuration.configuration_hash !== expectedHash) {
    throw new Error('P&L entity configuration changed during the weekly history backfill. Variant=' + variant);
  }
  const range = buildPnlWeeklyHistoryRange_(job.snapshotWeek);
  const result = executeProfitAndLossVariantSnapshot_(variant, loaded, { range: range, clientIds: missingClientIds });
  return {
    status: 'completed', variant: variant, range: range, rowCount: result.rowCount,
    clientCount: result.clientCount, verification: result.verification && result.verification.status
  };
}

function processPnlWeeklyHistoryBackfill2026() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deletePnlWeeklyHistoryTriggers_();
    const state = readPnlWeeklyHistoryState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistPnlWeeklyHistoryState_(state);
    replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const result = executePnlWeeklyHistoryJob_(state.jobs[state.jobIndex], state);
      if (result.status === 'skipped_existing') state.skippedCount += 1;
      else state.completedCount += 1;
      state.lastResult = result;
      state.jobIndex += 1;
      state.stageAttempts = 0;
      if (state.jobIndex >= state.jobs.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validatePnlWeeklyHistoryBackfill2026_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'data_source_sheets') {
      refreshPnlConnectedSheetsStage_('data_source_sheets');
      state.dataSourceSheets = { status: 'completed' };
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      refreshPnlConnectedSheetsStage_('extracts');
      state.extracts = { status: 'completed' };
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported P&L weekly history stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistPnlWeeklyHistoryState_(state);
    if (state.status === 'completed') deletePnlWeeklyHistoryTriggers_();
    else replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readPnlWeeklyHistoryState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.stageAttempts || 0) < PNL_WEEKLY_HISTORY_BACKFILL.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistPnlWeeklyHistoryState_(state);
      if (state.status === 'pending') {
        replacePnlWeeklyHistorySchedule_(PNL_WEEKLY_HISTORY_BACKFILL.failureRetryDelayMs);
      } else {
        deletePnlWeeklyHistoryTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
