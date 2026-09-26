/***********************
 * QBO Balance Sheet - Weekly and Monthly Cadence
 ***********************/

const BALANCE_CADENCE = {
  weeklyHandler: 'snapshotWeeklyBalanceSheetToBigQuery',
  monthlyHandler: 'snapshotMonthlyBalanceSheetToBigQuery',
  backfillHandler: 'processBalanceMonthlyCadenceBackfill2026',
  backfillStateProperty: 'QBO_BALANCE_MONTHLY_CADENCE_BACKFILL_2026',
  weeklyHour: 3,
  monthlyHour: 4,
  monthlyDay: 10
};

function normalizeBalanceSnapshotType_(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if ([BALANCE_SNAPSHOT_TYPE_WEEKLY, BALANCE_SNAPSHOT_TYPE_MONTHLY].indexOf(normalized) === -1) {
    throw new Error('Unsupported Balance Sheet SnapshotType: ' + value);
  }
  return normalized;
}

function parseIsoDateUtc_(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Invalid ISO date: ' + value);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatUtcDate_(date) {
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}

function getBalanceWeeklySnapshotRange_(referenceIsoDate) {
  const reference = parseIsoDateUtc_(referenceIsoDate || todayIsoDate_());
  const monday = new Date(reference.getTime());
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const asOfDate = new Date(monday.getTime() - 86400000);
  const snapshotWeek = new Date(monday.getTime() - 7 * 86400000);
  return { snapshotType: BALANCE_SNAPSHOT_TYPE_WEEKLY, snapshotDate: formatUtcDate_(monday),
    snapshotWeek: formatUtcDate_(snapshotWeek), asOfDate: formatUtcDate_(asOfDate) };
}

function getBalanceMonthlySnapshotRange_(referenceIsoDate) {
  const reference = parseIsoDateUtc_(referenceIsoDate || todayIsoDate_());
  const monthStart = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const previousMonthStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
  const previousMonthEnd = new Date(monthStart.getTime() - 86400000);
  const snapshotDate = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), BALANCE_CADENCE.monthlyDay));
  return { snapshotType: BALANCE_SNAPSHOT_TYPE_MONTHLY, snapshotDate: formatUtcDate_(snapshotDate),
    snapshotWeek: formatUtcDate_(previousMonthStart), asOfDate: formatUtcDate_(previousMonthEnd) };
}

function buildBalanceMonthlyBackfillRanges2026_(referenceIsoDate) {
  const latest = getBalanceMonthlySnapshotRange_(referenceIsoDate);
  const end = parseIsoDateUtc_(latest.snapshotWeek);
  const ranges = [];
  for (let month = new Date(Date.UTC(2026, 0, 1)); month.getTime() <= end.getTime();
       month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    ranges.push({
      snapshotType: BALANCE_SNAPSHOT_TYPE_MONTHLY,
      snapshotDate: formatUtcDate_(new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), BALANCE_CADENCE.monthlyDay))),
      snapshotWeek: formatUtcDate_(month),
      asOfDate: formatUtcDate_(new Date(nextMonth.getTime() - 86400000))
    });
  }
  return ranges;
}

function runBalanceSnapshotRange_(range) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another Balance Sheet snapshot or deployment is already running.');
  try {
    return executeBalanceSheetBigQuerySnapshot_(null, {
      snapshotType: range.snapshotType, snapshotDate: range.snapshotDate,
      snapshotWeek: range.snapshotWeek, asOfDate: range.asOfDate,
      requireAsOfDateMatch: true
    });
  } finally {
    lock.releaseLock();
  }
}

function snapshotWeeklyBalanceSheetToBigQuery() {
  return runBalanceSnapshotRange_(getBalanceWeeklySnapshotRange_());
}

function snapshotMonthlyBalanceSheetToBigQuery() {
  return runBalanceSnapshotRange_(getBalanceMonthlySnapshotRange_());
}

function buildBalanceMetricsViewSql_(viewName, snapshotType, latestOnly) {
  const source = BQ_CONFIG.projectId + '.' + BQ_CONFIG.snapshotsDatasetId + '.' + BQ_CONFIG.snapshotsTableId;
  if (latestOnly) {
    return [
      'CREATE OR REPLACE VIEW `' + BQ_CONFIG.projectId + '.views.' + viewName + '` AS',
      'WITH ranked AS (',
      '  SELECT *, ROW_NUMBER() OVER (',
      '    PARTITION BY ClientId, NormalizedCategory',
      '    ORDER BY SnapshotDate DESC, LoadedAt DESC',
      '  ) AS rn',
      '  FROM `' + source + '`',
      '  WHERE IsKeyMetric = TRUE',
      "    AND COALESCE(SnapshotType, 'WEEKLY') = '" + snapshotType + "'",
      ')',
      'SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,',
      '  MetricName, NormalizedCategory, AccountName, AccountPath, Amount, Currency, Source, LoadedAt,',
      '  SnapshotType',
      'FROM ranked',
      'WHERE rn = 1',
      'ORDER BY Entity ASC, ClientName ASC, NormalizedCategory ASC'
    ].join('\n');
  }
  return [
    'CREATE OR REPLACE VIEW `' + BQ_CONFIG.projectId + '.views.' + viewName + '` AS',
    'SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,',
    '  MetricName, NormalizedCategory, AccountName, AccountPath, Amount, Currency, Source, LoadedAt,',
    '  SnapshotType',
    'FROM `' + source + '`',
    'WHERE IsKeyMetric = TRUE',
    "  AND COALESCE(SnapshotType, 'WEEKLY') = '" + snapshotType + "'",
    'ORDER BY SnapshotDate DESC, Entity ASC, ClientName ASC, NormalizedCategory ASC'
  ].join('\n');
}

