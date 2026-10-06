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
      formatDate(value) { return new Date(value).toISOString().slice(0, 10); },
      getUuid() { return 'test-uuid'; }
    },
    Session: { getScriptTimeZone() { return 'Etc/UTC'; } }
  });
  files.forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  });
  return context;
}

test('weekly history ranges use Monday, Sunday close, and next-Monday snapshot', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js', 'profit-and-loss/6.Backfill.js']);
  const invoices = loadProject(['invoices/1.Config.js', 'invoices/3.Functions.js', 'invoices/6.Backfill.js']);

  assert.deepEqual(JSON.parse(JSON.stringify(balance.buildBalanceWeeklyHistoryRange_('2026-01-05'))), {
    snapshotType: 'WEEKLY', snapshotWeek: '2026-01-05', asOfDate: '2026-01-11', snapshotDate: '2026-01-12'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(pnl.buildPnlWeeklyHistoryRange_('2026-01-05'))), {
    snapshotType: 'WEEKLY', snapshotDate: '2026-01-12', snapshotWeek: '2026-01-05',
    dateFrom: '2026-01-05', dateTo: '2026-01-11', periodKey: '2026-01-05|2026-01-11'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(invoices.buildInvoiceWeeklyHistoryRange_('2026-01-05'))), {
    snapshotDate: '2026-01-12', snapshotWeek: '2026-01-05',
    dateFrom: '2026-01-05', dateTo: '2026-01-11', periodKey: '2026-01-05|2026-01-11'
  });
});

test('expected history ends at the last closed week', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js', 'profit-and-loss/6.Backfill.js']);
  const invoices = loadProject(['invoices/1.Config.js', 'invoices/3.Functions.js', 'invoices/6.Backfill.js']);
  for (const weeks of [
    balance.buildBalanceWeeklyHistoryExpectedWeeks_('2026-10-05'),
    pnl.buildPnlWeeklyHistoryExpectedWeeks_('2026-10-05'),
    invoices.buildInvoiceWeeklyHistoryExpectedWeeks_('2026-10-05')
  ]) {
    assert.equal(weeks.length, 39);
    assert.equal(weeks[0], '2026-01-05');
    assert.equal(weeks.at(-1), '2026-09-28');
  }
});

test('planners include only missing canonical weeks and P&L plans both variants independently', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  balance.readBalanceCanonicalWeeklyHistory_ = () => ({
    '2026-01-05': ['a', 'b'], '2026-01-12': ['a'], '2026-01-19': ['a', 'b']
  });
  const balancePlan = balance.planBalanceWeeklyHistoryBackfill2026_('2026-01-26', ['a', 'b']);
  assert.deepEqual(Array.from(balancePlan.missingWeeks), ['2026-01-12']);
  assert.deepEqual(Array.from(balancePlan.jobs[0].missingClientIds), ['b']);

  const invoices = loadProject(['invoices/1.Config.js', 'invoices/3.Functions.js', 'invoices/6.Backfill.js']);
  invoices.readInvoiceCanonicalWeeklyHistory_ = () => ({ '2026-01-12': ['a'] });
  const invoicePlan = invoices.planInvoiceWeeklyHistoryBackfill2026_('2026-01-26', ['a']);
  assert.deepEqual(Array.from(invoicePlan.missingWeeks), ['2026-01-05', '2026-01-19']);

  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js', 'profit-and-loss/6.Backfill.js']);
  let queriedPnlTable = '';
  pnl.runPnlBigQueryQuery_ = sql => {
    queriedPnlTable = sql;
    return { rows: [{ f: [{ v: '2026-01-05' }, { v: 'a,b' }] }] };
  };
  assert.deepEqual(JSON.parse(JSON.stringify(pnl.readPnlCanonicalWeeklyHistory_('normal', '2026-01-05', '2026-01-19'))), {
    '2026-01-05': ['a', 'b']
  });
  assert.match(queriedPnlTable, /profit_and_loss_snapshots/);
  pnl.readPnlCanonicalWeeklyHistory_ = variant => variant === 'normal'
    ? { '2026-01-05': ['a'] } : { '2026-01-12': ['a'] };
  const pnlPlan = pnl.planPnlWeeklyHistoryBackfill2026_('2026-01-26', { normal: ['a'], by_class: ['a'] });
  assert.deepEqual(JSON.parse(JSON.stringify(pnlPlan.jobs)), [
    { variant: 'normal', snapshotWeek: '2026-01-12', missingClientIds: ['a'] },
    { variant: 'normal', snapshotWeek: '2026-01-19', missingClientIds: ['a'] },
    { variant: 'by_class', snapshotWeek: '2026-01-05', missingClientIds: ['a'] },
    { variant: 'by_class', snapshotWeek: '2026-01-19', missingClientIds: ['a'] }
  ]);
});

