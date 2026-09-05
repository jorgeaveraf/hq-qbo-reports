/***********************
 * Journal Entries historical backfill
 *
 * One-time, manually started operation. It fills weekly BigQuery partitions
 * from 2026-01-01 through the day before the oldest partition that existed
 * when the operation was planned. It deliberately does not refresh Sheets.
 ***********************/

function addJournalBackfillDays_(isoDate, dayCount) {
  const date = safeParseDate_(isoDate);
  if (!date) throw new Error('Invalid Journal Entries backfill date: ' + isoDate);
  date.setUTCDate(date.getUTCDate() + Number(dayCount || 0));
  return formatUtcDate_(date);
}

function getJournalBackfillWeekStart_(isoDate) {
  const date = safeParseDate_(isoDate);
  if (!date) throw new Error('Invalid Journal Entries backfill date: ' + isoDate);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return formatUtcDate_(date);
}

function buildJournalBackfillPeriod_(cursorDate, horizonDate) {
  const cursor = normalizeDateForOutput_(cursorDate);
  const horizon = normalizeDateForOutput_(horizonDate);
  if (!cursor || !horizon) {
    throw new Error('Journal Entries backfill period requires valid dates.');
  }
  if (cursor > horizon) return null;

  const weekStart = getJournalBackfillWeekStart_(cursor);
  const weekEnd = addJournalBackfillDays_(weekStart, 6);
  const dateTo = weekEnd < horizon ? weekEnd : horizon;
  return normalizeJournalDeploymentRange_({
    snapshotDate: addJournalBackfillDays_(dateTo, 1),
    snapshotWeek: weekStart,
    dateFrom: cursor,
    dateTo,
    periodKey: cursor + '|' + dateTo
  });
}

function parseJournalBackfillCoverage_(queryResult) {
  const cells = queryResult && queryResult.rows && queryResult.rows[0] &&
    queryResult.rows[0].f || [];
  const oldestSnapshotWeek = String(cells[0] && cells[0].v || '').trim();
  const newestSnapshotWeek = String(cells[1] && cells[1].v || '').trim();
  const partitionCount = Number(cells[2] && cells[2].v || 0);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(oldestSnapshotWeek)) {
    throw new Error(
      'Journal Entries backfill cannot determine the oldest existing SnapshotWeek. ' +
      'The destination table must already contain the current weekly history.'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newestSnapshotWeek)) {
    throw new Error('Journal Entries backfill cannot determine the newest SnapshotWeek.');
  }

  return { oldestSnapshotWeek, newestSnapshotWeek, partitionCount };
}

function getJournalBackfillCoverage_() {
  return parseJournalBackfillCoverage_(runBigQueryQuery_([
    'SELECT',
    "  FORMAT_DATE('%F', MIN(SnapshotWeek)) AS oldest_snapshot_week,",
    "  FORMAT_DATE('%F', MAX(SnapshotWeek)) AS newest_snapshot_week,",
    '  COUNT(DISTINCT SnapshotWeek) AS partition_count',
    'FROM `' + JOURNAL_BIGQUERY_TABLE + '`'
  ].join('\n')));
}

function planJournalBackfill_(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const startDate = normalizeDateForOutput_(
    settings.startDate || JOURNAL_BACKFILL_CONFIG.startDate
  );
  if (!startDate || startDate < JOURNAL_BACKFILL_CONFIG.startDate) {
    throw new Error(
      'Journal Entries backfill cannot start before ' +
      JOURNAL_BACKFILL_CONFIG.startDate + '.'
    );
  }

  const coverage = settings.coverage || getJournalBackfillCoverage_();
  const protectedBefore = normalizeDateForOutput_(coverage.oldestSnapshotWeek);
  if (!protectedBefore) {
    throw new Error('Journal Entries backfill coverage is invalid.');
  }
  const horizonDate = addJournalBackfillDays_(protectedBefore, -1);
  const periods = [];
  let cursorDate = startDate;

  while (cursorDate <= horizonDate) {
    if (periods.length >= 400) {
      throw new Error('Journal Entries backfill plan exceeded 400 weekly periods.');
    }
    const period = buildJournalBackfillPeriod_(cursorDate, horizonDate);
    if (!period) break;
    if (period.snapshotWeek >= protectedBefore) {
      throw new Error('Journal Entries backfill plan overlaps protected history.');
    }
    periods.push(period);
    cursorDate = addJournalBackfillDays_(period.dateTo, 1);
  }

  return {
    startDate,
    horizonDate,
    protectedBefore,
    oldestExistingSnapshotWeek: protectedBefore,
    newestExistingSnapshotWeek: coverage.newestSnapshotWeek,
    existingPartitionCount: Number(coverage.partitionCount || 0),
    periodCount: periods.length,
    firstPeriod: periods.length ? periods[0] : null,
    lastPeriod: periods.length ? periods[periods.length - 1] : null,
    periods
  };
}

