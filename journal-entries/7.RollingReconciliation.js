/***********************
 * Rolling weekly reconciliation
 *
 * Re-captures the last 12 completed Monday-to-Sunday Journal periods. Each
 * successful client replaces only its own rows in one weekly partition. A
 * partial retry never performs full-scope stale-client cleanup.
 ***********************/

const JOURNAL_ROLLING_RECONCILIATION = {
  planVersion: '2026-journal-rolling-v1',
  weekCount: 12,
  statePropertyKey: 'QBO_JOURNAL_ROLLING_RECONCILIATION',
  workerHandler: 'processJournalRollingReconciliation',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 13 * 60 * 1000,
  maxJobAttempts: 3,
  maxStageAttempts: 3,
  maxStateBytes: 8500
};

function buildJournalRollingReconciliationPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = weekCountOverride === undefined
    ? JOURNAL_ROLLING_RECONCILIATION.weekCount
    : Number(weekCountOverride);
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('Journal Entries rolling week count must be an integer between 1 and 52.');
  }

  const latest = getPreviousCompletedWeekRange_(referenceIsoDate);
  const latestMonday = safeParseDate_(latest.snapshotWeek);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    const monday = new Date(latestMonday.getTime() - offset * 7 * 86400000);
    const snapshotWeek = formatUtcDate_(monday);
    periods.push(normalizeJournalDeploymentRange_({
      snapshotWeek,
      snapshotDate: addJournalBackfillDays_(snapshotWeek, 7),
      dateFrom: snapshotWeek,
      dateTo: addJournalBackfillDays_(snapshotWeek, 6),
      periodKey: snapshotWeek + '|' + addJournalBackfillDays_(snapshotWeek, 6)
    }));
  }

  return {
    strategy: 'rolling_closed_weeks',
    weekCount,
    startWeek: periods[0].snapshotWeek,
    endWeek: periods[periods.length - 1].snapshotWeek,
    horizonDate: periods[periods.length - 1].dateTo,
    periods
  };
}

/** Public read-only planner. It creates no state, triggers, QBO calls, or BigQuery jobs. */
function getJournalRollingReconciliationPlan(referenceIsoDate) {
  return buildJournalRollingReconciliationPlan_(referenceIsoDate);
}

function readJournalRollingScalarRow_(queryResult) {
  const fields = queryResult && queryResult.schema && queryResult.schema.fields || [];
  const values = queryResult && queryResult.rows && queryResult.rows[0] && queryResult.rows[0].f || [];
  return fields.reduce((row, field, index) => {
    row[field.name] = values[index] && values[index].v;
    return row;
  }, {});
}

function readJournalRollingOutsideFingerprint_(plan) {
  const result = runBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS distinct_key_count,',
    "  COALESCE(CAST(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS STRING), '0') AS row_fingerprint",
    'FROM `' + JOURNAL_BIGQUERY_TABLE + '` t',
    "WHERE SnapshotWeek < DATE '" + plan.startWeek + "'",
    "   OR SnapshotWeek > DATE '" + plan.endWeek + "'"
  ].join('\n'));
  const row = readJournalRollingScalarRow_(result);
  return {
    rowCount: Number(row.row_count || 0),
    distinctKeyCount: Number(row.distinct_key_count || 0),
    rowFingerprint: String(row.row_fingerprint || '0')
  };
}

