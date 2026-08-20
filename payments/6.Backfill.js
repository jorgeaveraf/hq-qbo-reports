/***********************
 * Payments historical backfill
 *
 * Processes one ISO-week segment per execution, starting on 2026-01-01.
 * The final segment ends on the last completed calendar day, so the worker
 * never labels current or future activity as historical data.
 ***********************/

function getPaymentBackfillToday_(todayOverride) {
  const normalizedOverride = normalizeDateForOutput_(todayOverride);
  if (todayOverride && !normalizedOverride) {
    throw new Error('Invalid Payments backfill today override: ' + todayOverride);
  }
  if (normalizedOverride) return normalizedOverride;

  let timeZone = Session.getScriptTimeZone() || 'Etc/UTC';
  try {
    timeZone = getTargetSpreadsheet_().getSpreadsheetTimeZone() || timeZone;
  } catch (error) {
    // Script timezone is a safe fallback for planning. Target access is still
    // required later when Connected Sheets is refreshed.
  }
  return Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
}

function addPaymentBackfillDays_(isoDate, dayCount) {
  const date = safeParseDate_(isoDate);
  if (!date) throw new Error('Invalid Payments backfill date: ' + isoDate);
  date.setUTCDate(date.getUTCDate() + Number(dayCount || 0));
  return formatUtcDate_(date);
}

function getPaymentBackfillHorizon_(todayOverride) {
  return addPaymentBackfillDays_(getPaymentBackfillToday_(todayOverride), -1);
}

function buildPaymentBackfillPeriod_(cursorDate, horizonDate) {
  const cursor = safeParseDate_(cursorDate);
  const horizon = safeParseDate_(horizonDate);
  if (!cursor || !horizon) {
    throw new Error('Payments backfill period requires valid cursor and horizon dates.');
  }
  if (cursor.getTime() > horizon.getTime()) return null;

  const weekEnd = new Date(cursor.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + (7 - ((weekEnd.getUTCDay() + 6) % 7) - 1));
  const dateTo = weekEnd.getTime() < horizon.getTime()
    ? formatUtcDate_(weekEnd)
    : formatUtcDate_(horizon);
  return normalizePaymentSnapshotRange_({
    dateFrom: formatUtcDate_(cursor),
    dateTo
  });
}

function planPaymentBackfill_(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const startDate = normalizeDateForOutput_(
    settings.startDate || PAYMENT_BACKFILL_CONFIG.startDate
  );
  if (!startDate) throw new Error('Payments backfill startDate is invalid.');
  if (startDate < PAYMENT_BACKFILL_CONFIG.startDate) {
    throw new Error(
      'Payments backfill cannot start before ' +
        PAYMENT_BACKFILL_CONFIG.startDate +
        '.'
    );
  }

  const safeHorizon = getPaymentBackfillHorizon_(settings.today);
  let horizonDate = settings.endDate
    ? normalizeDateForOutput_(settings.endDate)
    : safeHorizon;
  if (!horizonDate) throw new Error('Payments backfill endDate is invalid.');
  if (horizonDate > safeHorizon) horizonDate = safeHorizon;

  const periods = [];
  let cursorDate = startDate;
  while (cursorDate <= horizonDate) {
    if (periods.length >= 400) {
      throw new Error('Payments backfill plan exceeded 400 weekly periods.');
    }
    const period = buildPaymentBackfillPeriod_(cursorDate, horizonDate);
    if (!period) break;
    periods.push(period);
    cursorDate = addPaymentBackfillDays_(period.dateTo, 1);
  }

  return {
    startDate,
    horizonDate,
    today: getPaymentBackfillToday_(settings.today),
    periodCount: periods.length,
    firstPeriod: periods.length ? periods[0] : null,
    lastPeriod: periods.length ? periods[periods.length - 1] : null,
    periods
  };
}

function validatePaymentBackfillSnapshot_(snapshot, expectedRange) {
  if (!snapshot || !Array.isArray(snapshot.rows)) {
    throw new Error('Payments backfill snapshot is invalid.');
  }
  const range = normalizePaymentSnapshotRange_(expectedRange);
  const fromMs = Date.parse(range.updatedSince);
  const throughMs = Date.parse(range.updatedThroughExclusive);

  snapshot.rows.forEach((row, index) => {
    if (
      row.DateFrom !== range.dateFrom ||
      row.DateTo !== range.dateTo ||
      row.SnapshotWeek !== range.snapshotWeek ||
      row.SnapshotDate !== range.snapshotDate
    ) {
      throw new Error('Payments backfill row ' + index + ' belongs to another period.');
    }
    const updatedAt = Date.parse(row.UpdatedAt || '');
    if (!Number.isFinite(updatedAt) || updatedAt < fromMs || updatedAt >= throughMs) {
      throw new Error('Payments backfill row ' + index + ' is outside the requested update window.');
    }
  });

  return {
    status: 'passed',
    rowCount: snapshot.rows.length,
    paymentCount: snapshot.hierarchyValidation.paymentCount,
    period: range
  };
}

