/***********************
 * QBO Balance Sheet - Configuration
 ***********************/

const BS_EXPORT_COLUMNS = [
  'ReportType',
  'SnapshotType',
  'Entity',
  'ClientName',
  'ClientId',
  'RealmId',
  'SnapshotDate',
  'SnapshotWeek',
  'AsOfDate',
  'FetchedAt',
  'LoadedAt',
  'StatementSection',
  'StatementSubsection',
  'ParentAccount',
  'AccountName',
  'AccountId',
  'AccountPath',
  'LineType',
  'Level',
  'NormalizedCategory',
  'MetricName',
  'IsKeyMetric',
  'Amount',
  'Currency',
  'Source'
];

const BALANCE_SNAPSHOT_TYPE_WEEKLY = 'WEEKLY';
const BALANCE_SNAPSHOT_TYPE_MONTHLY = 'MONTHLY';

const BS_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  apiKeyProperty: 'QBO_API_KEY',
  environment: 'prod',
  outputSheetName: 'Balance Sheet Export',
  currencyDefault: 'USD',
  sourceDefault: 'QBO'
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting',
  snapshotsDatasetId: 'raw',
  snapshotsTableId: 'balance_sheet_snapshots',
  auditDatasetId: 'intermediate',
  auditTableId: 'balance_sheet_audit'
};

/***********************
 * Central Entity Configuration
 ***********************/

const BALANCE_ENTITY_CONTROL = {
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',

  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',
  reportKey: 'balance_sheet',

  localPropertyKey: 'QBO_ENTITY_CONFIG_BALANCE_SHEET',
  cacheKey: 'QBO_ENTITY_CONFIG_BALANCE_SHEET_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,

  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_BALANCE_SHEET',
  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',
  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120
};

/***********************
 * Operational Configuration Deployment
 ***********************/

const BALANCE_OPERATIONAL_DEPLOYMENT = {
  statePropertyKey: 'QBO_BALANCE_CONFIGURATION_DEPLOYMENT_STATE',
  reportSpreadsheetIdProperty: 'QBO_REPORT_SPREADSHEET_ID',
  workerHandler: 'processBalanceConfigurationDeployment',
  initialDelayMs: 5000,
  nextStageDelayMs: 5000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  maxStageAttempts: 3,
  staleProcessingSeconds: 900,
  maxStateBytes: 9000
};

const BALANCE_SHEET_REFRESH_CONFIG = {
  sourceSheets: [],
  extractSheets: [],
  sourceNamePatterns: ['balance', 'vw_latest_balance_sheet_metrics'],
  extractNamePatterns: ['balance', 'bs_', 'extract'],
  timeoutSeconds: 300
};

const BALANCE_BIGQUERY_PARTITION_FIELD = 'SnapshotDate';
const BALANCE_SNAPSHOT_TABLE = [
  BQ_CONFIG.projectId,
  BQ_CONFIG.snapshotsDatasetId,
  BQ_CONFIG.snapshotsTableId
].join('.');

const BALANCE_AUDIT_TABLE = [
  BQ_CONFIG.projectId,
  BQ_CONFIG.auditDatasetId,
  BQ_CONFIG.auditTableId
].join('.');
