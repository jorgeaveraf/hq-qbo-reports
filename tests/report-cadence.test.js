const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadProject(files) {
  const scriptProperties = {};
  const projectTriggers = [];
  let nextTriggerId = 1;
  const context = vm.createContext({
    console,
    Logger: { log() {} },
    Utilities: {
      formatDate(value) {
        return new Date(value).toISOString().slice(0, 10);
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(key) { return Object.prototype.hasOwnProperty.call(scriptProperties, key) ? scriptProperties[key] : null; },
          setProperty(key, value) { scriptProperties[key] = String(value); },
          deleteProperty(key) { delete scriptProperties[key]; }
        };
      }
    },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      getProjectTriggers() { return projectTriggers.slice(); },
      deleteTrigger(trigger) {
        const index = projectTriggers.indexOf(trigger);
        if (index !== -1) projectTriggers.splice(index, 1);
      },
      newTrigger(handler) {
        const schedule = { handler };
        const builder = {
          timeBased() { return builder; },
          onWeekDay(value) { schedule.weekDay = value; return builder; },
          onMonthDay(value) { schedule.monthDay = value; return builder; },
          atHour(value) { schedule.hour = value; return builder; },
          create() {
            const id = 'trigger-' + nextTriggerId++;
            const trigger = {
              schedule,
              getUniqueId() { return id; },
              getHandlerFunction() { return handler; }
            };
            projectTriggers.push(trigger);
            return trigger;
          }
        };
        return builder;
      }
    }
  });
  files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {
    filename: file
  }));
  context.__scriptProperties = scriptProperties;
  context.__projectTriggers = projectTriggers;
  return context;
}

test('P&L weekly and monthly ranges use the agreed closed periods', () => {
  const context = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js'
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.getPreviousCompletedWeekRange_('2026-09-21'))), {
    snapshotType: 'WEEKLY', snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14',
    dateFrom: '2026-09-14', dateTo: '2026-09-20', periodKey: '2026-09-14|2026-09-20'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getPreviousCompletedMonthRange_('2026-09-26'))), {
    snapshotType: 'MONTHLY', snapshotDate: '2026-09-10', snapshotWeek: '2026-08-01',
    dateFrom: '2026-08-01', dateTo: '2026-08-31', periodKey: '2026-08-01|2026-08-31'
  });
  const backfill = JSON.parse(JSON.stringify(context.buildPnlMonthlyBackfillRanges2026_('2026-09-26')));
  assert.equal(backfill.length, 8);
  assert.equal(backfill[0].periodKey, '2026-01-01|2026-01-31');
  assert.equal(backfill[7].periodKey, '2026-08-01|2026-08-31');
});

test('Balance Sheet ranges align to the same Sunday and completed month as P&L', () => {
  const context = loadProject([
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js'
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.getBalanceWeeklySnapshotRange_('2026-09-26'))), {
    snapshotType: 'WEEKLY', snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14',
    asOfDate: '2026-09-20'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getBalanceMonthlySnapshotRange_('2026-09-26'))), {
    snapshotType: 'MONTHLY', snapshotDate: '2026-09-10', snapshotWeek: '2026-08-01',
    asOfDate: '2026-08-31'
  });
  const backfill = JSON.parse(JSON.stringify(context.buildBalanceMonthlyBackfillRanges2026_('2026-09-26')));
  assert.equal(backfill.length, 8);
  assert.equal(backfill[0].snapshotWeek, '2026-01-01');
  assert.equal(backfill[7].asOfDate, '2026-08-31');
});

test('existing snapshot handlers resolve weekly and monthly cadence from trigger UID', () => {
  const pnl = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js'
  ]);
  pnl.__scriptProperties.QBO_PNL_CADENCE_TRIGGER_TYPES = JSON.stringify({ weeklyUid: 'WEEKLY', monthlyUid: 'MONTHLY' });
  assert.equal(pnl.resolvePnlSnapshotRange_({ triggerUid: 'weeklyUid' }, '2026-09-21').snapshotType, 'WEEKLY');
  assert.equal(pnl.resolvePnlSnapshotRange_({ triggerUid: 'monthlyUid' }, '2026-09-21').snapshotType, 'MONTHLY');
  assert.equal(pnl.resolvePnlSnapshotRange_(null, '2026-09-21').snapshotType, 'WEEKLY');

  const balance = loadProject([
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js'
  ]);
  balance.__scriptProperties.QBO_BALANCE_CADENCE_TRIGGER_TYPES = JSON.stringify({ weeklyUid: 'WEEKLY', monthlyUid: 'MONTHLY' });
  assert.equal(balance.resolveBalanceSnapshotRange_({ triggerUid: 'weeklyUid' }, '2026-09-21').snapshotType, 'WEEKLY');
  assert.equal(balance.resolveBalanceSnapshotRange_({ triggerUid: 'monthlyUid' }, '2026-09-21').snapshotType, 'MONTHLY');
  assert.equal(balance.resolveBalanceSnapshotRange_(null, '2026-09-21').snapshotType, 'WEEKLY');
});

