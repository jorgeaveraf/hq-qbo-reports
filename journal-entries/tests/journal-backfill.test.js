const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadBackfillContext() {
  const context = vm.createContext({ console });
  const root = path.join(__dirname, '..');
  [
    '1.Config.js',
    '3.Functions.js',
    '5.Deployment.js',
    '6.Backfill.js'
  ].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, {
      filename: file
    });
  });
  context.Utilities = {
    formatDate(date) {
      return date.toISOString().slice(0, 10);
    }
  };
  return context;
}

test('plans from January 1 through the day before existing history', () => {
  const context = loadBackfillContext();
  const plan = context.planJournalBackfill_({
    coverage: {
      oldestSnapshotWeek: '2026-08-24',
      newestSnapshotWeek: '2026-08-24',
      partitionCount: 1
    }
  });

  assert.equal(plan.startDate, '2026-01-01');
  assert.equal(plan.horizonDate, '2026-08-23');
  assert.equal(plan.protectedBefore, '2026-08-24');
  assert.equal(plan.periodCount, 34);
  assert.deepEqual(JSON.parse(JSON.stringify(plan.firstPeriod)), {
    snapshotDate: '2026-01-05',
    snapshotWeek: '2025-12-29',
    dateFrom: '2026-01-01',
    dateTo: '2026-01-04',
    periodKey: '2026-01-01|2026-01-04'
  });
  assert.equal(plan.lastPeriod.snapshotWeek, '2026-08-17');
  assert.equal(plan.lastPeriod.dateTo, '2026-08-23');
});

test('returns a no-op plan when history already reaches January 1', () => {
  const context = loadBackfillContext();
  const plan = context.planJournalBackfill_({
    coverage: {
      oldestSnapshotWeek: '2025-12-29',
      newestSnapshotWeek: '2026-08-24',
      partitionCount: 35
    }
  });
  assert.equal(plan.periodCount, 0);
  assert.equal(plan.firstPeriod, null);
  assert.equal(plan.lastPeriod, null);
});

test('rejects a period that overlaps protected history before querying rows', () => {
  const context = loadBackfillContext();
  context.countJournalBackfillPartitionRows_ = () => {
    throw new Error('row query should not run');
  };
  assert.throws(
    () => context.assertJournalBackfillPeriodSafe_({
      snapshotDate: '2026-08-31',
      snapshotWeek: '2026-08-24',
      dateFrom: '2026-08-24',
      dateTo: '2026-08-30',
      periodKey: '2026-08-24|2026-08-30'
    }, '2026-08-24'),
    /refuses to touch protected history/
  );
});

test('stops before deletion when a planned partition unexpectedly has rows', () => {
  const context = loadBackfillContext();
  context.countJournalBackfillPartitionRows_ = () => 7;
  assert.throws(
    () => context.assertJournalBackfillPeriodSafe_({
      snapshotDate: '2026-08-24',
      snapshotWeek: '2026-08-17',
      dateFrom: '2026-08-17',
      dateTo: '2026-08-23',
      periodKey: '2026-08-17|2026-08-23'
    }, '2026-08-24'),
    /unexpected populated partition/
  );
});

test('snapshot assembly accepts a historical range override', () => {
  const context = loadBackfillContext();
  const range = {
    snapshotDate: '2026-01-12',
    snapshotWeek: '2026-01-05',
    dateFrom: '2026-01-05',
    dateTo: '2026-01-11',
    periodKey: '2026-01-05|2026-01-11'
  };
  context.normalizeJournalLoadedEntityConfiguration_ = value => value;
  context.getJournalSnapshotClients_ = () => [];
  context.buildJournalEntityConfigurationSummary_ = () => ({});
  context.Logger = { log() {} };
  const result = context.buildJournalSnapshot_({}, range);
  assert.deepEqual(JSON.parse(JSON.stringify(result.range)), range);
});
