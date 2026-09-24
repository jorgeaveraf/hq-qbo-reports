const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadPaymentsContext() {
  const context = vm.createContext({});
  const projectDir = path.resolve(__dirname, '..');

  ['1.Config.js', '3.Functions.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });

  return context;
}

function installSnapshotAssemblyStubs(context, calls) {
  context.Logger = { log: () => {} };
  context.normalizePaymentSnapshotRange_ = () => ({
    snapshotWeek: '2026-09-14',
    updatedSince: '2026-09-14T00:00:00.000Z',
    updatedThroughExclusive: '2026-09-21T00:00:00.000Z'
  });
  context.loadPaymentEntityConfiguration_ = () => ({
    source: 'test',
    configuration: {
      report_key: 'payments',
      configuration_version: 1,
      configuration_hash: 'hash',
      published_at: '2026-09-01T00:00:00.000Z',
      entities: [{}, {}, {}]
    }
  });
  context.fetchClients_ = () => ({
    a: { id: 'a', name: 'Alpha', entityAlias: 'alpha' },
    b: { id: 'b', name: 'Broken', entityAlias: 'broken' },
    c: { id: 'c', name: 'Charlie', entityAlias: 'charlie' }
  });
  context.buildPaymentClientSnapshot_ = client => {
    calls.push(client.id);
    if (client.id === 'b') {
      throw new Error('/qbo/b/payments page 1 returned HTTP 401 after 1 attempt(s).');
    }
    return {
      sourcePaymentCount: 1,
      paymentCount: 1,
      pageCount: 1,
      rows: [{ ClientId: client.id }],
      baselineUpdate: null,
      clientCheck: { status: 'unchanged' },
      schemaStatus: 'unchanged'
    };
  };
  context.sortPaymentRows_ = () => {};
  context.validatePaymentSnapshotHierarchy_ = rows => ({
    status: 'passed',
    rowCount: rows.length,
    paymentCount: rows.length,
    headerRowCount: rows.length,
    lineRowCount: 0,
    uniqueIdempotencyKeyCount: rows.length
  });
}

test('continues with later entities after a client-specific 401', () => {
  const context = loadPaymentsContext();
  const calls = [];
  installSnapshotAssemblyStubs(context, calls);

  const result = context.buildPaymentSnapshot_(null, {
    continueOnClientError: true,
    persistSchemaBaselines: false
  });

  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(result.successfulClientIds), ['a', 'c']);
  assert.equal(result.clientFailures.length, 1);
  assert.equal(result.clientFailures[0].clientId, 'b');
  assert.equal(result.clientFailures[0].httpStatus, 401);
  assert.equal(result.clientFailures[0].retryable, false);
  assert.deepEqual(Array.from(result.rows, row => row.ClientId), ['a', 'c']);
});

test('keeps fail-fast behavior unless entity isolation is explicitly enabled', () => {
  const context = loadPaymentsContext();
  const calls = [];
  installSnapshotAssemblyStubs(context, calls);

  assert.throws(
    () => context.buildPaymentSnapshot_(null, { persistSchemaBaselines: false }),
    /HTTP 401/
  );
  assert.deepEqual(calls, ['a', 'b']);
});

test('scheduled client snapshots fetch by TxnDate without bypassing isolation helpers', () => {
  const context = loadPaymentsContext();
  let receivedFilters = null;
  context.Logger = { log: () => {} };
  context.normalizeDateForOutput_ = value => String(value || '').slice(0, 10);
  context.fetchPayments_ = (_clientId, filters) => {
    receivedFilters = filters;
    return {
      items: [{ Id: 'payment-1', TxnDate: '2026-09-16' }],
      pageCount: 1
    };
  };
  context.buildPaymentSchemaProfile_ = () => ({ paths: {} });
  context.loadPaymentSchemaProfile_ = () => null;
  context.comparePaymentSchemaProfiles_ = () => ({
    status: 'baseline_missing',
    newPaths: [],
    missingPaths: [],
    typeChanges: []
  });
  context.normalizePayment_ = (client, range, payment) => ({
    rows: [{ ClientId: client.id, PaymentId: payment.Id, TxnDate: payment.TxnDate,
      SnapshotWeek: range.snapshotWeek }]
  });

  const result = context.buildPaymentClientSnapshot_(
    { id: 'a', name: 'Alpha', entityAlias: 'alpha' },
    { dateFrom: '2026-09-14', dateTo: '2026-09-20', snapshotWeek: '2026-09-14' },
    '2026-09-21T00:00:00.000Z'
  );

  assert.deepEqual(
    JSON.parse(JSON.stringify(receivedFilters)),
    { dateFrom: '2026-09-14', dateTo: '2026-09-20' }
  );
  assert.equal(result.paymentCount, 1);
  assert.equal(result.rows[0].PaymentId, 'payment-1');
});

