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

test('clamps a requested future end date to the last completed ISO week', () => {
  const context = loadBackfillContext();
  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    today: '2026-08-19'
  });

  assert.equal(plan.horizonDate, '2026-08-16');
  assert.equal(plan.periodCount, 33);
  assert.equal(plan.lastPeriod.dateFrom, '2026-08-10');
  assert.equal(plan.lastPeriod.dateTo, '2026-08-16');
  assert.ok(plan.periods.every(period => period.dateTo <= '2026-08-16'));
});

test('starts the September incident backfill with only the affected range', () => {
  const context = loadBackfillContext();
  let receivedOptions = null;
  context.queuePaymentBackfill_ = options => {
    receivedOptions = options;
    return { status: 'queued' };
  };

  const result = context.startPaymentSeptemberIncidentBackfill();

  assert.equal(result.status, 'queued');
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedOptions)),
    { startDate: '2026-09-07', endDate: '2026-09-20' }
  );
});

test('uses the actual accumulated extract sheet name', () => {
  const context = loadBackfillContext();
  const extractSheets = vm.runInContext(
    'JSON.stringify(PAYMENT_CONNECTED_SHEETS_CONFIG.extractSheets)',
    context
  );

  assert.deepEqual(JSON.parse(extractSheets), ['Weekly Payments', 'Payment Latest']);
});

test('resumes a failed backfill at its current stage and resets stage attempts', () => {
  const context = loadBackfillContext();
  const current = {
    strategy: 'transaction_date_v2',
    status: 'failed',
    current_stage: 'extracts',
    start_date: '2026-09-07',
    horizon_date: '2026-09-20',
    current_period_attempts: 0,
    processed_client_count: 16,
    total_client_count: 16,
    stages: {
      bigquery: { status: 'completed', attempts: 16 },
      data_source_sheets: { status: 'completed', attempts: 1 },
      extracts: { status: 'failed', attempts: 3 }
    }
  };
  let persisted = null;
  let scheduledDelay = null;

  context.assertPaymentDeploymentIdleForBackfill_ = () => {};
  context.planPaymentBackfill_ = () => ({
    startDate: '2026-09-07',
    horizonDate: '2026-09-20',
    periodCount: 2
  });
  context.validatePaymentBackfillConnectedSheetsPreflight_ = () => ({ status: 'passed' });
  context.loadPaymentEntityConfiguration_ = () => ({
    configuration: {
      configuration_version: 26,
      configuration_hash: 'hash'
    }
  });
  context.fetchClients_ = () => ({
    client_1: {
      id: 'client_1',
      name: 'Client 1',
      entity: 'client_1',
      entityAlias: 'client_1'
    }
  });
  context.readPaymentBackfillState_ = () => current;
  context.persistPaymentBackfillState_ = state => {
    persisted = JSON.parse(JSON.stringify(state));
  };
  context.replacePaymentBackfillWorkerSchedule_ = delay => {
    scheduledDelay = delay;
  };

  const result = context.queuePaymentBackfill_({
    startDate: '2026-09-07',
    endDate: '2026-09-20'
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.currentStage, 'extracts');
  assert.equal(persisted.processed_client_count, 16);
  assert.equal(persisted.stages.bigquery.status, 'completed');
  assert.equal(persisted.stages.extracts.status, 'pending');
  assert.equal(persisted.stages.extracts.attempts, 0);
  assert.equal(
    scheduledDelay,
    vm.runInContext('PAYMENT_BACKFILL_CONFIG.initialDelayMs', context)
  );
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

test('builds a bounded gateway URL with transaction dates supported by QBO Gateway', () => {
  const context = loadBackfillContext();
  const url = context.buildPaymentsUrl_(
    'client 1',
    { dateFrom: '2026-01-01', dateTo: '2026-01-04' },
    1
  );

  assert.match(url, /date_from=2026-01-01/);
  assert.match(url, /date_to=2026-01-04/);
  assert.doesNotMatch(url, /updated_since|updated_before/);
  assert.match(url, /startposition=1/);
});

test('retains bounded update timestamp support for compatibility', () => {
  const context = loadBackfillContext();
  const url = context.buildPaymentsUrl_(
    'client 1',
    {
      updatedSince: '2026-01-01T00:00:00.000Z',
      updatedBefore: '2026-01-05T00:00:00.000Z'
    },
    1
  );

  assert.match(url, /updated_since=2026-01-01T00%3A00%3A00\.000Z/);
  assert.match(url, /updated_before=2026-01-05T00%3A00%3A00\.000Z/);
  assert.doesNotMatch(url, /date_from|date_to/);
});

test('filters payments by inclusive transaction-date boundaries', () => {
  const context = loadBackfillContext();
  const range = context.normalizePaymentSnapshotRange_({
    dateFrom: '2026-01-01',
    dateTo: '2026-01-04'
  });
  const payment = value => ({ TxnDate: value });

  assert.equal(context.paymentTxnDateInRange_(payment('2026-01-01'), range), true);
  assert.equal(context.paymentTxnDateInRange_(payment('2026-01-04'), range), true);
  assert.equal(context.paymentTxnDateInRange_(payment('2025-12-31'), range), false);
  assert.equal(context.paymentTxnDateInRange_(payment('2026-01-05'), range), false);
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
      TxnDate: '2026-01-02',
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

test('fetches a client once by TxnDate and distributes payments across collection weeks', () => {
  const context = loadBackfillContext();
  let fetchCount = 0;
  let receivedFilters = null;
  context.fetchPayments_ = (_clientId, filters) => {
    fetchCount++;
    receivedFilters = filters;
    return {
      items: [
        { Id: 'p1', TxnDate: '2026-01-02', MetaData: { LastUpdatedTime: '2026-07-02T12:00:00.000Z' } },
        { Id: 'p2', TxnDate: '2026-01-08', MetaData: { LastUpdatedTime: '2026-08-08T12:00:00.000Z' } }
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
      TxnDate: payment.TxnDate,
      UpdatedAt: payment.MetaData.LastUpdatedTime,
      Entity: client.entity,
      ClientName: client.name
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
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedFilters)),
    { dateFrom: '2026-01-01', dateTo: '2026-01-11' }
  );
  assert.equal(snapshot.sourcePaymentCount, 2);
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

test('rejects snapshot rows whose transaction date falls outside the period', () => {
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
        TxnDate: '2026-01-05'
      }],
      hierarchyValidation: { paymentCount: 1 }
    }, range),
    /outside the requested transaction-date window/
  );
});

test('rejects a gateway payment outside the requested TxnDate plan', () => {
  const context = loadBackfillContext();
  context.fetchPayments_ = () => ({
    items: [{ Id: 'outside', TxnDate: '2025-12-31' }],
    pageCount: 1
  });
  const plan = context.planPaymentBackfill_({
    startDate: '2026-01-01',
    today: '2026-01-12'
  });
  assert.throws(
    () => context.buildPaymentBackfillClientSnapshot_({
      id: 'client-1',
      name: 'Client 1',
      entity: 'client_1'
    }, plan, '2026-01-12T01:00:00.000Z'),
    /outside the requested range/
  );
});

test('builds a Nova Farms PoC across only its authorized clients without writes', () => {
  const context = loadBackfillContext();
  context.loadPaymentEntityConfiguration_ = () => ({
    source: 'test',
    configuration: {}
  });
  context.fetchClients_ = () => ({
    ma: { id: 'ma', name: 'nova_farms_massachusetts', entityAlias: 'nova_farms' },
    nj: { id: 'nj', name: 'nova_farms_new_jersey', entityAlias: 'nova_farms' },
    other: { id: 'other', name: 'other_client', entityAlias: 'other' }
  });
  context.buildPaymentBackfillClientSnapshot_ = client => ({
    sourcePaymentCount: client.id === 'ma' ? 2 : 1,
    paymentCount: client.id === 'ma' ? 2 : 1,
    pageCount: 1,
    rows: [{ RecordType: 'HEADER', TotalAmount: client.id === 'ma' ? 20 : 10 }],
    periodPaymentCounts: { '2026-01-05|2026-01-11': 1 },
    hierarchyValidation: { status: 'passed' },
    rangeValidation: { status: 'passed', periodCountWithData: 1 }
  });

  const result = context.buildPaymentEntityBackfillPoc_('nova_farms', {
    startDate: '2026-01-01',
    today: '2026-01-12'
  });

  assert.equal(result.status, 'validated_dry_run');
  assert.equal(result.strategy, 'transaction_date_v2');
  assert.equal(result.modifiesBigQuery, false);
  assert.equal(result.clientCount, 2);
  assert.equal(result.paymentCount, 3);
  assert.equal(result.totalAmount, 30);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.clients.map(client => client.clientName))),
    ['nova_farms_massachusetts', 'nova_farms_new_jersey']
  );
});

