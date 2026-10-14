const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadInvoicesContext() {
  const context = vm.createContext({
    Session: { getScriptTimeZone: () => 'America/Mexico_City' },
    Utilities: {
      formatDate: date => new Date(date).toISOString().slice(0, 10),
      getUuid: () => '12345678-1234-1234-1234-123456789abc',
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(String(value))) }),
      sleep: () => {}
    },
    Logger: { log: () => {} }
  });
  const root = path.resolve(__dirname, '..');
  ['invoices/1.Config.js', 'invoices/3.Functions.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  });
  return context;
}

test('plans the previous 12 completed Monday-to-Sunday invoice weeks', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  assert.equal(plan.strategy, 'rolling_transaction_date');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startDate, '2026-07-27');
  assert.equal(plan.horizonDate, '2026-10-18');
  assert.equal(plan.firstPeriod.snapshotWeek, '2026-07-27');
  assert.equal(plan.lastPeriod.snapshotWeek, '2026-10-12');
  assert.equal(plan.lastPeriod.snapshotDate, '2026-10-19');
  assert.equal(plan.periods.length, 12);
});

test('public invoice rolling planner is read-only', () => {
  const context = loadInvoicesContext();
  let externalCalls = 0;
  context.fetchInvoices_ = () => { externalCalls++; };
  context.runBigQuerySingleRowQuery_ = () => { externalCalls++; };
  const plan = context.getInvoiceRollingSnapshotPlan('2026-10-19');
  assert.equal(plan.weekCount, 12);
  assert.equal(plan.startDate, '2026-07-27');
  assert.equal(externalCalls, 0);
});

test('paginates a 12-week invoice fetch without truncating a full entity result', () => {
  const context = loadInvoicesContext();
  const urls = [];
  context.fetchJsonOrThrow_ = url => {
    urls.push(url);
    if (urls.length === 1) {
      return { items: [{ Id: '1' }], next_startposition: 1001, latency_ms: 10, refreshed: true };
    }
    return { items: [{ Id: '2' }], next_startposition: null, latency_ms: 8, refreshed: false };
  };
  const result = context.fetchInvoices_('client-1', '2026-07-27', '2026-10-18');
  assert.equal(result.invoiceCount, 2);
  assert.equal(result.pageCount, 2);
  assert.match(urls[0], /startposition=1/);
  assert.match(urls[1], /startposition=1001/);
});

test('infers the next invoice page when a full gateway page omits pagination metadata', () => {
  const context = loadInvoicesContext();
  const urls = [];
  context.fetchJsonOrThrow_ = url => {
    urls.push(url);
    if (urls.length === 1) {
      return { items: Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1) })) };
    }
    return { items: [{ Id: '1001' }] };
  };
  const result = context.fetchInvoices_('client-1', '2026-07-27', '2026-10-18');
  assert.equal(result.invoiceCount, 1001);
  assert.equal(result.pageCount, 2);
  assert.match(urls[1], /startposition=1001/);
  assert.equal(result.pages[0].nextStartPositionSource, 'inferred_full_page');
  assert.equal(result.pages[1].nextStartPositionSource, 'short_page');
});

test('fails closed when the gateway repeats a full invoice page while ignoring startposition', () => {
  const context = loadInvoicesContext();
  const repeatedPage = Array.from({ length: 1000 }, (_, index) => ({ Id: String(index + 1), SyncToken: '0' }));
  context.fetchJsonOrThrow_ = () => ({ items: repeatedPage });
  assert.throws(
    () => context.fetchInvoices_('client-1', '2026-07-27', '2026-10-18'),
    /repeated the same page/
  );
});

