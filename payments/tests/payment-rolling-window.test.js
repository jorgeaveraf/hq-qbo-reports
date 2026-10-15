const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPaymentsContext() {
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) })
    },
    Logger: { log: () => {} }
  });
  const projectDir = path.resolve(__dirname, '..');
  ['1.Config.js', '3.Functions.js', '7.RollingReconciliation.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });
  return context;
}

test('plans exactly the previous 12 completed Monday-to-Sunday weeks', () => {
  const context = loadPaymentsContext();
  const plan = context.getPaymentRollingSnapshotPlan_('2026-10-19');

  assert.equal(plan.strategy, 'rolling_transaction_date');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startDate, '2026-07-27');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.firstPeriod.snapshotWeek, '2026-07-27');
  assert.equal(plan.lastPeriod.snapshotWeek, '2026-10-12');
  assert.equal(plan.lastPeriod.snapshotDate, '2026-10-19');
  assert.equal(plan.periods.length, 12);
  assert.ok(plan.periods.every(period => {
    const from = new Date(period.dateFrom + 'T00:00:00.000Z');
    const to = new Date(period.dateTo + 'T00:00:00.000Z');
    return from.getUTCDay() === 1 && to.getUTCDay() === 0;
  }));
});

test('exposes the rolling plan without fetching data or writing state', () => {
  const context = loadPaymentsContext();
  let externalCallCount = 0;
  context.fetchPayments_ = () => { externalCallCount++; };
  context.runBigQueryQuery_ = () => { externalCallCount++; };
  context.PropertiesService = {
    getScriptProperties: () => ({ setProperty: () => { externalCallCount++; } })
  };

  const plan = context.getPaymentRollingSnapshotPlan('2026-10-19');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startDate, '2026-07-27');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(externalCallCount, 0);
});

test('fetches each client once and distributes late corrections into canonical weeks', () => {
  const context = loadPaymentsContext();
  const plan = context.getPaymentRollingSnapshotPlan_('2026-10-19');
  let fetchCount = 0;
  let receivedFilters = null;
  context.fetchPayments_ = (_clientId, filters) => {
    fetchCount++;
    receivedFilters = filters;
    return {
      items: [
        { Id: 'late', TxnDate: '2026-08-04' },
        { Id: 'voided', TxnDate: '2026-10-15' }
      ],
      pageCount: 1
    };
  };
  context.normalizePayment_ = (client, period, payment) => ({
    rows: [{
      idempotency_key: client.id + '|' + payment.Id,
      RecordType: 'HEADER',
      RecordOrder: 0,
      ClientId: client.id,
      PaymentId: payment.Id,
      TxnDate: payment.TxnDate,
      SnapshotWeek: period.snapshotWeek,
      SnapshotDate: period.snapshotDate,
      DateFrom: period.dateFrom,
      DateTo: period.dateTo
    }]
  });
  context.buildPaymentSchemaProfile_ = () => ({ fields: {} });
  context.loadPaymentSchemaProfile_ = () => ({ fields: {} });
  context.comparePaymentSchemaProfiles_ = () => ({
    status: 'unchanged', newPaths: [], missingPaths: [], typeChanges: []
  });

  const result = context.buildPaymentRollingClientSnapshot_(
    { id: 'client-1', name: 'Client 1', entityAlias: 'client_1' },
    plan,
    '2026-10-19T06:00:00.000Z'
  );

  assert.equal(fetchCount, 1);
  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedFilters)),
    { dateFrom: '2026-07-27', dateTo: '2026-10-18' }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.rows.map(row => [row.PaymentId, row.SnapshotWeek]))),
    [['late', '2026-08-03'], ['voided', '2026-10-12']]
  );
});