test('scopes the backfill delete to one client and the completed TxnDate horizon', () => {
  const context = loadBackfillContext();
  let insertedRequest = null;
  context.BigQuery = {
    Jobs: {
      get: () => {
        throw new Error('404 not found');
      },
      insert: request => {
        insertedRequest = request;
        return {
          jobReference: {
            projectId: 'test-project',
            jobId: 'delete-job'
          }
        };
      }
    }
  };
  context.waitForBigQueryJob_ = jobReference => ({
    jobReference,
    status: { state: 'DONE' }
  });

  context.ensurePaymentBackfillDeleteJob_('delete-job', "client'1", {
    startDate: '2026-01-01',
    horizonDate: '2026-01-11',
    today: '2026-01-12'
  });

  const query = insertedRequest.configuration.query.query;
  assert.match(query, /WHERE ClientId = 'client\\'1'/);
  assert.match(query, /TxnDate >= DATE '2026-01-01'/);
  assert.match(query, /TxnDate <= DATE '2026-01-11'/);
  assert.doesNotMatch(query, /2026-01-12/);
  assert.equal(insertedRequest.configuration.query.useLegacySql, false);
});

test('verifies only the client TxnDate range and its ISO-week assignment', () => {
  const context = loadBackfillContext();
  let verificationQuery = null;
  context.runBigQueryQuery_ = query => {
    verificationQuery = query;
    return {
      rows: [{
        f: [
          { v: '12' },
          { v: '3' },
          { v: '3' },
          { v: '0' }
        ]
      }]
    };
  };

  const result = context.verifyPaymentBackfillClient_('client-1', {
    startDate: '2026-01-01',
    horizonDate: '2026-01-11',
    today: '2026-01-12'
  }, {
    rowCount: 12,
    paymentCount: 3
  });

  assert.equal(result.status, 'passed');
  assert.match(verificationQuery, /WHERE ClientId = 'client-1'/);
  assert.match(verificationQuery, /TxnDate >= DATE '2026-01-01'/);
  assert.match(verificationQuery, /TxnDate <= DATE '2026-01-11'/);
  assert.match(
    verificationQuery,
    /SnapshotWeek != DATE_TRUNC\(TxnDate, WEEK\(MONDAY\)\)/
  );
  assert.doesNotMatch(verificationQuery, /2026-01-12/);
});
