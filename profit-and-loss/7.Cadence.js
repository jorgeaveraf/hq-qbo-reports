/***********************
 * QBO Profit and Loss - Weekly and Monthly Cadence
 ***********************/

const PNL_CADENCE = {
  weeklyHandler: 'snapshotWeeklyProfitAndLossReports',
  monthlyHandler: 'snapshotMonthlyProfitAndLossReports',
  backfillHandler: 'processPnlMonthlyCadenceBackfill2026',
  backfillStateProperty: 'QBO_PNL_MONTHLY_CADENCE_BACKFILL_2026',
  weeklyHour: 1,
  monthlyHour: 2,
  monthlyDay: 10
};

function normalizePnlSnapshotType_(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if ([PNL_SNAPSHOT_TYPE_WEEKLY, PNL_SNAPSHOT_TYPE_MONTHLY].indexOf(normalized) === -1) {
    throw new Error('Unsupported P&L SnapshotType: ' + value);
  }
  return normalized;
}

function getPreviousCompletedMonthRange_(referenceIsoDate) {
  const referenceText = normalizeDateForOutput_(referenceIsoDate || todayIsoDate_());
  const referenceDate = safeParseDate_(referenceText);
  if (!referenceDate) throw new Error('Invalid P&L monthly reference date: ' + referenceIsoDate);
  const monthStart = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), 1));
  const dateFrom = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1));
  const dateTo = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 0));
  const dateFromIso = formatUtcDate_(dateFrom);
  const dateToIso = formatUtcDate_(dateTo);
  const snapshotDate = formatUtcDate_(new Date(Date.UTC(
    monthStart.getUTCFullYear(), monthStart.getUTCMonth(), PNL_CADENCE.monthlyDay
  )));
  return {
    snapshotType: PNL_SNAPSHOT_TYPE_MONTHLY,
    snapshotDate: snapshotDate,
    snapshotWeek: dateFromIso,
    dateFrom: dateFromIso,
    dateTo: dateToIso,
    periodKey: dateFromIso + '|' + dateToIso
  };
}

function buildPnlMonthlyBackfillRanges2026_(referenceIsoDate) {
  const latest = getPreviousCompletedMonthRange_(referenceIsoDate);
  const end = safeParseDate_(latest.dateFrom);
  const ranges = [];
  for (let month = new Date(Date.UTC(2026, 0, 1)); month.getTime() <= end.getTime();
       month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const dateFrom = formatUtcDate_(month);
    const dateTo = formatUtcDate_(new Date(nextMonth.getTime() - 86400000));
    const snapshotDate = formatUtcDate_(new Date(Date.UTC(
      nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), PNL_CADENCE.monthlyDay
    )));
    ranges.push({
      snapshotType: PNL_SNAPSHOT_TYPE_MONTHLY,
      snapshotDate: snapshotDate,
      snapshotWeek: dateFrom,
      dateFrom: dateFrom,
      dateTo: dateTo,
      periodKey: dateFrom + '|' + dateTo
    });
  }
  return ranges;
}

function buildPnlReportViewSql_(viewName, tableId, snapshotType, byClass, latestOnly) {
  // Keep the pre-cadence view contract intact for Connected Sheets. The new
  // discriminator is appended so existing column positions do not move.
  const columns = byClass ? [
    'SnapshotWeek', 'SnapshotDate', 'RecordType', 'RecordGroupOrder', 'RecordOrder',
    'ClassColumnIndex AS RecordColumnOrder', 'RecordGroupKey', 'Entity', 'ClientName',
    'DateFrom', 'DateTo', 'AccountingMethod', 'Currency', 'AccountName', 'AccountPath',
    'ClassName', 'Amount', 'MetricName', 'NormalizedMetric', 'IsKeyMetric',
    'idempotency_key', 'ClientId', 'LoadedAt', 'SnapshotType'
  ] : [
    'SnapshotWeek', 'SnapshotDate', 'RecordGroupOrder', 'RecordOrder', 'RecordGroupKey',
    'Entity', 'ClientName', 'DateFrom', 'DateTo', 'AccountingMethod', 'Currency',
    'RecordType', 'AccountName', 'AccountPath', 'Amount', 'MetricName',
    'NormalizedMetric', 'IsKeyMetric', 'idempotency_key', 'ClientId', 'LoadedAt',
    'SnapshotType'
  ];
  const where = ["COALESCE(SnapshotType, 'WEEKLY') = '" + snapshotType + "'"];
  if (latestOnly) {
    where.push('SnapshotWeek = (SELECT MAX(SnapshotWeek) FROM `' +
      BQ_CONFIG.projectId + '.' + BQ_CONFIG.rawDatasetId + '.' + tableId +
      "` WHERE COALESCE(SnapshotType, 'WEEKLY') = '" + snapshotType + "')");
  }
  return [
    'CREATE OR REPLACE VIEW `' + BQ_CONFIG.projectId + '.views.' + viewName + '` AS',
    'SELECT', '  ' + columns.join(',\n  '),
    'FROM `' + BQ_CONFIG.projectId + '.' + BQ_CONFIG.rawDatasetId + '.' + tableId + '`',
    'WHERE ' + where.join('\n  AND '),
    'ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,',
    '  RecordGroupOrder ASC, RecordOrder ASC'
  ].join('\n');
}

