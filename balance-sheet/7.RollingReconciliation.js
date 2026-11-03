/***********************
 * Rolling weekly reconciliation
 *
 * Re-captures the last 12 completed Balance Sheet weeks and each due monthly
 * close intersecting that window. Writes stay scoped to successful clients and
 * canonical weekly or month-end tuples.
 ***********************/

const BALANCE_ROLLING_RECONCILIATION = {
  planVersion: '2026-balance-rolling-v2',
  weekCount: 12,
  statePropertyKey: 'QBO_BALANCE_ROLLING_RECONCILIATION',
  workerHandler: 'processBalanceRollingReconciliation',
  recoveryHandler: 'recoverBalanceRollingReconciliation',
  initialDelayMs: 60000,
  continuationDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildBalanceRollingReconciliationPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = weekCountOverride === undefined
    ? BALANCE_ROLLING_RECONCILIATION.weekCount : Number(weekCountOverride);
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('Balance Sheet rolling week count must be an integer between 1 and 52.');
  }
  const latestWeek = getBalanceWeeklySnapshotRange_(referenceIsoDate).snapshotWeek;
  const latestMonday = parseIsoDateUtc_(latestWeek);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    periods.push(buildBalanceWeeklyHistoryRange_(formatUtcDate_(
      new Date(latestMonday.getTime() - offset * 7 * 86400000)
    )));
  }
  const monthlyPeriods = [];
  const reference = parseIsoDateUtc_(referenceIsoDate || todayIsoDate_());
  const currentMonthStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const lastClosedMonthStart = new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - 1, 1));
  const firstWeekDate = parseIsoDateUtc_(periods[0].snapshotWeek);
  let monthStart = new Date(Date.UTC(firstWeekDate.getUTCFullYear(), firstWeekDate.getUTCMonth(), 1));
  while (monthStart.getTime() <= lastClosedMonthStart.getTime()) {
    const captureDate = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, BALANCE_CADENCE.monthlyDay));
    if (captureDate.getTime() <= reference.getTime()) {
      const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
      monthlyPeriods.push({
        snapshotType: BALANCE_SNAPSHOT_TYPE_MONTHLY,
        snapshotWeek: formatUtcDate_(monthStart),
        asOfDate: formatUtcDate_(new Date(nextMonth.getTime() - 86400000)),
        snapshotDate: formatUtcDate_(captureDate)
      });
    }
    monthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
  }
  return {
    strategy: 'rolling_closed_weeks_and_due_months',
    weekCount: weekCount,
    startWeek: periods[0].snapshotWeek,
    endWeek: periods[periods.length - 1].snapshotWeek,
    horizonDate: periods[periods.length - 1].asOfDate,
    periods: periods,
    monthlyPeriods: monthlyPeriods,
    jobs: periods.concat(monthlyPeriods)
  };
}

/** Public read-only planner. It does not query QBO/BQ, create state, or install triggers. */
function getBalanceRollingReconciliationPlan(referenceIsoDate) {
  return buildBalanceRollingReconciliationPlan_(referenceIsoDate);
}

function readBalanceRollingScalarRow_(queryResult) {
  const fields = queryResult && queryResult.schema && queryResult.schema.fields || [];
  const values = queryResult && queryResult.rows && queryResult.rows[0] && queryResult.rows[0].f || [];
  return fields.reduce((row, field, index) => {
    row[field.name] = values[index] && values[index].v;
    return row;
  }, {});
}

function buildBalanceRollingCanonicalPredicate_(plan) {
  const weekly = "(COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY' AND SnapshotWeek BETWEEN DATE '" +
    plan.startWeek + "' AND DATE '" + plan.endWeek + "' AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)" +
    ' AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY))';
  const monthly = (plan.monthlyPeriods || []).map(period =>
    "(SnapshotType = 'MONTHLY' AND SnapshotWeek = DATE '" + period.snapshotWeek +
      "' AND SnapshotDate = DATE '" + period.snapshotDate + "' AND AsOfDate = DATE '" + period.asOfDate + "')"
  ).join(' OR ');
  return monthly ? '(' + weekly + ' OR ' + monthly + ')' : weekly;
}

