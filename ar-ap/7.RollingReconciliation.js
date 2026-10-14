/***********************
 * Rolling weekly AR/AP reconciliation
 *
 * Rebuilds the last 12 completed Sunday point-in-time reports. Each child
 * operation replaces only successful clients. Failed clients are retried as a
 * subset, and Connected Sheets is refreshed once after the entire window has
 * passed final validation.
 ***********************/

const AGING_ROLLING_RECONCILIATION = {
  planVersion: '2026-aging-rolling-v1',
  weekCount: 12,
  statePropertyKey: 'QBO_AGING_ROLLING_RECONCILIATION',
  workerHandler: 'processAgingRollingReconciliation',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  childPollDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 14 * 60 * 1000,
  maxJobRetries: 3,
  maxStateBytes: 8500
};

function formatAgingRollingDate_(date) {
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}

function buildAgingRollingReconciliationPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = weekCountOverride === undefined
    ? AGING_ROLLING_RECONCILIATION.weekCount
    : Number(weekCountOverride);
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('AR/AP rolling week count must be an integer between 1 and 52.');
  }

  const reference = safeParseDate_(referenceIsoDate || todayIsoDate_());
  if (!reference) throw new Error('Invalid AR/AP rolling reference date: ' + referenceIsoDate);
  const currentWeekMonday = safeParseDate_(getWeekStartMonday_(formatAgingRollingDate_(reference)));
  const latestSunday = new Date(currentWeekMonday.getTime() - 86400000);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    const snapshotDate = new Date(latestSunday.getTime() - offset * 7 * 86400000);
    const snapshotDateText = formatAgingRollingDate_(snapshotDate);
    periods.push({
      snapshotWeek: getWeekStartMonday_(snapshotDateText),
      snapshotDate: snapshotDateText,
      asOfDate: snapshotDateText
    });
  }

  return {
    strategy: 'rolling_closed_sundays',
    weekCount,
    startDate: periods[0].snapshotDate,
    endDate: periods[periods.length - 1].snapshotDate,
    periods
  };
}

/** Public read-only planner: no QBO calls, properties, triggers, or writes. */
function getAgingRollingReconciliationPlan(referenceIsoDate) {
  return buildAgingRollingReconciliationPlan_(referenceIsoDate);
}

function readAgingRollingScalarRow_(queryResult) {
  const fields = queryResult && queryResult.schema && queryResult.schema.fields || [];
  const values = queryResult && queryResult.rows && queryResult.rows[0] && queryResult.rows[0].f || [];
  return fields.reduce((row, field, index) => {
    row[field.name] = values[index] && values[index].v;
    return row;
  }, {});
}

function buildAgingRollingCanonicalDatePredicate_(plan, excluded) {
  return 'snapshot_date ' + (excluded ? 'NOT ' : '') +
    "IN UNNEST(GENERATE_DATE_ARRAY(DATE '" + plan.startDate + "', DATE '" +
    plan.endDate + "', INTERVAL 7 DAY))";
}

function readAgingRollingOutsideFingerprint_(plan) {
  const result = runAgingBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS STRING), '0') AS row_fingerprint",
    'FROM `' + AGING_BIGQUERY_TABLE + '` t',
    'WHERE ' + buildAgingRollingCanonicalDatePredicate_(plan, true)
  ].join('\n'));
  const row = readAgingRollingScalarRow_(result);
  return {
    rowCount: Number(row.row_count || 0),
    rowFingerprint: String(row.row_fingerprint || '0')
  };
}

function buildAgingRollingExpectedTotals_(state) {
  return Object.keys(state.expectedByDate || {}).reduce((total, snapshotDate) => {
    const item = state.expectedByDate[snapshotDate] || [];
    total.rowCount += Number(item[0] || 0);
    total.uniqueRowCount += Number(item[1] || 0);
    total.arRowCount += Number(item[2] || 0);
    total.apRowCount += Number(item[3] || 0);
    total.arOpenAmountCents += Number(item[4] || 0);
    total.apOpenAmountCents += Number(item[5] || 0);
    return total;
  }, {
    rowCount: 0, uniqueRowCount: 0, arRowCount: 0, apRowCount: 0,
    arOpenAmountCents: 0, apOpenAmountCents: 0
  });
}