function validateJournalRollingReconciliation_(state) {
  const loaded = loadJournalEntityConfiguration_();
  if (String(loaded.configuration.configuration_hash || '') !== String(state.configurationHash || '')) {
    throw new Error('Journal Entries entity configuration changed during rolling reconciliation.');
  }

  const plan = state.plan;
  const result = runBigQueryQuery_([
    'WITH window_rows AS (',
    '  SELECT *',
    '  FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
    "  WHERE SnapshotWeek BETWEEN DATE '" + plan.startWeek + "' AND DATE '" + plan.endWeek + "'",
    '), imbalanced AS (',
    '  SELECT SnapshotWeek, ClientId',
    '  FROM window_rows',
    '  GROUP BY SnapshotWeek, ClientId',
    '  HAVING ABS(ROUND(COALESCE(SUM(DebitAmount), 0) - COALESCE(SUM(CreditAmount), 0), 2)) > 0.01',
    '), cross_week_duplicates AS (',
    '  SELECT ClientId, TransactionId, LineNumber',
    '  FROM window_rows',
    '  GROUP BY ClientId, TransactionId, LineNumber',
    '  HAVING COUNT(DISTINCT SnapshotWeek) > 1',
    ')',
    'SELECT',
    '  COUNT(DISTINCT SnapshotWeek) AS actual_week_count,',
    '  COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '    OR DateFrom != SnapshotWeek',
    '    OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS noncanonical_row_count,',
    '  COUNTIF(TransactionDate < DateFrom OR TransactionDate > DateTo) AS transaction_outside_period_count,',
    '  COUNTIF(idempotency_key IS NULL OR TRIM(idempotency_key) = \'\') AS missing_key_count,',
    '  COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_key_count,',
    '  (SELECT COUNT(*) FROM imbalanced) AS imbalanced_client_week_count,',
    '  (SELECT COUNT(*) FROM cross_week_duplicates) AS cross_week_duplicate_count',
    'FROM window_rows'
  ].join('\n'));
  const row = readJournalRollingScalarRow_(result);
  const outsideWindow = readJournalRollingOutsideFingerprint_(plan);
  const validation = {
    status: 'passed',
    expectedCompletedWeekCount: plan.weekCount,
    completedWeekCount: Number(state.completedCount || 0),
    actualWeekCount: Number(row.actual_week_count || 0),
    noncanonicalRowCount: Number(row.noncanonical_row_count || 0),
    transactionOutsidePeriodCount: Number(row.transaction_outside_period_count || 0),
    missingKeyCount: Number(row.missing_key_count || 0),
    duplicateKeyCount: Number(row.duplicate_key_count || 0),
    imbalancedClientWeekCount: Number(row.imbalanced_client_week_count || 0),
    crossWeekDuplicateCount: Number(row.cross_week_duplicate_count || 0),
    outsideWindowUnchanged:
      JSON.stringify(outsideWindow) === JSON.stringify(state.outsideWindowBaseline)
  };

  if (
    validation.completedWeekCount !== validation.expectedCompletedWeekCount ||
    validation.noncanonicalRowCount ||
    validation.transactionOutsidePeriodCount ||
    validation.missingKeyCount ||
    validation.duplicateKeyCount ||
    validation.imbalancedClientWeekCount ||
    validation.crossWeekDuplicateCount ||
    !validation.outsideWindowUnchanged
  ) {
    throw new Error('Journal Entries rolling final validation failed: ' + JSON.stringify(validation));
  }
  return validation;
}

function readJournalRollingState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    JOURNAL_ROLLING_RECONCILIATION.statePropertyKey
  );
  return serialized ? JSON.parse(serialized) : null;
}

function persistJournalRollingState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > JOURNAL_ROLLING_RECONCILIATION.maxStateBytes) {
    throw new Error('Journal Entries rolling state exceeds safe Script Properties size. Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    JOURNAL_ROLLING_RECONCILIATION.statePropertyKey,
    serialized
  );
  return byteCount;
}

function deleteJournalRollingTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === JOURNAL_ROLLING_RECONCILIATION.workerHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceJournalRollingSchedule_(delayMs) {
  deleteJournalRollingTriggers_();
  ScriptApp.newTrigger(JOURNAL_ROLLING_RECONCILIATION.workerHandler)
    .timeBased().after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function assertJournalRollingIdle_(contextLabel) {
  const state = readJournalRollingState_();
  if (state && ['pending', 'running'].includes(state.status)) {
    throw new Error(
      'Journal Entries rolling reconciliation blocks ' +
      String(contextLabel || 'this operation') + '. CurrentWeek=' +
      String(state.plan && state.plan.periods && state.plan.periods[state.jobIndex] &&
        state.plan.periods[state.jobIndex].snapshotWeek || '')
    );
  }
}

function validateJournalRollingPreflight_() {
  const deployment = readJournalDeploymentState_();
  if (deployment && ['pending', 'running'].includes(deployment.status)) {
    throw new Error('Journal Entries deployment must finish before rolling reconciliation starts.');
  }
  const backfill = readJournalBackfillState_();
  if (backfill && ['pending', 'running'].includes(backfill.status)) {
    throw new Error('Journal Entries historical backfill must finish before rolling reconciliation starts.');
  }
  const incident = readJournalIncidentBackfillState_();
  if (incident && ['pending', 'running'].includes(incident.status)) {
    throw new Error('Journal Entries incident backfill must finish before rolling reconciliation starts.');
  }
  return loadJournalEntityConfiguration_();
}

function startJournalRollingReconciliation(referenceIsoDate) {
  const loaded = validateJournalRollingPreflight_();
  const current = readJournalRollingState_();
  if (
    current &&
    current.planVersion === JOURNAL_ROLLING_RECONCILIATION.planVersion &&
    ['pending', 'running'].includes(current.status)
  ) {
    replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.continuationDelayMs);
    return current;
  }

  const plan = buildJournalRollingReconciliationPlan_(referenceIsoDate);
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(),
    report: 'journal_entries',
    planVersion: JOURNAL_ROLLING_RECONCILIATION.planVersion,
    status: 'pending',
    currentStage: 'bigquery',
    jobIndex: 0,
    completedCount: 0,
    currentClientIds: null,
    retryGeneration: 0,
    jobAttempts: 0,
    stageAttempts: 0,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    plan,
    outsideWindowBaseline: readJournalRollingOutsideFingerprint_(plan),
    lastResult: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null
  };
  deleteJournalBigQueryCheckpoint_();
  persistJournalRollingState_(state);
  replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.initialDelayMs);
  return state;
}