test('Invoice canonical history treats an empty BigQuery ARRAY_AGG result as no coverage', () => {
  const invoices = loadProject(['invoices/1.Config.js', 'invoices/3.Functions.js', 'invoices/6.Backfill.js']);
  invoices.runBigQuerySingleRowQuery_ = () => ({ coverage: 'null' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(invoices.readInvoiceCanonicalWeeklyHistory_('2026-01-05', '2026-01-05'))),
    {}
  );
});

test('retry processes only entities still missing from a partially loaded week', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  balance.readBalanceCanonicalWeeklyHistory_ = () => ({ '2026-01-05': ['already-loaded'] });
  balance.loadBalanceEntityConfiguration_ = () => ({ configuration: { configuration_hash: 'hash' } });
  let requestedClientIds = null;
  balance.executeBalanceSheetBigQuerySnapshot_ = (_loaded, options) => {
    requestedClientIds = options.clientIds;
    return { status: 'completed', lineRowCount: 2, clientCount: 1, verification: { status: 'passed' } };
  };
  const result = balance.executeBalanceWeeklyHistoryWeek_('2026-01-05', {
    expectedClientIds: ['already-loaded', 'missing'], configurationHash: 'hash'
  });
  assert.deepEqual(Array.from(requestedClientIds), ['missing']);
  assert.equal(result.status, 'completed');
});

test('P&L planner treats confirmed empty clients as completed coverage', () => {
  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js', 'profit-and-loss/6.Backfill.js']);
  pnl.readPnlCanonicalWeeklyHistory_ = variant => variant === 'normal'
    ? { '2026-01-05': ['with-rows'] }
    : { '2026-01-05': ['with-rows', 'empty-client'] };
  const plan = pnl.planPnlWeeklyHistoryBackfill2026_(
    '2026-01-12',
    { normal: ['with-rows', 'empty-client'], by_class: ['with-rows', 'empty-client'] },
    { normal: { '2026-01-05': ['empty-client'] }, by_class: {} }
  );
  assert.equal(plan.jobs.length, 0);
});