function readBalanceRollingOutsideFingerprint_(tableName, datasetId, plan) {
  const result = runBalanceBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS STRING), '0') AS row_fingerprint",
    'FROM `' + tableName + '` t',
    'WHERE NOT COALESCE((' + buildBalanceRollingCanonicalPredicate_(plan) + '), FALSE)'
  ].join('\n'), datasetId);
  const row = readBalanceRollingScalarRow_(result);
  return {
    rowCount: Number(row.row_count || 0),
    rowFingerprint: String(row.row_fingerprint || '0')
  };
}

function readBalanceRollingOutsideFingerprints_(plan) {
  return {
    snapshots: readBalanceRollingOutsideFingerprint_(
      BALANCE_SNAPSHOT_TABLE, BQ_CONFIG.snapshotsDatasetId, plan
    ),
    audit: readBalanceRollingOutsideFingerprint_(
      BALANCE_AUDIT_TABLE, BQ_CONFIG.auditDatasetId, plan
    )
  };
}

function buildBalanceRollingLogicalKeySql_() {
  return "CONCAT(COALESCE(ClientId,''),'|',COALESCE(CAST(SnapshotWeek AS STRING),''),'|'," +
    "COALESCE(CAST(SnapshotDate AS STRING),''),'|',COALESCE(CAST(AsOfDate AS STRING),''),'|'," +
    "COALESCE(LineType,''),'|',COALESCE(StatementSection,''),'|',COALESCE(StatementSubsection,''),'|'," +
    "COALESCE(ParentAccount,''),'|',COALESCE(AccountName,''),'|',COALESCE(AccountPath,''),'|'," +
    "COALESCE(AccountId,''),'|',COALESCE(NormalizedCategory,''),'|',COALESCE(MetricName,''))";
}

