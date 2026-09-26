const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadProject(files) {
  const context = vm.createContext({
    console,
    Logger: { log() {} },
    Utilities: {
      formatDate(value) {
        return new Date(value).toISOString().slice(0, 10);
      }
    }
  });
  files.forEach(file => vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {
    filename: file
  }));
  return context;
}

test('P&L weekly and monthly ranges use the agreed closed periods', () => {
  const context = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js',
    'profit-and-loss/7.Cadence.js'
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
    'balance-sheet/3.Functions.js',
    'balance-sheet/7.Cadence.js'
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

test('cadence deployments preserve weekly views and add monthly views', () => {
  const pnl = loadProject([
    'profit-and-loss/1.Config.js',
    'profit-and-loss/3.Functions.js',
    'profit-and-loss/7.Cadence.js'
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
    'balance-sheet/3.Functions.js',
    'balance-sheet/7.Cadence.js'
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
});
