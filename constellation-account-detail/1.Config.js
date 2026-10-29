/***********************
 * QBO P&L Account Detail - Configuration
 ***********************/

const ACCOUNT_DETAIL_SNAPSHOT_LATEST = 'LATEST';
const ACCOUNT_DETAIL_SNAPSHOT_MONTHLY = 'MONTHLY';

const ACCOUNT_DETAIL_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  environment: 'prod',
  accountingMethod: 'Accrual',
  apiKeyProperty: 'QBO_API_KEY',
  source: 'QBO',
  reportName: 'ProfitAndLossDetail',
  projectId: 'qbo-gateway-reporting',
  rawDatasetId: 'raw',
  viewsDatasetId: 'views',
  tableId: 'profit_and_loss_account_detail_snapshots',
  runsTableId: 'profit_and_loss_account_detail_runs',
  latestViewId: 'vw_profit_and_loss_account_detail_latest',
  monthlyViewId: 'vw_monthly_profit_and_loss_account_detail',
  partitionField: 'SnapshotDate',
  clusterFields: ['ClientId', 'SubAccountId', 'SnapshotType'],
  requiredColumnKeys: ['tx_date', 'txn_type', 'subt_nat_amount'],
  reportKey: 'profit_and_loss_account_detail'
};

const ACCOUNT_DETAIL_ENTITY_CONTROL = {
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',
  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',
  localPropertyKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS_ACCOUNT_DETAIL',
  cacheKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS_ACCOUNT_DETAIL_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000
};

const ACCOUNT_DETAIL_SPREADSHEET = {
  idProperty: 'QBO_ACCOUNT_DETAIL_REPORT_SPREADSHEET_ID',
  targetsProperty: 'QBO_ACCOUNT_DETAIL_CONNECTED_SHEETS_TARGETS',
  latestSheetName: 'P&L Detail Latest',
  monthlySheetName: 'P&L Detail Monthly',
  latestExtractSheetName: 'P&L Detail Latest_extract',
  monthlyExtractSheetName: 'P&L Detail Monthly_extract',
  extractColumns: [
    'SnapshotDate', 'PeriodStart', 'PeriodEnd', 'Entity',
    'ParentAccountNumber', 'ParentAccountName', 'SubAccountNumber', 'SubAccountName',
    'TxnDate', 'TxnType', 'DocNumber', 'Name', 'Location', 'Memo',
    'SplitAccountName', 'Amount', 'RunningBalance', 'AccountingMethod', 'Currency'
  ],
  extractRowLimit: 25000,
  timeoutSeconds: 300
};

const ACCOUNT_DETAIL_CADENCE = {
  dailyHandler: 'snapshotAccountDetailLatest',
  monthlyHandler: 'snapshotAccountDetailMonthly',
  repairHandler: 'startAccountDetailRollingReconciliation',
  dailyHour: 5,
  monthlyHour: 6,
  monthlyDay: 10,
  repairHour: 7,
  repairWeekDay: 'MONDAY'
};

const ACCOUNT_DETAIL_WORKER = {
  backfillStateProperty: 'QBO_ACCOUNT_DETAIL_BACKFILL_STATE',
  backfillHandler: 'processAccountDetailBackfill',
  repairStateProperty: 'QBO_ACCOUNT_DETAIL_ROLLING_RECONCILIATION',
  repairHandler: 'processAccountDetailRollingReconciliation',
  initialDelayMs: 5000,
  continuationDelayMs: 5000,
  failureRetryDelayMs: 60000,
  watchdogDelayMs: 840000,
  maxAttempts: 3,
  maxStateBytes: 8500
};

const ACCOUNT_DETAIL_SCHEMA = [
  { name: 'idempotency_key', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'PeriodStart', type: 'DATE', mode: 'REQUIRED' },
  { name: 'PeriodEnd', type: 'DATE', mode: 'REQUIRED' },
  { name: 'Entity', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RealmId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Environment', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ParentAccountId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ParentAccountNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ParentAccountName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SubAccountId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SubAccountNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SubAccountName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'AccountPath', type: 'STRING', mode: 'REQUIRED' },
  { name: 'TxnDate', type: 'DATE', mode: 'NULLABLE' },
  { name: 'TxnType', type: 'STRING', mode: 'NULLABLE' },
  { name: 'TxnId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DocNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'NameId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Name', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LocationId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Location', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Memo', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SplitAccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SplitAccountName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Amount', type: 'NUMERIC', mode: 'REQUIRED' },
  { name: 'RunningBalance', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'SourceRowOrder', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'AccountingMethod', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Currency', type: 'STRING', mode: 'NULLABLE' },
  { name: 'FetchedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'LoadedAt', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
];

const ACCOUNT_DETAIL_EXPORT_COLUMNS = ACCOUNT_DETAIL_SCHEMA.map(field => field.name);
const ACCOUNT_DETAIL_RUN_SCHEMA = [
  { name: 'scope_key', type: 'STRING', mode: 'REQUIRED' },
  { name: 'operation_id', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'PeriodStart', type: 'DATE', mode: 'REQUIRED' },
  { name: 'PeriodEnd', type: 'DATE', mode: 'REQUIRED' },
  { name: 'ClientId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SubAccountId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RowCount', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'ConfigurationHash', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Status', type: 'STRING', mode: 'REQUIRED' },
  { name: 'CompletedAt', type: 'TIMESTAMP', mode: 'REQUIRED' }
];
const ACCOUNT_DETAIL_TABLE = [
  ACCOUNT_DETAIL_CONFIG.projectId,
  ACCOUNT_DETAIL_CONFIG.rawDatasetId,
  ACCOUNT_DETAIL_CONFIG.tableId
].join('.');
const ACCOUNT_DETAIL_RUNS_TABLE = [
  ACCOUNT_DETAIL_CONFIG.projectId,
  ACCOUNT_DETAIL_CONFIG.rawDatasetId,
  ACCOUNT_DETAIL_CONFIG.runsTableId
].join('.');