test('replaces only the planned weeks and successful clients in one transaction', () => {
  const context = loadPaymentsContext();
  const plan = context.getPaymentRollingSnapshotPlan_('2026-10-19');
  let query = '';
  let removedTable = '';
  context.validatePaymentBigQueryRow_ = () => {};
  context.validatePaymentSnapshotHierarchy_ = rows => ({
    status: 'passed',
    rowCount: rows.length,
    paymentCount: rows.length,
    headerRowCount: rows.length,
    lineRowCount: 0,
    uniqueIdempotencyKeyCount: rows.length
  });
  context.BigQuery = {
    Jobs: { insert: request => ({ jobReference: request.jobReference }) },
    Tables: { remove: (_project, _dataset, tableId) => { removedTable = tableId; } }
  };
  context.waitForBigQueryJob_ = jobReference => ({
    jobReference,
    status: { state: 'DONE' }
  });
  context.runBigQueryQuery_ = sql => {
    query = sql;
    return { jobReference: { jobId: 'rolling-transaction-job' } };
  };
  const row = {
    ClientId: 'client-a',
    SnapshotWeek: '2026-10-12',
    SnapshotDate: '2026-10-19',
    DateFrom: '2026-10-12',
    DateTo: '2026-10-18',
    TxnDate: '2026-10-15'
  };

  const result = context.replacePaymentSnapshotRangeClients_(
    plan,
    [row],
    ['client-a']
  );

  assert.equal(result.mode, 'rolling_successful_clients_replace');
  assert.match(query, /^BEGIN TRANSACTION;/);
  assert.match(query, /SnapshotWeek IN \(DATE '2026-07-27'/);
  assert.match(query, /DATE '2026-10-12'\)/);
  assert.match(query, /ClientId IN \('client-a'\)/);
  assert.doesNotMatch(query, /client-b/);
  assert.doesNotMatch(query, /2026-07-20/);
  assert.match(query, /COMMIT TRANSACTION;/);
  assert.equal(removedTable, 'payment_rolling_stage_12345678123412341234123456789abc');
});

test('rejects rows outside the rolling plan before any BigQuery write', () => {
  const context = loadPaymentsContext();
  const plan = context.getPaymentRollingSnapshotPlan_('2026-10-19');
  let writeCalled = false;
  context.validatePaymentBigQueryRow_ = () => {};
  context.BigQuery = { Jobs: { insert: () => { writeCalled = true; } } };

  assert.throws(
    () => context.replacePaymentSnapshotRangeClients_(plan, [{
      ClientId: 'client-a',
      SnapshotWeek: '2026-07-20',
      SnapshotDate: '2026-07-27',
      DateFrom: '2026-07-20',
      DateTo: '2026-07-26',
      TxnDate: '2026-07-21'
    }], ['client-a']),
    /outside the rolling plan/
  );
  assert.equal(writeCalled, false);
});

test('does not refresh Connected Sheets when snapshot validation fails', () => {
  const context = loadPaymentsContext();
  let refreshCount = 0;
  let released = false;
  context.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { released = true; }
    })
  };
  context.assertPaymentBackfillIdle_ = () => {};
  context.executePaymentBigQuerySnapshot_ = () => {
    throw new Error('rolling validation failed');
  };
  context.verifyPaymentConsumptionViews_ = () => ({ status: 'passed' });
  context.refreshPaymentConnectedSheetsPipeline_ = () => {
    refreshCount++;
  };

  assert.throws(
    () => context.snapshotPaymentsToBigQuery(),
    /rolling validation failed/
  );
  assert.equal(refreshCount, 0);
  assert.equal(released, true);
});

test('refreshes Connected Sheets once after a successful rolling snapshot', () => {
  const context = loadPaymentsContext();
  let refreshCount = 0;
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
  };
  context.assertPaymentBackfillIdle_ = () => {};
  context.executePaymentBigQuerySnapshot_ = () => ({ status: 'completed' });
  context.verifyPaymentConsumptionViews_ = () => ({ status: 'passed' });
  context.refreshPaymentConnectedSheetsPipeline_ = () => {
    refreshCount++;
    return { status: 'passed' };
  };

  const result = context.snapshotPaymentsToBigQuery();
  assert.equal(refreshCount, 1);
  assert.equal(result.connectedSheets.status, 'passed');
});

test('does not refresh Connected Sheets when the consumption view validation fails', () => {
  const context = loadPaymentsContext();
  let refreshCount = 0;
  let released = false;
  context.LockService = {
    getScriptLock: () => ({ tryLock: () => true, releaseLock: () => { released = true; } })
  };
  context.assertPaymentBackfillIdle_ = () => {};
  context.executePaymentBigQuerySnapshot_ = () => ({ status: 'completed' });
  context.verifyPaymentConsumptionViews_ = () => {
    throw new Error('Payments consumption view validation failed');
  };
  context.refreshPaymentConnectedSheetsPipeline_ = () => {
    refreshCount++;
    return { status: 'passed' };
  };

  assert.throws(
    () => context.snapshotPaymentsToBigQuery(),
    /Payments consumption view validation failed/
  );
  assert.equal(refreshCount, 0);
  assert.equal(released, true);
});