function validateBalanceRollingReconciliation_(state) {
  const plan = state.plan;
  const clientIds = Array.from(new Set((state.expectedClientIds || []).map(String))).sort();
  if (!clientIds.length) throw new Error('Balance Sheet rolling validation requires expected clients.');
  const clientScope = buildBalanceClientScopeSql_(clientIds);
  const canonical = "(COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY' AND SnapshotWeek BETWEEN DATE '" +
    plan.startWeek + "' AND DATE '" + plan.endWeek +
    "' AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)" +
    ' AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY))';
  const weeklyResult = runBalanceBigQueryQuery_([
    'SELECT',
    '  (SELECT COUNT(DISTINCT SnapshotWeek) FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    '   WHERE ' + canonical + ' AND ClientId IN (' + clientScope + ')) AS actual_line_week_count,',
    '  (SELECT COUNT(*) - COUNT(DISTINCT ' + buildBalanceRollingLogicalKeySql_() + ')',
    '   FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    '   WHERE ' + canonical + ' AND ClientId IN (' + clientScope + ')) AS duplicate_line_count,',
    '  (SELECT COUNT(DISTINCT CONCAT(CAST(SnapshotWeek AS STRING), "|", ClientId))',
    '   FROM `' + BALANCE_AUDIT_TABLE + '`',
    '   WHERE ' + canonical + ' AND ClientId IN (' + clientScope + ')) AS covered_client_week_count,',
    '  (SELECT COUNT(*) - COUNT(DISTINCT CONCAT(CAST(SnapshotWeek AS STRING), "|", ClientId))',
    '   FROM `' + BALANCE_AUDIT_TABLE + '`',
    '   WHERE ' + canonical + ' AND ClientId IN (' + clientScope + ')) AS duplicate_audit_count,',
    '  (SELECT COUNT(*) FROM `' + BALANCE_AUDIT_TABLE + '`',
    "   WHERE LoadedAt >= TIMESTAMP '" + state.createdAt + "'",
    "     AND COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'",
    "     AND SnapshotWeek BETWEEN DATE '" + plan.startWeek + "' AND DATE '" + plan.endWeek + "'",
    '     AND ClientId IN (' + clientScope + ')',
    '     AND (SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '       OR AsOfDate != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY))) AS processed_noncanonical_count'
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const row = readBalanceRollingScalarRow_(weeklyResult);
  const monthlyWeeks = (plan.monthlyPeriods || []).map(period => "DATE '" + period.snapshotWeek + "'");
  const monthlyResult = monthlyWeeks.length ? runBalanceBigQueryQuery_([
    'SELECT',
    '  COUNT(DISTINCT SnapshotWeek) AS actual_month_count,',
    '  COUNT(*) - COUNT(DISTINCT ' + buildBalanceRollingLogicalKeySql_() + ') AS duplicate_line_count,',
    '  (SELECT COUNT(DISTINCT CONCAT(CAST(SnapshotWeek AS STRING), "|", ClientId))',
    '   FROM `' + BALANCE_AUDIT_TABLE + '` WHERE SnapshotType = \'MONTHLY\' AND SnapshotWeek IN (' + monthlyWeeks.join(',') + ')' +
      ' AND ClientId IN (' + clientScope + ')) AS covered_client_month_count,',
    '  (SELECT COUNT(*) - COUNT(DISTINCT CONCAT(CAST(SnapshotWeek AS STRING), "|", ClientId))',
    '   FROM `' + BALANCE_AUDIT_TABLE + '` WHERE SnapshotType = \'MONTHLY\' AND SnapshotWeek IN (' + monthlyWeeks.join(',') + ')' +
      ' AND ClientId IN (' + clientScope + ')) AS duplicate_audit_count',
    'FROM `' + BALANCE_SNAPSHOT_TABLE + '` WHERE SnapshotType = \'MONTHLY\' AND SnapshotWeek IN (' + monthlyWeeks.join(',') + ')' +
      ' AND ClientId IN (' + clientScope + ')'
  ].join('\n'), BQ_CONFIG.snapshotsDatasetId) : null;
  const mrow = monthlyResult ? readBalanceRollingScalarRow_(monthlyResult) : {};
  const currentOutside = readBalanceRollingOutsideFingerprints_(plan);
  const details = {
    expectedWeekCount: plan.weekCount,
    completedWeekCount: Number(state.completedCount || 0),
    actualLineWeekCount: Number(row.actual_line_week_count || 0),
    expectedClientWeekCount: plan.weekCount * clientIds.length,
    coveredClientWeekCount: Number(row.covered_client_week_count || 0),
    duplicateLineCount: Number(row.duplicate_line_count || 0),
    duplicateAuditCount: Number(row.duplicate_audit_count || 0),
    processedNoncanonicalCount: Number(row.processed_noncanonical_count || 0),
    expectedMonthCount: monthlyWeeks.length,
    completedMonthCount: Number(state.completedMonthCount || 0),
    actualMonthCount: Number(mrow.actual_month_count || 0),
    expectedClientMonthCount: monthlyWeeks.length * clientIds.length,
    coveredClientMonthCount: Number(mrow.covered_client_month_count || 0),
    duplicateMonthlyLineCount: Number(mrow.duplicate_line_count || 0),
    duplicateMonthlyAuditCount: Number(mrow.duplicate_audit_count || 0),
    outsideScopeUnchanged: JSON.stringify(currentOutside) === JSON.stringify(state.outsideScopeBaseline)
  };
  if (details.completedWeekCount !== details.expectedWeekCount ||
      details.coveredClientWeekCount !== details.expectedClientWeekCount ||
      details.completedMonthCount !== details.expectedMonthCount ||
      details.coveredClientMonthCount !== details.expectedClientMonthCount ||
      details.duplicateLineCount || details.duplicateAuditCount ||
      details.duplicateMonthlyLineCount || details.duplicateMonthlyAuditCount ||
      details.processedNoncanonicalCount || !details.outsideScopeUnchanged) {
    throw new Error('Balance Sheet rolling final validation failed: ' + JSON.stringify(details));
  }
  return { status: 'passed', ...details };
}

function readBalanceRollingState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    BALANCE_ROLLING_RECONCILIATION.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistBalanceRollingState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > BALANCE_ROLLING_RECONCILIATION.maxStateBytes) {
    throw new Error('Balance Sheet rolling state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    BALANCE_ROLLING_RECONCILIATION.statePropertyKey, serialized
  );
  return byteCount;
}

function deleteBalanceRollingTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === BALANCE_ROLLING_RECONCILIATION.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function ensureBalanceRollingRecoveryTrigger_() {
  const existing = ScriptApp.getProjectTriggers().find(trigger =>
    trigger.getHandlerFunction() === BALANCE_ROLLING_RECONCILIATION.recoveryHandler
  );
  if (existing) return existing;
  return ScriptApp.newTrigger(BALANCE_ROLLING_RECONCILIATION.recoveryHandler)
    .timeBased().everyHours(1).create();
}

function deleteBalanceRollingRecoveryTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === BALANCE_ROLLING_RECONCILIATION.recoveryHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function recoverBalanceRollingReconciliation() {
  const state = readBalanceRollingState_();
  if (!state || !['pending', 'running'].includes(state.status)) {
    deleteBalanceRollingRecoveryTriggers_();
    return { status: 'idle' };
  }
  const hasWorker = ScriptApp.getProjectTriggers().some(trigger =>
    trigger.getHandlerFunction() === BALANCE_ROLLING_RECONCILIATION.workerHandler
  );
  const updatedAt = Date.parse(state.updatedAt || '');
  const stale = !Number.isFinite(updatedAt) ||
    Date.now() - updatedAt >= BALANCE_ROLLING_RECONCILIATION.watchdogDelayMs;
  if (hasWorker && !stale) return { status: 'scheduled' };
  Logger.log(JSON.stringify({ event: 'balance_rolling_recovery_started', hasWorker, stale }));
  return processBalanceRollingReconciliation();
}

function replaceBalanceRollingSchedule_(delayMs, options) {
  const settings = options || {};
  const effectiveDelayMs = Math.max(60000, Number(delayMs) || 60000);
  if (!settings.preserveExisting) deleteBalanceRollingTriggers_();
  const trigger = ScriptApp.newTrigger(BALANCE_ROLLING_RECONCILIATION.workerHandler).timeBased()
    .after(effectiveDelayMs).create();
  Logger.log(JSON.stringify({
    event: 'balance_rolling_trigger_created',
    reason: settings.reason || 'unspecified',
    delayMs: effectiveDelayMs,
    preserveExisting: Boolean(settings.preserveExisting),
    triggerId: trigger && trigger.getUniqueId ? trigger.getUniqueId() : null
  }));
  return trigger;
}

function validateBalanceRollingPreflight_() {
  const deployment = readBalanceDeploymentState_();
  if (deployment && ['pending', 'processing', 'running'].includes(deployment.status)) {
    throw new Error('Balance Sheet deployment must finish before rolling reconciliation starts.');
  }
  const history = readBalanceWeeklyHistoryState_();
  if (history && ['pending', 'running'].includes(history.status)) {
    throw new Error('Balance Sheet weekly history backfill must finish before rolling reconciliation starts.');
  }
  const incident = readBalanceIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('Balance Sheet incident backfill must finish before rolling reconciliation starts.');
  }
  const monthlyValue = PropertiesService.getScriptProperties().getProperty(
    BALANCE_CADENCE.backfillStateProperty
  );
  const monthly = monthlyValue ? JSON.parse(monthlyValue) : null;
  if (monthly && ['pending', 'running'].includes(monthly.status)) {
    throw new Error('Balance Sheet monthly cadence backfill must finish before rolling reconciliation starts.');
  }
  validateBalanceCanonicalWeeklyView_();
  const spreadsheet = getBalanceReportSpreadsheet_();
  getBalanceConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getBalanceConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadBalanceEntityConfiguration_();
}

function startBalanceRollingReconciliation(referenceIsoDate) {
  const loaded = validateBalanceRollingPreflight_();
  const current = readBalanceRollingState_();
  if (current && ['pending', 'running'].includes(current.status) &&
      current.planVersion !== BALANCE_ROLLING_RECONCILIATION.planVersion) {
    throw new Error('An earlier Balance Sheet reconciliation is still active; finish it before starting the monthly plan.');
  }
  if (current && current.planVersion === BALANCE_ROLLING_RECONCILIATION.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    ensureBalanceRollingRecoveryTrigger_();
    replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'resume_existing_operation'
    });
    return current;
  }
  const selection = resolveBalanceEntitySelection_(null, loaded);
  const expectedClientIds = Object.keys(selection.clientsById).map(String).sort();
  if (!expectedClientIds.length) throw new Error('Balance Sheet rolling reconciliation has no authorized clients.');
  const plan = buildBalanceRollingReconciliationPlan_(referenceIsoDate);
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'balance_sheet',
    planVersion: BALANCE_ROLLING_RECONCILIATION.planVersion,
    status: 'pending', currentStage: 'bigquery', jobIndex: 0,
    plan: plan, expectedClientIds: expectedClientIds, currentClientIds: null,
    completedCount: 0, completedMonthCount: 0, retriedClientCount: 0,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    outsideScopeBaseline: readBalanceRollingOutsideFingerprints_(plan),
    lastResult: null, lastError: null, stageAttempts: 0,
    createdAt: now, updatedAt: now, completedAt: null
  };
  persistBalanceRollingState_(state);
  ensureBalanceRollingRecoveryTrigger_();
  replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.initialDelayMs, { reason: 'initial_continuation' });
  replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.watchdogDelayMs, {
    preserveExisting: true,
    reason: 'initial_watchdog'
  });
  return state;
}

