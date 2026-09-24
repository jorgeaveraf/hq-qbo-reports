/***********************
 * QBO Profit and Loss - Debug and Administration
 ***********************/

function debugProfitAndLossEntityConfigurations() {
  const normal = loadPnlEntityConfiguration_(PNL_VARIANT_NORMAL);
  const byClass = loadPnlEntityConfiguration_(PNL_VARIANT_BY_CLASS);
  const result = {
    event: 'pnl_entity_configurations_debug',
    normal: summarizePnlLoadedConfiguration_(normal),
    byClass: summarizePnlLoadedConfiguration_(byClass)
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function summarizePnlLoadedConfiguration_(loaded) {
  return {
    source: loaded.source,
    reportKey: loaded.definition.reportKey,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    publishedAt: loaded.configuration.published_at,
    entityCount: loaded.configuration.entities.length,
    entities: loaded.configuration.entities
  };
}
function debugRefreshProfitAndLossEntityConfigurationsFromCentral() {
  const spreadsheet = getPnlControlSpreadsheet_();
  const metadata = readPnlCentralMetadata_(spreadsheet);
  const sharedContext = { spreadsheet, metadata };
  const normal = refreshPnlEntityConfigurationFromCentral_(PNL_VARIANT_NORMAL, sharedContext);
  const byClass = refreshPnlEntityConfigurationFromCentral_(PNL_VARIANT_BY_CLASS, sharedContext);
  const result = {
    event: 'pnl_entity_configurations_manual_refresh_completed',
    normal: {
      reportKey: normal.definition.reportKey,
      configurationVersion: normal.configuration.configuration_version,
      configurationHash: normal.configuration.configuration_hash,
      entityCount: normal.configuration.entities.length,
      persistence: normal.persistence
    },
    byClass: {
      reportKey: byClass.definition.reportKey,
      configurationVersion: byClass.configuration.configuration_version,
      configurationHash: byClass.configuration.configuration_hash,
      entityCount: byClass.configuration.entities.length,
      persistence: byClass.persistence
    }
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugClearProfitAndLossEntityConfigurationCaches() {
  const cache = CacheService.getScriptCache();
  const definitions = [
    getPnlEntityControlDefinition_(PNL_VARIANT_NORMAL),
    getPnlEntityControlDefinition_(PNL_VARIANT_BY_CLASS)
  ];
  definitions.forEach(definition => cache.remove(definition.cacheKey));
  const result = {
    event: 'pnl_entity_configuration_caches_cleared',
    cacheKeys: definitions.map(definition => definition.cacheKey)
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugProfitAndLossFilteredClients() {
  const sourceClients = fetchPnlSourceClients_();
  const normal = resolvePnlEntitySelection_(PNL_VARIANT_NORMAL, sourceClients);
  const byClass = resolvePnlEntitySelection_(PNL_VARIANT_BY_CLASS, sourceClients);
  const result = {
    event: 'pnl_filtered_clients_debug',
    sourceClientCount: sourceClients.length,
    normal: {
      entityConfiguration: normal.entityConfiguration,
      clientCount: normal.clients.length,
      clients: normal.clients
    },
    byClass: {
      entityConfiguration: byClass.entityConfiguration,
      clientCount: byClass.clients.length,
      clients: byClass.clients
    }
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function initializePnlEntityPushSecret() {
  const properties = PropertiesService.getScriptProperties();
  const existingSecret = String(
    properties.getProperty(PNL_ENTITY_CONTROL.pushSecretProperty) || ''
  ).trim();
  if (existingSecret) {
    return {
      status: 'already_exists',
      property: PNL_ENTITY_CONTROL.pushSecretProperty,
      secretLength: existingSecret.length
    };
  }
  const secret = sha256Hex_([
    Utilities.getUuid(), Utilities.getUuid(), Date.now(), Session.getScriptTimeZone()
  ].join('|'));
  properties.setProperty(PNL_ENTITY_CONTROL.pushSecretProperty, secret);
  return {
    status: 'created',
    property: PNL_ENTITY_CONTROL.pushSecretProperty,
    secretLength: secret.length
  };
}
function debugPnlEntityPushEndpointNormal() {
  return debugPnlEntityPushEndpoint_(PNL_VARIANT_NORMAL);
}
function debugPnlEntityPushEndpointByClass() {
  return debugPnlEntityPushEndpoint_(PNL_VARIANT_BY_CLASS);
}
function debugPnlEntityPushEndpoint_(variantOrReportKey) {
  const definition = getPnlEntityControlDefinition_(variantOrReportKey);
  const endpointUrl = getPnlEntityPushEndpointUrl_();
  const secret = getPnlEntityPushSecret_();
  const loaded = loadPnlEntityConfiguration_(definition.reportKey);
  const configuration = loaded.configuration;
  const pushPayload = {
    contract_type: PNL_ENTITY_CONTROL.pushContractType,
    contract_version: PNL_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(),
    report_key: definition.reportKey,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: new Date().toISOString(),
    configuration
  };
  const serializedPayload = JSON.stringify(pushPayload);
  const envelope = {
    contract_type: PNL_ENTITY_CONTROL.pushEnvelopeContractType,
    contract_version: PNL_ENTITY_CONTROL.pushEnvelopeContractVersion,
    payload: serializedPayload,
    signature: hmacSha256Hex_(serializedPayload, secret)
  };
  const response = UrlFetchApp.fetch(endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(envelope),
    muteHttpExceptions: true,
    followRedirects: true
  });
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();
  let parsedBody;
  try { parsedBody = JSON.parse(responseBody); }
  catch (error) {
    parsedBody = { success: false, status: 'invalid_response', rawResponse: responseBody };
  }
  const result = {
    event: 'pnl_entity_push_endpoint_debug',
    reportKey: definition.reportKey,
    endpointUrl,
    responseCode,
    response: parsedBody
  };
  Logger.log(JSON.stringify(result, null, 2));
  if (responseCode < 200 || responseCode >= 300 || parsedBody.success !== true) {
    throw new Error('P&L entity push endpoint test failed: ' + JSON.stringify(result));
  }
  return result;
}
function debugProfitAndLossRequests() {
  const range = getPreviousCompletedWeekRange_();
  const sourceClients = fetchPnlSourceClients_();
  const normalSelection = resolvePnlEntitySelection_(PNL_VARIANT_NORMAL, sourceClients);
  const byClassSelection = resolvePnlEntitySelection_(PNL_VARIANT_BY_CLASS, sourceClients);

  if (!normalSelection.clients.length || !byClassSelection.clients.length) {
    throw new Error('No filtered clients were found for one or both P&L request tests.');
  }

  const normalClient = normalSelection.clients[0];
  const byClassClient = byClassSelection.clients[0];
  const normalPayload = fetchProfitAndLossReport_(
    normalClient.id, range.dateFrom, range.dateTo, PNL_VARIANT_NORMAL
  );
  const byClassPayload = fetchProfitAndLossReport_(
    byClassClient.id, range.dateFrom, range.dateTo, PNL_VARIANT_BY_CLASS
  );

  const result = {
    event: 'profit_and_loss_requests_completed',
    period: range,
    normal: {
      entityConfiguration: normalSelection.entityConfiguration,
      client: normalClient,
      response: summarizePnlResponseForDebug_(normalPayload)
    },
    byClass: {
      entityConfiguration: byClassSelection.entityConfiguration,
      client: byClassClient,
      response: summarizePnlResponseForDebug_(byClassPayload)
    }
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function summarizePnlResponseForDebug_(payload) {
  const reportData =
    payload && payload.data
      ? payload.data
      : {};

  const header =
    reportData.Header || {};

  const columns =
    reportData.Columns &&
    Array.isArray(reportData.Columns.Column)
      ? reportData.Columns.Column
      : [];

  const rows =
    reportData.Rows &&
    Array.isArray(reportData.Rows.Row)
      ? reportData.Rows.Row
      : [];

  return {
    clientId: payload.client_id || null,
    realmId: payload.realm_id || null,
    fetchedAt: payload.fetched_at || null,
    latencyMs: payload.latency_ms || null,
    refreshed:
      payload.refreshed === true,
    idempotentReuse:
      payload.idempotent_reuse === true,
    reportName: header.ReportName || null,
    reportBasis: header.ReportBasis || null,
    summarizeColumnsBy:
      header.SummarizeColumnsBy || null,
    startPeriod: header.StartPeriod || null,
    endPeriod: header.EndPeriod || null,
    currency: header.Currency || null,
    columnCount: columns.length,
    topLevelRowCount: rows.length,
    columns: columns.map((column, index) => ({
      index,
      title: column.ColTitle || '',
      type: column.ColType || '',
      key: getPnlColumnKey_(column)
    }))
  };
}
function debugNormalizeProfitAndLossReports() {
  const range = getPreviousCompletedWeekRange_();
  const sourceClients = fetchPnlSourceClients_();
  const normalSelection = resolvePnlEntitySelection_(PNL_VARIANT_NORMAL, sourceClients);
  const byClassSelection = resolvePnlEntitySelection_(PNL_VARIANT_BY_CLASS, sourceClients);

  if (!normalSelection.clients.length || !byClassSelection.clients.length) {
    throw new Error('No filtered clients were found for one or both P&L normalization tests.');
  }

  const normalClient = normalSelection.clients[0];
  const byClassClient = byClassSelection.clients[0];
  const normalPayload = fetchProfitAndLossReport_(
    normalClient.id, range.dateFrom, range.dateTo, PNL_VARIANT_NORMAL
  );
  const byClassPayload = fetchProfitAndLossReport_(
    byClassClient.id, range.dateFrom, range.dateTo, PNL_VARIANT_BY_CLASS
  );
  const normalRows = normalizeProfitAndLossReport_(normalPayload, normalClient, range);
  const byClassRows = normalizeProfitAndLossByClassReport_(byClassPayload, byClassClient, range);
  const reconciliation = reconcilePnlByClassRows_(byClassRows);

  const result = {
    event: 'profit_and_loss_normalization_completed',
    period: range,
    normal: {
      entityConfiguration: normalSelection.entityConfiguration,
      client: normalClient,
      rowCount: normalRows.length,
      lineTypeCounts: countPnlRowsByField_(normalRows, 'LineType'),
      keyMetricCount: normalRows.filter(row => row.IsKeyMetric).length
    },
    byClass: {
      entityConfiguration: byClassSelection.entityConfiguration,
      client: byClassClient,
      rowCount: byClassRows.length,
      lineTypeCounts: countPnlRowsByField_(byClassRows, 'LineType'),
      classRoleCounts: countPnlRowsByField_(byClassRows, 'ClassColumnRole'),
      reconciliation
    }
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugValidateProfitAndLossBigQuerySchemas() {
  const normal =
    validatePnlBigQuerySchema_(
      PNL_VARIANT_NORMAL
    );

  const byClass =
    validatePnlBigQuerySchema_(
      PNL_VARIANT_BY_CLASS
    );

  const result = {
    event:
      'profit_and_loss_bigquery_schema_validation_completed',

    success: true,

    tables: {
      normal,
      byClass
    }
  };

  Logger.log(
    JSON.stringify(
      result,
      null,
      2
    )
  );

  return result;
}
function debugBuildProfitAndLossSnapshots() {
  const range = getPreviousCompletedWeekRange_();
  const loadedAt = new Date().toISOString();
  const sourceClients = fetchPnlSourceClients_();
  const normalSelection = resolvePnlEntitySelection_(PNL_VARIANT_NORMAL, sourceClients);
  const byClassSelection = resolvePnlEntitySelection_(PNL_VARIANT_BY_CLASS, sourceClients);

  const normal = buildProfitAndLossVariantSnapshot_(PNL_VARIANT_NORMAL, {
    range,
    loadedAt,
    clients: normalSelection.clients,
    entityConfiguration: normalSelection.entityConfiguration
  });
  const byClass = buildProfitAndLossVariantSnapshot_(PNL_VARIANT_BY_CLASS, {
    range,
    loadedAt,
    clients: byClassSelection.clients,
    entityConfiguration: byClassSelection.entityConfiguration
  });

  const result = {
    event: 'profit_and_loss_snapshot_build_completed',
    bigQueryModified: false,
    period: range,
    loadedAt,
    normal: {
      entityConfiguration: normal.entityConfiguration,
      clientCount: normal.clientCount,
      rowCount: normal.rowCount,
      uniqueIdempotencyKeyCount: normal.validation.uniqueIdempotencyKeyCount,
      duplicateIdempotencyKeyCount: normal.validation.duplicateIdempotencyKeyCount,
      lineTypeCounts: countPnlRowsByField_(normal.rows, 'LineType'),
      clientResults: normal.clientResults
    },
    byClass: {
      entityConfiguration: byClass.entityConfiguration,
      clientCount: byClass.clientCount,
      rowCount: byClass.rowCount,
      uniqueIdempotencyKeyCount: byClass.validation.uniqueIdempotencyKeyCount,
      duplicateIdempotencyKeyCount: byClass.validation.duplicateIdempotencyKeyCount,
      lineTypeCounts: countPnlRowsByField_(byClass.rows, 'LineType'),
      classRoleCounts: countPnlRowsByField_(byClass.rows, 'ClassColumnRole'),
      reconciliation: {
        checkedLineCount: byClass.reconciliation.checkedLineCount,
        mismatchCount: byClass.reconciliation.mismatchCount
      },
      clientResults: byClass.clientResults
    }
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/***********************
 * Operational Deployment Debug
 ***********************/

function initializeProfitAndLossOperationalDeployment() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Open the QBO Gateway Profit and Loss spreadsheet before running this function.');
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(PNL_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty, spreadsheet.getId());
  SpreadsheetApp.enableBigQueryExecution();
  const targetConfiguration = discoverPnlConnectedSheetTargets_(spreadsheet);
  properties.setProperty(
    PNL_OPERATIONAL_DEPLOYMENT.connectedSheetTargetsProperty,
    JSON.stringify(targetConfiguration)
  );
  const triggers = debugProfitAndLossDeploymentTriggers_();
  const result = {
    event: 'pnl_operational_deployment_initialized',
    modifiesBigQuery: false,
    refreshesConnectedSheets: false,
    spreadsheetIdProperty: PNL_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    workerHandler: PNL_OPERATIONAL_DEPLOYMENT.workerHandler,
    connectedSheetTargets: targetConfiguration,
    activeDeploymentTriggerCount: triggers.activeDeploymentTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugProfitAndLossConnectedSheetsInventory() {
  const result = {
    event: 'pnl_connected_sheets_inventory_debug',
    modifiesBigQuery: false,
    refreshesConnectedSheets: false,
    ...inspectPnlConnectedSheetsInventory_()
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugProfitAndLossConfigurationDeployments() {
  const deployments = getPnlDeploymentDefinitions_().map(definition => {
    const state = readPnlDeploymentState_(definition);
    return {
      reportKey: definition.reportKey,
      statePropertyKey: definition.deploymentStateProperty,
      state: state || null
    };
  });
  const result = {
    event: 'pnl_configuration_deployments_debug',
    modifiesBigQuery: false,
    refreshesConnectedSheets: false,
    deployments
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunProfitAndLossConfigurationDeploymentWorker() {
  const result = processProfitAndLossConfigurationDeployment();
  Logger.log(JSON.stringify({
    event: 'pnl_configuration_deployment_worker_debug',
    modifiesCurrentStage: true,
    mayModifyBigQuery: true,
    mayRefreshConnectedSheets: true,
    result
  }, null, 2));
  return result;
}

function debugRunProfitAndLossConfigurationDeploymentNormal() {
  return debugRunPnlConfigurationDeploymentStage_(PNL_VARIANT_NORMAL);
}

function debugRunProfitAndLossConfigurationDeploymentByClass() {
  return debugRunPnlConfigurationDeploymentStage_(PNL_VARIANT_BY_CLASS);
}

function debugRunPnlConfigurationDeploymentStage_(variantOrReportKey) {
  const definition = getPnlEntityControlDefinition_(variantOrReportKey);
  const state = readPnlDeploymentState_(definition);
  if (!state) throw new Error('No deployment state exists for ' + definition.reportKey + '.');
  const result = processPnlConfigurationDeployment_(definition.reportKey);
  const output = {
    event: 'pnl_configuration_deployment_stage_debug',
    reportKey: definition.reportKey,
    stageBeforeExecution: state.currentStage,
    modifiesBigQuery: state.currentStage === 'bigquery',
    refreshesDataSourceSheets: state.currentStage === 'data_source_sheets',
    refreshesExtracts: state.currentStage === 'extracts',
    result
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function debugProfitAndLossDeploymentTriggers() {
  return debugProfitAndLossDeploymentTriggers_();
}

function debugProfitAndLossDeploymentTriggers_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_OPERATIONAL_DEPLOYMENT.workerHandler)
    .map(trigger => ({
      triggerId: trigger.getUniqueId(),
      handlerFunction: trigger.getHandlerFunction(),
      eventType: String(trigger.getEventType()),
      triggerSource: String(trigger.getTriggerSource())
    }));
  const result = {
    event: 'pnl_configuration_deployment_triggers_debug',
    modifiesBigQuery: false,
    refreshesConnectedSheets: false,
    workerHandler: PNL_OPERATIONAL_DEPLOYMENT.workerHandler,
    activeDeploymentTriggerCount: triggers.length,
    triggers
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugCleanupProfitAndLossDeploymentTriggers() {
  const deletedTriggerCount = deletePnlDeploymentWorkerTriggers_();
  const result = {
    event: 'pnl_configuration_deployment_triggers_cleaned',
    modifiesBigQuery: false,
    refreshesConnectedSheets: false,
    deletedTriggerCount
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRequeueFailedProfitAndLossDeploymentNormal() {
  const result = requeueFailedPnlDeployment_(PNL_VARIANT_NORMAL);
  Logger.log(JSON.stringify({ event: 'pnl_failed_deployment_requeued', ...result }, null, 2));
  return result;
}

function debugRequeueFailedProfitAndLossDeploymentByClass() {
  const result = requeueFailedPnlDeployment_(PNL_VARIANT_BY_CLASS);
  Logger.log(JSON.stringify({ event: 'pnl_failed_deployment_requeued', ...result }, null, 2));
  return result;
}