/***********************
 * QBO Balance Sheet - Debug and Administration
 ***********************/

function debugBalanceEntityConfiguration() {
  const loaded = loadBalanceEntityConfiguration_();
  const result = {
    event: 'balance_entity_configuration_debug',
    source: loaded.source,
    reportKey: BALANCE_ENTITY_CONTROL.reportKey,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    publishedAt: loaded.configuration.published_at,
    entityCount: loaded.configuration.entities.length,
    entities: loaded.configuration.entities
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugRefreshBalanceEntityConfigurationFromCentral() {
  const refreshed = refreshBalanceEntityConfigurationFromCentral_();
  const result = {
    event: 'balance_entity_configuration_manual_refresh_completed',
    source: refreshed.source,
    reportKey: BALANCE_ENTITY_CONTROL.reportKey,
    configurationVersion: refreshed.configuration.configuration_version,
    configurationHash: refreshed.configuration.configuration_hash,
    entityCount: refreshed.configuration.entities.length,
    persistence: refreshed.persistence
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugClearBalanceEntityConfigurationCache() {
  CacheService.getScriptCache().remove(BALANCE_ENTITY_CONTROL.cacheKey);
  const result = {
    event: 'balance_entity_configuration_cache_cleared',
    cacheKey: BALANCE_ENTITY_CONTROL.cacheKey
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function debugBalanceSheetSnapshotAssembly() {
  const result = buildBalanceSheetSnapshot_();
  const output = {
    event: 'balance_sheet_snapshot_assembly_debug',
    bigQueryModified: false,
    entityConfiguration: result.entityConfiguration,
    clientCount: result.clientCount,
    rawRowCount: result.rawRows.length,
    lineRowCount: result.lineRows.length,
    sheetRowCount: result.sheetRows.length
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}
function initializeBalanceEntityPushSecret() {
  const properties = PropertiesService.getScriptProperties();
  const existingSecret = String(
    properties.getProperty(BALANCE_ENTITY_CONTROL.pushSecretProperty) || ''
  ).trim();
  if (existingSecret) {
    return {
      status: 'already_exists',
      property: BALANCE_ENTITY_CONTROL.pushSecretProperty,
      secretLength: existingSecret.length
    };
  }
  const secret = sha256Hex_([
    Utilities.getUuid(),
    Utilities.getUuid(),
    Date.now(),
    Session.getScriptTimeZone()
  ].join('|'));
  properties.setProperty(BALANCE_ENTITY_CONTROL.pushSecretProperty, secret);
  return {
    status: 'created',
    property: BALANCE_ENTITY_CONTROL.pushSecretProperty,
    secretLength: secret.length
  };
}
function debugBalanceEntityPushEndpoint() {
  const endpointUrl = getBalanceEntityPushEndpointUrl_();
  const secret = getBalanceEntityPushSecret_();
  const loaded = loadBalanceEntityConfiguration_();
  const configuration = loaded.configuration;
  const pushPayload = {
    contract_type: BALANCE_ENTITY_CONTROL.pushContractType,
    contract_version: BALANCE_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(), report_key: BALANCE_ENTITY_CONTROL.reportKey,
    configuration_version: configuration.configuration_version, configuration_hash: configuration.configuration_hash,
    sent_at: new Date().toISOString(), configuration
  };
  const serializedPayload = JSON.stringify(pushPayload);
  const envelope = { contract_type: BALANCE_ENTITY_CONTROL.pushEnvelopeContractType, contract_version: BALANCE_ENTITY_CONTROL.pushEnvelopeContractVersion, payload: serializedPayload, signature: hmacSha256Hex_(serializedPayload, secret) };
  const response = UrlFetchApp.fetch(endpointUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(envelope), muteHttpExceptions: true, followRedirects: true });
  const responseCode = response.getResponseCode();
  let parsedBody; try { parsedBody = JSON.parse(response.getContentText()); } catch (error) { parsedBody = { success: false, status: 'invalid_response', rawResponse: response.getContentText() }; }
  const result = { event: 'balance_entity_push_endpoint_debug', endpointUrl, responseCode, response: parsedBody };
  Logger.log(JSON.stringify(result, null, 2));
  if (responseCode < 200 || responseCode >= 300 || parsedBody.success !== true || !['queued','idempotent'].includes(parsedBody.status)) throw new Error('Balance Sheet entity push endpoint test failed: ' + JSON.stringify(result));
  return result;
}
function debugFilteredClients() {
  const selection = resolveBalanceEntitySelection_();
  const clients = Object.keys(selection.clientsById)
    .map(clientId => selection.clientsById[clientId])
    .sort((left, right) => left.name.localeCompare(right.name));

  const result = {
    event: 'balance_sheet_filtered_clients_debug',
    entityConfiguration: selection.entityConfiguration,
    sourceClientCount: selection.sourceClientCount,
    filteredClientCount: clients.length,
    clients
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


function debugBalanceBigQueryTargets() {
  const schemaValidation = validateBalanceSheetBigQuerySchema_();
  const result = {
    event: 'balance_sheet_bigquery_targets_debug',
    modifiesBigQuery: false,
    snapshot: {
      table: BALANCE_SNAPSHOT_TABLE,
      location: getBalanceBigQueryLocation_(BQ_CONFIG.snapshotsDatasetId)
    },
    audit: {
      table: BALANCE_AUDIT_TABLE,
      location: getBalanceBigQueryLocation_(BQ_CONFIG.auditDatasetId)
    },
    schemaValidation
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


/***********************
 * Operational Deployment Debug
 ***********************/

function debugBalanceConfigurationDeployment() {
  const state = readBalanceDeploymentState_();
  const result = { event: 'balance_sheet_configuration_deployment_debug', modifiesBigQuery: false, modifiesConnectedSheets: false, state: state ? summarizeBalanceDeploymentState_(state) : null };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}
function debugRunBalanceConfigurationDeploymentStage() {
  const before = readBalanceDeploymentState_();
  const result = processBalanceConfigurationDeployment();
  const after = readBalanceDeploymentState_();
  const output = { event: 'balance_sheet_configuration_deployment_manual_worker_debug', bigQueryModified: before && before.currentStage === 'bigquery', connectedSheetsModified: before && ['data_source_sheets','extracts'].includes(before.currentStage), result, state: after ? summarizeBalanceDeploymentState_(after) : null };
  Logger.log(JSON.stringify(output, null, 2)); return output;
}
function debugInspectBalanceDeploymentTriggers() {
  const result = { event: 'balance_sheet_configuration_deployment_triggers_debug', modifiesBigQuery: false, triggers: inspectBalanceDeploymentWorkerTriggers_() };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}
function debugCleanupBalanceDeploymentTriggers() {
  const deletedCount = deleteBalanceDeploymentWorkerTriggers_();
  const result = { event: 'balance_sheet_configuration_deployment_triggers_cleaned', modifiesBigQuery: false, deletedCount };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}
function debugBalanceConnectedSheetsInventory() {
  const spreadsheet = getBalanceReportSpreadsheet_();
  const result = {
    event: 'balance_sheet_connected_sheets_inventory', modifiesBigQuery: false, modifiesConnectedSheets: false,
    dataSourceSheets: spreadsheet.getDataSourceSheets().map(source => source.asSheet().getName()),
    extracts: spreadsheet.getDataSourceTables().map(table => table.getRange().getSheet().getName())
  };
  Logger.log(JSON.stringify(result, null, 2)); return result;
}
function debugRequeueFailedBalanceConfigurationDeployment() {
  const state = readBalanceDeploymentState_();
  if (!state) throw new Error('No Balance Sheet deployment state exists.');
  if (state.status !== 'failed') throw new Error('Only a failed Balance Sheet deployment can be explicitly requeued. Current=' + state.status);
  const stage = state.currentStage;
  state.status = 'pending'; state.lastError = null; state.updatedAt = new Date().toISOString(); state.stages[stage].status = 'pending'; state.stages[stage].error = null; state.stages[stage].retryScheduled = true;
  persistBalanceDeploymentState_(state); scheduleBalanceDeploymentWorker_(BALANCE_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs);
  const result = summarizeBalanceDeploymentState_(state); Logger.log(JSON.stringify(result, null, 2)); return result;
}