function executeBalanceRollingWeek_(range, state) {
  const loaded = loadBalanceEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('Balance Sheet entity configuration changed during rolling reconciliation.');
  }
  const clientIds = state.currentClientIds || state.expectedClientIds;
  const result = executeBalanceSheetBigQuerySnapshot_(loaded, {
    snapshotType: range.snapshotType,
    snapshotDate: range.snapshotDate,
    snapshotWeek: range.snapshotWeek,
    asOfDate: range.asOfDate,
    requireAsOfDateMatch: true,
    clientIds: clientIds,
    forceClientScope: true,
    returnPartialResult: true
  });
  const failedIds = (result.clientFailures || []).map(failure => String(failure.clientId));
  if (failedIds.length) {
    state.currentClientIds = failedIds;
    state.retriedClientCount += failedIds.length;
    state.updatedAt = new Date().toISOString();
    persistBalanceRollingState_(state);
    throw new Error('Balance Sheet rolling week still has entity failures: ' +
      JSON.stringify(result.clientFailures));
  }
  return {
    status: 'completed', snapshotWeek: range.snapshotWeek, snapshotType: range.snapshotType,
    rowCount: result.lineRowCount, clientCount: result.clientCount,
    verification: result.verification && result.verification.status
  };
}

function compactBalanceRollingRefreshResult_(result) {
  return {
    status: result && result.status || 'completed',
    refreshedObjectCount: Number(result && result.refreshedObjectCount || 0)
  };
}

function processBalanceRollingReconciliation() {
  Logger.log(JSON.stringify({
    event: 'balance_rolling_worker_started',
    startedAt: new Date().toISOString()
  }));
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'lock_busy_retry'
    });
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteBalanceRollingTriggers_();
    const state = readBalanceRollingState_();
    if (!state) return { status: 'not_started' };
    if (['completed', 'failed'].includes(state.status)) {
      deleteBalanceRollingRecoveryTriggers_();
      return state;
    }
    ensureBalanceRollingRecoveryTrigger_();
    state.status = 'running';
    state.stageAttempts = Number(state.stageAttempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistBalanceRollingState_(state);
    replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.watchdogDelayMs, {
      reason: 'active_worker_watchdog'
    });

    if (state.currentStage === 'bigquery') {
      const result = executeBalanceRollingWeek_(state.plan.jobs[state.jobIndex], state);
      state.lastResult = result;
      state.jobIndex += 1;
      if (result.snapshotType === BALANCE_SNAPSHOT_TYPE_MONTHLY) state.completedMonthCount += 1;
      else state.completedCount += 1;
      state.currentClientIds = null;
      state.stageAttempts = 0;
      if (state.jobIndex >= state.plan.jobs.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validateBalanceRollingReconciliation_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = compactBalanceRollingRefreshResult_(
        refreshBalanceConnectedSheetsStage_('data_source_sheets')
      );
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      state.extracts = compactBalanceRollingRefreshResult_(
        refreshBalanceConnectedSheetsStage_('extracts')
      );
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Balance Sheet rolling reconciliation stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistBalanceRollingState_(state);
    if (state.status === 'completed') {
      deleteBalanceRollingTriggers_();
      deleteBalanceRollingRecoveryTriggers_();
    }
    else replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.continuationDelayMs, {
      preserveExisting: true,
      reason: 'next_stage_continuation'
    });
    return state;
  } catch (error) {
    const state = readBalanceRollingState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.stageAttempts || 0) < BALANCE_ROLLING_RECONCILIATION.maxStageAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistBalanceRollingState_(state);
      if (state.status === 'pending') {
        replaceBalanceRollingSchedule_(BALANCE_ROLLING_RECONCILIATION.failureRetryDelayMs, {
          preserveExisting: true,
          reason: 'failure_retry'
        });
      } else {
        deleteBalanceRollingTriggers_();
        deleteBalanceRollingRecoveryTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
