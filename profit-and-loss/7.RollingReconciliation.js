/***********************
 * Rolling weekly and monthly reconciliation
 *
 * Re-captures the last 12 completed Monday-to-Sunday periods for both P&L
 * variants, then rebuilds every already-due monthly snapshot intersected by
 * that window. A touched month is always rebuilt in full. Each write remains
 * scoped to successful clients; all history outside the planned weekly and
 * monthly scopes is protected by a before/after fingerprint.
 ***********************/

const PNL_ROLLING_RECONCILIATION = {
  planVersion: '2026-pnl-rolling-v2',
  weekCount: 12,
  statePropertyKey: 'QBO_PNL_ROLLING_RECONCILIATION',
  workerHandler: 'processPnlRollingReconciliation',
  initialDelayMs: 60000,
  continuationDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildPnlRollingMonthlyPeriods_(startWeek, horizonDate, referenceIsoDate) {
  const start = safeParseDate_(startWeek);
  const horizon = safeParseDate_(horizonDate);
  const reference = safeParseDate_(normalizeDateForOutput_(referenceIsoDate || todayIsoDate_()));
  if (!start || !horizon || !reference) {
    throw new Error('Invalid P&L rolling monthly planning dates.');
  }
  const periods = [];
  for (let month = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
       month.getTime() <= horizon.getTime();
       month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const snapshotDate = new Date(Date.UTC(
      nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), PNL_CADENCE.monthlyDay
    ));
    // Do not create a monthly snapshot before its normal day-10 cadence.
    if (snapshotDate.getTime() > reference.getTime()) continue;
    const dateFrom = formatUtcDate_(month);
    const dateTo = formatUtcDate_(new Date(nextMonth.getTime() - 86400000));
    periods.push({
      snapshotType: PNL_SNAPSHOT_TYPE_MONTHLY,
      snapshotDate: formatUtcDate_(snapshotDate),
      snapshotWeek: dateFrom,
      dateFrom: dateFrom,
      dateTo: dateTo,
      periodKey: dateFrom + '|' + dateTo
    });
  }
  return periods;
}

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
  const monthlyPeriods = buildPnlRollingMonthlyPeriods_(
    periods[0].snapshotWeek, periods[periods.length - 1].dateTo, referenceIsoDate
  );
  const weeklyJobs = [];
  const monthlyJobs = [];
  [PNL_VARIANT_NORMAL, PNL_VARIANT_BY_CLASS].forEach(variant => {
    periods.forEach(period => weeklyJobs.push({
      variant, snapshotType: PNL_SNAPSHOT_TYPE_WEEKLY, snapshotWeek: period.snapshotWeek
    }));
    monthlyPeriods.forEach(period => monthlyJobs.push({
      variant, snapshotType: PNL_SNAPSHOT_TYPE_MONTHLY, snapshotWeek: period.snapshotWeek
    }));
  });
  return {
    strategy: 'rolling_closed_weeks_and_due_months', weekCount,
    startWeek: periods[0].snapshotWeek,
    endWeek: periods[periods.length - 1].snapshotWeek,
    horizonDate: periods[periods.length - 1].dateTo,
    periods, monthlyPeriods, jobs: weeklyJobs.concat(monthlyJobs)
  };
}

/** Public, read-only planner. It does not fetch QBO data, create state, or install triggers. */
function getPnlRollingReconciliationPlan(referenceIsoDate) {
  return buildPnlRollingReconciliationPlan_(referenceIsoDate);
}