function executePaymentBackfillPeriod_(range, options) {
  const settings = options && typeof options === 'object' ? options : {};
  const normalizedRange = normalizePaymentSnapshotRange_(range);
  const safeHorizon = getPaymentBackfillHorizon_(settings.today);
  if (normalizedRange.dateFrom < PAYMENT_BACKFILL_CONFIG.startDate) {
    throw new Error('Payments backfill period starts before the configured lower bound.');
  }
  if (normalizedRange.dateTo > safeHorizon) {
    throw new Error('Payments backfill refuses to process current or future dates.');
  }

  const snapshot = buildPaymentSnapshot_(settings.loadedEntityConfiguration || null, {
    range: normalizedRange,
    persistSchemaBaselines: false
  });
  const validation = validatePaymentBackfillSnapshot_(snapshot, normalizedRange);
  const summary = {
    status: settings.dryRun === true ? 'validated_dry_run' : 'completed',
    period: normalizedRange,
    clientCount: snapshot.clientCount,
    sourcePaymentCount: snapshot.sourcePaymentCount,
    paymentCount: snapshot.paymentCount,
    pageCount: snapshot.pageCount,
    rowCount: snapshot.rows.length,
    hierarchyValidation: snapshot.hierarchyValidation,
    rangeValidation: validation,
    schemaMonitoring: {
      changedCount: snapshot.schemaMonitoring.changedCount,
      observedVariationCount: snapshot.schemaMonitoring.observedVariationCount,
      baselineMissingCount: snapshot.schemaMonitoring.baselineMissingCount
    }
  };

  if (settings.dryRun === true) return summary;

  summary.schemaValidation = validatePaymentBigQuerySchema_();
  summary.loadResult = replacePaymentSnapshotPartition_(normalizedRange, snapshot.rows);
  summary.verification = verifyPaymentSnapshotPartition_(
    normalizedRange.snapshotWeek,
    snapshot.hierarchyValidation
  );
  return summary;
}

function getPaymentBackfillPeriodForTimestamp_(timestamp, plan) {
  const updatedAt = new Date(timestamp || '');
  if (isNaN(updatedAt.getTime())) return null;
  const updatedDate = formatUtcDate_(updatedAt);
  if (updatedDate < plan.startDate || updatedDate > plan.horizonDate) return null;

  const weekStart = new Date(Date.UTC(
    updatedAt.getUTCFullYear(),
    updatedAt.getUTCMonth(),
    updatedAt.getUTCDate()
  ));
  weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7));
  const weekEnd = new Date(weekStart.getTime());
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const dateFrom = formatUtcDate_(weekStart) < plan.startDate
    ? plan.startDate
    : formatUtcDate_(weekStart);
  const dateTo = formatUtcDate_(weekEnd) > plan.horizonDate
    ? plan.horizonDate
    : formatUtcDate_(weekEnd);
  return normalizePaymentSnapshotRange_({ dateFrom, dateTo });
}

function buildPaymentBackfillClientSnapshot_(client, plan, loadedAt) {
  if (!client || !String(client.id || '').trim()) {
    throw new Error('A valid Payments backfill client is required.');
  }
  const updatedSince = plan.startDate + 'T00:00:00.000Z';
  const updatedBefore = addPaymentBackfillDays_(plan.horizonDate, 1) +
    'T00:00:00.000Z';
  const response = fetchPayments_(client.id, updatedSince, updatedBefore);
  const rows = [];
  const periodPaymentCounts = {};
  let paymentCount = 0;

  response.items.forEach(payment => {
    const metadata = payment && payment.MetaData && typeof payment.MetaData === 'object'
      ? payment.MetaData
      : {};
    const updatedAt = metadata.LastUpdatedTime ||
      metadata.UpdatedAt ||
      metadata.last_updated_time ||
      '';
    const period = getPaymentBackfillPeriodForTimestamp_(updatedAt, plan);
    if (!period) return;

    const normalized = normalizePayment_(client, period, payment, loadedAt);
    normalized.rows.forEach(row => rows.push(row));
    periodPaymentCounts[period.periodKey] =
      Number(periodPaymentCounts[period.periodKey] || 0) + 1;
    paymentCount++;
  });

  sortPaymentRows_(rows);
  const hierarchyValidation = validatePaymentSnapshotHierarchy_(rows);
  const snapshot = {
    client,
    plan,
    sourcePaymentCount: response.items.length,
    paymentCount,
    pageCount: response.pageCount,
    rows,
    periodPaymentCounts,
    hierarchyValidation
  };
  snapshot.rangeValidation = validatePaymentBackfillClientSnapshot_(snapshot);
  return snapshot;
}