function deployBalanceCadenceSchemaAndViews() {
  const snapshotTable = BQ_CONFIG.projectId + '.' + BQ_CONFIG.snapshotsDatasetId + '.' + BQ_CONFIG.snapshotsTableId;
  const auditTable = BQ_CONFIG.projectId + '.' + BQ_CONFIG.auditDatasetId + '.' + BQ_CONFIG.auditTableId;
  const statements = [
    'ALTER TABLE `' + snapshotTable + '` ADD COLUMN IF NOT EXISTS SnapshotType STRING;',
    "UPDATE `" + snapshotTable + "` SET SnapshotType = 'WEEKLY' WHERE SnapshotType IS NULL;",
    'ALTER TABLE `' + auditTable + '` ADD COLUMN IF NOT EXISTS SnapshotType STRING;',
    "UPDATE `" + auditTable + "` SET SnapshotType = 'WEEKLY' WHERE SnapshotType IS NULL;",
    buildBalanceMetricsViewSql_('vw_weekly_balance_sheet_metrics', BALANCE_SNAPSHOT_TYPE_WEEKLY, false) + ';',
    buildBalanceMetricsViewSql_('vw_latest_balance_sheet_metrics', BALANCE_SNAPSHOT_TYPE_WEEKLY, true) + ';',
    buildBalanceMetricsViewSql_('vw_monthly_balance_sheet_metrics', BALANCE_SNAPSHOT_TYPE_MONTHLY, false) + ';'
  ];
  const result = runBalanceBigQueryQuery_(statements.join('\n'), BQ_CONFIG.snapshotsDatasetId);
  return { event: 'balance_cadence_schema_and_views_deployed', jobId: result.jobReference.jobId,
    snapshotTable: snapshotTable, auditTable: auditTable, viewCount: 3 };
}

function deleteBalanceCadenceTriggers_() {
  const handlers = [BALANCE_CADENCE.weeklyHandler, BALANCE_CADENCE.monthlyHandler];
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    handlers.indexOf(trigger.getHandlerFunction()) !== -1
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function installBalanceCadenceTriggers() {
  const deletedCount = deleteBalanceCadenceTriggers_();
  const weekly = ScriptApp.newTrigger(BALANCE_CADENCE.weeklyHandler).timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(BALANCE_CADENCE.weeklyHour).create();
  const monthly = ScriptApp.newTrigger(BALANCE_CADENCE.monthlyHandler).timeBased()
    .onMonthDay(BALANCE_CADENCE.monthlyDay).atHour(BALANCE_CADENCE.monthlyHour).create();
  return { event: 'balance_cadence_triggers_installed', deletedCount: deletedCount,
    weeklyTriggerId: weekly.getUniqueId(), monthlyTriggerId: monthly.getUniqueId() };
}

function deleteBalanceMonthlyBackfillTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === BALANCE_CADENCE.backfillHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function scheduleBalanceMonthlyBackfillWorker_() {
  deleteBalanceMonthlyBackfillTriggers_();
  return ScriptApp.newTrigger(BALANCE_CADENCE.backfillHandler).timeBased().after(10000).create();
}

function startBalanceMonthlyCadenceBackfill2026() {
  const ranges = buildBalanceMonthlyBackfillRanges2026_();
  PropertiesService.getScriptProperties().setProperty(BALANCE_CADENCE.backfillStateProperty,
    JSON.stringify({ status: 'running', nextIndex: 0, ranges: ranges, results: [] }));
  const trigger = scheduleBalanceMonthlyBackfillWorker_();
  return { event: 'balance_monthly_backfill_started', rangeCount: ranges.length,
    triggerId: trigger.getUniqueId() };
}

function processBalanceMonthlyCadenceBackfill2026() {
  deleteBalanceMonthlyBackfillTriggers_();
  const properties = PropertiesService.getScriptProperties();
  const state = JSON.parse(properties.getProperty(BALANCE_CADENCE.backfillStateProperty) || 'null');
  if (!state || state.status !== 'running') return { status: 'idle' };
  const range = state.ranges[state.nextIndex];
  if (!range) {
    state.status = 'completed';
    properties.setProperty(BALANCE_CADENCE.backfillStateProperty, JSON.stringify(state));
    return state;
  }
  const result = runBalanceSnapshotRange_(range);
  state.results.push({ snapshotWeek: range.snapshotWeek, completedAt: new Date().toISOString(),
    lineRowCount: result.lineRowCount, clientCount: result.clientCount });
  state.nextIndex++;
  state.status = state.nextIndex >= state.ranges.length ? 'completed' : 'running';
  properties.setProperty(BALANCE_CADENCE.backfillStateProperty, JSON.stringify(state));
  if (state.status === 'running') scheduleBalanceMonthlyBackfillWorker_();
  return state;
}
