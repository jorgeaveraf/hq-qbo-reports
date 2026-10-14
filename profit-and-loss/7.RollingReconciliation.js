/***********************
 * Rolling weekly reconciliation
 *
 * Re-captures the last 12 completed Monday-to-Sunday periods for both P&L
 * variants. Each write is scoped to the successful clients in one variant and
 * one week. Monthly snapshots and weekly history outside the window are never
 * part of the replacement scope.
 ***********************/

const PNL_ROLLING_RECONCILIATION = {
  planVersion: '2026-pnl-rolling-v1',
  weekCount: 12,
  statePropertyKey: 'QBO_PNL_ROLLING_RECONCILIATION',
  workerHandler: 'processPnlRollingReconciliation',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildPnlRollingReconciliationPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = weekCountOverride === undefined
    ? PNL_ROLLING_RECONCILIATION.weekCount : Number(weekCountOverride);
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('P&L rolling week count must be an integer between 1 and 52.');
  }
  const latest = getPreviousCompletedWeekRange_(referenceIsoDate);
  const latestMonday = safeParseDate_(latest.snapshotWeek);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    periods.push(buildPnlWeeklyHistoryRange_(formatUtcDate_(
      new Date(latestMonday.getTime() - offset * 7 * 86400000)
    )));
  }
  const jobs = [];
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    periods.forEach(period => jobs.push({ variant, snapshotWeek: period.snapshotWeek }));
  });
  return {
    strategy: 'rolling_closed_weeks', weekCount,
    startWeek: periods[0].snapshotWeek,
    endWeek: periods[periods.length - 1].snapshotWeek,
    horizonDate: periods[periods.length - 1].dateTo,
    periods, jobs
  };
}

/** Public, read-only planner. It does not fetch QBO data, create state, or install triggers. */
function getPnlRollingReconciliationPlan(referenceIsoDate) {
  return buildPnlRollingReconciliationPlan_(referenceIsoDate);
}

function getPnlRollingPeriod_(plan, snapshotWeek) {
  const period = (plan.periods || []).filter(item => item.snapshotWeek === snapshotWeek)[0];
  if (!period) throw new Error('P&L rolling job is outside the planned window: ' + snapshotWeek);
  return period;
}

function readPnlRollingScalarRow_(queryResult) {
  const fields = queryResult && queryResult.schema && queryResult.schema.fields || [];
  const values = queryResult && queryResult.rows && queryResult.rows[0] && queryResult.rows[0].f || [];
  return fields.reduce((row, field, index) => {
    row[field.name] = values[index] && values[index].v;
    return row;
  }, {});
}

function readPnlRollingOutsideFingerprint_(variant, plan) {
  const contract = getPnlBigQueryContract_(variant);
  const result = runPnlBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS distinct_key_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS STRING), '0') AS row_fingerprint",
    'FROM `' + contract.tableName + '` t',
    "WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
    "  AND (SnapshotWeek < DATE '" + plan.startWeek + "' OR SnapshotWeek > DATE '" + plan.endWeek + "')"
  ].join('\n'));
  const row = readPnlRollingScalarRow_(result);
  return {
    rowCount: Number(row.row_count || 0),
    distinctKeyCount: Number(row.distinct_key_count || 0),
    rowFingerprint: String(row.row_fingerprint || '0')
  };
}

function validatePnlRollingReconciliation_(state) {
  const plan = state.plan;
  const validation = { status: 'passed', weekCount: plan.weekCount, variants: {} };
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    const contract = getPnlBigQueryContract_(variant);
    const result = runPnlBigQueryQuery_([
      'SELECT',
      '  COUNT(DISTINCT SnapshotWeek) AS actual_week_count,',
      '  COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
      '    OR DateFrom != SnapshotWeek OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS noncanonical_row_count,',
      '  COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_key_count',
      'FROM `' + contract.tableName + '`',
      "WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
      "  AND SnapshotWeek BETWEEN DATE '" + plan.startWeek + "' AND DATE '" + plan.endWeek + "'"
    ].join('\n'));
    const row = readPnlRollingScalarRow_(result);
    const currentOutside = readPnlRollingOutsideFingerprint_(variant, plan);
    const expectedOutside = state.outsideWindowBaseline[variant];
    const details = {
      expectedWeekCount: plan.weekCount,
      actualWeekCount: Number(row.actual_week_count || 0),
      completedWeekCount: Number(state.completedByVariant && state.completedByVariant[variant] || 0),
      noncanonicalRowCount: Number(row.noncanonical_row_count || 0),
      duplicateKeyCount: Number(row.duplicate_key_count || 0),
      outsideWindowUnchanged: JSON.stringify(currentOutside) === JSON.stringify(expectedOutside)
    };
    // A fully processed week may legitimately contain no P&L rows for every
    // selected client. Completion is therefore proven by the worker checkpoint,
    // while actualWeekCount remains an observable diagnostic.
    if (details.completedWeekCount !== details.expectedWeekCount || details.noncanonicalRowCount ||
        details.duplicateKeyCount || !details.outsideWindowUnchanged) {
      throw new Error('P&L rolling final validation failed. Variant=' + variant + ' ' + JSON.stringify(details));
    }
    validation.variants[variant] = details;
  });
  return validation;
}

