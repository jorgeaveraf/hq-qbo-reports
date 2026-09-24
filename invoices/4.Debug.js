/***********************
 * QBO Invoices - Debug and Administration
 ***********************/

function debugInvoiceEntityConfiguration() {
  const loaded = loadInvoiceEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps =
    buildInvoiceEntityAuthorizationMaps_(configuration);

  const result = {
    event: 'invoice_entity_configuration_loaded',
    source: loaded.source,
    reportKey: configuration.report_key,
    configurationVersion:
      configuration.configuration_version,
    configurationHash:
      configuration.configuration_hash,
    publishedAt:
      configuration.published_at,
    entityCount:
      configuration.entities.length,
    firstWordAuthorizationCount:
      Object.keys(
        authorizationMaps.firstWordAliases
      ).length,
    clientIdAuthorizationCount:
      Object.keys(
        authorizationMaps.clientIdAliases
      ).length,
    firstWordAliases:
      authorizationMaps.firstWordAliases,
    clientIdAliases:
      authorizationMaps.clientIdAliases
  };

  Logger.log(JSON.stringify(result, null, 2));

  return result;
}

function debugFilteredClients() {
  const loadedEntityConfiguration =
    loadInvoiceEntityConfiguration_();

  const clientsById = fetchClients_(
    loadedEntityConfiguration
  );

  const filteredClients = Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) => {
      const entityDifference = String(
        left.entityAlias
      ).localeCompare(String(right.entityAlias));

      if (entityDifference) return entityDifference;

      return String(left.name).localeCompare(
        String(right.name)
      );
    });

  const clientsByEntity = {};
  const clientsByMatchType = {};

  filteredClients.forEach(client => {
    clientsByEntity[client.entityAlias] =
      (clientsByEntity[client.entityAlias] || 0) + 1;

    clientsByMatchType[client.authorizationMatchType] =
      (clientsByMatchType[client.authorizationMatchType] || 0) + 1;
  });

  const result = {
    event: 'invoice_filtered_clients_debug',
    configurationSource:
      loadedEntityConfiguration.source,
    configurationVersion:
      loadedEntityConfiguration.configuration.configuration_version,
    configurationHash:
      loadedEntityConfiguration.configuration.configuration_hash,
    authorizedEntityCount:
      loadedEntityConfiguration.configuration.entities.length,
    totalFilteredClients:
      filteredClients.length,
    clientsByEntity: clientsByEntity,
    clientsByMatchType: clientsByMatchType,
    clients: filteredClients
  };

  Logger.log(JSON.stringify(result, null, 2));

  return result;
}

function debugInvoiceSnapshotAssembly() {
  const result = buildInvoiceSnapshot_();

  if (!result || !Array.isArray(result.lineRows)) {
    throw new Error(
      'Invoice snapshot assembly did not return a valid lineRows array.'
    );
  }

  if (!result.lineRows.length) {
    throw new Error(
      'Invoice snapshot assembly returned zero rows. ' +
      'BigQuery was not modified.'
    );
  }

  const clients = {};
  const entities = {};
  const invoiceIds = {};

  result.lineRows.forEach((row, index) => {
    const clientId = String(row.ClientId || '').trim();
    const clientName = String(row.ClientName || '').trim();
    const entity = String(row.Entity || '').trim();
    const invoiceId = String(row.InvoiceId || '').trim();

    if (!clientId) {
      throw new Error(
        'Snapshot row ' + index + ' is missing ClientId.'
      );
    }

    if (!entity) {
      throw new Error(
        'Snapshot row ' + index + ' is missing Entity.'
      );
    }

    if (!invoiceId) {
      throw new Error(
        'Snapshot row ' + index + ' is missing InvoiceId.'
      );
    }

    clients[clientId] = {
      clientName: clientName,
      rowCount: (clients[clientId] && clients[clientId].rowCount || 0) + 1
    };

    entities[entity] = (entities[entity] || 0) + 1;
    invoiceIds[clientId + '|' + invoiceId] = true;
  });

  const output = {
    event: 'invoice_snapshot_assembly_debug',
    bigQueryModified: false,
    period: result.range,
    entityConfiguration: result.entityConfiguration,
    clientCount: result.clientCount,
    observedClientCount: Object.keys(clients).length,
    invoiceCount: Object.keys(invoiceIds).length,
    rowCount: result.lineRows.length,
    rowsByEntity: entities,
    clients: clients,
    sourceDiagnostics: result.sourceDiagnostics,
    mappingWarnings: result.mappingWarnings,
    schemaMonitoring: result.schemaMonitoring
  };

  Logger.log(JSON.stringify(output, null, 2));

  return output;
}

