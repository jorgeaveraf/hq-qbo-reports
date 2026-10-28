/***********************
 * QBO P&L Account Detail - BigQuery, Sheet and schedules
 ***********************/

function runAccountDetailBigQuery_(query) {
  const request = {
    query: String(query),
    useLegacySql: false,
    useQueryCache: false,
    timeoutMs: 200000
  };
  let result = BigQuery.Jobs.query(request, ACCOUNT_DETAIL_CONFIG.projectId);
  const jobId = result.jobReference && result.jobReference.jobId;
  while (result.jobComplete === false) {
    Utilities.sleep(1000);
    result = BigQuery.Jobs.getQueryResults(
      ACCOUNT_DETAIL_CONFIG.projectId,
      jobId,
      { timeoutMs: 200000 }
    );
  }
  if (result.errors && result.errors.length) {
    throw new Error('BigQuery query failed: ' + JSON.stringify(result.errors));
  }
  return result;
}

function accountDetailSqlString_(value) {
  return "'" + accountDetailText_(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function getAccountDetailTableReference_(tableId) {
  return {
    projectId: ACCOUNT_DETAIL_CONFIG.projectId,
    datasetId: ACCOUNT_DETAIL_CONFIG.rawDatasetId,
    tableId: tableId || ACCOUNT_DETAIL_CONFIG.tableId
  };
}

function getAccountDetailTable_() {
  try {
    return BigQuery.Tables.get(
      ACCOUNT_DETAIL_CONFIG.projectId,
      ACCOUNT_DETAIL_CONFIG.rawDatasetId,
      ACCOUNT_DETAIL_CONFIG.tableId
    );
  } catch (error) {
    if (String(error && error.message || error).toLowerCase().indexOf('not found') !== -1) return null;
    throw error;
  }
}

function getAccountDetailRunsTable_() {
  try {
    return BigQuery.Tables.get(
      ACCOUNT_DETAIL_CONFIG.projectId,
      ACCOUNT_DETAIL_CONFIG.rawDatasetId,
      ACCOUNT_DETAIL_CONFIG.runsTableId
    );
  } catch (error) {
    if (String(error && error.message || error).toLowerCase().indexOf('not found') !== -1) return null;
    throw error;
  }
}

function createAccountDetailTable_() {
  const resource = {
    tableReference: getAccountDetailTableReference_(),
    schema: { fields: ACCOUNT_DETAIL_SCHEMA },
    timePartitioning: { type: 'DAY', field: ACCOUNT_DETAIL_CONFIG.partitionField },
    clustering: { fields: ACCOUNT_DETAIL_CONFIG.clusterFields },
    description: 'Canonical QBO P&L transaction detail for configured subaccounts.'
  };
  return BigQuery.Tables.insert(
    resource,
    ACCOUNT_DETAIL_CONFIG.projectId,
    ACCOUNT_DETAIL_CONFIG.rawDatasetId
  );
}

function createAccountDetailRunsTable_() {
  return BigQuery.Tables.insert({
    tableReference: getAccountDetailTableReference_(ACCOUNT_DETAIL_CONFIG.runsTableId),
    schema: { fields: ACCOUNT_DETAIL_RUN_SCHEMA },
    description: 'Successful account-detail scope executions, including valid zero-row scopes.'
  }, ACCOUNT_DETAIL_CONFIG.projectId, ACCOUNT_DETAIL_CONFIG.rawDatasetId);
}

function validateAccountDetailBigQuerySchema_() {
  const table = getAccountDetailTable_();
  if (!table) throw new Error('Missing BigQuery table: ' + ACCOUNT_DETAIL_TABLE);
  const actual = {};
  ((table.schema && table.schema.fields) || []).forEach(field => {
    actual[field.name] = { type: field.type, mode: field.mode || 'NULLABLE' };
  });
  const mismatches = [];
  ACCOUNT_DETAIL_SCHEMA.forEach(field => {
    const found = actual[field.name];
    if (!found || found.type !== field.type || found.mode !== field.mode) {
      mismatches.push({ expected: field, actual: found || null });
    }
  });
  if (mismatches.length || Object.keys(actual).length !== ACCOUNT_DETAIL_SCHEMA.length) {
    throw new Error('Account detail BigQuery schema mismatch: ' + JSON.stringify(mismatches));
  }
  return { status: 'passed', table: ACCOUNT_DETAIL_TABLE, fieldCount: ACCOUNT_DETAIL_SCHEMA.length };
}

function ensureAccountDetailBigQuerySchema_() {
  const table = getAccountDetailTable_();
  if (!table) createAccountDetailTable_();
  if (!getAccountDetailRunsTable_()) createAccountDetailRunsTable_();
  const result = validateAccountDetailBigQuerySchema_();
  result.runsTable = ACCOUNT_DETAIL_RUNS_TABLE;
  return result;
}

function buildAccountDetailScopePredicate_(scope, alias) {
  const prefix = alias ? alias + '.' : '';
  const common = [
    prefix + 'SnapshotType = ' + accountDetailSqlString_(scope.snapshotType),
    prefix + 'ClientId = ' + accountDetailSqlString_(scope.clientId),
    prefix + 'SubAccountId = ' + accountDetailSqlString_(scope.accountId)
  ];
  if (scope.snapshotType !== ACCOUNT_DETAIL_SNAPSHOT_LATEST) {
    common.splice(1, 0,
      prefix + 'SnapshotDate = DATE ' + accountDetailSqlString_(scope.snapshotDate),
      prefix + 'PeriodStart = DATE ' + accountDetailSqlString_(scope.periodStart),
      prefix + 'PeriodEnd = DATE ' + accountDetailSqlString_(scope.periodEnd)
    );
  }
  return common.join(' AND ');
}

function buildAccountDetailAtomicReplaceSql_(targetTable, stagingTable, scopes) {
  if (!Array.isArray(scopes) || !scopes.length) throw new Error('At least one replacement scope is required.');
  const predicate = scopes.map(scope => '(' + buildAccountDetailScopePredicate_(scope, 'T') + ')').join('\n    OR ');
  const quotedColumns = ACCOUNT_DETAIL_EXPORT_COLUMNS.map(name => '`' + name + '`');
  return [
    'MERGE `' + targetTable + '` AS T',
    'USING `' + stagingTable + '` AS S',
    'ON FALSE',
    'WHEN NOT MATCHED BY SOURCE AND (',
    '    ' + predicate,
    ') THEN DELETE',
    'WHEN NOT MATCHED THEN',
    '  INSERT (' + quotedColumns.join(', ') + ')',
    '  VALUES (' + quotedColumns.map(name => 'S.' + name).join(', ') + ')'
  ].join('\n');
}

function createAccountDetailStagingTable_(tableId) {
  const resource = {
    tableReference: getAccountDetailTableReference_(tableId),
    schema: { fields: ACCOUNT_DETAIL_SCHEMA },
    expirationTime: String(Date.now() + 3600000)
  };
  return BigQuery.Tables.insert(
    resource,
    ACCOUNT_DETAIL_CONFIG.projectId,
    ACCOUNT_DETAIL_CONFIG.rawDatasetId
  );
}

function insertAccountDetailStagingRows_(tableId, rows) {
  const batches = [];
  for (let index = 0; index < rows.length; index += 500) batches.push(rows.slice(index, index + 500));
  batches.forEach((batch, batchIndex) => {
    const request = {
      skipInvalidRows: false,
      ignoreUnknownValues: false,
      rows: batch.map(row => {
        const json = {};
        ACCOUNT_DETAIL_EXPORT_COLUMNS.forEach(column => {
          if (row[column] !== null && row[column] !== undefined) {
            json[column] = ['Amount', 'RunningBalance'].includes(column)
              ? String(row[column]) : row[column];
          }
        });
        return { insertId: row.idempotency_key, json: json };
      })
    };
    const response = BigQuery.Tabledata.insertAll(
      request,
      ACCOUNT_DETAIL_CONFIG.projectId,
      ACCOUNT_DETAIL_CONFIG.rawDatasetId,
      tableId
    );
    if (response.insertErrors && response.insertErrors.length) {
      throw new Error('BigQuery staging insert failed at batch ' + batchIndex + ': ' +
        JSON.stringify(response.insertErrors));
    }
  });
  return { rowCount: rows.length, batchCount: batches.length };
}

function replaceAccountDetailScopes_(rows, scopes) {
  const stagingId = '_account_detail_stage_' + Utilities.getUuid().replace(/-/g, '_');
  createAccountDetailStagingTable_(stagingId);
  try {
    const staging = insertAccountDetailStagingRows_(stagingId, rows || []);
    const stagingTable = [
      ACCOUNT_DETAIL_CONFIG.projectId,
      ACCOUNT_DETAIL_CONFIG.rawDatasetId,
      stagingId
    ].join('.');
    runAccountDetailBigQuery_(buildAccountDetailAtomicReplaceSql_(
      ACCOUNT_DETAIL_TABLE, stagingTable, scopes
    ));
    return {
      status: 'completed',
      mode: 'scoped_atomic_replace',
      scopeCount: scopes.length,
      rowCount: rows.length,
      staging: staging
    };
  } finally {
    try {
      BigQuery.Tables.remove(
        ACCOUNT_DETAIL_CONFIG.projectId,
        ACCOUNT_DETAIL_CONFIG.rawDatasetId,
        stagingId
      );
    } catch (error) {
      Logger.log(JSON.stringify({ event: 'account_detail_staging_cleanup_failed', error: error.message }));
    }
  }
}

function readAccountDetailScalar_(result) {
  const fields = result && result.schema && result.schema.fields || [];
  const values = result && result.rows && result.rows[0] && result.rows[0].f || [];
  return fields.reduce((row, field, index) => {
    row[field.name] = values[index] && values[index].v;
    return row;
  }, {});
}

function verifyAccountDetailScopes_(expectedRows, scopes) {
  const predicate = scopes.map(scope => '(' + buildAccountDetailScopePredicate_(scope, '') + ')').join('\n  OR ');
  const result = runAccountDetailBigQuery_([
    'SELECT COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS unique_key_count,',
    '  COUNTIF(TxnDate IS NOT NULL AND (TxnDate < PeriodStart OR TxnDate > PeriodEnd)) AS out_of_period_count',
    'FROM `' + ACCOUNT_DETAIL_TABLE + '`',
    'WHERE ' + predicate
  ].join('\n'));
  const row = readAccountDetailScalar_(result);
  const expectedKeys = Array.from(new Set((expectedRows || []).map(item => item.idempotency_key)));
  const verification = {
    expectedRowCount: expectedRows.length,
    expectedUniqueKeyCount: expectedKeys.length,
    actualRowCount: Number(row.row_count || 0),
    actualUniqueKeyCount: Number(row.unique_key_count || 0),
    outOfPeriodCount: Number(row.out_of_period_count || 0)
  };
  verification.status = verification.actualRowCount === verification.expectedRowCount &&
    verification.actualUniqueKeyCount === verification.actualRowCount &&
    verification.expectedUniqueKeyCount === verification.expectedRowCount &&
    verification.outOfPeriodCount === 0 ? 'passed' : 'failed';
  return verification;
}

function recordAccountDetailRunScopes_(operationId, scopes, rows, configurationHash) {
  const completedAt = new Date().toISOString();
  const statements = scopes.map(scope => {
    const rowCount = (rows || []).filter(row =>
      row.SnapshotType === scope.snapshotType && row.ClientId === scope.clientId &&
      row.SubAccountId === scope.accountId && row.PeriodStart === scope.periodStart &&
      row.PeriodEnd === scope.periodEnd
    ).length;
    const scopeKey = sha256AccountDetail_([
      scope.snapshotType, scope.snapshotDate, scope.periodStart, scope.periodEnd,
      scope.clientId, scope.accountId
    ].join('|'));
    return [
      'MERGE `' + ACCOUNT_DETAIL_RUNS_TABLE + '` T',
      'USING (SELECT ' + accountDetailSqlString_(scopeKey) + ' AS scope_key) S',
      'ON T.scope_key = S.scope_key',
      'WHEN MATCHED THEN UPDATE SET',
      '  operation_id = ' + accountDetailSqlString_(operationId) + ',',
      '  RowCount = ' + rowCount + ',',
      '  ConfigurationHash = ' + accountDetailSqlString_(configurationHash) + ',',
      "  Status = 'COMPLETED',",
      '  CompletedAt = TIMESTAMP ' + accountDetailSqlString_(completedAt),
      'WHEN NOT MATCHED THEN INSERT (',
      '  scope_key, operation_id, SnapshotType, SnapshotDate, PeriodStart, PeriodEnd,',
      '  ClientId, SubAccountId, RowCount, ConfigurationHash, Status, CompletedAt',
      ') VALUES (',
      '  ' + accountDetailSqlString_(scopeKey) + ', ' + accountDetailSqlString_(operationId) + ',',
      '  ' + accountDetailSqlString_(scope.snapshotType) + ', DATE ' + accountDetailSqlString_(scope.snapshotDate) + ',',
      '  DATE ' + accountDetailSqlString_(scope.periodStart) + ', DATE ' + accountDetailSqlString_(scope.periodEnd) + ',',
      '  ' + accountDetailSqlString_(scope.clientId) + ', ' + accountDetailSqlString_(scope.accountId) + ',',
      '  ' + rowCount + ', ' + accountDetailSqlString_(configurationHash) + ", 'COMPLETED',",
      '  TIMESTAMP ' + accountDetailSqlString_(completedAt),
      ')'
    ].join('\n');
  });
  statements.forEach(statement => runAccountDetailBigQuery_(statement));
  return { status: 'recorded', operationId: operationId, scopeCount: scopes.length };
}

function buildAccountDetailViewSql_(viewId, snapshotType) {
  const columns = [
    'SnapshotDate', 'PeriodStart', 'PeriodEnd', 'Entity', 'ClientName',
    'ParentAccountNumber', 'ParentAccountName', 'SubAccountNumber', 'SubAccountName', 'AccountPath',
    'TxnDate', 'TxnType', 'DocNumber', 'Name', 'Location', 'Memo',
    'SplitAccountName', 'Amount', 'RunningBalance',
    'ClientId', 'ParentAccountId', 'SubAccountId', 'TxnId', 'NameId',
    'LocationId', 'SplitAccountId', 'AccountingMethod', 'Currency', 'LoadedAt'
  ];
  return [
    'CREATE OR REPLACE VIEW `' + ACCOUNT_DETAIL_CONFIG.projectId + '.' +
      ACCOUNT_DETAIL_CONFIG.viewsDatasetId + '.' + viewId + '` AS',
    'SELECT',
    '  ' + columns.join(',\n  '),
    'FROM `' + ACCOUNT_DETAIL_TABLE + '`',
    'WHERE SnapshotType = ' + accountDetailSqlString_(snapshotType),
    'QUALIFY ROW_NUMBER() OVER (',
    '  PARTITION BY ClientId, SubAccountId, PeriodStart, PeriodEnd, idempotency_key',
    '  ORDER BY LoadedAt DESC',
    ') = 1'
  ].join('\n');
}

function deployAccountDetailViews_() {
  runAccountDetailBigQuery_(buildAccountDetailViewSql_(
    ACCOUNT_DETAIL_CONFIG.latestViewId, ACCOUNT_DETAIL_SNAPSHOT_LATEST
  ));
  runAccountDetailBigQuery_(buildAccountDetailViewSql_(
    ACCOUNT_DETAIL_CONFIG.monthlyViewId, ACCOUNT_DETAIL_SNAPSHOT_MONTHLY
  ));
  return {
    status: 'passed',
    views: [ACCOUNT_DETAIL_CONFIG.latestViewId, ACCOUNT_DETAIL_CONFIG.monthlyViewId]
  };
}

function getAccountDetailSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const configuredId = accountDetailText_(properties.getProperty(ACCOUNT_DETAIL_SPREADSHEET.idProperty));
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Missing Script Property: ' + ACCOUNT_DETAIL_SPREADSHEET.idProperty);
  properties.setProperty(ACCOUNT_DETAIL_SPREADSHEET.idProperty, active.getId());
  return active;
}

function buildAccountDetailSheetQuery_(viewId) {
  return 'SELECT * FROM `' + ACCOUNT_DETAIL_CONFIG.projectId + '.' +
    ACCOUNT_DETAIL_CONFIG.viewsDatasetId + '.' + viewId + '` ORDER BY Entity, SubAccountNumber, TxnDate, TxnId';
}

function createAccountDetailDataSourceSheet_(spreadsheet, name, viewId) {
  const spec = SpreadsheetApp.newDataSourceSpec()
    .asBigQuery()
    .setProjectId(ACCOUNT_DETAIL_CONFIG.projectId)
    .setRawQuery(buildAccountDetailSheetQuery_(viewId))
    .build();
  const dataSourceSheet = spreadsheet.insertDataSourceSheet(spec);
  dataSourceSheet.asSheet().setName(name);
  return dataSourceSheet;
}

function createAccountDetailExtract_(dataSourceSheet, name) {
  const table = dataSourceSheet.getDataSource().createDataSourceTableOnNewSheet();
  table.syncAllColumns();
  table.setRowLimit(ACCOUNT_DETAIL_SPREADSHEET.extractRowLimit);
  table.getRange().getSheet().setName(name);
  return table;
}

function ensureAccountDetailExtractFilter_(table) {
  if (!table || typeof table.getRange !== 'function') {
    throw new Error('Account Detail extract filter requires a valid DataSourceTable.');
  }
  const range = table.getRange();
  const sheet = range.getSheet();
  if (sheet.getFilter()) {
    return { name: sheet.getName(), status: 'preserved' };
  }
  if (range.getNumRows() < 1 || range.getNumColumns() < 1) {
    throw new Error('Account Detail extract has no range available for its filter: ' + sheet.getName());
  }
  range.createFilter();
  return {
    name: sheet.getName(),
    status: 'created',
    range: range.getA1Notation()
  };
}

function getAccountDetailSheetDefinitions_() {
  return [
    {
      sourceName: ACCOUNT_DETAIL_SPREADSHEET.latestSheetName,
      extractName: ACCOUNT_DETAIL_SPREADSHEET.latestExtractSheetName,
      viewId: ACCOUNT_DETAIL_CONFIG.latestViewId
    },
    {
      sourceName: ACCOUNT_DETAIL_SPREADSHEET.monthlySheetName,
      extractName: ACCOUNT_DETAIL_SPREADSHEET.monthlyExtractSheetName,
      viewId: ACCOUNT_DETAIL_CONFIG.monthlyViewId
    }
  ];
}

function installAccountDetailConnectedSheets_() {
  const spreadsheet = getAccountDetailSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const expected = getAccountDetailSheetDefinitions_();
  const sourceByName = {};
  spreadsheet.getDataSourceSheets().forEach(source => {
    sourceByName[source.asSheet().getName()] = source;
  });
  const createdSources = [];
  expected.forEach(item => {
    if (!sourceByName[item.sourceName]) {
      sourceByName[item.sourceName] = createAccountDetailDataSourceSheet_(
        spreadsheet, item.sourceName, item.viewId
      );
      createdSources.push(item.sourceName);
    }
  });

  const extractByName = {};
  spreadsheet.getDataSourceTables().forEach(table => {
    extractByName[table.getRange().getSheet().getName()] = table;
  });
  const createdExtracts = [];
  expected.forEach(item => {
    if (!extractByName[item.extractName]) {
      extractByName[item.extractName] = createAccountDetailExtract_(
        sourceByName[item.sourceName], item.extractName
      );
      createdExtracts.push(item.extractName);
    }
  });
  const filters = expected.map(item =>
    ensureAccountDetailExtractFilter_(extractByName[item.extractName])
  );

  const targets = {
    spreadsheetId: spreadsheet.getId(),
    sourceSheets: expected.map(item => item.sourceName),
    extracts: expected.map(item => item.extractName)
  };
  PropertiesService.getScriptProperties().setProperty(
    ACCOUNT_DETAIL_SPREADSHEET.targetsProperty, JSON.stringify(targets)
  );
  const defaultSheet = spreadsheet.getSheetByName('Sheet1');
  if (defaultSheet && spreadsheet.getSheets().length > expected.length * 2) {
    spreadsheet.deleteSheet(defaultSheet);
  }
  return {
    status: 'passed',
    spreadsheetId: spreadsheet.getId(),
    created: { sourceSheets: createdSources, extracts: createdExtracts },
    filters: filters,
    targets: targets
  };
}

function getAccountDetailConnectedSheetTargets_() {
  const spreadsheet = getAccountDetailSpreadsheet_();
  const definitions = getAccountDetailSheetDefinitions_();
  const expectedSourceNames = definitions.map(item => item.sourceName);
  const expectedExtractNames = definitions.map(item => item.extractName);
  const sourceSheets = spreadsheet.getDataSourceSheets().filter(source =>
    expectedSourceNames.includes(source.asSheet().getName())
  );
  const extracts = spreadsheet.getDataSourceTables().filter(table =>
    expectedExtractNames.includes(table.getRange().getSheet().getName())
  );
  const actualSourceNames = sourceSheets.map(source => source.asSheet().getName());
  const actualExtractNames = extracts.map(table => table.getRange().getSheet().getName());
  const missingSourceSheets = expectedSourceNames.filter(name => !actualSourceNames.includes(name));
  const missingExtracts = expectedExtractNames.filter(name => !actualExtractNames.includes(name));
  if (missingSourceSheets.length || missingExtracts.length) {
    throw new Error('Connected Sheets targets are incomplete: ' + JSON.stringify({
      expectedSourceNames: expectedSourceNames,
      actualSourceNames: actualSourceNames,
      expectedExtractNames: expectedExtractNames,
      actualExtractNames: actualExtractNames
    }));
  }
  return { spreadsheet: spreadsheet, sourceSheets: sourceSheets, extracts: extracts };
}

function describeAccountDetailDataExecution_(target, name) {
  const status = target.getStatus();
  return {
    name: name,
    state: String(status.getExecutionState()),
    errorCode: String(status.getErrorCode() || 'NONE'),
    errorMessage: accountDetailText_(status.getErrorMessage()),
    truncated: status.isTruncated() === true
  };
}

function assertAccountDetailDataExecutionsPassed_(stage, executions) {
  const failed = executions.filter(item =>
    item.state !== 'SUCCESS' || item.errorCode !== 'NONE' || item.truncated
  );
  if (failed.length) {
    throw new Error('Connected Sheets ' + stage + ' refresh failed: ' + JSON.stringify(failed));
  }
}

function refreshAccountDetailConnectedSheets_() {
  const resolved = getAccountDetailConnectedSheetTargets_();
  SpreadsheetApp.enableBigQueryExecution();
  resolved.sourceSheets.forEach(target => target.refreshData());
  resolved.spreadsheet.waitForAllDataExecutionsCompletion(ACCOUNT_DETAIL_SPREADSHEET.timeoutSeconds);
  const sourceExecutions = resolved.sourceSheets.map(target =>
    describeAccountDetailDataExecution_(target, target.asSheet().getName())
  );
  assertAccountDetailDataExecutionsPassed_('source', sourceExecutions);

  resolved.extracts.forEach(target => target.refreshData());
  resolved.spreadsheet.waitForAllDataExecutionsCompletion(ACCOUNT_DETAIL_SPREADSHEET.timeoutSeconds);
  const extractExecutions = resolved.extracts.map(target =>
    describeAccountDetailDataExecution_(target, target.getRange().getSheet().getName())
  );
  assertAccountDetailDataExecutionsPassed_('extract', extractExecutions);
  const filters = resolved.extracts.map(target => ensureAccountDetailExtractFilter_(target));
  return {
    status: 'passed',
    stages: { sourceSheets: sourceExecutions, extracts: extractExecutions },
    filters: filters
  };
}

function deleteAccountDetailCadenceTriggers_() {
  const handlers = [
    ACCOUNT_DETAIL_CADENCE.dailyHandler,
    ACCOUNT_DETAIL_CADENCE.monthlyHandler,
    ACCOUNT_DETAIL_CADENCE.repairHandler
  ];
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    handlers.includes(trigger.getHandlerFunction())
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function installAccountDetailCadenceTriggers() {
  deleteAccountDetailCadenceTriggers_();
  const daily = ScriptApp.newTrigger(ACCOUNT_DETAIL_CADENCE.dailyHandler)
    .timeBased().everyDays(1).atHour(ACCOUNT_DETAIL_CADENCE.dailyHour).create();
  const monthly = ScriptApp.newTrigger(ACCOUNT_DETAIL_CADENCE.monthlyHandler)
    .timeBased().onMonthDay(ACCOUNT_DETAIL_CADENCE.monthlyDay)
    .atHour(ACCOUNT_DETAIL_CADENCE.monthlyHour).create();
  const repair = ScriptApp.newTrigger(ACCOUNT_DETAIL_CADENCE.repairHandler)
    .timeBased().onWeekDay(ScriptApp.WeekDay[ACCOUNT_DETAIL_CADENCE.repairWeekDay])
    .atHour(ACCOUNT_DETAIL_CADENCE.repairHour).create();
  return {
    status: 'installed',
    timeZone: 'America/Mexico_City',
    daily: { triggerId: daily.getUniqueId(), hour: ACCOUNT_DETAIL_CADENCE.dailyHour },
    monthly: {
      triggerId: monthly.getUniqueId(),
      day: ACCOUNT_DETAIL_CADENCE.monthlyDay,
      hour: ACCOUNT_DETAIL_CADENCE.monthlyHour
    },
    repair: {
      triggerId: repair.getUniqueId(),
      weekDay: ACCOUNT_DETAIL_CADENCE.repairWeekDay,
      hour: ACCOUNT_DETAIL_CADENCE.repairHour
    }
  };
}

function deployAccountDetailReport() {
  const schema = ensureAccountDetailBigQuerySchema_();
  const views = deployAccountDetailViews_();
  const sheets = installAccountDetailConnectedSheets_();
  const cadence = installAccountDetailCadenceTriggers();
  const result = { status: 'completed', schema: schema, views: views, sheets: sheets, cadence: cadence };
  Logger.log(JSON.stringify({ event: 'account_detail_deployment_completed', result: result }));
  return result;
}