function readPnlRollingState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    PNL_ROLLING_RECONCILIATION.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistPnlRollingState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > PNL_ROLLING_RECONCILIATION.maxStateBytes) {
    throw new Error('P&L rolling state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    PNL_ROLLING_RECONCILIATION.statePropertyKey, serialized
  );
  return byteCount;
}

function deletePnlRollingTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_ROLLING_RECONCILIATION.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replacePnlRollingSchedule_(delayMs) {
  deletePnlRollingTriggers_();
  ScriptApp.newTrigger(PNL_ROLLING_RECONCILIATION.workerHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validatePnlRollingPreflight_() {
  const history = readPnlWeeklyHistoryState_();
  if (history && ['pending', 'running'].includes(history.status)) {
    throw new Error('P&L weekly history backfill must finish before rolling reconciliation starts.');
  }
  const incident = readPnlIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('P&L incident backfill must finish before rolling reconciliation starts.');
  }
  const monthlyValue = PropertiesService.getScriptProperties().getProperty(PNL_CADENCE.backfillStateProperty);
  const monthly = monthlyValue ? JSON.parse(monthlyValue) : null;
  if (monthly && ['pending', 'running'].includes(monthly.status)) {
    throw new Error('P&L monthly cadence backfill must finish before rolling reconciliation starts.');
  }
  return validatePnlIncidentBackfillPreflight_();
}

function startPnlRollingReconciliation(referenceIsoDate) {
  const loaded = validatePnlRollingPreflight_();
  const plan = buildPnlRollingReconciliationPlan_(referenceIsoDate);
  const current = readPnlRollingState_();
  if (current && current.planVersion === PNL_ROLLING_RECONCILIATION.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'profit_and_loss',
    planVersion: PNL_ROLLING_RECONCILIATION.planVersion,
    status: 'pending', currentStage: 'bigquery', jobIndex: 0,
    plan: plan, currentClientIds: null,
    completedCount: 0, retriedClientCount: 0,
    completedByVariant: { normal: 0, by_class: 0 },
    configuration: {
      normal: loaded.normal.configuration.configuration_hash,
      by_class: loaded.byClass.configuration.configuration_hash
    },
    outsideWindowBaseline: {
      normal: readPnlRollingOutsideFingerprint_(PNL_VARIANT_NORMAL, plan),
      by_class: readPnlRollingOutsideFingerprint_(PNL_VARIANT_BY_CLASS, plan)
    },
    lastResult: null, lastError: null, stageAttempts: 0,
    createdAt: now, updatedAt: now, completedAt: null
  };
  persistPnlRollingState_(state);
  replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.initialDelayMs);
  return state;
}

function executePnlRollingJob_(job, state) {
  const variant = getPnlVariantConfig_(job.variant).variantKey;
  const loaded = loadPnlEntityConfiguration_(variant);
  if (loaded.configuration.configuration_hash !== state.configuration[variant]) {
    throw new Error('P&L entity configuration changed during rolling reconciliation. Variant=' + variant);
  }
  const clientIds = state.currentClientIds ||
    resolvePnlEntitySelection_(variant, null, loaded).clients.map(client => String(client.id));
  const result = executeProfitAndLossVariantSnapshot_(variant, loaded, {
    range: getPnlRollingPeriod_(state.plan, job.snapshotWeek),
    clientIds, returnPartialResult: true
  });
  const failedIds = (result.clientFailures || []).map(failure => String(failure.clientId));
  if (failedIds.length) {
    state.currentClientIds = failedIds;
    state.retriedClientCount += failedIds.length;
    state.updatedAt = new Date().toISOString();
    persistPnlRollingState_(state);
    throw new Error('P&L rolling job still has entity failures: ' + JSON.stringify(result.clientFailures));
  }
  return {
    status: 'completed', variant, snapshotWeek: job.snapshotWeek,
    rowCount: result.rowCount, clientCount: result.clientCount,
    verification: result.verification && result.verification.status
  };
}

function processPnlRollingReconciliation() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deletePnlRollingTriggers_();
    const state = readPnlRollingState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistPnlRollingState_(state);
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const result = executePnlRollingJob_(state.plan.jobs[state.jobIndex], state);
      state.lastResult = result;
      state.jobIndex += 1;
      state.completedCount += 1;
      state.completedByVariant[result.variant] =
        Number(state.completedByVariant[result.variant] || 0) + 1;
      state.currentClientIds = null;
      state.stageAttempts = 0;
      if (state.jobIndex >= state.plan.jobs.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validatePnlRollingReconciliation_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
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
      throw new Error('Unsupported P&L rolling reconciliation stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistPnlRollingState_(state);
    if (state.status === 'completed') deletePnlRollingTriggers_();
    else replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readPnlRollingState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.stageAttempts || 0) < PNL_ROLLING_RECONCILIATION.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistPnlRollingState_(state);
      if (state.status === 'pending') {
        replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.failureRetryDelayMs);
      } else {
        deletePnlRollingTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
