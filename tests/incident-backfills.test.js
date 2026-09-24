const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadConstant(file, constantName) {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  return JSON.parse(vm.runInContext(`JSON.stringify(${constantName})`, context));
}

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const weeklyPeriods = [
  {
    snapshotDate: '2026-09-14', snapshotWeek: '2026-09-07',
    dateFrom: '2026-09-07', dateTo: '2026-09-13',
    periodKey: '2026-09-07|2026-09-13'
  },
  {
    snapshotDate: '2026-09-21', snapshotWeek: '2026-09-14',
    dateFrom: '2026-09-14', dateTo: '2026-09-20',
    periodKey: '2026-09-14|2026-09-20'
  }
];

test('weekly incident backfills are bounded to the two affected weeks', () => {
  const invoice = loadConstant('invoices/6.Backfill.js', 'INVOICE_INCIDENT_BACKFILL');
  const journal = loadConstant('journal-entries/6.Backfill.js', 'JOURNAL_INCIDENT_BACKFILL');
  assert.deepEqual(invoice.periods, weeklyPeriods);
  assert.deepEqual(journal.periods, weeklyPeriods);
});

test('aging backfill uses the affected Monday snapshots', () => {
  const aging = loadConstant('ar-ap/6.Backfill.js', 'AGING_INCIDENT_BACKFILL');
  assert.deepEqual(aging.snapshotDates, ['2026-09-14', '2026-09-21']);
});

test('balance backfill targets only the missing Nova Massachusetts daily snapshots', () => {
  const balance = loadConstant('balance-sheet/6.Backfill.js', 'BALANCE_INCIDENT_BACKFILL');
  assert.deepEqual(balance.jobs, [
    { snapshotDate: '2026-09-17', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-18', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-19', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] },
    { snapshotDate: '2026-09-20', clientIds: ['070b2e37-aa28-4911-b2b2-e493678d38f5'] }
  ]);
});

test('P&L backfills both report variants for both affected weeks', () => {
  const pnl = loadConstant('profit-and-loss/6.Backfill.js', 'PNL_INCIDENT_BACKFILL');
  assert.equal(pnl.jobs.length, 4);
  assert.deepEqual(
    pnl.jobs.map(job => [job.variant, job.range.periodKey]),
    [
      ['normal', weeklyPeriods[0].periodKey],
      ['by_class', weeklyPeriods[0].periodKey],
      ['normal', weeklyPeriods[1].periodKey],
      ['by_class', weeklyPeriods[1].periodKey]
    ]
  );
});

test('each project exposes a dedicated starter and resumable worker', () => {
  const expectations = [
    ['invoices/6.Backfill.js', 'startInvoiceSeptemberIncidentBackfill', 'processInvoiceSeptemberIncidentBackfill'],
    ['journal-entries/6.Backfill.js', 'startJournalSeptemberIncidentBackfill', 'processJournalSeptemberIncidentBackfill'],
    ['ar-ap/6.Backfill.js', 'startAgingSeptemberIncidentBackfill', 'processAgingSeptemberIncidentBackfill'],
    ['balance-sheet/6.Backfill.js', 'startBalanceSeptemberIncidentBackfill', 'processBalanceSeptemberIncidentBackfill'],
    ['profit-and-loss/6.Backfill.js', 'startPnlSeptemberIncidentBackfill', 'processPnlSeptemberIncidentBackfill']
  ];
  expectations.forEach(([file, starter, worker]) => {
    const text = source(file);
    assert.match(text, new RegExp(`function ${starter}\\(`));
    assert.match(text, new RegExp(`function ${worker}\\(`));
    assert.match(text, /maxStageAttempts:\s*3/);
    assert.match(text, /currentStage:\s*'bigquery'/);
    assert.match(text, /'data_source_sheets'/);
    assert.match(text, /'extracts'/);
  });
});

test('snapshot builders accept controlled historical ranges', () => {
  assert.match(source('journal-entries/3.Functions.js'),
    /executeJournalBigQuerySnapshot_\(loadedEntityConfiguration, rangeOverride\)/);
  assert.match(source('invoices/3.Functions.js'),
    /const range = settings\.range \|\| getPreviousCompletedWeekRange_\(\)/);
  assert.match(source('ar-ap/3.Functions.js'),
    /buildAgingSnapshot_\(loadedEntityConfiguration, snapshotDateOverride\)/);
  assert.match(source('balance-sheet/3.Functions.js'),
    /settings\.snapshotDate \|\| todayIsoDate_\(\)/);
  assert.match(source('profit-and-loss/3.Functions.js'),
    /const range = settings\.range \|\| getPreviousCompletedWeekRange_\(\)/);
});

test('historical point-in-time reports send the endpoint date expected by each report', () => {
  const aging = source('ar-ap/3.Functions.js');
  const balance = source('balance-sheet/3.Functions.js');
  assert.match(aging, /report_date=/);
  assert.match(aging, /AR\/AP historical response date mismatch/);
  assert.match(balance, /&as_of_date=/);
  assert.match(balance, /Balance Sheet historical response date mismatch/);
  assert.match(balance, /requireAsOfDateMatch/);
  assert.match(balance, /forceClientScope/);
});
