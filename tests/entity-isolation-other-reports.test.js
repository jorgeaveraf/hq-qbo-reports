const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function load(relativePath, globals = {}) {
  const context = vm.createContext({
    console,
    Logger: { log() {} },
    ...globals
  });
  vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, {
    filename: relativePath
  });
  return context;
}

test('Invoices continues after one client fails and reports the isolated failure', () => {
  const context = load('invoices/3.Functions.js');
  context.getPreviousCompletedWeekRange_ = () => ({ snapshotWeek: '2026-09-13', dateFrom: '2026-09-13', dateTo: '2026-09-19' });
  context.validateInvoiceEntityConfiguration_ = value => value;
  context.fetchClients_ = () => ({
    a: { id: 'a', name: 'A', entityAlias: 'a' },
    b: { id: 'b', name: 'B', entityAlias: 'b' },
    c: { id: 'c', name: 'C', entityAlias: 'c' }
  });
  const fetched = [];
  context.fetchInvoices_ = clientId => {
    fetched.push(clientId);
    if (clientId === 'b') throw new Error('/invoices page 1 returned HTTP 401');
    return { clientId };
  };
  context.normalizeInvoices_ = (client, range, response) => ({
    rows: [{ ClientId: client.id, Entity: client.entityAlias, ClientName: client.name,
      SnapshotWeek: range.snapshotWeek, InvoiceId: response.clientId, RecordType: 'HEADER', RecordOrder: 0 }],
    diagnostics: {}, stats: { invoiceCount: 1, snapshotRowCount: 1 }
  });
  context.createInvoiceSourceDiagnostics_ = () => ({});
  context.mergeInvoiceSourceDiagnostics_ = () => {};
  context.summarizeInvoiceSourceDiagnostics_ = () => ({ aliasResolutionCount: 0, normalizedKeyMatchCount: 0 });
  context.prepareInvoiceSchemaBaseline_ = client => ({ check: { clientId: client.id, status: 'unchanged' }, update: null });
  context.summarizeInvoiceSchemaMonitoring_ = checks => ({ clientCount: checks.length });

  const result = context.buildInvoiceSnapshot_({
    source: 'test',
    configuration: { report_key: 'invoices', configuration_version: 1, configuration_hash: 'hash', published_at: 'now', entities: [] }
  }, { continueOnClientError: true });

  assert.deepEqual(fetched, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(result.successfulClientIds), ['a', 'c']);
  assert.equal(result.clientFailures.length, 1);
  assert.equal(result.clientFailures[0].clientId, 'b');
  assert.equal(result.clientFailures[0].httpStatus, 401);
});

test('Profit and Loss continues after one client fails', () => {
  const context = load('profit-and-loss/3.Functions.js', {
    PNL_VARIANT_NORMAL: 'normal',
    PNL_VARIANT_BY_CLASS: 'by_class'
  });
  context.getPnlVariantConfig_ = variant => ({ variantKey: variant });
  context.getPreviousCompletedWeekRange_ = () => ({ snapshotWeek: '2026-09-13', dateFrom: '2026-09-13', dateTo: '2026-09-19' });
  const clients = ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), entityAlias: id }));
  const fetched = [];
  context.fetchProfitAndLossReport_ = clientId => {
    fetched.push(clientId);
    if (clientId === 'b') throw new Error('/reports returned HTTP 401');
    return { data: {}, clientId };
  };
  context.getPnlColumnDefinitions_ = () => ({ isNoData: false, columns: [{}], moneyColumns: [{}] });
  context.normalizeProfitAndLossReport_ = (payload, client, range) => [{
    ClientId: client.id, Entity: client.entityAlias, ClientName: client.name,
    SnapshotWeek: range.snapshotWeek, RecordGroupOrder: 0, RecordOrder: 0, SourceRowOrder: 0, RowPath: client.id
  }];
  context.validatePnlPreparedRows_ = rows => ({ rowCount: rows.length });

  const result = context.buildProfitAndLossVariantSnapshot_('normal', {
    clients,
    range: context.getPreviousCompletedWeekRange_(),
    continueOnClientError: true
  });

  assert.deepEqual(fetched, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(result.successfulClientIds), ['a', 'c']);
  assert.equal(result.clientFailures[0].clientId, 'b');
});

test('Balance Sheet rolls back only the failed client rows and continues', () => {
  const context = load('balance-sheet/3.Functions.js', {
    BS_CONFIG: { currencyDefault: 'USD', sourceDefault: 'QBO' }
  });
  context.todayIsoDate_ = () => '2026-09-22';
  context.getWeekStartSunday_ = () => '2026-09-20';
  context.resolveBalanceEntitySelection_ = () => ({
    entityConfiguration: { source: 'test' },
    clientsById: {
      a: { id: 'a', name: 'A', entity: 'a' },
      b: { id: 'b', name: 'B', entity: 'b' },
      c: { id: 'c', name: 'C', entity: 'c' }
    }
  });
  const fetched = [];
  context.fetchBalanceSheet_ = clientId => {
    fetched.push(clientId);
    if (clientId === 'b') throw new Error('/balance-sheet returned HTTP 401');
    return { data: { Header: {} }, realm_id: clientId };
  };
  context.extractBalanceSheetAsOfDate_ = () => '2026-09-22';
  context.flattenBalanceSheet_ = () => [{
    section: 'Assets', statementSubsection: '', parentAccount: '', accountName: 'Cash', accountId: '1',
    path: 'Assets/Cash', lineType: 'Data', level: 1, normalizedCategory: 'cash_total',
    metricName: 'Cash', isKeyMetric: true, amount: 1
  }];
  context.md5Hash_ = value => String(value.length);

  const result = context.buildBalanceSheetSnapshot_(null, { continueOnClientError: true });

  assert.deepEqual(fetched, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(result.successfulClientIds), ['a', 'c']);
  assert.deepEqual(Array.from(result.lineRows, row => row.ClientId), ['a', 'c']);
  assert.equal(result.clientFailures[0].clientId, 'b');
});

