/***********************
 * QBO Journal Entries → BigQuery
 * Configuration
 ***********************/

const JOURNAL_REQUIRED_COLUMN_KEYS = [
  'tx_date', 'txn_type', 'doc_num', 'name', 'memo', 'account_name', 'debt_amt', 'credit_amt'
];

const JOURNAL_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  apiKeyProperty: 'QBO_API_KEY',
  environment: 'prod',
  reportType: 'Journal Entries',
  reportName: 'JournalReport',
  currencyDefault: 'USD',
  sourceDefault: 'QBO'
};

const JOURNAL_ENTITY_CONTROL = {
  reportKey: 'journal_entries',
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',

  localPropertyKey: 'QBO_ENTITY_CONFIG_JOURNAL_ENTRIES',
  cacheKey: 'QBO_ENTITY_CONFIG_JOURNAL_ENTRIES_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,

  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',

  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_JOURNAL_ENTRIES',

  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',

  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120
};

const JOURNAL_OPERATIONAL_DEPLOYMENT = {
  statePropertyKey: 'QBO_JOURNAL_CONFIGURATION_DEPLOYMENT_STATE',
  checkpointPropertyKey: 'QBO_JOURNAL_BIGQUERY_CHECKPOINT',
  reportSpreadsheetIdProperty: 'QBO_REPORT_SPREADSHEET_ID',
  workerHandler: 'processJournalConfigurationDeployment',

  initialDelayMs: 5000,
  nextStageDelayMs: 5000,
  continuationDelayMs: 60000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 13 * 60 * 1000,

  maxStageAttempts: 3,
  maxTimeoutRecoveries: 5,
  maxContinuationCount: 50,
  maxClientsPerExecution: 5,
  executionBudgetMs: 10 * 60 * 1000,
  bigQueryJobWaitMs: 120000,
  staleRunningSeconds: 12 * 60,

  maxStateBytes: 9000,
  maxCheckpointBytes: 9000
};

const JOURNAL_BACKFILL_CONFIG = {
  statePropertyKey: 'QBO_JOURNAL_BACKFILL_STATE',
  workerHandler: 'processJournalBackfill',
  startDate: '2026-01-01',
  initialDelayMs: 5000,
  continuationDelayMs: 60000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 13 * 60 * 1000,
  staleRunningSeconds: 15 * 60,
  maxAttemptsPerPeriod: 3,
  maxStateBytes: 9000
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting',
  rawDatasetId: 'raw',
  snapshotsTableId: 'journal_entry_snapshots'
};

const JOURNAL_BIGQUERY_SCHEMA = [
  { name: 'idempotency_key', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ReportType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Entity', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RealmId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Environment', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'SnapshotWeek', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateFrom', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateTo', type: 'DATE', mode: 'REQUIRED' },
  { name: 'LoadedAt', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'ReportTime', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'Currency', type: 'STRING', mode: 'REQUIRED' },
  { name: 'TransactionId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'TransactionDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'TransactionType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'DocumentNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'NameId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LocationId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LocationName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LineNumber', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'AccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'AccountName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'MemoDescription', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DebitAmount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'CreditAmount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'NetAmount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
];

const JOURNAL_EXPORT_COLUMNS = JOURNAL_BIGQUERY_SCHEMA.map(field => field.name);
const JOURNAL_REQUIRED_EXPORT_COLUMNS = JOURNAL_BIGQUERY_SCHEMA.filter(field => field.mode === 'REQUIRED').map(field => field.name);
const JOURNAL_DATE_COLUMNS = JOURNAL_BIGQUERY_SCHEMA.filter(field => field.type === 'DATE').map(field => field.name);
const JOURNAL_TIMESTAMP_COLUMNS = JOURNAL_BIGQUERY_SCHEMA.filter(field => field.type === 'TIMESTAMP').map(field => field.name);
const JOURNAL_NUMERIC_COLUMNS = JOURNAL_BIGQUERY_SCHEMA.filter(field => field.type === 'NUMERIC').map(field => field.name);
const JOURNAL_BIGQUERY_PARTITION_FIELD = 'SnapshotWeek';
const JOURNAL_BIGQUERY_CLUSTER_FIELDS = ['Entity', 'ClientId', 'TransactionDate', 'TransactionType'];
const JOURNAL_BIGQUERY_TABLE = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
const JOURNAL_BALANCE_TOLERANCE_CENTS = 1;

const JE_SHEET_REFRESH_CONFIG = {
  sourceSheets: ['vw_journal_entry_reports', 'vw_journal_entry_report_latest'],
  extractSheets: ['JE_weekly_extract', 'JE_latest_extract'],
  timeoutSeconds: 300
};