test('P&L weekly job records successful zero-row clients and preserves failed clients for retry', () => {
  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js', 'profit-and-loss/6.Backfill.js']);
  const properties = {};
  pnl.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => properties[key] || null,
    setProperty: (key, value) => { properties[key] = value; }
  }) };
  pnl.loadPnlEntityConfiguration_ = () => ({ configuration: { configuration_hash: 'hash' } });
  pnl.readPnlCanonicalWeeklyHistory_ = () => ({});
  let requestedClientIds = null;
  pnl.executeProfitAndLossVariantSnapshot_ = (_variant, _loaded, options) => {
    requestedClientIds = options.clientIds;
    assert.equal(options.returnPartialResult, true);
    return {
      rowCount: 0, clientCount: 2, successfulClientIds: ['empty-client'],
      clientFailures: [{ clientId: 'failed-client', error: 'timeout' }],
      verification: { status: 'passed' }
    };
  };
  const state = {
    operationId: 'operation-1', jobs: [{ variant: 'normal', snapshotWeek: '2026-01-05' }],
    expectedClientIds: { normal: ['empty-client', 'failed-client'], by_class: ['class-client'] },
    configuration: { normal: 'hash', byClass: 'other' }
  };
  assert.throws(
    () => pnl.executePnlWeeklyHistoryJob_(state.jobs[0], state),
    /still has entity failures/
  );
  assert.deepEqual(Array.from(requestedClientIds), ['empty-client', 'failed-client']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(pnl.readPnlWeeklyHistoryEmptyEvidence_(state, 'normal', '2026-01-05'))),
    ['empty-client']
  );
  const plan = pnl.planPnlWeeklyHistoryBackfill2026_(
    '2026-01-12', state.expectedClientIds,
    {
      normal: { '2026-01-05': ['empty-client'] },
      by_class: { '2026-01-05': ['class-client'] }
    }
  );
  const normalJob = plan.jobs.find(job => job.variant === 'normal');
  assert.deepEqual(Array.from(normalJob.missingClientIds), ['failed-client']);
});

test('failed final validation blocks Connected Sheets refresh', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  const state = { status: 'pending', currentStage: 'validation', stageAttempts: 0 };
  let refreshCalls = 0;
  balance.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  balance.readBalanceWeeklyHistoryState_ = () => state;
  balance.persistBalanceWeeklyHistoryState_ = updated => Object.assign(state, updated);
  balance.deleteBalanceWeeklyHistoryTriggers_ = () => {};
  balance.replaceBalanceWeeklyHistorySchedule_ = () => {};
  balance.validateBalanceWeeklyHistoryBackfill2026_ = () => { throw new Error('coverage failed'); };
  balance.refreshBalanceConnectedSheetsStage_ = () => { refreshCalls += 1; };
  assert.throws(() => balance.processBalanceWeeklyHistoryBackfill2026(), /coverage failed/);
  assert.equal(refreshCalls, 0);
  assert.equal(state.currentStage, 'validation');
});

