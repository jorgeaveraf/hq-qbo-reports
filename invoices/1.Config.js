/***********************
 * QBO Invoices - Configuration
 ***********************/

const INVOICE_BIGQUERY_SCHEMA = [
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
  { name: 'LoadedAt', type: 'TIMESTAMP', mode: 'REQUIRED' },

  { name: 'InvoiceId', type: 'STRING', mode: 'REQUIRED' },
  { name: 'SyncToken', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DocNumber', type: 'STRING', mode: 'NULLABLE' },
  { name: 'TxnDate', type: 'DATE', mode: 'NULLABLE' },
  { name: 'DueDate', type: 'DATE', mode: 'NULLABLE' },
  { name: 'ShipDate', type: 'DATE', mode: 'NULLABLE' },

  { name: 'CustomerId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CustomerName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CurrencyCode', type: 'STRING', mode: 'NULLABLE' },
  { name: 'CurrencyName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SalesTermId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'SalesTermName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DepartmentId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DepartmentName', type: 'STRING', mode: 'NULLABLE' },

  { name: 'BillEmail', type: 'STRING', mode: 'NULLABLE' },
  { name: 'PrintStatus', type: 'STRING', mode: 'NULLABLE' },
  { name: 'EmailStatus', type: 'STRING', mode: 'NULLABLE' },
  { name: 'EInvoiceStatus', type: 'STRING', mode: 'NULLABLE' },

  { name: 'TotalAmount', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'Balance', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'PaymentStatus', type: 'STRING', mode: 'NULLABLE' },

  { name: 'LineId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LineNumber', type: 'INTEGER', mode: 'NULLABLE' },
  { name: 'LineType', type: 'STRING', mode: 'NULLABLE' },
  { name: 'Description', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ServiceDate', type: 'DATE', mode: 'NULLABLE' },

  { name: 'LineAmountRaw', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'LineAmountSigned', type: 'NUMERIC', mode: 'NULLABLE' },

  { name: 'ItemId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ItemName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'UnitPrice', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'Quantity', type: 'NUMERIC', mode: 'NULLABLE' },

  { name: 'AccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'AccountName', type: 'STRING', mode: 'NULLABLE' },
  { name: 'TaxCode', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ClassName', type: 'STRING', mode: 'NULLABLE' },

  { name: 'DiscountPercent', type: 'NUMERIC', mode: 'NULLABLE' },
  { name: 'DiscountAccountId', type: 'STRING', mode: 'NULLABLE' },
  { name: 'DiscountAccountName', type: 'STRING', mode: 'NULLABLE' },

  { name: 'LinkedTxnIds', type: 'STRING', mode: 'NULLABLE' },
  { name: 'LinkedTxnTypes', type: 'STRING', mode: 'NULLABLE' },

  { name: 'BillAddress', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ShipAddress', type: 'STRING', mode: 'NULLABLE' },
  { name: 'ShipFromAddress', type: 'STRING', mode: 'NULLABLE' },

  { name: 'CreatedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'UpdatedAt', type: 'TIMESTAMP', mode: 'NULLABLE' },
  { name: 'LastModifiedBy', type: 'STRING', mode: 'NULLABLE' },

  { name: 'Source', type: 'STRING', mode: 'REQUIRED' }
];

const INVOICE_EXPORT_COLUMNS = INVOICE_BIGQUERY_SCHEMA.map(field => field.name);

const INVOICE_CONFIG = {
  baseUrl: 'https://qbo.headquarters.co',
  apiKeyProperty: 'QBO_API_KEY', environment: 'prod', reportType: 'Invoices', maxResults: 1000, currencyDefault: 'USD',
  sourceDefault: 'QBO'
};

const INVOICE_ENTITY_CONTROL = {
  reportKey: 'invoices',
  spreadsheetIdProperty: 'QBO_CONTROL_SPREADSHEET_ID',
  metadataSheetName: 'Configuration Metadata',
  publishedSheetName: 'Published Configuration',

  localPropertyKey: 'QBO_ENTITY_CONFIG_INVOICES',
  cacheKey: 'QBO_ENTITY_CONFIG_INVOICES_CACHE',
  cacheTtlSeconds: 21600,
  maxPropertyBytes: 8000,

  contractType: 'qbo_entity_configuration',
  contractVersion: '1.0',
  schemaVersion: '1.0',

  pushEndpointUrlProperty: 'QBO_ENTITY_PUSH_ENDPOINT_URL',
  pushSecretProperty: 'QBO_ENTITY_PUSH_SECRET',
  pushReceiptProperty: 'QBO_ENTITY_PUSH_LAST_RECEIPT_INVOICES',

  pushEnvelopeContractType: 'qbo_entity_configuration_envelope',
  pushEnvelopeContractVersion: '1.0',
  pushContractType: 'qbo_entity_configuration_push',
  pushContractVersion: '1.0',

  pushMaxAgeSeconds: 600,
  pushFutureToleranceSeconds: 120
};


const INVOICE_OPERATIONAL_DEPLOYMENT = {
  statePropertyKey: 'QBO_INVOICE_CONFIGURATION_DEPLOYMENT_STATE',
  reportSpreadsheetIdProperty: 'QBO_REPORT_SPREADSHEET_ID',
  workerHandler: 'processInvoiceConfigurationDeployment',
  initialDelayMs: 5000,
  nextStageDelayMs: 5000,
  busyRetryDelayMs: 60000,
  failureRetryDelayMs: 60000,
  maxStageAttempts: 3,
  staleProcessingSeconds: 900,
  maxStateBytes: 9000
};

const INVOICE_CONNECTED_SHEETS_CONFIG = {
  // This is a dedicated Invoice Report Sheet. Empty arrays mean all Connected Sheets
  // objects in this spreadsheet are treated as Invoice-owned objects.
  sourceSheets: [],
  extractSheets: [],
  timeoutSeconds: 300
};

const BQ_CONFIG = {
  projectId: 'qbo-gateway-reporting', rawDatasetId: 'raw', snapshotsTableId: 'invoice_snapshots'
};

const INVOICE_SOURCE_FIELDS = {
  invoice: {
    invoiceId: { paths: ['Id', 'InvoiceId', 'invoice_id'], required: true },
    syncToken: { paths: ['SyncToken', 'sync_token'], required: false },
    docNumber: { paths: ['DocNumber', 'DocumentNumber', 'doc_number'], required: false },
    txnDate: { paths: ['TxnDate', 'TransactionDate', 'txn_date'], required: false },
    dueDate: { paths: ['DueDate', 'due_date'], required: false },
    shipDate: { paths: ['ShipDate', 'ship_date'], required: false },
    customerRef: { paths: ['CustomerRef', 'customer_ref'], required: false },
    currencyRef: { paths: ['CurrencyRef', 'currency_ref'], required: false },
    salesTermRef: { paths: ['SalesTermRef', 'PaymentTermRef', 'sales_term_ref'], required: false },
    departmentRef: { paths: ['DepartmentRef', 'LocationRef', 'department_ref', 'location_ref'], required: false },
    billEmail: {
      paths: ['BillEmail.Address', 'BillingEmail.Address', 'BillEmail', 'BillingEmail'], required: false
    }, printStatus: { paths: ['PrintStatus', 'print_status'], required: false },
    emailStatus: { paths: ['EmailStatus', 'email_status'], required: false },
    eInvoiceStatus: { paths: ['EInvoiceStatus', 'ElectronicInvoiceStatus', 'e_invoice_status'], required: false },
    totalAmount: { paths: ['TotalAmt', 'TotalAmount', 'total_amount'], required: false },
    balance: { paths: ['Balance', 'OpenBalance', 'open_balance'], required: false },
    linkedTransactions: { paths: ['LinkedTxn', 'LinkedTransactions', 'linked_txn'], required: false },
    billAddress: { paths: ['BillAddr', 'BillingAddress', 'bill_address'], required: false },
    shipAddress: { paths: ['ShipAddr', 'ShippingAddress', 'ship_address'], required: false },
    shipFromAddress: { paths: ['ShipFromAddr', 'ShipFromAddress', 'ship_from_address'], required: false },
    metadata: { paths: ['MetaData', 'Metadata', 'meta_data'], required: false },
    lines: { paths: ['Line', 'Lines', 'line_items'], required: false }
  }, metadata: {
    createdAt: { paths: ['CreateTime', 'CreatedAt', 'create_time'], required: false },
    updatedAt: { paths: ['LastUpdatedTime', 'UpdatedAt', 'last_updated_time'], required: false },
    lastModifiedByRef: { paths: ['LastModifiedByRef', 'ModifiedByRef', 'last_modified_by_ref'], required: false }
  }, line: {
    lineId: { paths: ['Id', 'LineId', 'line_id'], required: false },
    lineNumber: { paths: ['LineNum', 'LineNumber', 'line_number'], required: false },
    lineType: { paths: ['DetailType', 'LineType', 'detail_type'], required: true },
    description: { paths: ['Description', 'Memo', 'description'], required: false },
    amount: { paths: ['Amount', 'LineAmount', 'line_amount'], required: false },
    salesDetail: { paths: ['SalesItemLineDetail', 'SalesLineDetail', 'sales_item_line_detail'], required: false },
    discountDetail: { paths: ['DiscountLineDetail', 'DiscountDetail', 'discount_line_detail'], required: false }
  }, salesDetail: {
    itemRef: { paths: ['ItemRef', 'ProductRef', 'item_ref'], required: false },
    accountRef: { paths: ['ItemAccountRef', 'AccountRef', 'item_account_ref'], required: false },
    taxCodeRef: { paths: ['TaxCodeRef', 'TaxRef', 'tax_code_ref'], required: false },
    classRef: { paths: ['ClassRef', 'ClassificationRef', 'class_ref'], required: false },
    serviceDate: { paths: ['ServiceDate', 'service_date'], required: false },
    unitPrice: { paths: ['UnitPrice', 'Rate', 'unit_price'], required: false },
    quantity: { paths: ['Qty', 'Quantity', 'quantity'], required: false }
  }, discountDetail: {
    discountPercent: { paths: ['DiscountPercent', 'Percent', 'discount_percent'], required: false },
    discountAccountRef: {
      paths: ['DiscountAccountRef', 'AccountRef', 'discount_account_ref'], required: false
    }
  }, linkedTransaction: {
    transactionId: { paths: ['TxnId', 'TransactionId', 'txn_id'], required: false },
    transactionType: { paths: ['TxnType', 'TransactionType', 'txn_type'], required: false }
  }
};

const INVOICE_SCHEMA_BASELINE_VERSION = 2;
const INVOICE_SCHEMA_BASELINE_PREFIX = 'INVOICE_SCHEMA_BASELINE_V2_';
const INVOICE_SCHEMA_SAFE_PROPERTY_BYTES = 8000;
const INVOICE_SCHEMA_MISSING_WEEK_THRESHOLD = 3;

/***********************
 * Configuration Accessors
 ***********************/

function getQboApiKey_() {
  const apiKey = String(PropertiesService.getScriptProperties().getProperty(INVOICE_CONFIG.apiKeyProperty) || '').trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + INVOICE_CONFIG.apiKeyProperty);
  return apiKey;
}

function getInvoiceControlSpreadsheet_() {
  const spreadsheetId = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(INVOICE_ENTITY_CONTROL.spreadsheetIdProperty) || ''
  ).trim();

  if (!spreadsheetId) {
    throw new Error(
      'Missing Script Property: ' +
      INVOICE_ENTITY_CONTROL.spreadsheetIdProperty
    );
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open the QBO control spreadsheet. ' +
      'Property=' +
      INVOICE_ENTITY_CONTROL.spreadsheetIdProperty +
      ', error=' +
      error.message
    );
  }
}

function getInvoiceEntityPushEndpointUrl_() {
  const endpointUrl = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        INVOICE_ENTITY_CONTROL.pushEndpointUrlProperty
      ) || ''
  ).trim();

  if (!endpointUrl) {
    throw new Error(
      'Missing Script Property: ' +
      INVOICE_ENTITY_CONTROL.pushEndpointUrlProperty
    );
  }

  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(endpointUrl)) {
    throw new Error(
      'Invoice push endpoint must be the deployed Web App URL ending in /exec. ' +
      'CurrentValue=' +
      endpointUrl
    );
  }

  return endpointUrl;
}

function getInvoiceEntityPushSecret_() {
  const secret = String(
    PropertiesService
      .getScriptProperties()
      .getProperty(
        INVOICE_ENTITY_CONTROL.pushSecretProperty
      ) || ''
  ).trim();

  if (!secret) {
    throw new Error(
      'Missing Script Property: ' +
      INVOICE_ENTITY_CONTROL.pushSecretProperty
    );
  }

  if (secret.length < 32) {
    throw new Error(
      'Invoice entity push secret must contain at least 32 characters.'
    );
  }

  return secret;
}