function countJournalBackfillPartitionRows_(snapshotWeek) {
  const normalized = normalizeDateForOutput_(snapshotWeek);
  if (!normalized) throw new Error('Invalid Journal Entries backfill SnapshotWeek.');
  const result = runBigQueryQuery_([
    'SELECT COUNT(*) AS row_count',
    'FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek = DATE '" + escapeJournalBigQueryString_(normalized) + "'"
  ].join('\n'));
  return Number(
    result && result.rows && result.rows[0] && result.rows[0].f &&
    result.rows[0].f[0] && result.rows[0].f[0].v || 0
  );
}

function assertJournalBackfillPeriodSafe_(period, protectedBefore) {
  const normalized = normalizeJournalDeploymentRange_(period);
  const boundary = normalizeDateForOutput_(protectedBefore);
  if (!boundary || normalized.snapshotWeek >= boundary || normalized.dateTo >= boundary) {
    throw new Error(
      'Journal Entries backfill refuses to touch protected history. Period=' +
      normalized.periodKey + ', protectedBefore=' + boundary
    );
  }
  const existingRowCount = countJournalBackfillPartitionRows_(normalized.snapshotWeek);
  if (existingRowCount !== 0) {
    throw new Error(
      'Journal Entries backfill found an unexpected populated partition and stopped before deletion. ' +
      'SnapshotWeek=' + normalized.snapshotWeek + ', rowCount=' + existingRowCount
    );
  }
  return { status: 'passed', snapshotWeek: normalized.snapshotWeek, existingRowCount };
}

function readJournalBackfillState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    JOURNAL_BACKFILL_CONFIG.statePropertyKey
  );
  if (!serialized) return null;
  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('State is not an object.');
    }
    if (!String(state.operation_id || '').trim()) throw new Error('Missing operation_id.');
    return state;
  } catch (error) {
    throw new Error('Invalid Journal Entries backfill state: ' + error.message);
  }
}

function persistJournalBackfillState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > JOURNAL_BACKFILL_CONFIG.maxStateBytes) {
    throw new Error(
      'Journal Entries backfill state exceeds the Script Property limit. Bytes=' + byteCount
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    JOURNAL_BACKFILL_CONFIG.statePropertyKey,
    serialized
  );
  return { byteCount };
}

function summarizeJournalBackfillState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operation_id,
    status: state.status,
    startDate: state.start_date,
    horizonDate: state.horizon_date,
    protectedBefore: state.protected_before,
    cursorDate: state.cursor_date,
    totalPeriodCount: state.total_period_count,
    processedPeriodCount: state.processed_period_count,
    nonEmptyPeriodCount: state.non_empty_period_count,
    emptyPeriodCount: state.empty_period_count,
    totalRowCount: state.total_row_count,
    totalTransactionCount: state.total_transaction_count,
    currentPeriod: state.current_period || null,
    currentPeriodAttempts: Number(state.current_period_attempts || 0),
    sheetsRefreshed: false,
    updatedAt: state.updated_at,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null
  };
}

function replaceJournalBackfillWorkerSchedule_(delayMs) {
  const existing = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === JOURNAL_BACKFILL_CONFIG.workerHandler
  );
  existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  const normalizedDelayMs = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(JOURNAL_BACKFILL_CONFIG.workerHandler)
    .timeBased().after(normalizedDelayMs).create();
  return {
    triggerId: trigger.getUniqueId(),
    delayMs: normalizedDelayMs,
    previousTriggersDeleted: existing.length
  };
}

function deleteJournalBackfillWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === JOURNAL_BACKFILL_CONFIG.workerHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function assertJournalDeploymentIdleForBackfill_() {
  const deployment = readJournalDeploymentState_();
  if (deployment && ['pending', 'running', 'processing'].includes(deployment.status)) {
    throw new Error(
      'Journal Entries deployment must finish before the backfill starts. CurrentStatus=' +
      deployment.status
    );
  }
}

function assertJournalBackfillIdle_(contextLabel) {
  const state = readJournalBackfillState_();
  if (state && ['pending', 'running'].includes(state.status)) {
    throw new Error(
      'Journal Entries backfill is active and blocks ' +
      String(contextLabel || 'this operation') + '. CurrentPeriod=' +
      JSON.stringify(state.current_period || null)
    );
  }
}

