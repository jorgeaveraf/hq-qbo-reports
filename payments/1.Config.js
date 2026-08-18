/***********************
 * QBO Gateway Payments → BigQuery
 * Configuration
 ***********************/

const PAYMENT_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  apiKeyProperty: 'QBO_API_KEY',
  environment: 'prod',
  reportType: 'Payments',
  currencyDefault: 'USD',
  sourceDefault: 'QBO',
  firstStartPosition: 1,
  pageSize: 100,
  maxPages: 1000,
  pageDelayMs: 100
};

const PAYMENT_ENTITY_CONTROL = {
  reportKey: 'payments',
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',
  localPropertyKey: 'QBO_ENTITY_CONFIG_PAYMENTS',
  cacheKey: 'QBO_ENTITY_CONFIG_PAYMENTS_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,
  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',
  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_PAYMENTS',
  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',
  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120
};

const PAYMENT_OPERATIONAL_DEPLOYMENT = {
  statePropertyKey: 'QBO_PAYMENT_CONFIGURATION_DEPLOYMENT_STATE',
  workerHandler: 'processPaymentConfigurationDeployment',
  initialDelayMs: 5000,
  nextStageDelayMs: 5000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  maxStageAttempts: 3,
  staleRunningSeconds: 900,
  maxStateBytes: 9000
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting',
  rawDatasetId: 'raw',
  snapshotsTableId: 'payment_snapshots'
};

const PAYMENT_BIGQUERY_SCHEMA = [
  { name: 'idempotency_key', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RecordType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RecordOrder', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'ReportType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Entity', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'SnapshotWeek', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateFrom', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateTo', type: 'DATE', mode: 'REQUIRED' },
  { name: 'UpdatedSince', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'LoadedAt', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'PaymentId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SyncToken', type: 'STRING', mode: 'NULLABLE' },
  { name: 'TxnDate', type: 'DATE', mode: 'NULLABLE' },
  { name: 'CustomerId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CustomerName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DepositToAccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PaymentMethodId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PaymentRefNum', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PrivateNote', type: 'STRING', mode: 'NULLABLE' },
  { name: 'TotalAmount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'UnappliedAmount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'ProcessPayment', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'IsVoided', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'CurrencyCode', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CurrencyName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PaymentLinkedTxnIds', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PaymentLinkedTxnTypes', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LineCount', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'LineAmountRaw', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'LineAmountSigned', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'LinkedTxnId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LinkedTxnType', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LinkedTxnOpenBalance', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'LinkedTxnReferenceNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CreatedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'UpdatedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'Domain', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Sparse', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
];

const PAYMENT_EXPORT_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.map(field => field.name);
const PAYMENT_REQUIRED_EXPORT_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.mode === 'REQUIRED').map(field => field.name);
const PAYMENT_DATE_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.type === 'DATE').map(field => field.name);
const PAYMENT_TIMESTAMP_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.type === 'TIMESTAMP').map(field => field.name);
const PAYMENT_NUMERIC_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.type === 'NUMERIC').map(field => field.name);
const PAYMENT_INTEGER_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.type === 'INTEGER').map(field => field.name);
const PAYMENT_BOOLEAN_COLUMNS = PAYMENT_BIGQUERY_SCHEMA.filter(field => field.type === 'BOOLEAN').map(field => field.name);
const PAYMENT_BIGQUERY_PARTITION_FIELD = 'SnapshotWeek';
const PAYMENT_BIGQUERY_CLUSTER_FIELDS = ['Entity', 'ClientId', 'PaymentId', 'RecordType'];
const PAYMENT_BIGQUERY_TABLE = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
const PAYMENT_RECORD_TYPES = { header: 'HEADER', line: 'LINE' };
const PAYMENT_LINE_SIGN_BY_TXN_TYPE = { Invoice: 1, CreditMemo: -1, JournalEntry: -1, Deposit: -1 };
const PAYMENT_RECONCILIATION_TOLERANCE_CENTS = 1;
const PAYMENT_SCHEMA_BASELINE_VERSION = 1;
const PAYMENT_SCHEMA_BASELINE_PREFIX = 'PAYMENT_SCHEMA_BASELINE_V1_';
const PAYMENT_SCHEMA_SAFE_PROPERTY_BYTES = 8000;
const PAYMENT_SCHEMA_MISSING_WEEK_THRESHOLD = 3;

const PAYMENT_CONNECTED_SHEETS_CONFIG = {
  sourceSheets: [
    'vw_payment_reports_accumulated',
    'vw_payment_report_latest'
  ],

  extractSheets: [
    'Payment Accumulated',
    'Payment Latest'
  ],
  timeoutSeconds: 300
};