test('public planners are exposed without creating state or triggers', () => {
  const sources = [
    fs.readFileSync(path.join(root, 'balance-sheet/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'profit-and-loss/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'invoices/6.Backfill.js'), 'utf8')
  ];
  assert.match(sources[0], /function getBalanceWeeklyHistoryBackfillPlan2026\(/);
  assert.match(sources[1], /function getPnlWeeklyHistoryBackfillPlan2026\(/);
  assert.match(sources[2], /function getInvoiceWeeklyHistoryBackfillPlan2026\(/);

  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js', 'balance-sheet/6.Backfill.js']);
  balance.loadBalanceEntityConfiguration_ = () => ({ configuration: {} });
  balance.resolveBalanceEntitySelection_ = () => ({ clientsById: { a: {}, b: {} } });
  balance.readBalanceCanonicalWeeklyHistory_ = () => ({ '2026-01-05': ['a', 'b'] });
  const plan = balance.getBalanceWeeklyHistoryBackfillPlan2026('2026-01-12');
  assert.equal(plan.jobs.length, 0);
});

test('final validators check coverage, canonical dates, duplicates, and the preexisting fingerprint', () => {
  const sources = [
    fs.readFileSync(path.join(root, 'balance-sheet/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'profit-and-loss/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'invoices/6.Backfill.js'), 'utf8')
  ];
  sources.forEach(source => {
    assert.match(source, /final coverage validation failed/);
    assert.match(source, /preexisting-period fingerprint changed/);
    assert.match(source, /final canonical\/duplicate validation failed/);
  });
});

test('P&L subset load preserves clients already present in the partition', () => {
  const pnl = loadProject(['profit-and-loss/1.Config.js', 'profit-and-loss/3.Functions.js']);
  const storedClients = new Set(['existing-a', 'existing-b']);
  let partitionReplaceCalled = false;
  pnl.replacePnlSnapshotClients_ = (_range, rows, _variant, clientIds) => {
    clientIds.forEach(id => storedClients.add(id));
    return { state: 'DONE', rowCount: rows.length };
  };
  pnl.replacePnlSnapshotPartition_ = () => {
    partitionReplaceCalled = true;
    storedClients.clear();
    return { state: 'DONE' };
  };
  pnl.verifyPnlSnapshotPartition_ = (_week, count) => ({
    status: 'passed', expectedRowCount: count, actualRowCount: count,
    missingKeyCount: 0, uniqueKeyCount: count
  });
  pnl.loadPnlVariantSnapshot_({
    range: { snapshotWeek: '2026-07-20', snapshotType: 'WEEKLY' },
    rows: [{ ClientId: 'missing-c' }], rowCount: 1, variant: 'normal',
    successfulClientIds: ['missing-c'], clientFailures: [], clientResults: [],
    validation: {}, reconciliation: null
  }, { forceClientScope: true });
  assert.equal(partitionReplaceCalled, false);
  assert.deepEqual(Array.from(storedClients).sort(), ['existing-a', 'existing-b', 'missing-c']);
});

test('Invoice subset execution preserves clients already present in the partition', () => {
  const invoices = loadProject(['invoices/1.Config.js', 'invoices/3.Functions.js']);
  const storedClients = new Set(['existing-a', 'existing-b']);
  let partitionReplaceCalled = false;
  invoices.validateInvoiceBigQuerySchema_ = () => ({ status: 'passed' });
  invoices.buildInvoiceSnapshot_ = () => ({
    range: { snapshotWeek: '2026-07-20' }, lineRows: [{ ClientId: 'missing-c' }],
    successfulClientIds: ['missing-c'], clientFailures: [], clientCount: 1,
    entityConfiguration: {}, sourceDiagnostics: {}, mappingWarnings: [],
    schemaMonitoring: {}, schemaBaselineUpdates: []
  });
  invoices.validateInvoiceSnapshotHierarchy_ = () => ({ rowCount: 1 });
  invoices.replaceInvoiceSnapshotClients_ = (_range, _rows, clientIds) => {
    clientIds.forEach(id => storedClients.add(id));
    return { state: 'DONE' };
  };
  invoices.replaceInvoiceSnapshotPartition_ = () => {
    partitionReplaceCalled = true;
    storedClients.clear();
    return { state: 'DONE' };
  };
  invoices.verifyInvoiceSnapshotPartition_ = () => ({ status: 'passed' });
  invoices.persistInvoiceSchemaBaselineUpdates_ = () => ({ status: 'unchanged' });
  invoices.executeInvoiceBigQuerySnapshot_({}, {
    range: { snapshotWeek: '2026-07-20' }, clientIds: ['missing-c']
  });
  assert.equal(partitionReplaceCalled, false);
  assert.deepEqual(Array.from(storedClients).sort(), ['existing-a', 'existing-b', 'missing-c']);
});

test('worst-case production state remains below the Script Properties limit', () => {
  const weeks = [];
  for (let date = new Date('2026-01-05T00:00:00Z'); date <= new Date('2026-09-28T00:00:00Z');
       date = new Date(date.getTime() + 7 * 86400000)) {
    weeks.push(date.toISOString().slice(0, 10));
  }
  const ids = count => Array.from({ length: count }, (_, index) =>
    String(index).padStart(8, '0') + '-aaaa-bbbb-cccc-' + String(index).padStart(12, '0'));
  const common = {
    operationId: '12345678-1234-1234-1234-123456789012', planVersion: '2026-weekly-history-v1',
    status: 'pending', currentStage: 'bigquery', createdAt: '2026-10-05T12:00:00.000Z',
    updatedAt: '2026-10-05T12:00:00.000Z', completedAt: null,
    preexistingBaseline: '999999|9223372036854775807', stageAttempts: 2,
    lastError: 'x'.repeat(1500), completedCount: 38, skippedCount: 1,
    lastResult: { status: 'completed', snapshotWeek: '2026-09-28', rowCount: 99999,
      verification: 'passed' }
  };
  const states = {
    balance_sheet: { ...common, report: 'balance_sheet', weeks, weekIndex: 38,
      expectedClientIds: ids(16), configurationVersion: 'v'.repeat(100), configurationHash: 'h'.repeat(64) },
    profit_and_loss: { ...common, report: 'profit_and_loss',
      jobs: weeks.flatMap(snapshotWeek => ['normal', 'by_class'].map(variant => ({ variant, snapshotWeek }))),
      jobIndex: 77, expectedClientIds: { normal: ids(15), by_class: ids(15) },
      configuration: { normal: 'n'.repeat(64), byClass: 'b'.repeat(64) },
      preexistingBaseline: { normal: common.preexistingBaseline, by_class: common.preexistingBaseline } },
    invoices: { ...common, report: 'invoices', weeks, weekIndex: 38,
      expectedClientIds: ids(12), configurationVersion: 'v'.repeat(100), configurationHash: 'h'.repeat(64) }
  };
  const sizes = Object.fromEntries(Object.entries(states).map(([name, state]) =>
    [name, Buffer.byteLength(JSON.stringify(state), 'utf8')]));
  Object.values(sizes).forEach(size => assert.ok(size < 8500));
  const invoiceEvidenceSize = Buffer.byteLength(JSON.stringify(ids(12)), 'utf8');
  const pnlEvidenceSize = Buffer.byteLength(JSON.stringify(ids(15)), 'utf8');
  assert.ok(invoiceEvidenceSize < 8500);
  assert.ok(pnlEvidenceSize < 8500);
  assert.deepEqual(sizes, { balance_sheet: 3377, profit_and_loss: 7349, invoices: 3216 });
  assert.equal(invoiceEvidenceSize, 469);
  assert.equal(pnlEvidenceSize, 586);
});

test('Balance Sheet starter requires the canonical weekly view first', () => {
  const source = fs.readFileSync(path.join(root, 'balance-sheet/6.Backfill.js'), 'utf8');
  assert.match(source, /validateBalanceCanonicalWeeklyView_\(\)/);
  assert.match(source, /Deploy the canonical Balance Sheet weekly view before starting/);
});

test('Balance Sheet weekly consumption excludes legacy daily captures', () => {
  const balance = loadProject(['balance-sheet/1.Config.js', 'balance-sheet/3.Functions.js']);
  const weekly = balance.buildBalanceMetricsViewSql_('vw_weekly_balance_sheet_metrics', 'WEEKLY', false);
  assert.match(weekly, /EXTRACT\(DAYOFWEEK FROM SnapshotWeek\) = 2/);
  assert.match(weekly, /SnapshotDate = DATE_ADD\(SnapshotWeek, INTERVAL 7 DAY\)/);
  assert.match(weekly, /AsOfDate = DATE_ADD\(SnapshotWeek, INTERVAL 6 DAY\)/);
});

test('history workers are isolated from recurring and September incident handlers', () => {
  const sources = [
    fs.readFileSync(path.join(root, 'balance-sheet/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'profit-and-loss/6.Backfill.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'invoices/6.Backfill.js'), 'utf8')
  ];
  assert.match(sources[0], /workerHandler: 'processBalanceWeeklyHistoryBackfill2026'/);
  assert.match(sources[1], /workerHandler: 'processPnlWeeklyHistoryBackfill2026'/);
  assert.match(sources[2], /workerHandler: 'processInvoiceWeeklyHistoryBackfill2026'/);
  sources.forEach(source => {
    assert.match(source, /IncidentBackfillState_/);
    assert.match(source, /skipped_existing/);
  });
});