function deployPnlCadenceSchemaAndViews() {
  const tables = [BQ_CONFIG.snapshotsTableIds.normal, BQ_CONFIG.snapshotsTableIds.by_class];
  const statements = [];
  tables.forEach(tableId => {
    const tableName = BQ_CONFIG.projectId + '.' + BQ_CONFIG.rawDatasetId + '.' + tableId;
    statements.push('ALTER TABLE `' + tableName + '` ADD COLUMN IF NOT EXISTS SnapshotType STRING;');
    statements.push("UPDATE `" + tableName + "` SET SnapshotType = 'WEEKLY' WHERE SnapshotType IS NULL;");
  });
  statements.push(
    buildPnlReportViewSql_('vw_profit_and_loss_reports', tables[0], PNL_SNAPSHOT_TYPE_WEEKLY, false, false) + ';',
    buildPnlReportViewSql_('vw_profit_and_loss_report_latest', tables[0], PNL_SNAPSHOT_TYPE_WEEKLY, false, true) + ';',
    buildPnlReportViewSql_('vw_profit_and_loss_by_class_reports', tables[1], PNL_SNAPSHOT_TYPE_WEEKLY, true, false) + ';',
    buildPnlReportViewSql_('vw_profit_and_loss_by_class_report_latest', tables[1], PNL_SNAPSHOT_TYPE_WEEKLY, true, true) + ';',
    buildPnlReportViewSql_('vw_monthly_profit_and_loss_reports', tables[0], PNL_SNAPSHOT_TYPE_MONTHLY, false, false) + ';',
    buildPnlReportViewSql_('vw_monthly_profit_and_loss_by_class_reports', tables[1], PNL_SNAPSHOT_TYPE_MONTHLY, true, false) + ';'
  );
  const result = runPnlBigQueryQuery_(statements.join('\n'));
  return { event: 'pnl_cadence_schema_and_views_deployed', jobId: result.jobReference.jobId,
    tables: tables, viewCount: 6 };
}

function deletePnlCadenceTriggers_() {
  const handlers = [PNL_CADENCE.weeklyHandler, PNL_CADENCE.monthlyHandler, 'snapshotAllProfitAndLossReports'];
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    handlers.indexOf(trigger.getHandlerFunction()) !== -1
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function installPnlCadenceTriggers() {
  const deletedCount = deletePnlCadenceTriggers_();
  const weekly = ScriptApp.newTrigger(PNL_CADENCE.weeklyHandler).timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(PNL_CADENCE.weeklyHour).create();
  const monthly = ScriptApp.newTrigger(PNL_CADENCE.monthlyHandler).timeBased()
    .onMonthDay(PNL_CADENCE.monthlyDay).atHour(PNL_CADENCE.monthlyHour).create();
  return { event: 'pnl_cadence_triggers_installed', deletedCount: deletedCount,
    weeklyTriggerId: weekly.getUniqueId(), monthlyTriggerId: monthly.getUniqueId() };
}

function deletePnlMonthlyBackfillTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === PNL_CADENCE.backfillHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function schedulePnlMonthlyBackfillWorker_() {
  deletePnlMonthlyBackfillTriggers_();
  return ScriptApp.newTrigger(PNL_CADENCE.backfillHandler).timeBased().after(10000).create();
}

function startPnlMonthlyCadenceBackfill2026() {
  const ranges = buildPnlMonthlyBackfillRanges2026_();
  PropertiesService.getScriptProperties().setProperty(PNL_CADENCE.backfillStateProperty,
    JSON.stringify({ status: 'running', nextIndex: 0, ranges: ranges, results: [] }));
  const trigger = schedulePnlMonthlyBackfillWorker_();
  return { event: 'pnl_monthly_backfill_started', rangeCount: ranges.length,
    triggerId: trigger.getUniqueId() };
}

function processPnlMonthlyCadenceBackfill2026() {
  deletePnlMonthlyBackfillTriggers_();
  const properties = PropertiesService.getScriptProperties();
  const state = JSON.parse(properties.getProperty(PNL_CADENCE.backfillStateProperty) || 'null');
  if (!state || state.status !== 'running') return { status: 'idle' };
  const range = state.ranges[state.nextIndex];
  if (!range) {
    state.status = 'completed';
    properties.setProperty(PNL_CADENCE.backfillStateProperty, JSON.stringify(state));
    return state;
  }
  const result = executeAllProfitAndLossReports_(range);
  state.results.push({
    periodKey: range.periodKey,
    completedAt: new Date().toISOString(),
    normalRowCount: result.reports.normal.rowCount,
    byClassRowCount: result.reports.byClass.rowCount
  });
  state.nextIndex++;
  state.status = state.nextIndex >= state.ranges.length ? 'completed' : 'running';
  properties.setProperty(PNL_CADENCE.backfillStateProperty, JSON.stringify(state));
  if (state.status === 'running') schedulePnlMonthlyBackfillWorker_();
  return state;
}