function initializeInvoiceEntityPushSecret() {
  const properties =
    PropertiesService.getScriptProperties();

  const existingSecret = String(
    properties.getProperty(
      INVOICE_ENTITY_CONTROL.pushSecretProperty
    ) || ''
  ).trim();

  if (existingSecret) {
    return {
      status: 'already_exists',
      property:
        INVOICE_ENTITY_CONTROL.pushSecretProperty,
      secretLength: existingSecret.length
    };
  }

  const secret = sha256Hex_([
    Utilities.getUuid(),
    Utilities.getUuid(),
    Date.now(),
    Session.getScriptTimeZone()
  ].join('|'));

  properties.setProperty(
    INVOICE_ENTITY_CONTROL.pushSecretProperty,
    secret
  );

  return {
    status: 'created',
    property:
      INVOICE_ENTITY_CONTROL.pushSecretProperty,
    secretLength: secret.length
  };
}

function debugInvoiceEntityPushEndpoint() {
  const endpointUrl = getInvoiceEntityPushEndpointUrl_();
  const secret = getInvoiceEntityPushSecret_();
  const loaded = loadInvoiceEntityConfiguration_();
  const configuration = loaded.configuration;

  const pushPayload = {
    contract_type:
      INVOICE_ENTITY_CONTROL.pushContractType,
    contract_version:
      INVOICE_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(),
    report_key:
      INVOICE_ENTITY_CONTROL.reportKey,
    configuration_version:
      configuration.configuration_version,
    configuration_hash:
      configuration.configuration_hash,
    sent_at: new Date().toISOString(),
    configuration: configuration
  };

  const serializedPayload =
    JSON.stringify(pushPayload);

  const envelope = {
    contract_type:
      INVOICE_ENTITY_CONTROL.pushEnvelopeContractType,
    contract_version:
      INVOICE_ENTITY_CONTROL.pushEnvelopeContractVersion,
    payload: serializedPayload,
    signature: hmacSha256Hex_(
      serializedPayload,
      secret
    )
  };

  const response = UrlFetchApp.fetch(
    endpointUrl,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(envelope),
      muteHttpExceptions: true,
      followRedirects: true
    }
  );

  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();

  let parsedBody;

  try {
    parsedBody = JSON.parse(responseBody);
  } catch (error) {
    parsedBody = {
      success: false,
      status: 'invalid_response',
      rawResponse: responseBody
    };
  }

  const result = {
    event: 'invoice_entity_push_endpoint_debug',
    endpointUrl: endpointUrl,
    responseCode: responseCode,
    response: parsedBody
  };

  Logger.log(JSON.stringify(result, null, 2));

  if (
    responseCode < 200 ||
    responseCode >= 300 ||
    parsedBody.success !== true
  ) {
    throw new Error(
      'Invoice entity push endpoint test failed: ' +
      JSON.stringify(result)
    );
  }

  return result;
}

function debugRefreshInvoiceEntityConfigurationFromCentral() {
  const loaded =
    refreshInvoiceEntityConfigurationFromCentral_();

  const result = {
    event:
      'invoice_entity_configuration_manual_refresh_completed',
    source: loaded.source,
    reportKey:
      loaded.configuration.report_key,
    configurationVersion:
      loaded.configuration.configuration_version,
    configurationHash:
      loaded.configuration.configuration_hash,
    entityCount:
      loaded.configuration.entities.length,
    persistence:
      loaded.persistence
  };

  Logger.log(JSON.stringify(result, null, 2));

  return result;
}

function debugClearInvoiceEntityConfigurationCache() {
  CacheService
    .getScriptCache()
    .remove(
      INVOICE_ENTITY_CONTROL.cacheKey
    );

  const result = {
    event:
      'invoice_entity_configuration_cache_cleared',
    cacheKey:
      INVOICE_ENTITY_CONTROL.cacheKey
  };

  Logger.log(JSON.stringify(result, null, 2));

  return result;
}


/***********************
 * Invoice Operational Deployment Debug
 ***********************/