test('Journal continuation skips a failed entity, processes later entities, then surfaces partial failure', () => {
  const checkpoint = {
    operation_id: 'op', period: { snapshotWeek: '2026-09-13' }, loaded_at: 'now',
    clients: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), entityAlias: id })),
    next_client_index: 0, processed_client_count: 0, continuation_count: 0,
    total_transaction_count: 0, total_accounting_transaction_count: 0, total_row_count: 0,
    total_debit_cents: 0, total_credit_cents: 0, partition_cleared: true,
    stale_cleanup_job_id: 'cleanup', stale_cleanup_completed: true,
    current_client: null, successful_client_ids: [], client_failures: [],
    entity_configuration: {}, schema_validation: {}, load_job_count: 0, query_job_count: 0
  };
  const context = load('journal-entries/5.Deployment.js', {
    JOURNAL_OPERATIONAL_DEPLOYMENT: { maxClientsPerExecution: 50, executionBudgetMs: 999999 },
    JOURNAL_BIGQUERY_TABLE: 'p.d.t'
  });
  context.readJournalBigQueryCheckpoint_ = () => checkpoint;
  context.journalBigQueryCheckpointMatchesState_ = () => true;
  context.journalExecutionBudgetReached_ = () => false;
  context.persistJournalBigQueryCheckpoint_ = () => {};
  context.assertJournalBalanced_ = () => {};
  context.verifyJournalSnapshotPartitionDetailed_ = () => ({ status: 'passed' });
  context.centsToAmount_ = value => value / 100;
  const processed = [];
  context.processJournalBigQueryCheckpointClient_ = cp => {
    const client = cp.clients[cp.next_client_index];
    processed.push(client.id);
    if (client.id === 'b') throw new Error('/journal returned HTTP 401');
    cp.successful_client_ids.push(client.id);
    cp.processed_client_count++;
    cp.next_client_index++;
    return { completed: true, checkpoint: cp };
  };

  assert.throws(
    () => context.executeJournalBigQueryContinuationStage_({ operation_id: 'op' }, {}),
    error => error.entityIsolationFailure === true
  );
  assert.deepEqual(processed, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(checkpoint.successful_client_ids), ['a', 'c']);
  assert.equal(checkpoint.client_failures[0].clientId, 'b');
});

test('AR/AP continuation skips a failed entity, processes later entities, then surfaces partial failure', () => {
  const checkpoint = {
    operation_id: 'op', range: { snapshotDate: '2026-09-22', snapshotWeek: '2026-09-20' },
    clients: ['a', 'b', 'c'].map(id => ({ id, name: id.toUpperCase(), entityAlias: id })),
    next_client_index: 0, processed_client_count: 0, continuation_count: 0,
    clients_with_rows_count: 0, report_row_counts: { AR: 0, AP: 0 }, row_count: 0,
    unique_row_count: 0, open_amount_cents: { AR: 0, AP: 0 }, partition_initialized: true,
    stale_cleanup_job_id: 'cleanup', stale_cleanup_completed: true,
    current_client: null, successful_client_ids: [], client_failures: [],
    verification: { status: 'passed' }, entity_configuration: {}, schema_validation: {}
  };
  const context = load('ar-ap/5.Deployment.js', {
    AGING_OPERATIONAL_DEPLOYMENT: { maxClientsPerExecution: 50, executionBudgetMs: 999999 }
  });
  context.readAgingBigQueryCheckpoint_ = () => checkpoint;
  context.agingBigQueryCheckpointMatchesState_ = () => true;
  context.agingExecutionBudgetReached_ = () => false;
  context.persistAgingBigQueryCheckpoint_ = () => {};
  const processed = [];
  context.processAgingBigQueryCheckpointClient_ = cp => {
    const client = cp.clients[cp.next_client_index];
    processed.push(client.id);
    if (client.id === 'b') throw new Error('/aging returned HTTP 401');
    cp.successful_client_ids.push(client.id);
    cp.processed_client_count++;
    cp.next_client_index++;
    return { status: 'completed', checkpoint: cp };
  };

  assert.throws(
    () => context.executeAgingBigQueryContinuationStage_({ operation_id: 'op' }),
    error => error.entityIsolationFailure === true
  );
  assert.deepEqual(processed, ['a', 'b', 'c']);
  assert.deepEqual(Array.from(checkpoint.successful_client_ids), ['a', 'c']);
  assert.equal(checkpoint.client_failures[0].clientId, 'b');
});