function getPnlRollingPeriod_(plan, job) {
  const snapshotType = normalizePnlSnapshotType_(job && job.snapshotType || PNL_SNAPSHOT_TYPE_WEEKLY);
  const candidates = snapshotType === PNL_SNAPSHOT_TYPE_MONTHLY
    ? plan.monthlyPeriods || [] : plan.periods || [];
  const period = candidates.filter(item => item.snapshotWeek === job.snapshotWeek)[0];
  if (!period) {
    throw new Error('P&L rolling job is outside the planned scope: ' +
      snapshotType + ' ' + String(job && job.snapshotWeek || ''));
  }
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
  const monthlyWeeks = (plan.monthlyPeriods || []).map(period =>
    "DATE '" + period.snapshotWeek + "'");
  const monthlyScope = monthlyWeeks.length
    ? 'SnapshotWeek IN (' + monthlyWeeks.join(', ') + ')'
    : 'FALSE';
  const result = runPnlBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS distinct_key_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS STRING), '0') AS row_fingerprint",
    'FROM `' + contract.tableName + '` t',
    'WHERE NOT (',
    "  (COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
    "    AND SnapshotWeek BETWEEN DATE '" + plan.startWeek + "' AND DATE '" + plan.endWeek + "')",
    "  OR (COALESCE(SnapshotType, 'WEEKLY') = 'MONTHLY' AND " + monthlyScope + ')',
    ')'
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
  const validation = {
    status: 'passed', weekCount: plan.weekCount,
    monthlyPeriodCount: (plan.monthlyPeriods || []).length, variants: {}
  };
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
    const monthlyWeeks = (plan.monthlyPeriods || []).map(period =>
      "DATE '" + period.snapshotWeek + "'");
    const monthlyResult = monthlyWeeks.length ? runPnlBigQueryQuery_([
      'SELECT',
      '  COUNT(DISTINCT SnapshotWeek) AS actual_month_count,',
      '  COUNTIF(DateFrom != SnapshotWeek',
      '    OR DateTo != LAST_DAY(SnapshotWeek, MONTH)',
      '    OR SnapshotDate != DATE_ADD(DATE_TRUNC(DATE_ADD(SnapshotWeek, INTERVAL 1 MONTH), MONTH), INTERVAL 9 DAY))',
      '    AS noncanonical_row_count,',
      '  COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_key_count',
      'FROM `' + contract.tableName + '`',
      "WHERE COALESCE(SnapshotType, 'WEEKLY') = 'MONTHLY'",
      '  AND SnapshotWeek IN (' + monthlyWeeks.join(', ') + ')'
    ].join('\n')) : null;
    const monthlyRow = monthlyResult ? readPnlRollingScalarRow_(monthlyResult) : {
      actual_month_count: 0, noncanonical_row_count: 0, duplicate_key_count: 0
    };
    const currentOutside = readPnlRollingOutsideFingerprint_(variant, plan);
    const expectedOutside = state.outsideWindowBaseline[variant];
    const completed = state.completedByVariant && state.completedByVariant[variant] || {};
    const details = {
      expectedWeekCount: plan.weekCount,
      actualWeekCount: Number(row.actual_week_count || 0),
      completedWeekCount: Number(completed.weekly || 0),
      weeklyNoncanonicalRowCount: Number(row.noncanonical_row_count || 0),
      weeklyDuplicateKeyCount: Number(row.duplicate_key_count || 0),
      expectedMonthCount: (plan.monthlyPeriods || []).length,
      actualMonthCount: Number(monthlyRow.actual_month_count || 0),
      completedMonthCount: Number(completed.monthly || 0),
      monthlyNoncanonicalRowCount: Number(monthlyRow.noncanonical_row_count || 0),
      monthlyDuplicateKeyCount: Number(monthlyRow.duplicate_key_count || 0),
      outsideWindowUnchanged: JSON.stringify(currentOutside) === JSON.stringify(expectedOutside)
    };
    // A fully processed week may legitimately contain no P&L rows for every
    // selected client. Completion is therefore proven by the worker checkpoint,
    // while actualWeekCount remains an observable diagnostic.
    if (details.completedWeekCount !== details.expectedWeekCount ||
        details.completedMonthCount !== details.expectedMonthCount ||
        details.weeklyNoncanonicalRowCount || details.weeklyDuplicateKeyCount ||
        details.monthlyNoncanonicalRowCount || details.monthlyDuplicateKeyCount ||
        !details.outsideWindowUnchanged) {
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

function replacePnlRollingSchedule_(delayMs, options) {
  const settings = options || {};
  const effectiveDelayMs = Math.max(60000, Number(delayMs) || 60000);
  if (!settings.preserveExisting) deletePnlRollingTriggers_();
  const trigger = ScriptApp.newTrigger(PNL_ROLLING_RECONCILIATION.workerHandler).timeBased()
    .after(effectiveDelayMs).create();
  Logger.log(JSON.stringify({
    event: 'pnl_rolling_trigger_created',
    reason: settings.reason || 'unspecified',
    delayMs: effectiveDelayMs,
    preserveExisting: Boolean(settings.preserveExisting),
    triggerId: trigger && trigger.getUniqueId ? trigger.getUniqueId() : null
  }));
  return trigger;
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
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'resume_existing_operation'
    });
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'profit_and_loss',
    planVersion: PNL_ROLLING_RECONCILIATION.planVersion,
    status: 'pending', currentStage: 'bigquery', jobIndex: 0,
    plan: plan, currentClientIds: null,
    completedCount: 0, retriedClientCount: 0,
    completedByVariant: {
      normal: { weekly: 0, monthly: 0 },
      by_class: { weekly: 0, monthly: 0 }
    },
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
  replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.initialDelayMs, { reason: 'initial_continuation' });
  replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.watchdogDelayMs, {
    preserveExisting: true,
    reason: 'initial_watchdog'
  });
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
    range: getPnlRollingPeriod_(state.plan, job),
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
    status: 'completed', variant,
    snapshotType: normalizePnlSnapshotType_(job.snapshotType), snapshotWeek: job.snapshotWeek,
    rowCount: result.rowCount, clientCount: result.clientCount,
    verification: result.verification && result.verification.status
  };
}

function processPnlRollingReconciliation() {
  Logger.log(JSON.stringify({
    event: 'pnl_rolling_worker_started',
    startedAt: new Date().toISOString()
  }));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'lock_busy_retry'
    });
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
    replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.watchdogDelayMs, {
      reason: 'active_worker_watchdog'
    });

    if (state.currentStage === 'bigquery') {
      const result = executePnlRollingJob_(state.plan.jobs[state.jobIndex], state);
      state.lastResult = result;
      state.jobIndex += 1;
      state.completedCount += 1;
      const completionKey = result.snapshotType === PNL_SNAPSHOT_TYPE_MONTHLY ? 'monthly' : 'weekly';
      state.completedByVariant[result.variant][completionKey] =
        Number(state.completedByVariant[result.variant][completionKey] || 0) + 1;
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
    else replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'next_stage_continuation'
    });
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
        replacePnlRollingSchedule_(PNL_ROLLING_RECONCILIATION.failureRetryDelayMs, {
          preserveExisting: true,
          reason: 'failure_retry'
        });
      } else {
        deletePnlRollingTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