function validateAgingRollingReconciliation_(state) {
  const plan = state.plan;
  const expected = buildAgingRollingExpectedTotals_(state);
  const expectedDates = Object.keys(state.expectedByDate || {});
  const expectedNonEmptyWeekCount = expectedDates.filter(snapshotDate =>
    Number((state.expectedByDate[snapshotDate] || [])[0] || 0) > 0
  ).length;
  const result = runAgingBigQueryQuery_([
    'SELECT',
    '  COUNT(*) AS row_count,',
    '  COUNT(DISTINCT snapshot_date) AS actual_week_count,',
    '  COUNT(DISTINCT FARM_FINGERPRINT(TO_JSON_STRING((SELECT AS STRUCT t.* EXCEPT(loaded_at))))) AS unique_row_count,',
    "  COUNTIF(report_type = 'AR') AS ar_row_count,",
    "  COUNTIF(report_type = 'AP') AS ap_row_count,",
    "  COALESCE(SUM(IF(report_type = 'AR', open_amount, 0)), 0) AS ar_open_amount,",
    "  COALESCE(SUM(IF(report_type = 'AP', open_amount, 0)), 0) AS ap_open_amount,",
    '  COUNTIF(snapshot_week != DATE_TRUNC(snapshot_date, WEEK(MONDAY))',
    '    OR as_of_date != snapshot_date OR EXTRACT(DAYOFWEEK FROM snapshot_date) != 1) AS noncanonical_date_count,',
    "  COUNTIF(report_type NOT IN ('AR', 'AP')) AS invalid_report_type_count,",
    "  COUNTIF(bucket != CASE WHEN days_overdue IS NULL OR days_overdue <= 0 THEN 'Current'",
    "    WHEN days_overdue <= 30 THEN '1–30' WHEN days_overdue <= 60 THEN '31–60'",
    "    WHEN days_overdue <= 90 THEN '61–90' ELSE '91+' END) AS invalid_bucket_count",
    'FROM `' + AGING_BIGQUERY_TABLE + '` t',
    'WHERE ' + buildAgingRollingCanonicalDatePredicate_(plan, false)
  ].join('\n'));
  const row = readAgingRollingScalarRow_(result);
  const actual = {
    rowCount: Number(row.row_count || 0),
    actualWeekCount: Number(row.actual_week_count || 0),
    uniqueRowCount: Number(row.unique_row_count || 0),
    arRowCount: Number(row.ar_row_count || 0),
    apRowCount: Number(row.ap_row_count || 0),
    arOpenAmountCents: agingAmountToCents_(row.ar_open_amount || 0),
    apOpenAmountCents: agingAmountToCents_(row.ap_open_amount || 0),
    noncanonicalDateCount: Number(row.noncanonical_date_count || 0),
    invalidReportTypeCount: Number(row.invalid_report_type_count || 0),
    invalidBucketCount: Number(row.invalid_bucket_count || 0)
  };
  const outside = readAgingRollingOutsideFingerprint_(plan);
  const details = {
    expectedWeekCount: plan.weekCount,
    completedWeekCount: Number(state.completedCount || 0),
    evidencedWeekCount: expectedDates.length,
    expectedNonEmptyWeekCount,
    actualWeekCount: actual.actualWeekCount,
    duplicateBusinessRowCount: actual.rowCount - actual.uniqueRowCount,
    outsideWindowUnchanged: JSON.stringify(outside) === JSON.stringify(state.outsideWindowBaseline),
    expected,
    actual
  };

  const totalsMatch = ['rowCount', 'uniqueRowCount', 'arRowCount', 'apRowCount',
    'arOpenAmountCents', 'apOpenAmountCents']
    .every(name => Number(actual[name]) === Number(expected[name]));
  if (details.completedWeekCount !== details.expectedWeekCount ||
      details.evidencedWeekCount !== details.expectedWeekCount ||
      details.actualWeekCount !== details.expectedNonEmptyWeekCount || !totalsMatch ||
      details.duplicateBusinessRowCount !== 0 || actual.noncanonicalDateCount !== 0 ||
      actual.invalidReportTypeCount !== 0 || actual.invalidBucketCount !== 0 ||
      !details.outsideWindowUnchanged) {
    throw new Error('AR/AP rolling final validation failed: ' + JSON.stringify(details));
  }
  return { status: 'passed', ...details };
}

function readAgingRollingState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    AGING_ROLLING_RECONCILIATION.statePropertyKey
  );
  return value ? JSON.parse(value) : null;
}