test('cadence installers point both schedules to each existing snapshot handler', () => {
  const pnl = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js'
  ]);
  const pnlInstall = JSON.parse(JSON.stringify(pnl.installPnlCadenceTriggers()));
  assert.equal(pnlInstall.handler, 'snapshotAllProfitAndLossReports');
  assert.deepEqual(pnl.__projectTriggers.map(trigger => trigger.getHandlerFunction()), [
    'snapshotAllProfitAndLossReports', 'snapshotAllProfitAndLossReports'
  ]);
  assert.deepEqual(JSON.parse(pnl.__scriptProperties.QBO_PNL_CADENCE_TRIGGER_TYPES), {
    [pnlInstall.weeklyTriggerId]: 'WEEKLY', [pnlInstall.monthlyTriggerId]: 'MONTHLY'
  });

  const balance = loadProject([
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js'
  ]);
  const balanceInstall = JSON.parse(JSON.stringify(balance.installBalanceCadenceTriggers()));
  assert.equal(balanceInstall.handler, 'snapshotBalanceSheetToBigQuery');
  assert.deepEqual(balance.__projectTriggers.map(trigger => trigger.getHandlerFunction()), [
    'snapshotBalanceSheetToBigQuery', 'snapshotBalanceSheetToBigQuery'
  ]);
  assert.deepEqual(JSON.parse(balance.__scriptProperties.QBO_BALANCE_CADENCE_TRIGGER_TYPES), {
    [balanceInstall.weeklyTriggerId]: 'WEEKLY', [balanceInstall.monthlyTriggerId]: 'MONTHLY'
  });
});

test('cadence deployments preserve weekly views and add monthly views', () => {
  const pnl = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js'
  ]);
  const weeklyPnl = pnl.buildPnlReportViewSql_(
    'vw_profit_and_loss_reports', 'profit_and_loss_snapshots', 'WEEKLY', false, false
  );
  const monthlyPnl = pnl.buildPnlReportViewSql_(
    'vw_monthly_profit_and_loss_reports', 'profit_and_loss_snapshots', 'MONTHLY', false, false
  );
  assert.match(weeklyPnl, /COALESCE\(SnapshotType, 'WEEKLY'\) = 'WEEKLY'/);
  assert.match(weeklyPnl, /SnapshotWeek,\s+SnapshotDate,\s+RecordGroupOrder/);
  assert.match(weeklyPnl, /ClientId,\s+LoadedAt,\s+SnapshotType\s+FROM/);
  assert.match(monthlyPnl, /vw_monthly_profit_and_loss_reports/);
  assert.match(monthlyPnl, /COALESCE\(SnapshotType, 'WEEKLY'\) = 'MONTHLY'/);

  const weeklyPnlByClass = pnl.buildPnlReportViewSql_(
    'vw_profit_and_loss_by_class_reports', 'profit_and_loss_by_class_snapshots',
    'WEEKLY', true, false
  );
  assert.match(weeklyPnlByClass, /SnapshotWeek,\s+SnapshotDate,\s+RecordType,\s+RecordGroupOrder/);
  assert.match(weeklyPnlByClass, /ClientId,\s+LoadedAt,\s+SnapshotType\s+FROM/);

  const balance = loadProject([
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js'
  ]);
  const weeklyBalance = balance.buildBalanceMetricsViewSql_(
    'vw_weekly_balance_sheet_metrics', 'WEEKLY', false
  );
  const monthlyBalance = balance.buildBalanceMetricsViewSql_(
    'vw_monthly_balance_sheet_metrics', 'MONTHLY', false
  );
  assert.match(weeklyBalance, /vw_weekly_balance_sheet_metrics/);
  assert.match(weeklyBalance, /SnapshotWeek, SnapshotDate, Entity/);
  assert.match(weeklyBalance, /Source, LoadedAt,\s+SnapshotType\s+FROM/);
  assert.match(monthlyBalance, /vw_monthly_balance_sheet_metrics/);
  assert.match(monthlyBalance, /COALESCE\(SnapshotType, 'WEEKLY'\) = 'MONTHLY'/);

  const balanceSchemaStatements = balance.buildBalanceCadenceSchemaStatements_().join('\n');
  assert.match(balanceSchemaStatements,
    /ALTER TABLE `qbo-gateway-reporting\.raw\.balance_sheet_snapshots` SET OPTIONS \(partition_expiration_days = NULL\)/);
  assert.match(balanceSchemaStatements,
    /ALTER TABLE `qbo-gateway-reporting\.intermediate\.balance_sheet_audit` SET OPTIONS \(partition_expiration_days = NULL\)/);
});

test('Balance Sheet replacement is atomic and scoped by cadence', () => {
  const balance = loadProject([
    'balance-sheet/1.Config.js',
    'balance-sheet/3.Functions.js'
  ]);
  const sql = balance.buildBalanceAtomicReplaceSql_(
    'project.raw.balance_sheet_snapshots',
    'project.raw.balance_sheet_snapshot_stage',
    ['SnapshotDate', 'SnapshotType', 'ClientId', 'Amount'],
    '2026-02-10',
    'MONTHLY',
    "'client-a', 'client-b'"
  );
  assert.match(sql, /^MERGE `project\.raw\.balance_sheet_snapshots` AS T/);
  assert.match(sql, /USING `project\.raw\.balance_sheet_snapshot_stage` AS S/);
  assert.match(sql, /ON FALSE/);
  assert.match(sql, /T\.SnapshotDate = DATE '2026-02-10'/);
  assert.match(sql, /COALESCE\(T\.SnapshotType, 'WEEKLY'\) = 'MONTHLY'/);
  assert.match(sql, /T\.ClientId IN \('client-a', 'client-b'\)/);
  assert.match(sql, /THEN DELETE/);
  assert.match(sql, /VALUES \(S\.`SnapshotDate`, S\.`SnapshotType`, S\.`ClientId`, S\.`Amount`\)/);
  assert.doesNotMatch(sql, /BEGIN TRANSACTION|WRITE_TRUNCATE/);
});