function initializeInvoiceOperationalDeployment() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the Invoice spreadsheet before running this function.');

  PropertiesService.getScriptProperties().setProperty(
    INVOICE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,
    spreadsheet.getId()
  );
  SpreadsheetApp.enableBigQueryExecution();

  const existingWorkerTriggerCount = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === INVOICE_OPERATIONAL_DEPLOYMENT.workerHandler
  ).length;
  const result = {
    event: 'invoice_operational_deployment_initialized',
    modifiesBigQuery: false,
    refreshExecuted: false,
    spreadsheetIdProperty: INVOICE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    workerHandler: INVOICE_OPERATIONAL_DEPLOYMENT.workerHandler,
    existingWorkerTriggerCount: existingWorkerTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugInvoiceConnectedSheetsInventory() {
  const spreadsheet = getInvoiceReportSpreadsheet_();
  const readStatus = status => {
    const lastExecution = status.getLastExecutionTime();
    const lastRefreshed = status.getLastRefreshedTime();
    return {
      state: String(status.getExecutionState()),
      errorCode: String(status.getErrorCode()),
      errorMessage: String(status.getErrorMessage() || '').trim() || null,
      lastExecutionAt: lastExecution ? lastExecution.toISOString() : null,
      lastRefreshedAt: lastRefreshed ? lastRefreshed.toISOString() : null,
      truncated: status.isTruncated() === true
    };
  };

  const dataSourceSheets = spreadsheet.getDataSourceSheets().map(source => ({
    name: source.asSheet().getName(),
    type: 'data_source_sheet',
    status: readStatus(source.getStatus())
  }));
  const extracts = spreadsheet.getDataSourceTables().map(extract => ({
    name: extract.getRange().getSheet().getName(),
    type: 'extract',
    range: extract.getRange().getA1Notation(),
    status: readStatus(extract.getStatus())
  }));

  const result = {
    event: 'invoice_connected_sheets_inventory_debug',
    modifiesBigQuery: false,
    refreshExecuted: false,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    dataSourceSheetCount: dataSourceSheets.length,
    extractCount: extracts.length,
    dataSourceSheets: dataSourceSheets,
    extracts: extracts
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugInvoiceConfigurationDeployment() {
  const state = readInvoiceDeploymentState_();
  const result = state
    ? { event: 'invoice_configuration_deployment_debug', ...state }
    : { event: 'invoice_configuration_deployment_debug', status: 'not_found' };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugQueueCurrentInvoiceConfigurationDeployment() {
  const loaded = loadInvoiceEntityConfiguration_();
  const deployment = queueInvoiceConfigurationDeployment_(
    { request_id: Utilities.getUuid() },
    loaded.configuration
  );
  const result = {
    event: 'invoice_configuration_deployment_queued_manually',
    modifiesBigQuery: false,
    ...deployment
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunInvoiceConfigurationDeploymentStage() {
  const state = readInvoiceDeploymentState_();
  const currentStage = state && state.currentStage || null;
  const result = processInvoiceConfigurationDeployment();
  const output = {
    event: 'invoice_configuration_deployment_stage_debug',
    stageBeforeExecution: currentStage,
    modifiesBigQuery: currentStage === 'bigquery',
    refreshesConnectedSheets: currentStage === 'data_source_sheets' || currentStage === 'extracts',
    result: result
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function debugRequeueFailedInvoiceConfigurationDeployment() {
  const state = readInvoiceDeploymentState_();
  if (!state || state.status !== 'failed') {
    throw new Error('No failed Invoice configuration deployment is available for explicit requeue.');
  }
  const deployment = queueInvoiceConfigurationDeployment_(
    { request_id: Utilities.getUuid() },
    state.configuration,
    { forceRequeueFailed: true }
  );
  const result = {
    event: 'invoice_configuration_deployment_requeued_explicitly',
    modifiesBigQuery: false,
    ...deployment
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugInvoiceDeploymentTriggers() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === INVOICE_OPERATIONAL_DEPLOYMENT.workerHandler
  ).map(trigger => ({
    triggerId: trigger.getUniqueId(),
    handlerFunction: trigger.getHandlerFunction(),
    eventType: String(trigger.getEventType()),
    triggerSource: String(trigger.getTriggerSource())
  }));
  const result = {
    event: 'invoice_configuration_deployment_triggers_debug',
    modifiesBigQuery: false,
    triggerCount: triggers.length,
    triggers: triggers
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugCleanupInvoiceDeploymentTriggers() {
  const deletedTriggerCount = deleteInvoiceDeploymentWorkerTriggers_();
  const result = {
    event: 'invoice_configuration_deployment_triggers_cleaned',
    modifiesBigQuery: false,
    deletedTriggerCount: deletedTriggerCount,
    warning: 'A pending operation will not continue automatically until it is explicitly queued again.'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugResetInvoiceConfigurationDeployment() {
  PropertiesService.getScriptProperties().deleteProperty(
    INVOICE_OPERATIONAL_DEPLOYMENT.statePropertyKey
  );
  const deletedTriggerCount = deleteInvoiceDeploymentWorkerTriggers_();
  const result = {
    event: 'invoice_configuration_deployment_reset',
    modifiesBigQuery: false,
    statePropertyKey: INVOICE_OPERATIONAL_DEPLOYMENT.statePropertyKey,
    deletedTriggerCount: deletedTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}