function persistAgingRollingState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = unescape(encodeURIComponent(serialized)).length;
  if (byteCount > AGING_ROLLING_RECONCILIATION.maxStateBytes) {
    throw new Error('AR/AP rolling state exceeds safe Script Properties size. bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    AGING_ROLLING_RECONCILIATION.statePropertyKey,
    serialized
  );
  return byteCount;
}

function deleteAgingRollingTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === AGING_ROLLING_RECONCILIATION.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceAgingRollingSchedule_(delayMs) {
  deleteAgingRollingTriggers_();
  ScriptApp.newTrigger(AGING_ROLLING_RECONCILIATION.workerHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function validateAgingRollingPreflight_() {
  const incident = readAgingIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('AR/AP incident backfill must finish before rolling reconciliation starts.');
  }
  const deployment = readAgingDeploymentState_();
  if (deployment && ['pending', 'processing'].includes(deployment.status)) {
    throw new Error('AR/AP deployment must finish before rolling reconciliation starts.');
  }
  const spreadsheet = getAgingReportSpreadsheet_();
  getAgingConnectedSheetTargets_(spreadsheet, 'data_source_sheets');
  getAgingConnectedSheetTargets_(spreadsheet, 'extracts');
  return loadAgingEntityConfiguration_();
}

function startAgingRollingReconciliation(referenceIsoDate) {
  const loaded = validateAgingRollingPreflight_();
  const plan = buildAgingRollingReconciliationPlan_(referenceIsoDate);
  const current = readAgingRollingState_();
  if (current && current.planVersion === AGING_ROLLING_RECONCILIATION.planVersion &&
      ['pending', 'running'].includes(current.status)) {
    replaceAgingRollingSchedule_(AGING_ROLLING_RECONCILIATION.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(), report: 'ar_ap',
    planVersion: AGING_ROLLING_RECONCILIATION.planVersion,
    status: 'pending', currentStage: 'bigquery', jobIndex: 0,
    plan, configurationHash: loaded.configuration.configuration_hash,
    childOperationId: null, currentClientIds: null, currentRetryCount: 0,
    currentAccum: [0, 0, 0, 0, 0, 0], expectedByDate: {},
    completedCount: 0, retriedClientCount: 0,
    outsideWindowBaseline: readAgingRollingOutsideFingerprint_(plan),
    lastResult: null, lastError: null,
    createdAt: now, updatedAt: now, completedAt: null
  };
  persistAgingRollingState_(state);
  replaceAgingRollingSchedule_(AGING_ROLLING_RECONCILIATION.initialDelayMs);
  return state;
}

function addAgingRollingResult_(accum, result) {
  const next = (accum || [0, 0, 0, 0, 0, 0]).slice();
  const reportRows = result.reportRowCounts || result.report_row_counts || {};
  const openCents = result.open_amount_cents || {
    AR: agingAmountToCents_(result.openAmount && result.openAmount.AR || 0),
    AP: agingAmountToCents_(result.openAmount && result.openAmount.AP || 0)
  };
  next[0] += Number(result.rowCount === undefined ? result.row_count : result.rowCount) || 0;
  next[1] += Number(result.uniqueRowCount === undefined ? result.unique_row_count : result.uniqueRowCount) || 0;
  next[2] += Number(reportRows.AR || 0);
  next[3] += Number(reportRows.AP || 0);
  next[4] += Number(openCents.AR || 0);
  next[5] += Number(openCents.AP || 0);
  return next;
}

function advanceAgingRollingJob_(state) {
  const period = state.plan.periods[state.jobIndex];
  if (!period) throw new Error('AR/AP rolling job is missing at index ' + state.jobIndex);
  const loaded = loadAgingEntityConfiguration_();
  if (loaded.configuration.configuration_hash !== state.configurationHash) {
    throw new Error('AR/AP entity configuration changed during rolling reconciliation.');
  }

  if (!state.childOperationId) {
    const queued = queueAgingConfigurationDeployment_(
      { request_id: Utilities.getUuid() },
      loaded.configuration,
      {
        source: 'rolling_12_week_reconciliation',
        range: { snapshotDate: period.snapshotDate },
        skipOutputSheets: true,
        skipConnectedSheets: true,
        forceReprocess: true,
        clientIds: state.currentClientIds || []
      }
    );
    state.childOperationId = queued.operationId;
    return { waiting: true, reason: 'child_queued' };
  }

  const deployment = readAgingDeploymentState_();
  if (!deployment || deployment.operation_id !== state.childOperationId) {
    throw new Error('AR/AP rolling child deployment is missing or was replaced.');
  }
  if (deployment.status === 'pending' || deployment.status === 'processing') {
    return { waiting: true, reason: 'child_running' };
  }

  if (deployment.status === 'failed') {
    const checkpoint = readAgingBigQueryCheckpoint_();
    if (!checkpoint || checkpoint.operation_id !== state.childOperationId) {
      throw new Error('AR/AP rolling failed child checkpoint is unavailable.');
    }
    state.currentAccum = addAgingRollingResult_(state.currentAccum, checkpoint);
    const successfulIds = new Set((checkpoint.successful_client_ids || []).map(String));
    const failedIds = (checkpoint.clients || [])
      .map(client => String(client.id || ''))
      .filter(clientId => clientId && !successfulIds.has(clientId));
    if (!failedIds.length) {
      throw new Error('AR/AP rolling child failed without an isolated client: ' + deployment.last_error);
    }
    state.currentRetryCount = Number(state.currentRetryCount || 0) + 1;
    if (state.currentRetryCount > AGING_ROLLING_RECONCILIATION.maxJobRetries) {
      throw new Error('AR/AP rolling client retries exhausted: ' + failedIds.join(','));
    }
    state.retriedClientCount += failedIds.length;
    state.currentClientIds = Array.from(new Set(failedIds)).sort();
    state.childOperationId = null;
    return { waiting: true, reason: 'failed_clients_selected_for_retry' };
  }

  if (deployment.status !== 'completed') {
    throw new Error('Unexpected AR/AP rolling child status: ' + deployment.status);
  }
  const result = deployment.stages && deployment.stages.bigquery &&
    deployment.stages.bigquery.result;
  if (!result || result.status !== 'completed') {
    throw new Error('AR/AP rolling child completed without a valid BigQuery result.');
  }
  state.currentAccum = addAgingRollingResult_(state.currentAccum, result);
  state.expectedByDate[period.snapshotDate] = state.currentAccum;
  state.lastResult = {
    snapshotDate: period.snapshotDate,
    snapshotWeek: period.snapshotWeek,
    rowCount: state.currentAccum[0],
    status: 'completed'
  };
  state.jobIndex += 1;
  state.completedCount += 1;
  state.childOperationId = null;
  state.currentClientIds = null;
  state.currentRetryCount = 0;
  state.currentAccum = [0, 0, 0, 0, 0, 0];
  return { waiting: false, reason: 'week_completed' };
}

function processAgingRollingReconciliation() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceAgingRollingSchedule_(AGING_ROLLING_RECONCILIATION.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteAgingRollingTriggers_();
    const state = readAgingRollingState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    persistAgingRollingState_(state);
    replaceAgingRollingSchedule_(AGING_ROLLING_RECONCILIATION.watchdogDelayMs);

    let nextDelay = AGING_ROLLING_RECONCILIATION.continuationDelayMs;
    if (state.currentStage === 'bigquery') {
      const progress = advanceAgingRollingJob_(state);
      if (progress.waiting && progress.reason === 'child_running') {
        nextDelay = AGING_ROLLING_RECONCILIATION.childPollDelayMs;
      }
      if (state.jobIndex >= state.plan.periods.length) state.currentStage = 'validation';
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validateAgingRollingReconciliation_(state);
      state.currentStage = 'data_source_sheets';
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = refreshAgingConnectedSheetsStage_('data_source_sheets');
      state.currentStage = 'extracts';
    } else if (state.currentStage === 'extracts') {
      state.extracts = refreshAgingConnectedSheetsStage_('extracts');
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
    } else {
      throw new Error('Unsupported AR/AP rolling stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistAgingRollingState_(state);
    if (state.status === 'completed') deleteAgingRollingTriggers_();
    else replaceAgingRollingSchedule_(nextDelay);
    return state;
  } catch (error) {
    const state = readAgingRollingState_();
    if (state) {
      state.status = 'failed';
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.updatedAt = new Date().toISOString();
      persistAgingRollingState_(state);
    }
    deleteAgingRollingTriggers_();
    throw error;
  } finally {
    lock.releaseLock();
  }
}
