const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function formatDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function loadBackfillContext() {
  const context = vm.createContext({
    Session: {
      getScriptTimeZone: () => 'America/Mexico_City'
    },
    Utilities: {
      formatDate: date => formatDate(date),
      newBlob: value => ({ getBytes: () => Buffer.from(String(value)) }),
      getUuid: () => '00000000-0000-4000-8000-000000000000'
    }
  });
  const projectDir = path.resolve(__dirname, '..');
  ['1.Config.js', '3.Functions.js', '6.Backfill.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });
  return context;
}

test('plans the backfill from January 1 using ISO-week segments', () => {
  const context = loadBackfillContext();
  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    today: '2026-01-12'
  });

  assert.equal(plan.horizonDate, '2026-01-11');
  assert.equal(plan.periodCount, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(plan.periods.map(period => ({
      snapshotWeek: period.snapshotWeek,
      dateFrom: period.dateFrom,
      dateTo: period.dateTo
    })))),
    [
      { snapshotWeek: '2025-12-29', dateFrom: '2026-01-01', dateTo: '2026-01-04' },
      { snapshotWeek: '2026-01-05', dateFrom: '2026-01-05', dateTo: '2026-01-11' }
    ]
  );
});

test('clamps a requested future end date to the last completed day', () => {
  const context = loadBackfillContext();
  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    today: '2026-08-19'
  });

  assert.equal(plan.horizonDate, '2026-08-18');
  assert.equal(plan.periodCount, 34);
  assert.equal(plan.lastPeriod.dateFrom, '2026-08-17');
  assert.equal(plan.lastPeriod.dateTo, '2026-08-18');
  assert.ok(plan.periods.every(period => period.dateTo <= '2026-08-18'));
});

test('does not truncate the plan when historical weeks contain no payments', () => {
  const context = loadBackfillContext();
  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    today: '2026-02-02'
  });

  assert.equal(plan.periodCount, 5);
  assert.equal(plan.firstPeriod.dateFrom, '2026-01-01');
  assert.equal(plan.lastPeriod.dateTo, '2026-02-01');
});

test('rejects ranges before the configured lower bound or across ISO weeks', () => {
  const context = loadBackfillContext();
  assert.throws(
    () => context.planPaymentBackfill_({ startDate: '2025-12-31', today: '2026-01-10' }),
    /cannot start before 2026-01-01/
  );
  assert.throws(
    () => context.normalizePaymentSnapshotRange_({ dateFrom: '2026-01-01', dateTo: '2026-01-05' }),
    /cannot cross an ISO week boundary/
  );
});

test('builds a bounded gateway URL with both update timestamps', () => {
  const context = loadBackfillContext();
  const url = context.buildPaymentsUrl_(
    'client 1',
    '2026-01-01T00:00:00.000Z',
    1,
    '2026-01-05T00:00:00.000Z'
  );

  assert.match(url, /updated_since=2026-01-01T00%3A00%3A00\.000Z/);
  assert.match(url, /updated_before=2026-01-05T00%3A00%3A00\.000Z/);
  assert.match(url, /startposition=1/);
});

test('filters payments strictly inside the requested half-open interval', () => {
  const context = loadBackfillContext();
  const range = context.normalizePaymentSnapshotRange_({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-04'
  });
  const payment = value => ({ MetaData: { LastUpdatedTime: value } });

  assert.equal(context.paymentUpdatedInRange_(payment('2026-01-01T00:00:00.000Z'), range), true);
  assert.equal(context.paymentUpdatedInRange_(payment('2026-01-04T23:59:59.999Z'), range), true);
  assert.equal(context.paymentUpdatedInRange_(payment('2025-12-31T23:59:59.999Z'), range), false);
  assert.equal(context.paymentUpdatedInRange_(payment('2026-01-05T00:00:00.000Z'), range), false);
});