function validatePaymentBackfillClientSnapshot_(snapshot) {
  if (!snapshot || !snapshot.plan || !Array.isArray(snapshot.rows)) {
    throw new Error('Payments backfill client snapshot is invalid.');
  }
  const plan = snapshot.plan;
  const fromMs = Date.parse(plan.startDate + 'T00:00:00.000Z');
  const throughMs = Date.parse(
    addPaymentBackfillDays_(plan.horizonDate, 1) + 'T00:00:00.000Z'
  );
  const paymentKeys = {};

  snapshot.rows.forEach((row, index) => {
    const updatedAt = Date.parse(row.UpdatedAt || '');
    if (!Number.isFinite(updatedAt) || updatedAt < fromMs || updatedAt >= throughMs) {
      throw new Error('Payments backfill client row ' + index + ' is outside the plan.');
    }
    const period = getPaymentBackfillPeriodForTimestamp_(row.UpdatedAt, plan);
    if (
      !period ||
      row.DateFrom !== period.dateFrom ||
      row.DateTo !== period.dateTo ||
      row.SnapshotWeek !== period.snapshotWeek ||
      row.SnapshotDate !== period.snapshotDate
    ) {
      throw new Error('Payments backfill client row ' + index + ' has an invalid period.');
    }
    paymentKeys[row.ClientId + '|' + row.PaymentId] = true;
  });

  if (Object.keys(paymentKeys).length !== Number(snapshot.paymentCount || 0)) {
    throw new Error('Payments backfill client payment count does not match its rows.');
  }
  return {
    status: 'passed',
    rowCount: snapshot.rows.length,
    paymentCount: Object.keys(paymentKeys).length,
    periodCountWithData: Object.keys(snapshot.periodPaymentCounts).length
  };
}

function buildPaymentBackfillPoc_(options) {
  const plan = planPaymentBackfill_(options);
  const loaded = loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loaded);
  const clients = Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) =>
      String(left.entityAlias || '').localeCompare(String(right.entityAlias || '')) ||
      String(left.name || '').localeCompare(String(right.name || ''))
    );
  if (!clients.length) throw new Error('No Payments clients are available for the backfill PoC.');

  const snapshot = buildPaymentBackfillClientSnapshot_(
    clients[0],
    plan,
    new Date().toISOString()
  );
  const periodKeys = Object.keys(snapshot.periodPaymentCounts).sort();
  return {
    status: 'validated_dry_run',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    plan: {
      startDate: plan.startDate,
      horizonDate: plan.horizonDate,
      periodCount: plan.periodCount
    },
    client: {
      id: snapshot.client.id,
      name: snapshot.client.name
    },
    sourcePaymentCount: snapshot.sourcePaymentCount,
    paymentCount: snapshot.paymentCount,
    pageCount: snapshot.pageCount,
    rowCount: snapshot.rows.length,
    periodCountWithData: periodKeys.length,
    firstDataPeriod: periodKeys.length ? periodKeys[0] : null,
    lastDataPeriod: periodKeys.length ? periodKeys[periodKeys.length - 1] : null,
    hierarchyValidation: snapshot.hierarchyValidation,
    rangeValidation: snapshot.rangeValidation
  };
}

function escapePaymentBackfillBigQueryString_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildPaymentBackfillJobId_(operationId, clientId, kind) {
  return [
    'payment_backfill',
    String(operationId || '').replace(/[^A-Za-z0-9_]/g, ''),
    sha256Hex_(clientId).slice(0, 16),
    String(kind || '').replace(/[^A-Za-z0-9_]/g, '')
  ].join('_');
}

function getPaymentBackfillBigQueryJobIfExists_(jobId) {
  try {
    return BigQuery.Jobs.get(BQ_CONFIG.projectId, jobId);
  } catch (error) {
    const message = String(error && error.message || error);
    if (/not found|404/i.test(message)) return null;
    throw error;
  }
}

function ensurePaymentBackfillDeleteJob_(jobId, clientId, plan) {
  let job = getPaymentBackfillBigQueryJobIfExists_(jobId);
  if (!job) {
    const query = [
      'DELETE FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
      "WHERE ClientId = '" + escapePaymentBackfillBigQueryString_(clientId) + "'",
      "  AND DateFrom >= DATE '" + plan.startDate + "'",
      "  AND DateTo <= DATE '" + plan.horizonDate + "'"
    ].join('\n');
    job = BigQuery.Jobs.insert({
      jobReference: {
        projectId: BQ_CONFIG.projectId,
        jobId
      },
      configuration: {
        query: {
          query,
          useLegacySql: false
        }
      }
    }, BQ_CONFIG.projectId);
  }
  return waitForBigQueryJob_(job.jobReference, 120000);
}