test('fetches a client once and assigns invoices to canonical TxnDate weeks', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  let fetchCount = 0;
  let receivedRange = null;
  context.fetchInvoices_ = (_clientId, dateFrom, dateTo) => {
    fetchCount++;
    receivedRange = { dateFrom, dateTo };
    return { items: [
      { Id: 'old-edit', TxnDate: '2026-08-04' },
      { Id: 'recent', TxnDate: '2026-10-15' }
    ] };
  };
  context.normalizeInvoices_ = (client, period, response) => ({
    rows: [{
      idempotency_key: 'a'.repeat(64), RecordType: 'HEADER', RecordOrder: 0,
      ClientId: client.id, InvoiceId: response.items[0].Id,
      TxnDate: response.items[0].TxnDate, SnapshotWeek: period.snapshotWeek,
      SnapshotDate: period.snapshotDate, DateFrom: period.dateFrom, DateTo: period.dateTo
    }],
    diagnostics: context.createInvoiceSourceDiagnostics_()
  });
  context.validateInvoiceSnapshotHierarchy_ = rows => ({
    status: 'passed', rowCount: rows.length, invoiceCount: rows.length,
    headerRowCount: rows.length, lineRowCount: 0, uniqueIdempotencyKeyCount: rows.length
  });
  context.prepareInvoiceSchemaBaseline_ = () => ({
    check: { status: 'unchanged' }, update: null
  });
  const result = context.buildInvoiceRollingClientSnapshot_(
    { id: 'client-1', name: 'Client 1', entityAlias: 'client_1' },
    plan,
    '2026-10-19T06:00:00.000Z'
  );
  assert.equal(fetchCount, 1);
  assert.deepEqual(receivedRange, { dateFrom: '2026-07-27', dateTo: '2026-10-18' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.rows.map(row => [row.InvoiceId, row.SnapshotWeek]))),
    [['old-edit', '2026-08-03'], ['recent', '2026-10-12']]
  );
});

test('classifies QBO voided invoices from PrivateNote without hiding them from raw normalization', () => {
  const context = loadInvoicesContext();
  const diagnostics = context.createInvoiceSourceDiagnostics_();
  const header = context.buildInvoiceHeaderContext_(
    { id: 'client-1', name: 'Client 1', entityAlias: 'client_1' },
    {
      snapshotWeek: '2026-10-12', snapshotDate: '2026-10-19',
      dateFrom: '2026-10-12', dateTo: '2026-10-18'
    },
    {
      Id: 'invoice-voided', TxnDate: '2026-10-15',
      PrivateNote: 'Voided - corrected in QBO', TotalAmt: 0, Balance: 0
    },
    '2026-10-19T06:00:00.000Z', diagnostics, 'test'
  );
  assert.equal(header.PrivateNote, 'Voided - corrected in QBO');
  assert.equal(header.IsVoided, true);
  assert.equal(context.invoiceIsVoided_('customer requested correction'), false);
});

test('rolling replacement touches only planned weeks and successful clients', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  let query = '';
  let removedTable = '';
  context.validateInvoiceBigQueryRow_ = () => {};
  context.validateInvoiceSnapshotHierarchy_ = rows => ({
    status: 'passed', rowCount: rows.length, invoiceCount: rows.length,
    headerRowCount: rows.length, lineRowCount: 0, uniqueIdempotencyKeyCount: rows.length
  });
  context.BigQuery = {
    Jobs: { insert: request => ({ jobReference: request.jobReference }) },
    Tables: { remove: (_project, _dataset, tableId) => { removedTable = tableId; } }
  };
  context.waitForBigQueryJob_ = jobReference => ({ jobReference, status: { state: 'DONE' } });
  context.runBigQuerySingleRowQuery_ = sql => {
    query = sql;
    return { jobReference: { jobId: 'invoice-rolling-transaction' } };
  };
  const row = {
    ClientId: 'missing-client', InvoiceId: 'invoice-1', RecordType: 'HEADER', RecordOrder: 0,
    SnapshotWeek: '2026-10-12', SnapshotDate: '2026-10-19',
    DateFrom: '2026-10-12', DateTo: '2026-10-18', TxnDate: '2026-10-15'
  };
  const result = context.replaceInvoiceSnapshotRangeClients_(plan, [row], ['missing-client']);
  assert.equal(result.mode, 'rolling_successful_clients_replace');
  assert.match(query, /^BEGIN TRANSACTION;/);
  assert.match(query, /SnapshotWeek IN \(DATE '2026-07-27'/);
  assert.match(query, /DATE '2026-10-12'\)/);
  assert.match(query, /ClientId IN \('missing-client'\)/);
  assert.doesNotMatch(query, /existing-client/);
  assert.doesNotMatch(query, /2026-07-20/);
  assert.match(query, /COMMIT TRANSACTION;/);
  assert.equal(removedTable, 'invoice_rolling_stage_12345678123412341234123456789abc');
  assert.equal(result.stagingChunkCount, 1);
});