test('runs a controlled dry-run without invoking BigQuery writes', () => {
  const context = loadBackfillContext();
  let bigQueryWriteCalled = false;
  context.replacePaymentSnapshotPartition_ = () => {
    bigQueryWriteCalled = true;
    throw new Error('BigQuery write must not run during the PoC.');
  };
  context.buildPaymentSnapshot_ = (_configuration, options) => ({
    clientCount: 1,
    sourcePaymentCount: 1,
    paymentCount: 1,
    pageCount: 1,
    rows: [{
      DateFrom: options.range.dateFrom,
      DateTo: options.range.dateTo,
      SnapshotWeek: options.range.snapshotWeek,
      SnapshotDate: options.range.snapshotDate,
      UpdatedAt: '2026-01-02T12:00:00.000Z'
    }],
    hierarchyValidation: { status: 'passed', paymentCount: 1 },
    schemaMonitoring: {
      changedCount: 0,
      observedVariationCount: 0,
      baselineMissingCount: 0
    }
  });

  const result = context.executePaymentBackfillPeriod_(
    { dateFrom: '2026-01-01', dateTo: '2026-01-04' },
    { dryRun: true, today: '2026-01-12' }
  );

  assert.equal(result.status, 'validated_dry_run');
  assert.equal(result.paymentCount, 1);
  assert.equal(bigQueryWriteCalled, false);
});

test('fetches a client once and distributes its payments across weekly periods', () => {
  const context = loadBackfillContext();
  let fetchCount = 0;
  context.fetchPayments_ = () => {
    fetchCount++;
    return {
      items: [
        { Id: 'p1', MetaData: { LastUpdatedTime: '2026-01-02T12:00:00.000Z' } },
        { Id: 'p2', MetaData: { LastUpdatedTime: '2026-01-08T12:00:00.000Z' } },
        { Id: 'future', MetaData: { LastUpdatedTime: '2026-01-12T00:00:00.000Z' } }
      ],
      pageCount: 1
    };
  };
  context.normalizePayment_ = (client, range, payment) => ({
    rows: [{
      idempotency_key: client.id + '|' + payment.Id,
      RecordType: 'HEADER',
      RecordOrder: 0,
      ClientId: client.id,
      PaymentId: payment.Id,
      DateFrom: range.dateFrom,
      DateTo: range.dateTo,
      SnapshotWeek: range.snapshotWeek,
      SnapshotDate: range.snapshotDate,
      UpdatedAt: payment.MetaData.LastUpdatedTime,
      Entity: client.entity,
      ClientName: client.name,
      TxnDate: ''
    }]
  });

  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    today: '2026-01-12'
  });
  const snapshot = context.buildPaymentBackfillClientSnapshot_({
    id: 'client-1',
    name: 'Client 1',
    entity: 'client_1'
  }, plan, '2026-01-12T01:00:00.000Z');

  assert.equal(fetchCount, 1);
  assert.equal(snapshot.sourcePaymentCount, 3);
  assert.equal(snapshot.paymentCount, 2);
  assert.equal(snapshot.rows.length, 2);
  assert.deepEqual(
    Object.keys(JSON.parse(JSON.stringify(snapshot.periodPaymentCounts))).sort(),
    ['2026-01-01|2026-01-04', '2026-01-05|2026-01-11']
  );
});

test('rejects a backfill period that reaches today or the future', () => {
  const context = loadBackfillContext();
  assert.throws(
    () => context.executePaymentBackfillPeriod_(
      { dateFrom: '2026-01-05', dateTo: '2026-01-11' },
      { dryRun: true, today: '2026-01-10' }
    ),
    /refuses to process current or future dates/
  );
});

test('rejects snapshot rows whose update timestamp falls outside the period', () => {
  const context = loadBackfillContext();
  const range = context.normalizePaymentSnapshotRange_({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-04'
  });
  assert.throws(
    () => context.validatePaymentBackfillSnapshot_({
      rows: [{
        DateFrom: range.dateFrom,
        DateTo: range.dateTo,
        SnapshotWeek: range.snapshotWeek,
        SnapshotDate: range.snapshotDate,
        UpdatedAt: '2026-01-05T00:00:00.000Z'
      }],
      hierarchyValidation: { paymentCount: 1 }
    }, range),
    /outside the requested update window/
  );
});