function executeJournalRollingJob_(state) {
  const period = state.plan.periods[state.jobIndex];
  if (!period) throw new Error('Journal Entries rolling job is missing at index ' + state.jobIndex + '.');
  const loaded = loadJournalEntityConfiguration_();
  if (String(loaded.configuration.configuration_hash) !== String(state.configurationHash)) {
    throw new Error('Journal Entries entity configuration changed during rolling reconciliation.');
  }

  const childOperationId = [
    state.operationId,
    period.snapshotWeek.replace(/-/g, ''),
    Number(state.retryGeneration || 0)
  ].join('_');
  const result = executeJournalBigQueryContinuationStage_({
    operation_id: childOperationId,
    configuration_version: state.configurationVersion,
    configuration_hash: state.configurationHash,
    period
  }, loaded, {
    clientIds: state.currentClientIds || [],
    returnPartialResult: true
  });

  if (result && result.status === 'yielded') return result;
  const failedClientIds = (result.clientFailures || [])
    .map(failure => String(failure.clientId || '').trim())
    .filter(Boolean);
  if (failedClientIds.length) {
    state.jobAttempts = Number(state.jobAttempts || 0) + 1;
    if (state.jobAttempts >= JOURNAL_ROLLING_RECONCILIATION.maxJobAttempts) {
      throw new Error(
        'Journal Entries rolling job exhausted client retries. Week=' +
        period.snapshotWeek + ', failures=' + JSON.stringify(result.clientFailures)
      );
    }
    state.currentClientIds = failedClientIds;
    state.retryGeneration = Number(state.retryGeneration || 0) + 1;
    state.lastResult = {
      status: 'retry_required',
      snapshotWeek: period.snapshotWeek,
      failedClientCount: failedClientIds.length
    };
    deleteJournalBigQueryCheckpoint_();
    return state.lastResult;
  }

  return {
    status: 'completed',
    snapshotWeek: period.snapshotWeek,
    rowCount: Number(result.rowCount || 0),
    clientCount: Number(result.clientCount || 0),
    verification: result.verification && result.verification.status || null
  };
}

function processJournalRollingReconciliation() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }

  try {
    deleteJournalRollingTriggers_();
    const state = readJournalRollingState_();
    if (!state) return { status: 'not_started' };
    if (state.status === 'completed') return state;
    state.status = 'running';
    state.updatedAt = new Date().toISOString();
    persistJournalRollingState_(state);
    replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.watchdogDelayMs);

    if (state.currentStage === 'bigquery') {
      const result = executeJournalRollingJob_(state);
      state.lastResult = result;
      if (result.status === 'completed') {
        state.jobIndex += 1;
        state.completedCount += 1;
        state.currentClientIds = null;
        state.retryGeneration = 0;
        state.jobAttempts = 0;
        state.stageAttempts = 0;
        deleteJournalBigQueryCheckpoint_();
        if (state.jobIndex >= state.plan.periods.length) state.currentStage = 'validation';
      }
    } else if (state.currentStage === 'validation') {
      state.finalValidation = validateJournalRollingReconciliation_(state);
      state.currentStage = 'data_source_sheets';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'data_source_sheets') {
      state.dataSourceSheets = refreshJournalConnectedSheetsStage_('data_source_sheets');
      state.currentStage = 'extracts';
      state.stageAttempts = 0;
    } else if (state.currentStage === 'extracts') {
      state.extracts = refreshJournalConnectedSheetsStage_('extracts');
      state.currentStage = 'completed';
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.stageAttempts = 0;
    } else {
      throw new Error('Unsupported Journal Entries rolling stage: ' + state.currentStage);
    }

    if (state.status !== 'completed') state.status = 'pending';
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    persistJournalRollingState_(state);
    if (state.status === 'completed') deleteJournalRollingTriggers_();
    else replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.continuationDelayMs);
    return state;
  } catch (error) {
    const state = readJournalRollingState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.stageAttempts = Number(state.stageAttempts || 0) + 1;
      state.status = state.stageAttempts < JOURNAL_ROLLING_RECONCILIATION.maxStageAttempts
        ? 'pending'
        : 'failed';
      state.updatedAt = new Date().toISOString();
      prepareJournalBigQueryCheckpointForRetry_();
      persistJournalRollingState_(state);
      if (state.status === 'pending') {
        replaceJournalRollingSchedule_(JOURNAL_ROLLING_RECONCILIATION.failureRetryDelayMs);
      } else {
        deleteJournalRollingTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