function ensurePaymentBackfillLoadJob_(jobId, rows) {
  let job = getPaymentBackfillBigQueryJobIfExists_(jobId);
  if (!job) {
    if (!rows.length) return { status: { state: 'DONE' }, outputRows: 0 };
    rows.forEach((row, index) => validatePaymentBigQueryRow_(row, index));
    const ndjson = rows.map(row => JSON.stringify(row)).join('\n');
    const blob = Utilities.newBlob(
      ndjson,
      'application/octet-stream',
      jobId + '.ndjson'
    );
    job = BigQuery.Jobs.insert({
      jobReference: {
        projectId: BQ_CONFIG.projectId,
        jobId
      },
      configuration: {
        load: {
          destinationTable: {
            projectId: BQ_CONFIG.projectId,
            datasetId: BQ_CONFIG.rawDatasetId,
            tableId: BQ_CONFIG.snapshotsTableId
          },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: 'WRITE_APPEND',
          schema: { fields: PAYMENT_BIGQUERY_SCHEMA }
        }
      }
    }, BQ_CONFIG.projectId, blob);
  }
  return waitForBigQueryJob_(job.jobReference, 120000);
}

function verifyPaymentBackfillClient_(clientId, plan, expected) {
  const result = runBigQueryQuery_([
    'SELECT',
    '  COUNT(*) AS row_count,',
    '  COUNT(DISTINCT PaymentId) AS payment_count,',
    "  COUNTIF(RecordType = 'HEADER') AS header_count",
    'FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE ClientId = '" + escapePaymentBackfillBigQueryString_(clientId) + "'",
    "  AND DateFrom >= DATE '" + plan.startDate + "'",
    "  AND DateTo <= DATE '" + plan.horizonDate + "'"
  ].join('\n'));
  const values = result.rows && result.rows[0] && result.rows[0].f
    ? result.rows[0].f.map(cell => Number(cell.v || 0))
    : [0, 0, 0];
  const actual = {
    rowCount: values[0],
    paymentCount: values[1],
    headerCount: values[2]
  };
  if (
    actual.rowCount !== Number(expected.rowCount) ||
    actual.paymentCount !== Number(expected.paymentCount) ||
    actual.headerCount !== Number(expected.paymentCount)
  ) {
    throw new Error(
      'Payments backfill client verification failed. ClientId=' +
        clientId +
        ', expected=' +
        JSON.stringify(expected) +
        ', actual=' +
        JSON.stringify(actual)
    );
  }
  return { status: 'passed', ...actual };
}

function executePaymentBackfillClient_(state, client) {
  const plan = planPaymentBackfill_({
    startDate: state.start_date,
    endDate: state.horizon_date,
    today: addPaymentBackfillDays_(state.horizon_date, 1)
  });
  const loadedConfiguration = loadPaymentEntityConfiguration_();
  if (
    Number(loadedConfiguration.configuration.configuration_version) !==
      Number(state.configuration_version) ||
    String(loadedConfiguration.configuration.configuration_hash) !==
      String(state.configuration_hash)
  ) {
    throw new Error(
      'Payments entity configuration changed during the backfill. ' +
        'Reset and start a new backfill operation.'
    );
  }

  const snapshot = buildPaymentBackfillClientSnapshot_(
    client,
    plan,
    state.loaded_at
  );
  const deleteJob = ensurePaymentBackfillDeleteJob_(
    buildPaymentBackfillJobId_(state.operation_id, client.id, 'delete'),
    client.id,
    plan
  );
  const loadJob = ensurePaymentBackfillLoadJob_(
    buildPaymentBackfillJobId_(state.operation_id, client.id, 'load'),
    snapshot.rows
  );
  const verification = verifyPaymentBackfillClient_(client.id, plan, {
    rowCount: snapshot.rows.length,
    paymentCount: snapshot.paymentCount
  });
  return {
    clientId: client.id,
    clientName: client.name,
    sourcePaymentCount: snapshot.sourcePaymentCount,
    paymentCount: snapshot.paymentCount,
    pageCount: snapshot.pageCount,
    rowCount: snapshot.rows.length,
    periodCountWithData: snapshot.rangeValidation.periodCountWithData,
    dataPeriods: Object.keys(snapshot.periodPaymentCounts).sort(),
    deleteJobId: deleteJob.jobReference && deleteJob.jobReference.jobId || null,
    loadJobId: loadJob.jobReference && loadJob.jobReference.jobId || null,
    verification
  };
}

function readPaymentBackfillState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    PAYMENT_BACKFILL_CONFIG.statePropertyKey
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
    throw new Error('Invalid Payments backfill state: ' + error.message);
  }
}

function persistPaymentBackfillState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PAYMENT_BACKFILL_CONFIG.maxStateBytes) {
    throw new Error('Payments backfill state exceeds the Script Property limit. Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    PAYMENT_BACKFILL_CONFIG.statePropertyKey,
    serialized
  );
  return { byteCount };
}

function summarizePaymentBackfillState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operation_id,
    status: state.status,
    currentStage: state.current_stage,
    startDate: state.start_date,
    horizonDate: state.horizon_date,
    cursorDate: state.cursor_date,
    totalPeriodCount: state.total_period_count,
    processedPeriodCount: state.processed_period_count,
    totalClientCount: state.total_client_count,
    processedClientCount: state.processed_client_count,
    totalSourcePaymentCount: state.total_source_payment_count,
    totalPaymentCount: state.total_payment_count,
    totalRowCount: state.total_row_count,
    totalPageCount: state.total_page_count,
    nonEmptyPeriodCount: state.non_empty_period_count,
    emptyPeriodCount: state.empty_period_count,
    lastDataPeriod: state.last_data_period || null,
    currentPeriod: state.current_period || null,
    updatedAt: state.updated_at,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null
  };
}