test('rolling staging load splits a large payload into ordered truncate and append jobs', () => {
  const context = loadInvoicesContext();
  const requests = [];
  context.BigQuery = {
    Jobs: { insert: (request, _projectId, blob) => {
      requests.push({ request, bytes: blob.getBytes().length });
      return { jobReference: request.jobReference };
    }}
  };
  context.waitForBigQueryJob_ = jobReference => ({ jobReference, status: { state: 'DONE' } });
  const rows = Array.from({ length: 8 }, (_, index) => ({
    idempotency_key: String(index), Description: 'á'.repeat(90), InvoiceId: 'invoice-' + index
  }));
  const jobs = context.loadInvoiceRollingStagingChunks_(rows, 'stage_table', 'token', 1024);
  assert.ok(jobs.length > 1);
  assert.equal(requests[0].request.configuration.load.writeDisposition, 'WRITE_TRUNCATE');
  requests.slice(1).forEach(({ request }) => {
    assert.equal(request.configuration.load.writeDisposition, 'WRITE_APPEND');
    assert.equal(request.configuration.load.createDisposition, 'CREATE_NEVER');
  });
  requests.forEach(({ bytes }) => assert.ok(bytes <= 1024));
  assert.equal(jobs.reduce((total, job) => total + job.rowCount, 0), rows.length);
});

test('rolling validation accepts invoice line rows without a duplicated TxnDate', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  const period = plan.lastPeriod;
  const base = {
    ClientId: 'client-1', ClientName: 'Client 1', Entity: 'client_1', InvoiceId: 'invoice-1',
    SnapshotWeek: period.snapshotWeek, SnapshotDate: period.snapshotDate,
    DateFrom: period.dateFrom, DateTo: period.dateTo
  };
  const rows = [
    {
      ...base, idempotency_key: 'a'.repeat(64), RecordType: 'HEADER', RecordOrder: 0,
      TxnDate: period.dateFrom
    },
    {
      ...base, idempotency_key: 'b'.repeat(64), RecordType: 'LINE', RecordOrder: 1,
      LineId: 'line-1', LineType: 'SalesItemLineDetail', TxnDate: null
    }
  ];
  context.validateInvoiceBigQueryRow_ = () => {};
  const result = context.validateInvoiceRollingSnapshotRows_(plan, rows, ['client-1']);
  assert.equal(result.status, 'passed');
  assert.equal(result.headerRowCount, 1);
  assert.equal(result.lineRowCount, 1);
});

test('rolling validation still rejects a header whose TxnDate is outside its canonical week', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  const period = plan.lastPeriod;
  const rows = [{
    idempotency_key: 'a'.repeat(64), RecordType: 'HEADER', RecordOrder: 0,
    ClientId: 'client-1', InvoiceId: 'invoice-1', SnapshotWeek: period.snapshotWeek,
    SnapshotDate: period.snapshotDate, DateFrom: period.dateFrom, DateTo: period.dateTo,
    TxnDate: '2026-01-01'
  }];
  context.validateInvoiceBigQueryRow_ = () => {};
  assert.throws(
    () => context.validateInvoiceRollingSnapshotRows_(plan, rows, ['client-1']),
    /non-canonical period dates/
  );
});

test('an empty successful client removes stale invoices without creating a staging table', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  let query = '';
  let inserted = false;
  context.validateInvoiceSnapshotHierarchy_ = () => ({
    status: 'passed', rowCount: 0, invoiceCount: 0,
    headerRowCount: 0, lineRowCount: 0, uniqueIdempotencyKeyCount: 0
  });
  context.BigQuery = {
    Jobs: { insert: () => { inserted = true; } },
    Tables: { remove: () => {} }
  };
  context.runBigQuerySingleRowQuery_ = sql => { query = sql; return {}; };
  const result = context.replaceInvoiceSnapshotRangeClients_(plan, [], ['client-with-no-invoices']);
  assert.equal(inserted, false);
  assert.match(query, /ClientId IN \('client-with-no-invoices'\)/);
  assert.doesNotMatch(query, /INSERT INTO/);
  assert.equal(result.rowCount, 0);
  assert.equal(result.state, 'DONE');
});

