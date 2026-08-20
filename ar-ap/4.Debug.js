/***********************
 * Central Configuration Debug
 ***********************/

function initializeAgingEntityPushSecret() {
  const properties = PropertiesService.getScriptProperties();
  const existing = String(properties.getProperty(AGING_ENTITY_CONTROL.pushSecretProperty) || '').trim();
  const secret = existing || agingSha256Hex_(Utilities.getUuid() + '|' + Utilities.getUuid() + '|' + Date.now());
  if (!existing) properties.setProperty(AGING_ENTITY_CONTROL.pushSecretProperty, secret);

  const result = {
    event: 'aging_entity_push_secret_initialized',
    created: !existing,
    property: AGING_ENTITY_CONTROL.pushSecretProperty,
    secret: secret
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRefreshAgingEntityConfigurationFromCentral() {
  const result = refreshAgingEntityConfigurationFromCentral_();
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAgingEntityConfiguration() {
  const loaded = loadAgingEntityConfiguration_();
  const result = {
    event: 'aging_entity_configuration_debug',
    source: loaded.source,
    reportKey: loaded.configuration.report_key,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    publishedAt: loaded.configuration.published_at,
    entityCount: loaded.configuration.entities.length,
    entities: loaded.configuration.entities
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugClearAgingEntityConfigurationCache() {
  CacheService.getScriptCache().remove(AGING_ENTITY_CONTROL.cacheKey);
  const result = {
    event: 'aging_entity_configuration_cache_cleared',
    cacheKey: AGING_ENTITY_CONTROL.cacheKey
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugFilteredClients() {
  const selection = resolveAgingEntitySelection_();
  const filteredClients = Object.keys(selection.clientsById).map(clientId => {
    const client = selection.clientsById[clientId];
    return {
      id: client.id,
      name: client.name,
      entity: client.entity,
      outputSheetName: client.outputSheetName,
      authorizationMatchType: client.authorizationMatchType
    };
  });

  const result = {
    event: 'aging_filtered_clients_debug',
    entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
    sourceClientCount: selection.sourceClients.length,
    filteredClientCount: filteredClients.length,
    clientIdMatchCount: selection.clientIdMatchCount,
    firstWordMatchCount: selection.firstWordMatchCount,
    clients: filteredClients
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugEnsureAgingOutputSheets() {
  const selection = resolveAgingEntitySelection_();
  const spreadsheet = getTargetSpreadsheet_();
  const aliases = [...new Set(Object.keys(selection.clientsById).map(id => selection.clientsById[id].outputSheetName))];
  const results = aliases.map(alias => {
    const existed = Boolean(spreadsheet.getSheetByName(alias));
    const sheet = getOrCreateAgingSheet_(spreadsheet, alias);
    return { sheetName: sheet.getName(), status: existed ? 'existing' : 'created' };
  });

  const result = {
    event: 'aging_output_sheets_ensured',
    entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
    sheetCount: results.length,
    sheets: results
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAgingSnapshotAssembly() {
  const selection = resolveAgingEntitySelection_();
  const clientsById = selection.clientsById;
  const clientResults = [];
  let rowCount = 0;

  Object.keys(clientsById).forEach(clientId => {
    const client = clientsById[clientId];
    const reportResults = [];

    ['customer', 'vendor'].forEach(reportKind => {
      const payload = fetchReport_(clientId, reportKind);
      if (!payload) {
        reportResults.push({ reportKind, reportType: reportKind === 'customer' ? 'AR' : 'AP', rowCount: 0, payloadAvailable: false });
        return;
      }

      const asOfDate = extractAsOfDate_(payload);
      const rows = mapToExportRows_(flattenReport_(payload), client, reportKind, asOfDate);
      rowCount += rows.length;
      reportResults.push({
        reportKind,
        reportType: reportKind === 'customer' ? 'AR' : 'AP',
        asOfDate,
        rowCount: rows.length,
        payloadAvailable: true
      });
    });

    clientResults.push({
      clientId: client.id,
      clientName: client.name,
      entity: client.entity,
      outputSheetName: client.outputSheetName,
      reports: reportResults
    });
  });

  const result = {
    event: 'aging_snapshot_assembly_debug',
    bigQueryModified: false,
    sheetsModified: false,
    entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
    clientCount: Object.keys(clientsById).length,
    rowCount: rowCount,
    clientResults: clientResults
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAgingEntityPushEndpoint() {
  const endpointUrl = String(
    PropertiesService.getScriptProperties().getProperty(AGING_ENTITY_CONTROL.pushEndpointUrlProperty) || ''
  ).trim();
  if (!endpointUrl) throw new Error('Missing Script Property: ' + AGING_ENTITY_CONTROL.pushEndpointUrlProperty);

  const configuration = loadAgingEntityConfiguration_().configuration;
  const pushPayload = {
    contract_type: AGING_ENTITY_CONTROL.pushContractType,
    contract_version: AGING_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(),
    report_key: AGING_ENTITY_CONTROL.reportKey,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: new Date().toISOString(),
    configuration: configuration
  };

  const serializedPayload = JSON.stringify(pushPayload);
  const envelope = {
    contract_type: AGING_ENTITY_CONTROL.pushEnvelopeContractType,
    contract_version: AGING_ENTITY_CONTROL.pushEnvelopeContractVersion,
    payload: serializedPayload,
    signature: agingHmacSha256Hex_(serializedPayload, getAgingEntityPushSecret_())
  };

  const response = UrlFetchApp.fetch(endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(envelope),
    muteHttpExceptions: true,
    followRedirects: true
  });

  const responseText = response.getContentText();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch (error) {
    responseBody = { success: false, status: 'invalid_response', rawResponse: responseText };
  }

  const result = {
    event: 'aging_entity_push_endpoint_debug',
    endpointUrl: endpointUrl,
    responseCode: response.getResponseCode(),
    response: responseBody
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/***********************
 * Existing Report Debug
 ***********************/
function debugFirstRowsByEntity() {
  Logger.log('--- DEBUG FIRST ROWS BY ENTITY START ---');

  const clientsById = fetchClients_();
  const clientIds = Object.keys(clientsById);

  if (!clientIds.length) {
    Logger.log('No hay clientes filtrados para depurar.');
    Logger.log('--- DEBUG FIRST ROWS BY ENTITY END ---');
    return;
  }

  clientIds.forEach(clientId => {
    const client = clientsById[clientId];
    const entity = client.entity || slugifyEntity_(client.name);

    Logger.log(
      'Entity=' +
        entity +
        ', clientId=' +
        clientId +
        ', clientName=' +
        client.name +
        ', outputSheetName=' +
        client.outputSheetName
    );

    ['customer', 'vendor'].forEach(reportKind => {
      const reportType = reportKind === 'customer' ? 'AR' : 'AP';
      const payload = fetchReport_(clientId, reportKind);

      if (!payload) {
        Logger.log(reportType + ': sin payload');
        return;
      }

      const asOfDate = extractAsOfDate_(payload);
      const flatRows = flattenReport_(payload);

      if (!flatRows.length) {
        Logger.log(reportType + ': sin filas');
        return;
      }

      const exportRows = mapToExportRows_(flatRows, client, reportKind, asOfDate);

      if (!exportRows.length) {
        Logger.log(reportType + ': sin filas exportables');
        return;
      }

      Logger.log(
        reportType + ' first row: ' + JSON.stringify(exportRowToObject_(exportRows[0]), null, 2)
      );
    });
  });

  Logger.log('--- DEBUG FIRST ROWS BY ENTITY END ---');
}
function exportRowToObject_(row) {
  const out = {};

  for (let i = 0; i < EXPORT_COLUMNS.length; i++) {
    out[EXPORT_COLUMNS[i]] = row[i];
  }

  return out;
}
function debugRawReportRowsForClientName() {
  const targetFirstWord = 'primetime'; // cambia esto si quieres debuggear otra entity
  const maxRowsToLog = 25;

  const url = QBO_CONFIG.baseUrl + '/clients';
  const payload = fetchJsonOrThrow_(url, '/clients');
  const clients = extractClientsArray_(payload);

  const matchedClients = clients.filter(client => {
    const name = String(
      client.name || client.clientName || client.displayName || client.companyName || ''
    ).trim();

    return getFirstWordNormalized_(name) === targetFirstWord;
  });

  Logger.log('Clientes encontrados para firstWord=' + targetFirstWord + ': ' + matchedClients.length);

  matchedClients.forEach(client => {
    const clientId = String(client.id || client.clientId || client.client_id || '').trim();
    const clientName = String(
      client.name || client.clientName || client.displayName || client.companyName || ''
    ).trim();

    Logger.log('--- CLIENT DEBUG ---');
    Logger.log('clientId=' + clientId);
    Logger.log('clientName=' + clientName);

    ['customer', 'vendor'].forEach(reportKind => {
      Logger.log('--- RAW REPORT DEBUG: ' + reportKind + ' ---');

      const payload = fetchReport_(clientId, reportKind);
      if (!payload) {
        Logger.log('Sin payload para reportKind=' + reportKind);
        return;
      }

      Logger.log('Header: ' + JSON.stringify(payload.data && payload.data.Header ? payload.data.Header : payload.Header, null, 2));

      const columns =
        payload &&
        payload.data &&
        payload.data.Columns &&
        payload.data.Columns.Column
          ? payload.data.Columns.Column
          : [];

      Logger.log('Columns: ' + JSON.stringify(columns, null, 2));

      const rows = [];
      collectRawRowsRecursive_(
        payload && payload.data && payload.data.Rows ? payload.data.Rows.Row : [],
        '',
        rows
      );

      Logger.log('Raw data rows found: ' + rows.length);

      rows.slice(0, maxRowsToLog).forEach((row, idx) => {
        Logger.log('--- Row #' + (idx + 1) + ' ---');
        Logger.log('Counterparty: ' + row.counterpartyName);
        Logger.log('Raw ColData: ' + JSON.stringify(row.colData, null, 2));

        const compact = row.colData.map((cell, cellIdx) => {
          return {
            idx: cellIdx,
            value: cell && cell.value ? cell.value : '',
            id: cell && cell.id ? cell.id : ''
          };
        });

        Logger.log('Compact ColData: ' + JSON.stringify(compact, null, 2));
      });
    });
  });
}
function collectRawRowsRecursive_(rows, inheritedCounterparty, out) {
  if (!Array.isArray(rows)) return;

  rows.forEach(row => {
    const sectionCounterparty =
      (row.Header && row.Header.ColData && row.Header.ColData[0] && row.Header.ColData[0].value) ||
      inheritedCounterparty ||
      '';

    const nestedRows = row.Rows && row.Rows.Row;

    if (Array.isArray(nestedRows) && nestedRows.length) {
      collectRawRowsRecursive_(nestedRows, sectionCounterparty, out);
    }

    const colData = row.ColData;
    if (!Array.isArray(colData) || !colData.length) return;
    if (isNonDataRow_(row, colData)) return;

    out.push({
      counterpartyName: sectionCounterparty,
      colData: colData
    });
  });
}
function debugBigQueryTarget() {
  const result = {
    event: 'aging_bigquery_target_checked',
    success: false,
    projectId: BQ_CONFIG.projectId,
    datasetId: BQ_CONFIG.datasetId,
    tableId: BQ_CONFIG.tableId
  };

  try {
    const dataset = BigQuery.Datasets.get(
      BQ_CONFIG.projectId,
      BQ_CONFIG.datasetId
    );

    const table = BigQuery.Tables.get(
      BQ_CONFIG.projectId,
      BQ_CONFIG.datasetId,
      BQ_CONFIG.tableId
    );

    result.success = true;
    result.datasetLocation = dataset.location || '';
    result.tableType = table.type || '';
    result.numRows = table.numRows || '0';
    result.partitioning = table.timePartitioning || null;
    result.clustering = table.clustering || null;
  } catch (error) {
    result.error = String(
      error && error.message ? error.message : error
    );
  }

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


/***********************
 * Operational Deployment Debug
 ***********************/

function debugAgingConfigurationDeployment() {
  const state = readAgingDeploymentState_();
  const result = { event: 'aging_configuration_deployment_debug', modifiesBigQuery: false, modifiesSheets: false, createsTriggers: false, state };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

function debugRunAgingConfigurationDeploymentWorker() {
  const result = { event: 'aging_configuration_deployment_worker_debug', modifiesBigQuery: true, modifiesSheets: true, createsTriggers: true, execution: processAgingConfigurationDeployment() };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

function debugRunAgingDeploymentStage(stage) {
  const normalizedStage = String(stage || '').trim();
  if (!['bigquery', 'data_source_sheets', 'extracts'].includes(normalizedStage)) throw new Error('Stage must be bigquery, data_source_sheets, or extracts.');
  const state = readAgingDeploymentState_(); if (!state) throw new Error('No Aging deployment state exists.');
  const result = { event: 'aging_configuration_deployment_stage_debug', stage: normalizedStage, modifiesBigQuery: normalizedStage === 'bigquery', modifiesSheets: normalizedStage !== 'bigquery', createsTriggers: false, execution: executeAgingDeploymentStage_(normalizedStage, state) };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

function debugAgingDeploymentTriggers() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === AGING_OPERATIONAL_DEPLOYMENT.workerHandler).map(trigger => ({ triggerId: trigger.getUniqueId(), handlerFunction: trigger.getHandlerFunction(), eventType: String(trigger.getEventType()), triggerSource: String(trigger.getTriggerSource()) }));
  const result = { event: 'aging_configuration_deployment_triggers_debug', modifiesBigQuery: false, modifiesSheets: false, createsTriggers: false, triggerCount: triggers.length, triggers };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

function debugCleanupAgingDeploymentTriggers() {
  const deletedCount = deleteAgingDeploymentWorkerTriggers_();
  const result = { event: 'aging_configuration_deployment_triggers_cleaned', modifiesBigQuery: false, modifiesSheets: false, createsTriggers: false, deletedCount };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

function debugAgingConnectedSheetsObjects() {
  const spreadsheet = getAgingReportSpreadsheet_();
  const sourceSheets = spreadsheet.getDataSourceSheets().map(source => ({ name: source.asSheet().getName(), type: 'data_source_sheet' }));
  const extracts = spreadsheet.getDataSourceTables().map(table => ({ name: table.getRange().getSheet().getName(), type: 'extract', range: table.getRange().getA1Notation() }));
  const result = { event: 'aging_connected_sheets_objects_debug', modifiesBigQuery: false, modifiesSheets: false, createsTriggers: false, spreadsheetId: spreadsheet.getId(), sourceSheets, extracts };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}

/***********************
 * Timeout-Resilient Aging Debug
 ***********************/

function initializeAgingOperationalDeployment() {
  const spreadsheet = getTargetSpreadsheet_();

  PropertiesService.getScriptProperties().setProperty(
    AGING_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,
    spreadsheet.getId()
  );

  const result = {
    event: 'aging_operational_deployment_initialized',
    spreadsheetIdProperty:
      AGING_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    workerHandler: AGING_OPERATIONAL_DEPLOYMENT.workerHandler,
    checkpointPropertyKey:
      AGING_OPERATIONAL_DEPLOYMENT.checkpointPropertyKey,
    maxClientsPerExecution:
      AGING_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution,
    executionBudgetMs: AGING_OPERATIONAL_DEPLOYMENT.executionBudgetMs,
    watchdogDelayMs: AGING_OPERATIONAL_DEPLOYMENT.watchdogDelayMs
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAgingBigQueryCheckpoint() {
  const checkpoint = readAgingBigQueryCheckpoint_();
  const result = {
    event: 'aging_bigquery_checkpoint_debug',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    checkpoint
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAgingBigQueryBatchAssembly() {
  const loaded = loadAgingEntityConfiguration_();
  const range = buildAgingSnapshotRange_();
  const loadedAt = new Date().toISOString();
  const snapshotClients = getAgingSnapshotClients_(loaded);
  const clients = snapshotClients.clients.slice(
    0,
    AGING_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution
  );

  const clientResults = clients.map(client => {
    const snapshot = buildAgingClientSnapshot_(client, range, loadedAt);
    return {
      clientId: client.id,
      clientName: client.name,
      entity: client.entityAlias || client.entity,
      rowCount: snapshot.rowCount,
      uniqueRowCount: snapshot.uniqueRowCount,
      reportRowCounts: snapshot.reportRowCounts,
      openAmount: {
        AR: snapshot.openAmountCents.AR / 100,
        AP: snapshot.openAmountCents.AP / 100
      }
    };
  });

  const result = {
    event: 'aging_bigquery_batch_assembly_debug',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    period: range,
    maxClientsPerExecution:
      AGING_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution,
    totalFilteredClientCount: snapshotClients.clients.length,
    assembledClientCount: clientResults.length,
    clients: clientResults
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunAgingBigQueryContinuation() {
  const state = readAgingDeploymentState_();
  if (!state) throw new Error('No Aging deployment state exists.');
  if (state.current_stage !== 'bigquery') {
    throw new Error(
      'The current Aging deployment stage is not bigquery. Current=' +
        state.current_stage
    );
  }

  const execution = processAgingConfigurationDeployment();
  const result = {
    event: 'aging_bigquery_continuation_debug',
    modifiesBigQuery: true,
    modifiesSheets: false,
    createsTriggers: true,
    execution
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugCleanupAgingBigQueryCheckpoint() {
  const checkpoint = readAgingBigQueryCheckpoint_();
  const deleted = deleteAgingBigQueryCheckpoint_(
    checkpoint && checkpoint.operation_id || null
  );
  const result = {
    event: 'aging_bigquery_checkpoint_cleaned',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    deleted
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugResetAgingConfigurationDeployment() {
  const properties = PropertiesService.getScriptProperties();
  const state = readAgingDeploymentState_();
  const checkpoint = readAgingBigQueryCheckpoint_();
  properties.deleteProperty(AGING_OPERATIONAL_DEPLOYMENT.statePropertyKey);
  properties.deleteProperty(AGING_OPERATIONAL_DEPLOYMENT.checkpointPropertyKey);
  const deletedTriggerCount = deleteAgingDeploymentWorkerTriggers_();

  const result = {
    event: 'aging_configuration_deployment_reset',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    stateDeleted: Boolean(state),
    checkpointDeleted: Boolean(checkpoint),
    deletedTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