function replacePaymentBackfillWorkerSchedule_(delayMs) {
  const existing = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === PAYMENT_BACKFILL_CONFIG.workerHandler
  );
  existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  const normalizedDelayMs = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(PAYMENT_BACKFILL_CONFIG.workerHandler)
    .timeBased()
    .after(normalizedDelayMs)
    .create();
  return {
    triggerId: trigger.getUniqueId(),
    delayMs: normalizedDelayMs,
    previousTriggersDeleted: existing.length
  };
}

function deletePaymentBackfillWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger => trigger.getHandlerFunction() === PAYMENT_BACKFILL_CONFIG.workerHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function assertPaymentDeploymentIdleForBackfill_() {
  const deployment = readPaymentDeploymentState_();
  if (deployment && ['pending', 'running', 'processing'].includes(deployment.status)) {
    throw new Error(
      'Payments configuration deployment must finish before starting the backfill. ' +
        'CurrentStatus=' + deployment.status
    );
  }
}

function assertPaymentBackfillIdle_(contextLabel) {
  const state = readPaymentBackfillState_();
  if (state && ['pending', 'running'].includes(state.status)) {
    throw new Error(
      'Payments backfill is active and blocks ' +
        String(contextLabel || 'this operation') +
        '. CurrentStage=' +
        state.current_stage
    );
  }
}

function queuePaymentBackfill_(options) {
  assertPaymentDeploymentIdleForBackfill_();
  const plan = planPaymentBackfill_(options);
  const loadedConfiguration = loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loadedConfiguration);
  const clients = Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) =>
      String(left.entityAlias || '').localeCompare(String(right.entityAlias || '')) ||
      String(left.name || '').localeCompare(String(right.name || ''))
    )
    .map(client => ({
      id: String(client.id || '').trim(),
      name: String(client.name || '').trim(),
      entity: String(client.entity || '').trim(),
      entityAlias: String(client.entityAlias || '').trim()
    }));
  if (!clients.length) {
    throw new Error('No authorized Payments clients are available for backfill.');
  }
  const current = readPaymentBackfillState_();
  const samePlan = current &&
    current.start_date === plan.startDate &&
    current.horizon_date === plan.horizonDate;
  if (samePlan && ['pending', 'running', 'completed', 'failed'].includes(current.status)) {
    if (current.status === 'failed') {
      current.status = 'pending';
      current.current_period_attempts = 0;
      current.last_error = null;
      current.updated_at = new Date().toISOString();
      if (current.stages && current.stages[current.current_stage]) {
        current.stages[current.current_stage].status = 'pending';
      }
      persistPaymentBackfillState_(current);
      replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.initialDelayMs);
      return summarizePaymentBackfillState_(current, true);
    }
    if (current.status !== 'completed') {
      replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.continuationDelayMs);
    }
    return summarizePaymentBackfillState_(current, false);
  }

  deletePaymentBackfillWorkerTriggers_();
  const now = new Date().toISOString();
  const state = {
    schema_version: '1.0',
    operation_id: Utilities.getUuid(),
    configuration_version:
      loadedConfiguration.configuration.configuration_version,
    configuration_hash:
      loadedConfiguration.configuration.configuration_hash,
    status: plan.periodCount ? 'pending' : 'completed',
    current_stage: plan.periodCount ? 'bigquery' : 'completed',
    start_date: plan.startDate,
    horizon_date: plan.horizonDate,
    cursor_date: plan.startDate,
    total_period_count: plan.periodCount,
    processed_period_count: 0,
    clients,
    total_client_count: clients.length,
    next_client_index: 0,
    processed_client_count: 0,
    non_empty_period_count: 0,
    empty_period_count: 0,
    total_payment_count: 0,
    total_row_count: 0,
    total_source_payment_count: 0,
    total_page_count: 0,
    data_periods: {},
    last_data_period: null,
    current_period: null,
    current_client: null,
    current_period_attempts: 0,
    stages: {
      bigquery: { status: plan.periodCount ? 'pending' : 'completed', attempts: 0, result: null },
      data_source_sheets: { status: 'pending', attempts: 0, result: null },
      extracts: { status: 'pending', attempts: 0, result: null }
    },
    created_at: now,
    loaded_at: now,
    updated_at: now,
    completed_at: plan.periodCount ? null : now,
    last_error: null
  };
  persistPaymentBackfillState_(state);
  if (plan.periodCount) {
    replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.initialDelayMs);
  }
  return summarizePaymentBackfillState_(state, plan.periodCount > 0);
}