test('rejects invoice rows outside the rolling plan before writing', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  let writeCalled = false;
  context.validateInvoiceBigQueryRow_ = () => {};
  context.BigQuery = { Jobs: { insert: () => { writeCalled = true; } } };
  assert.throws(() => context.replaceInvoiceSnapshotRangeClients_(plan, [{
    ClientId: 'client-a', InvoiceId: 'invoice-a', RecordType: 'HEADER', RecordOrder: 0,
    SnapshotWeek: '2026-07-20', SnapshotDate: '2026-07-27',
    DateFrom: '2026-07-20', DateTo: '2026-07-26', TxnDate: '2026-07-21'
  }], ['client-a']), /outside the rolling plan/);
  assert.equal(writeCalled, false);
});

test('does not refresh Connected Sheets when rolling validation fails', () => {
  const context = loadInvoicesContext();
  let refreshCount = 0;
  let released = false;
  context.LockService = { getScriptLock: () => ({
    tryLock: () => true, releaseLock: () => { released = true; }
  }) };
  context.executeInvoiceRollingBigQuerySnapshot_ = () => {
    throw new Error('invoice rolling validation failed');
  };
  context.refreshInvoiceConnectedSheetsPipeline_ = () => { refreshCount++; };
  assert.throws(() => context.snapshotInvoicesToBigQuery(), /rolling validation failed/);
  assert.equal(refreshCount, 0);
  assert.equal(released, true);
});

test('refreshes Connected Sheets once after successful rolling validation', () => {
  const context = loadInvoicesContext();
  let refreshCount = 0;
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.executeInvoiceRollingBigQuerySnapshot_ = () => ({ status: 'completed' });
  context.verifyInvoiceConsumptionViews_ = () => ({ status: 'passed' });
  context.refreshInvoiceConnectedSheetsPipeline_ = () => {
    refreshCount++;
    return { status: 'passed' };
  };
  const result = context.snapshotInvoicesToBigQuery();
  assert.equal(refreshCount, 1);
  assert.equal(result.connectedSheets.status, 'passed');
  assert.equal(result.consumptionViews.status, 'passed');
});

test('does not refresh Connected Sheets when consumption-view validation fails', () => {
  const context = loadInvoicesContext();
  let refreshCount = 0;
  context.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
  context.executeInvoiceRollingBigQuerySnapshot_ = () => ({ status: 'completed' });
  context.verifyInvoiceConsumptionViews_ = () => {
    throw new Error('Invoice consumption view validation failed');
  };
  context.refreshInvoiceConnectedSheetsPipeline_ = () => { refreshCount++; };
  assert.throws(() => context.snapshotInvoicesToBigQuery(), /consumption view validation failed/);
  assert.equal(refreshCount, 0);
});

test('final validation rejects cross-week duplicate invoice identities and fingerprint drift', () => {
  const context = loadInvoicesContext();
  const plan = context.getInvoiceRollingSnapshotPlan_('2026-10-19');
  context.validateInvoiceRollingSnapshotRows_ = () => ({
    successfulClientCount: 1, rowCount: 0, invoiceCount: 0
  });
  context.validateInvoiceSnapshotHierarchy_ = () => ({
    rowCount: 0, invoiceCount: 0, headerRowCount: 0,
    lineRowCount: 0, uniqueIdempotencyKeyCount: 0
  });
  context.verifyInvoiceSnapshotPartition_ = () => ({ status: 'passed' });
  context.runBigQuerySingleRowQuery_ = () => ({
    noncanonical_row_count: 0,
    duplicate_invoice_week_count: 1
  });
  context.readInvoiceOutsideWindowFingerprint_ = () => ({
    rowCount: 10, distinctKeyCount: 10, rowFingerprint: '123'
  });
  assert.throws(() => context.verifyInvoiceRollingSnapshot_(
    plan, [], ['client-a'], { rowCount: 10, distinctKeyCount: 10, rowFingerprint: '123' }
  ), /final validation failed/);

  context.runBigQuerySingleRowQuery_ = () => ({
    noncanonical_row_count: 0,
    duplicate_invoice_week_count: 0
  });
  context.readInvoiceOutsideWindowFingerprint_ = () => ({
    rowCount: 11, distinctKeyCount: 11, rowFingerprint: '456'
  });
  assert.throws(() => context.verifyInvoiceRollingSnapshot_(
    plan, [], ['client-a'], { rowCount: 10, distinctKeyCount: 10, rowFingerprint: '123' }
  ), /modified data outside/);
});