test('loads and verifies successful clients before surfacing a partial failure', () => {
  const context = loadPaymentsContext();
  const calls = [];
  context.Logger = { log: () => {} };
  context.validatePaymentBigQuerySchema_ = () => ({ status: 'passed' });
  context.buildPaymentSnapshot_ = (_configuration, options) => {
    calls.push(['build', options.continueOnClientError]);
    return {
      entityConfiguration: {},
      range: { snapshotWeek: '2026-09-14' },
      clientCount: 3,
      sourcePaymentCount: 2,
      paymentCount: 2,
      pageCount: 2,
      rows: [{ ClientId: 'a' }, { ClientId: 'c' }],
      hierarchyValidation: { rowCount: 2, paymentCount: 2, headerRowCount: 2, lineRowCount: 0 },
      schemaMonitoring: {},
      baselinePersistence: {},
      successfulClientIds: ['a', 'c'],
      clientFailures: [{ clientId: 'b', httpStatus: 401, error: 'unauthorized' }]
    };
  };
  context.replacePaymentSnapshotPartition_ = () => assert.fail('must not truncate a partial partition');
  context.replacePaymentSnapshotClients_ = (_range, rows, clientIds) => {
    calls.push(['replace', rows.length, clientIds.join(',')]);
    return { jobId: 'partial-job' };
  };
  context.verifyPaymentSnapshotPartition_ = () => assert.fail('must verify only successful clients');
  context.verifyPaymentSnapshotClients_ = (_week, clientIds) => {
    calls.push(['verify', clientIds.join(',')]);
    return { status: 'passed_successful_clients' };
  };

  assert.throws(
    () => context.executePaymentBigQuerySnapshot_(),
    /loaded successful entities but completed with entity errors/
  );
  assert.deepEqual(calls, [
    ['build', true],
    ['replace', 2, 'a,c'],
    ['verify', 'a,c']
  ]);
});

test('partial replacement uses an atomic client-scoped transaction', () => {
  const context = loadPaymentsContext();
  let query = '';
  let removedTable = '';
  context.Logger = { log: () => {} };
  context.validatePaymentBigQueryRow_ = () => {};
  context.Utilities = {
    getUuid: () => '12345678-1234-1234-1234-123456789abc',
    newBlob: value => ({ getBytes: () => Array.from(Buffer.from(value)) })
  };
  context.BigQuery = {
    Jobs: {
      insert: request => ({ jobReference: request.jobReference })
    },
    Tables: {
      remove: (_project, _dataset, tableId) => { removedTable = tableId; }
    }
  };
  context.waitForBigQueryJob_ = jobReference => ({
    jobReference,
    status: { state: 'DONE' },
    statistics: { load: { outputRows: '1' } }
  });
  context.runBigQueryQuery_ = sql => {
    query = sql;
    return { jobReference: { jobId: 'transaction-job' } };
  };

  const result = context.replacePaymentSnapshotClients_(
    { snapshotWeek: '2026-09-14' },
    [{ SnapshotWeek: '2026-09-14', ClientId: 'a' }],
    ['a']
  );

  assert.equal(result.mode, 'successful_clients_replace');
  assert.match(query, /BEGIN TRANSACTION;/);
  assert.match(query, /SnapshotWeek = DATE '2026-09-14'/);
  assert.match(query, /ClientId IN \('a'\)/);
  assert.match(query, /INSERT INTO `qbo-gateway-reporting\.raw\.payment_snapshots`/);
  assert.match(query, /COMMIT TRANSACTION;/);
  assert.equal(removedTable, 'payment_snapshot_stage_20260914_12345678123412341234123456789abc');
});