function startPaymentBackfillFrom2026() {
  return queuePaymentBackfill_({ startDate: PAYMENT_BACKFILL_CONFIG.startDate });
}

function processPaymentBackfillLegacy_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.busyRetryDelayMs);
    return { status: 'deferred_lock_busy', retryScheduled: true };
  }

  let claimedPeriod = null;
  try {
    let state = readPaymentBackfillState_();
    if (!state) return { status: 'no_pending_backfill' };
    if (state.status === 'completed' || state.status === 'failed') {
      deletePaymentBackfillWorkerTriggers_();
      return summarizePaymentBackfillState_(state, false);
    }
    assertPaymentDeploymentIdleForBackfill_();

    if (state.status === 'running') {
      const updatedAt = Date.parse(state.updated_at || '');
      const ageSeconds = Number.isFinite(updatedAt)
        ? (Date.now() - updatedAt) / 1000
        : Infinity;
      if (ageSeconds < PAYMENT_BACKFILL_CONFIG.staleRunningSeconds) {
        replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.busyRetryDelayMs);
        return {
          status: 'deferred_execution_running',
          currentStage: state.current_stage,
          retryScheduled: true
        };
      }
      state.status = 'pending';
      state.last_error = 'Recovered after a stale Payments backfill execution.';
      state.updated_at = new Date().toISOString();
      if (state.stages && state.stages[state.current_stage]) {
        state.stages[state.current_stage].status = 'pending';
      }
      persistPaymentBackfillState_(state);
    }

    if (state.current_stage === 'bigquery') {
      claimedPeriod = buildPaymentBackfillPeriod_(state.cursor_date, state.horizon_date);
      if (!claimedPeriod) {
        state.stages.bigquery.status = 'completed';
        state.current_stage = 'data_source_sheets';
        state.status = 'pending';
      } else {
        const sameAttempt = state.current_period &&
          state.current_period.periodKey === claimedPeriod.periodKey;
        state.current_period_attempts = sameAttempt
          ? Number(state.current_period_attempts || 0) + 1
          : 1;
        state.current_period = claimedPeriod;
        state.status = 'running';
        state.stages.bigquery.status = 'running';
        state.stages.bigquery.attempts =
          Number(state.stages.bigquery.attempts || 0) + 1;
        state.updated_at = new Date().toISOString();
        state.last_error = null;
        persistPaymentBackfillState_(state);

        replacePaymentBackfillWorkerSchedule_(
          PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
        );

        const loadedConfiguration = loadPaymentEntityConfiguration_();
        if (
          Number(loadedConfiguration.configuration.configuration_version) !==
            Number(state.configuration_version) ||
          String(loadedConfiguration.configuration.configuration_hash) !==
            String(state.configuration_hash)
        ) {
          throw new Error(
            'Payments entity configuration changed during the backfill. ' +
              'Reset and start a new backfill operation.'
          );
        }

        const result = executePaymentBackfillPeriod_(claimedPeriod, {
          loadedEntityConfiguration: loadedConfiguration
        });
        state = readPaymentBackfillState_();
        state.processed_period_count++;
        state.total_payment_count += Number(result.paymentCount || 0);
        state.total_row_count += Number(result.rowCount || 0);
        if (Number(result.paymentCount || 0) > 0) {
          state.non_empty_period_count++;
          state.last_data_period = claimedPeriod;
        } else {
          state.empty_period_count++;
        }
        state.stages.bigquery.result = {
          period: claimedPeriod,
          paymentCount: result.paymentCount,
          rowCount: result.rowCount,
          verificationStatus: result.verification && result.verification.status || null
        };
        state.cursor_date = addPaymentBackfillDays_(claimedPeriod.dateTo, 1);
        state.current_period = null;
        state.current_period_attempts = 0;
        state.status = 'pending';
        state.stages.bigquery.status = state.cursor_date > state.horizon_date
          ? 'completed'
          : 'pending';
        state.current_stage = state.cursor_date > state.horizon_date
          ? 'data_source_sheets'
          : 'bigquery';
      }
    } else if (state.current_stage === 'data_source_sheets') {
      state.status = 'running';
      state.stages.data_source_sheets.status = 'running';
      state.stages.data_source_sheets.attempts =
        Number(state.stages.data_source_sheets.attempts || 0) + 1;
      persistPaymentBackfillState_(state);
      replacePaymentBackfillWorkerSchedule_(
        PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
      );
      const result = refreshPaymentConnectedSheetsStage_('data_source_sheets');
      state = readPaymentBackfillState_();
      state.stages.data_source_sheets = {
        status: 'completed',
        result: {
          status: result.status,
          refreshedObjectCount: result.refreshedObjectCount
        }
      };
      state.current_stage = 'extracts';
      state.status = 'pending';
    } else if (state.current_stage === 'extracts') {
      state.status = 'running';
      state.stages.extracts.status = 'running';
      state.stages.extracts.attempts =
        Number(state.stages.extracts.attempts || 0) + 1;
      persistPaymentBackfillState_(state);
      replacePaymentBackfillWorkerSchedule_(
        PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
      );
      const result = refreshPaymentConnectedSheetsStage_('extracts');
      state = readPaymentBackfillState_();
      state.stages.extracts = {
        status: 'completed',
        result: {
          status: result.status,
          refreshedObjectCount: result.refreshedObjectCount
        }
      };
      state.current_stage = 'completed';
      state.status = 'completed';
      state.completed_at = new Date().toISOString();
    } else {
      throw new Error('Unsupported Payments backfill stage: ' + state.current_stage);
    }

    state.updated_at = new Date().toISOString();
    state.last_error = null;
    persistPaymentBackfillState_(state);
    if (state.status === 'completed') {
      deletePaymentBackfillWorkerTriggers_();
    } else {
      replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.continuationDelayMs);
    }
    return summarizePaymentBackfillState_(state, false);
  } catch (error) {
    const state = readPaymentBackfillState_();
    if (state) {
      const attemptCount = state.current_stage === 'bigquery'
        ? Number(state.current_period_attempts || 0)
        : Number(
            state.stages &&
            state.stages[state.current_stage] &&
            state.stages[state.current_stage].attempts || 0
          );
      const maxAttempts = state.current_stage === 'bigquery'
        ? PAYMENT_BACKFILL_CONFIG.maxAttemptsPerPeriod
        : PAYMENT_BACKFILL_CONFIG.maxStageAttempts;
      const canRetry = attemptCount < maxAttempts;
      state.status = canRetry ? 'pending' : 'failed';
      state.last_error = String(error && error.message || error);
      state.updated_at = new Date().toISOString();
      if (state.stages && state.stages[state.current_stage]) {
        state.stages[state.current_stage].status = canRetry ? 'pending' : 'failed';
      }
      persistPaymentBackfillState_(state);
      if (canRetry) {
        replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.failureRetryDelayMs);
      } else {
        deletePaymentBackfillWorkerTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function processPaymentBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.busyRetryDelayMs);
    return { status: 'deferred_lock_busy', retryScheduled: true };
  }

  try {
    let state = readPaymentBackfillState_();
    if (!state) return { status: 'no_pending_backfill' };
    if (state.status === 'completed' || state.status === 'failed') {
      deletePaymentBackfillWorkerTriggers_();
      return summarizePaymentBackfillState_(state, false);
    }
    assertPaymentDeploymentIdleForBackfill_();

    if (state.status === 'running') {
      const updatedAt = Date.parse(state.updated_at || '');
      const ageSeconds = Number.isFinite(updatedAt)
        ? (Date.now() - updatedAt) / 1000
        : Infinity;
      if (ageSeconds < PAYMENT_BACKFILL_CONFIG.staleRunningSeconds) {
        replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.busyRetryDelayMs);
        return {
          status: 'deferred_execution_running',
          currentStage: state.current_stage,
          retryScheduled: true
        };
      }
      state.status = 'pending';
      state.last_error = 'Recovered after a stale Payments backfill execution.';
      state.updated_at = new Date().toISOString();
      if (state.stages && state.stages[state.current_stage]) {
        state.stages[state.current_stage].status = 'pending';
      }
      persistPaymentBackfillState_(state);
    }

    if (state.current_stage === 'bigquery') {
      const client = state.clients && state.clients[state.next_client_index];
      if (!client) {
        state.processed_period_count = state.total_period_count;
        const dataPeriods = Object.keys(state.data_periods || {}).sort();
        state.non_empty_period_count = dataPeriods.length;
        state.empty_period_count = Math.max(
          0,
          Number(state.total_period_count || 0) - dataPeriods.length
        );
        state.last_data_period = dataPeriods.length
          ? dataPeriods[dataPeriods.length - 1]
          : null;
        state.cursor_date = addPaymentBackfillDays_(state.horizon_date, 1);
        state.current_client = null;
        state.current_period_attempts = 0;
        state.stages.bigquery.status = 'completed';
        state.current_stage = 'data_source_sheets';
        state.status = 'pending';
      } else {
        const sameClient = state.current_client &&
          state.current_client.id === client.id;
        state.current_period_attempts = sameClient
          ? Number(state.current_period_attempts || 0) + 1
          : 1;
        state.current_client = {
          index: state.next_client_index,
          id: client.id,
          name: client.name
        };
        state.status = 'running';
        state.stages.bigquery.status = 'running';
        state.stages.bigquery.attempts =
          Number(state.stages.bigquery.attempts || 0) + 1;
        state.updated_at = new Date().toISOString();
        state.last_error = null;
        persistPaymentBackfillState_(state);
        replacePaymentBackfillWorkerSchedule_(
          PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
        );

        const result = executePaymentBackfillClient_(state, client);
        state = readPaymentBackfillState_();
        state.processed_client_count++;
        state.next_client_index++;
        state.total_source_payment_count =
          Number(state.total_source_payment_count || 0) +
          Number(result.sourcePaymentCount || 0);
        state.total_payment_count += Number(result.paymentCount || 0);
        state.total_row_count += Number(result.rowCount || 0);
        state.total_page_count =
          Number(state.total_page_count || 0) +
          Number(result.pageCount || 0);
        state.data_periods = state.data_periods || {};
        result.dataPeriods.forEach(periodKey => {
          state.data_periods[periodKey] = true;
        });
        state.stages.bigquery.result = {
          clientId: result.clientId,
          clientName: result.clientName,
          sourcePaymentCount: result.sourcePaymentCount,
          paymentCount: result.paymentCount,
          rowCount: result.rowCount,
          periodCountWithData: result.periodCountWithData,
          verificationStatus: result.verification.status
        };
        state.current_client = null;
        state.current_period_attempts = 0;
        if (state.next_client_index >= state.clients.length) {
          state.processed_period_count = state.total_period_count;
          const dataPeriods = Object.keys(state.data_periods).sort();
          state.non_empty_period_count = dataPeriods.length;
          state.empty_period_count = Math.max(
            0,
            Number(state.total_period_count || 0) - dataPeriods.length
          );
          state.last_data_period = dataPeriods.length
            ? dataPeriods[dataPeriods.length - 1]
            : null;
          state.cursor_date = addPaymentBackfillDays_(state.horizon_date, 1);
        }
        state.status = 'pending';
        state.stages.bigquery.status = state.next_client_index >= state.clients.length
          ? 'completed'
          : 'pending';
        state.current_stage = state.next_client_index >= state.clients.length
          ? 'data_source_sheets'
          : 'bigquery';
      }
    } else if (state.current_stage === 'data_source_sheets') {
      state.status = 'running';
      state.stages.data_source_sheets.status = 'running';
      state.stages.data_source_sheets.attempts =
        Number(state.stages.data_source_sheets.attempts || 0) + 1;
      state.updated_at = new Date().toISOString();
      persistPaymentBackfillState_(state);
      replacePaymentBackfillWorkerSchedule_(
        PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
      );
      const result = refreshPaymentConnectedSheetsStage_('data_source_sheets');
      state = readPaymentBackfillState_();
      state.stages.data_source_sheets = {
        status: 'completed',
        attempts: state.stages.data_source_sheets.attempts,
        result: {
          status: result.status,
          refreshedObjectCount: result.refreshedObjectCount
        }
      };
      state.current_stage = 'extracts';
      state.status = 'pending';
    } else if (state.current_stage === 'extracts') {
      state.status = 'running';
      state.stages.extracts.status = 'running';
      state.stages.extracts.attempts =
        Number(state.stages.extracts.attempts || 0) + 1;
      state.updated_at = new Date().toISOString();
      persistPaymentBackfillState_(state);
      replacePaymentBackfillWorkerSchedule_(
        PAYMENT_BACKFILL_CONFIG.watchdogDelayMs
      );
      const result = refreshPaymentConnectedSheetsStage_('extracts');
      state = readPaymentBackfillState_();
      state.stages.extracts = {
        status: 'completed',
        attempts: state.stages.extracts.attempts,
        result: {
          status: result.status,
          refreshedObjectCount: result.refreshedObjectCount
        }
      };
      state.current_stage = 'completed';
      state.status = 'completed';
      state.completed_at = new Date().toISOString();
    } else {
      throw new Error('Unsupported Payments backfill stage: ' + state.current_stage);
    }

    state.updated_at = new Date().toISOString();
    state.last_error = null;
    persistPaymentBackfillState_(state);
    if (state.status === 'completed') {
      deletePaymentBackfillWorkerTriggers_();
    } else {
      replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.continuationDelayMs);
    }
    return summarizePaymentBackfillState_(state, false);
  } catch (error) {
    const state = readPaymentBackfillState_();
    if (state) {
      const attemptCount = state.current_stage === 'bigquery'
        ? Number(state.current_period_attempts || 0)
        : Number(
            state.stages &&
            state.stages[state.current_stage] &&
            state.stages[state.current_stage].attempts || 0
          );
      const maxAttempts = state.current_stage === 'bigquery'
        ? PAYMENT_BACKFILL_CONFIG.maxAttemptsPerPeriod
        : PAYMENT_BACKFILL_CONFIG.maxStageAttempts;
      const canRetry = attemptCount < maxAttempts;
      state.status = canRetry ? 'pending' : 'failed';
      state.last_error = String(error && error.message || error);
      state.updated_at = new Date().toISOString();
      if (state.stages && state.stages[state.current_stage]) {
        state.stages[state.current_stage].status = canRetry ? 'pending' : 'failed';
      }
      persistPaymentBackfillState_(state);
      if (canRetry) {
        replacePaymentBackfillWorkerSchedule_(PAYMENT_BACKFILL_CONFIG.failureRetryDelayMs);
      } else {
        deletePaymentBackfillWorkerTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}
