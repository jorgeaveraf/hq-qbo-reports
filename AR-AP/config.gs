/***********************
 * QBO AR/AP Detailed
 * Configuration
 ***********************/

const ALLOWED_DOC_TYPES = [];

const EXPORT_COLUMNS = [
  'ReportType',
  'Entity',
  'AsOfDate',
  'Bucket',
  'Counterparty',
  'DocumentNumber',
  'DocumentType',
  'TransactionDate',
  'DueDate',
  'DaysOverdue',
  'OpenAmount',
  'Currency',
  'Source'
];

const BUCKET_ORDER = ['Current', '1–30', '31–60', '61–90', '91+'];

const QBO_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  apiKeyProperty: 'QBO_API_KEY',
  environment: 'production',
  allowedDocTypes: ALLOWED_DOC_TYPES,
  outputSheetName: 'Aging Export',
  currencyDefault: 'USD',
  sourceDefault: 'QBO'
};

const AGING_ENTITY_CONTROL = {
  reportKey: 'aging',
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',

  localPropertyKey: 'QBO_ENTITY_CONFIG_AGING',
  cacheKey: 'QBO_ENTITY_CONFIG_AGING_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,

  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',

  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_AGING',

  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',

  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting',
  datasetId: 'raw',
  tableId: 'aging_snapshots'
};


const AGING_OPERATIONAL_DEPLOYMENT = {
  statePropertyKey: 'QBO_AGING_CONFIGURATION_DEPLOYMENT_STATE',
  reportSpreadsheetIdProperty: 'QBO_REPORT_SPREADSHEET_ID',
  workerHandler: 'processAgingConfigurationDeployment',
  initialDelayMs: 5000,
  nextStageDelayMs: 5000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  maxStageAttempts: 3,
  staleRunningSeconds: 900,
  maxStateBytes: 9000
};

const AGING_BIGQUERY_SCHEMA = [
  { name: 'snapshot_date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'snapshot_week', type: 'DATE', mode: 'REQUIRED' },
  { name: 'report_type', type: 'STRING', mode: 'REQUIRED' },
  { name: 'entity', type: 'STRING', mode: 'REQUIRED' },
  { name: 'as_of_date', type: 'DATE', mode: 'REQUIRED' },
  { name: 'bucket', type: 'STRING', mode: 'REQUIRED' },
  { name: 'counterparty', type: 'STRING', mode: 'REQUIRED' },
  { name: 'document_number', type: 'STRING', mode: 'NULLABLE' },
  { name: 'document_type', type: 'STRING', mode: 'REQUIRED' },
  { name: 'transaction_date', type: 'DATE', mode: 'NULLABLE' },
  { name: 'due_date', type: 'DATE', mode: 'NULLABLE' },
  { name: 'days_overdue', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'open_amount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'currency', type: 'STRING', mode: 'REQUIRED' },
  { name: 'source', type: 'STRING', mode: 'REQUIRED' },
  { name: 'client_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'client_name', type: 'STRING', mode: 'REQUIRED' },
  { name: 'loaded_at', type: 'TIMESTAMP', mode: 'REQUIRED' }
];

const AGING_BIGQUERY_COLUMNS = AGING_BIGQUERY_SCHEMA.map(field => field.name);
const AGING_BIGQUERY_TABLE = [BQ_CONFIG.projectId, BQ_CONFIG.datasetId, BQ_CONFIG.tableId].join('.');

const AGING_SHEET_REFRESH_CONFIG = {
  sourceSheets: [],
  extractSheets: [],
  timeoutSeconds: 300
};