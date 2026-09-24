/***********************
 * QBO Profit and Loss - Centralized Entity Control + BigQuery
 ***********************/

const PNL_VARIANT_NORMAL = 'normal';
const PNL_VARIANT_BY_CLASS = 'by_class';

const PNL_LINE_TYPES = { header: 'Header', data: 'Data', summary: 'Summary' };
const PNL_CLASS_COLUMN_ROLES = {
  directClass: 'direct_class', classSubtotal: 'class_subtotal',
  notSpecified: 'not_specified', grandTotal: 'grand_total'
};

const PNL_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co', apiKeyProperty: 'QBO_API_KEY', environment: 'prod',
  reportType: 'Profit and Loss', reportName: 'ProfitAndLoss', accountingMethod: 'Accrual',
  currencyDefault: 'USD', sourceDefault: 'QBO',
  variants: {
    normal: {
      reportVariant: PNL_VARIANT_NORMAL, summarizeColumnBy: null,
      expectedSummarizeColumnsBy: 'Total', snapshotsTableId: 'profit_and_loss_snapshots'
    },
    by_class: {
      reportVariant: PNL_VARIANT_BY_CLASS, summarizeColumnBy: 'Class',
      expectedSummarizeColumnsBy: 'Classes', snapshotsTableId: 'profit_and_loss_by_class_snapshots'
    }
  }
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting', rawDatasetId: 'raw',
  snapshotsTableIds: {
    normal: PNL_CONFIG.variants.normal.snapshotsTableId,
    by_class: PNL_CONFIG.variants.by_class.snapshotsTableId
  }
};

const PNL_COMMON_BIGQUERY_SCHEMA = [
  { name: 'idempotency_key', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ReportType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ReportVariant', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Entity', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'ClientId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RealmId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Environment', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SnapshotDate', type: 'DATE', mode: 'REQUIRED' },
  { name: 'SnapshotWeek', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateFrom', type: 'DATE', mode: 'REQUIRED' },
  { name: 'DateTo', type: 'DATE', mode: 'REQUIRED' },
  { name: 'AccountingMethod', type: 'STRING', mode: 'REQUIRED' },
  { name: 'AccountingStandard', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SummarizeColumnsBy', type: 'STRING', mode: 'REQUIRED' },
  { name: 'LoadedAt', type: 'TIMESTAMP', mode: 'REQUIRED' },
  { name: 'FetchedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'ReportTime', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'Currency', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RecordGroupKey', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RecordGroupOrder', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'RecordType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'RecordOrder', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'SourceRowOrder', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'GroupName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'StatementSection', type: 'STRING', mode: 'REQUIRED' },
  { name: 'StatementSubsection', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ParentAccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ParentAccountName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'AccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'AccountName', type: 'STRING', mode: 'REQUIRED' },
  { name: 'AccountPath', type: 'STRING', mode: 'REQUIRED' },
  { name: 'LineType', type: 'STRING', mode: 'REQUIRED' },
  { name: 'Level', type: 'INTEGER', mode: 'REQUIRED' },
  { name: 'RowPath', type: 'STRING', mode: 'REQUIRED' },
  { name: 'NormalizedMetric', type: 'STRING', mode: 'NULLABLE' },
  { name: 'MetricName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'IsKeyMetric', type: 'BOOLEAN', mode: 'REQUIRED' }
];

const PNL_NORMAL_BIGQUERY_SCHEMA = PNL_COMMON_BIGQUERY_SCHEMA.concat([
  { name: 'Amount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
]);

const PNL_BY_CLASS_BIGQUERY_SCHEMA = PNL_COMMON_BIGQUERY_SCHEMA.concat([
  { name: 'ClassColumnIndex', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'ClassKey', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassColumnRole', type: 'STRING', mode: 'NULLABLE' },
  { name: 'IsClassSubtotal', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'IsGrandTotal', type: 'BOOLEAN', mode: 'NULLABLE' },
  { name: 'Amount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
]);

const PNL_BIGQUERY_SCHEMAS = {
  normal: PNL_NORMAL_BIGQUERY_SCHEMA, by_class: PNL_BY_CLASS_BIGQUERY_SCHEMA
};
const PNL_EXPORT_COLUMNS = {
  normal: PNL_NORMAL_BIGQUERY_SCHEMA.map(field => field.name),
  by_class: PNL_BY_CLASS_BIGQUERY_SCHEMA.map(field => field.name)
};
const PNL_BIGQUERY_PARTITION_FIELD = 'SnapshotWeek';
const PNL_BIGQUERY_CLUSTER_FIELDS = {
  normal: ['Entity', 'ClientId', 'RecordGroupKey', 'RecordType'],
  by_class: ['Entity', 'ClientId', 'RecordGroupKey', 'ClassColumnRole']
};
const PNL_BIGQUERY_TABLES = {
  normal: [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableIds.normal].join('.'),
  by_class: [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableIds.by_class].join('.')
};

/***********************
 * Configuration and Dates
 ***********************/

/***********************
 * Central Entity Configuration
 ***********************/

const PNL_ENTITY_CONTROL = {
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',

  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',

  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',
  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120,

  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,

  reports: {
    normal: {
      reportKey: 'profit_and_loss',
      localPropertyKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS',
      cacheKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS_CACHE',
      pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_PROFIT_AND_LOSS',
      deploymentStateProperty: 'QBO_PNL_CONFIGURATION_DEPLOYMENT_STATE_PROFIT_AND_LOSS'
    },
    by_class: {
      reportKey: 'profit_and_loss_by_class',
      localPropertyKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS_BY_CLASS',
      cacheKey: 'QBO_ENTITY_CONFIG_PROFIT_AND_LOSS_BY_CLASS_CACHE',
      pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_PROFIT_AND_LOSS_BY_CLASS',
      deploymentStateProperty: 'QBO_PNL_CONFIGURATION_DEPLOYMENT_STATE_PROFIT_AND_LOSS_BY_CLASS'
    }
  }
};

/***********************
 * Operational Configuration Deployment
 ***********************/

const PNL_OPERATIONAL_DEPLOYMENT = {
  workerHandler: 'processProfitAndLossConfigurationDeployment',
  reportSpreadsheetIdProperty: 'QBO_PNL_REPORT_SPREADSHEET_ID',
  connectedSheetTargetsProperty: 'QBO_PNL_CONNECTED_SHEETS_TARGETS',
  maxStageAttempts: 3,
  initialDelayMs: 10000,
  nextStageDelayMs: 10000,
  failureRetryDelayMs: 60000,
  busyRetryDelayMs: 30000,
  staleProcessingSeconds: 900,
  maxStateBytes: 8500,
  stages: ['bigquery', 'data_source_sheets', 'extracts']
};

const PNL_CONNECTED_SHEETS_CONFIG = {
  timeoutSeconds: 300,
  reportSources: {
    normal: {
      reportKey: 'profit_and_loss',
      includeTokens: [
        'vw_profit_and_loss_reports',
        'vw_profit_and_loss_report_latest',
        'vw_latest_profit_and_loss_reports',
        'profit_and_loss_snapshots'
      ],
      excludeTokens: ['profit_and_loss_by_class', 'by class', 'by_class']
    },
    by_class: {
      reportKey: 'profit_and_loss_by_class',
      includeTokens: [
        'vw_profit_and_loss_by_class_reports',
        'vw_profit_and_loss_by_class_report_latest',
        'vw_latest_profit_and_loss_by_class_reports',
        'profit_and_loss_by_class_snapshots',
        'by class',
        'by_class',
        'byclass'
      ],
      excludeTokens: []
    }
  }
};