function queueJournalBackfill_(options) {
  assertJournalDeploymentIdleForBackfill_();
  const current = readJournalBackfillState_();

  if (current && ['pending', 'running', 'completed'].includes(current.status)) {
    if (current.status !== 'completed') {
      replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.continuationDelayMs);
    }
    return summarizeJournalBackfillState_(current, false);
  }

  if (current && current.status === 'failed') {
    current.status = 'pending';
    current.current_period_attempts = 0;
    current.last_error = null;
    current.updated_at = new Date().toISOString();
    prepareJournalBigQueryCheckpointForRetry_();
    persistJournalBackfillState_(current);
    replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.failureRetryDelayMs);
    return summarizeJournalBackfillState_(current, true);
  }

  const plan = planJournalBackfill_(options);
  const loaded = loadJournalEntityConfiguration_();
  const clients = getJournalSnapshotClients_(loaded);
  if (!clients.length) throw new Error('No authorized Journal Entries clients are available.');
  const schemaValidation = validateJournalBigQuerySchema_();

  deleteJournalBigQueryCheckpoint_();
  deleteJournalBackfillWorkerTriggers_();
  const now = new Date().toISOString();
  const state = {
    schema_version: '1.0',
    operation_id: Utilities.getUuid(),
    configuration_version: loaded.configuration.configuration_version,
    configuration_hash: loaded.configuration.configuration_hash,
    status: plan.periodCount ? 'pending' : 'completed',
    start_date: plan.startDate,
    horizon_date: plan.horizonDate,
    protected_before: plan.protectedBefore,
    cursor_date: plan.startDate,
    total_period_count: plan.periodCount,
    processed_period_count: 0,
    non_empty_period_count: 0,
    empty_period_count: 0,
    total_row_count: 0,
    total_transaction_count: 0,
    total_client_count: clients.length,
    current_period: null,
    current_period_operation_id: null,
    current_period_attempts: 0,
    schema_validation: schemaValidation,
    oldest_existing_snapshot_week: plan.oldestExistingSnapshotWeek,
    newest_existing_snapshot_week: plan.newestExistingSnapshotWeek,
    existing_partition_count: plan.existingPartitionCount,
    created_at: now,
    updated_at: now,
    completed_at: plan.periodCount ? null : now,
    last_error: null
  };
  persistJournalBackfillState_(state);
  if (plan.periodCount) {
    replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.initialDelayMs);
  }
  return summarizeJournalBackfillState_(state, plan.periodCount > 0);
}

function startJournalBackfillFrom2026() {
  return queueJournalBackfill_({ startDate: JOURNAL_BACKFILL_CONFIG.startDate });
}

function processJournalBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.busyRetryDelayMs);
    return { status: 'deferred_lock_busy', retryScheduled: true };
  }

  try {
    let state = readJournalBackfillState_();
    if (!state) return { status: 'no_pending_backfill' };
    if (state.status === 'completed' || state.status === 'failed') {
      deleteJournalBackfillWorkerTriggers_();
      return summarizeJournalBackfillState_(state, false);
    }
    assertJournalDeploymentIdleForBackfill_();

    if (state.status === 'running') {
      const updatedAt = Date.parse(state.updated_at || '');
      const ageSeconds = Number.isFinite(updatedAt)
        ? (Date.now() - updatedAt) / 1000
        : Infinity;
      if (ageSeconds < JOURNAL_BACKFILL_CONFIG.staleRunningSeconds) {
        replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.busyRetryDelayMs);
        return { status: 'deferred_execution_running', retryScheduled: true };
      }
      state.status = 'pending';
      state.last_error = 'Recovered after a stale Journal Entries backfill execution.';
      state.updated_at = new Date().toISOString();
      persistJournalBackfillState_(state);
    }

    state.status = 'running';
    state.updated_at = new Date().toISOString();
    state.last_error = null;
    persistJournalBackfillState_(state);
    replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.watchdogDelayMs);

    const loaded = loadJournalEntityConfiguration_();
    if (
      Number(loaded.configuration.configuration_version) !==
        Number(state.configuration_version) ||
      String(loaded.configuration.configuration_hash) !==
        String(state.configuration_hash)
    ) {
      throw new Error(
        'Journal Entries entity configuration changed during the backfill. ' +
        'Reset only after reviewing the partial result.'
      );
    }

    if (!state.current_period) {
      const period = buildJournalBackfillPeriod_(state.cursor_date, state.horizon_date);
      if (!period) {
        state.status = 'completed';
        state.completed_at = new Date().toISOString();
        state.updated_at = state.completed_at;
        persistJournalBackfillState_(state);
        deleteJournalBigQueryCheckpoint_();
        deleteJournalBackfillWorkerTriggers_();
        return summarizeJournalBackfillState_(state, false);
      }
      assertJournalBackfillPeriodSafe_(period, state.protected_before);
      state.current_period = period;
      state.current_period_operation_id = [
        state.operation_id,
        period.snapshotWeek.replace(/-/g, '')
      ].join('_');
      state.current_period_attempts = 0;
      state.updated_at = new Date().toISOString();
      persistJournalBackfillState_(state);
    }

    const stageResult = executeJournalBigQueryContinuationStage_({
      operation_id: state.current_period_operation_id,
      configuration_version: state.configuration_version,
      configuration_hash: state.configuration_hash,
      period: state.current_period
    }, loaded);

    state = readJournalBackfillState_();
    if (stageResult && stageResult.status === 'yielded') {
      state.status = 'pending';
      state.updated_at = new Date().toISOString();
      state.last_error = null;
      persistJournalBackfillState_(state);
      replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.continuationDelayMs);
      return summarizeJournalBackfillState_(state, false);
    }

    state.processed_period_count = Number(state.processed_period_count || 0) + 1;
    state.total_row_count = Number(state.total_row_count || 0) + Number(stageResult.rowCount || 0);
    state.total_transaction_count = Number(state.total_transaction_count || 0) +
      Number(stageResult.accountingTransactionCount || 0);
    if (Number(stageResult.rowCount || 0) > 0) state.non_empty_period_count++;
    else state.empty_period_count++;
    state.cursor_date = addJournalBackfillDays_(state.current_period.dateTo, 1);
    state.current_period = null;
    state.current_period_operation_id = null;
    state.current_period_attempts = 0;
    state.status = state.cursor_date > state.horizon_date ? 'completed' : 'pending';
    state.updated_at = new Date().toISOString();
    state.completed_at = state.status === 'completed' ? state.updated_at : null;
    state.last_error = null;
    persistJournalBackfillState_(state);
    deleteJournalBigQueryCheckpoint_();

    if (state.status === 'completed') {
      deleteJournalBackfillWorkerTriggers_();
    } else {
      replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.continuationDelayMs);
    }
    return summarizeJournalBackfillState_(state, false);
  } catch (error) {
    const state = readJournalBackfillState_();
    if (state) {
      const attempts = Number(state.current_period_attempts || 0) + 1;
      state.current_period_attempts = attempts;
      const canRetry = attempts < JOURNAL_BACKFILL_CONFIG.maxAttemptsPerPeriod;
      state.status = canRetry ? 'pending' : 'failed';
      state.last_error = String(error && error.message || error);
      state.updated_at = new Date().toISOString();
      persistJournalBackfillState_(state);
      prepareJournalBigQueryCheckpointForRetry_();
      if (canRetry) {
        replaceJournalBackfillWorkerSchedule_(JOURNAL_BACKFILL_CONFIG.failureRetryDelayMs);
      } else {
        deleteJournalBackfillWorkerTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function debugJournalBackfillPlan() {
  const plan = planJournalBackfill_({ startDate: JOURNAL_BACKFILL_CONFIG.startDate });
  const loaded = loadJournalEntityConfiguration_();
  const clients = getJournalSnapshotClients_(loaded);
  const result = {
    event: 'journal_backfill_plan',
    status: 'validated_dry_run',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    protectedBefore: plan.protectedBefore,
    periodCount: plan.periodCount,
    firstPeriod: plan.firstPeriod,
    lastPeriod: plan.lastPeriod,
    clientCount: clients.length,
    clients: clients.map(client => ({ id: client.id, name: client.name, entity: client.entityAlias }))
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugJournalBackfillState() {
  const state = readJournalBackfillState_();
  const result = state
    ? summarizeJournalBackfillState_(state, false)
    : { status: 'not_found' };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunJournalBackfillWorker() {
  const result = processJournalBackfill();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugResetJournalBackfill() {
  assertJournalDeploymentIdleForBackfill_();
  const state = readJournalBackfillState_();
  if (state && ['pending', 'running'].includes(state.status)) {
    throw new Error('Refusing to reset an active Journal Entries backfill.');
  }
  PropertiesService.getScriptProperties().deleteProperty(
    JOURNAL_BACKFILL_CONFIG.statePropertyKey
  );
  const checkpointDeleted = deleteJournalBigQueryCheckpoint_();
  const deletedTriggerCount = deleteJournalBackfillWorkerTriggers_();
  const result = {
    status: 'reset',
    modifiesBigQuery: false,
    checkpointDeleted,
    deletedTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
