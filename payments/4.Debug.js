/***********************
 * Payments Debug Functions
 ***********************/

function debugPaymentEntityConfiguration() {
  const loaded = loadPaymentEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildPaymentEntityAuthorizationMaps_(configuration);
  const result = {
    event: 'payment_entity_configuration_loaded',
    source: loaded.source,
    reportKey: configuration.report_key,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    publishedAt: configuration.published_at,
    entityCount: configuration.entities.length,
    firstWordAuthorizationCount: Object.keys(authorizationMaps.firstWordAliases).length,
    clientIdAuthorizationCount: Object.keys(authorizationMaps.clientIdAliases).length,
    firstWordAliases: authorizationMaps.firstWordAliases,
    clientIdAliases: authorizationMaps.clientIdAliases
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugFilteredPaymentClients() {
  const loadedEntityConfiguration = loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loadedEntityConfiguration);
  const clients = Object.keys(clientsById).map(clientId => clientsById[clientId]).sort((a, b) => a.entityAlias.localeCompare(b.entityAlias) || a.name.localeCompare(b.name));
  const result = {
    event: 'payment_filtered_clients_debug',
    configurationSource: loadedEntityConfiguration.source,
    configurationVersion: loadedEntityConfiguration.configuration.configuration_version,
    configurationHash: loadedEntityConfiguration.configuration.configuration_hash,
    authorizedEntityCount: loadedEntityConfiguration.configuration.entities.length,
    totalFilteredClients: clients.length,
    clients
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentSnapshotAssembly() {
  const result = buildPaymentSnapshot_(null, { persistSchemaBaselines: false });
  const output = {
    event: 'payment_snapshot_assembly_debug',
    bigQueryModified: false,
    schemaBaselinesModified: false,
    period: result.range,
    entityConfiguration: result.entityConfiguration,
    clientCount: result.clientCount,
    sourcePaymentCount: result.sourcePaymentCount,
    paymentCount: result.paymentCount,
    pageCount: result.pageCount,
    rowCount: result.rows.length,
    hierarchyValidation: result.hierarchyValidation,
    schemaMonitoring: result.schemaMonitoring
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function debugPaymentBackfillPlan() {
  const plan = planPaymentBackfill_({
    startDate: PAYMENT_BACKFILL_CONFIG.startDate
  });
  const result = {
    event: 'payment_backfill_plan_debug',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    today: plan.today,
    periodCount: plan.periodCount,
    firstPeriod: plan.firstPeriod,
    lastPeriod: plan.lastPeriod
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentBackfillPoc() {
  const execution = buildPaymentBackfillPoc_({
    startDate: PAYMENT_BACKFILL_CONFIG.startDate
  });
  const result = {
    event: 'payment_backfill_poc_debug',
    modifiesBigQuery: false,
    modifiesSheets: false,
    createsTriggers: false,
    execution
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentBackfillState() {
  const state = readPaymentBackfillState_();
  const result = state
    ? { event: 'payment_backfill_state_debug', ...summarizePaymentBackfillState_(state, false) }
    : { event: 'payment_backfill_state_debug', status: 'not_found' };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunPaymentBackfillWorker() {
  const result = processPaymentBackfill();
  Logger.log(JSON.stringify({ event: 'payment_backfill_worker_debug', result }, null, 2));
  return result;
}

function debugResetPaymentBackfill() {
  const deletedTriggerCount = deletePaymentBackfillWorkerTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(
    PAYMENT_BACKFILL_CONFIG.statePropertyKey
  );
  const result = {
    event: 'payment_backfill_reset',
    deletedTriggerCount,
    stateDeleted: true
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentBigQuerySchema() {
  const result = validatePaymentBigQuerySchema_();
  Logger.log(JSON.stringify({ event: 'payment_bigquery_schema_debug', ...result }, null, 2));
  return result;
}

function initializePaymentEntityPushSecret() {
  const properties = PropertiesService.getScriptProperties();
  const existingSecret = String(properties.getProperty(PAYMENT_ENTITY_CONTROL.pushSecretProperty) || '').trim();
  if (existingSecret) return { status: 'already_exists', property: PAYMENT_ENTITY_CONTROL.pushSecretProperty, secretLength: existingSecret.length };
  const secret = sha256Hex_([Utilities.getUuid(), Utilities.getUuid(), Date.now(), Session.getScriptTimeZone()].join('|'));
  properties.setProperty(PAYMENT_ENTITY_CONTROL.pushSecretProperty, secret);
  return { status: 'created', property: PAYMENT_ENTITY_CONTROL.pushSecretProperty, secretLength: secret.length };
}

function debugPaymentEntityPushEndpoint() {
  const endpointUrl = getPaymentEntityPushEndpointUrl_();
  const secret = getPaymentEntityPushSecret_();
  const loaded = loadPaymentEntityConfiguration_();
  const configuration = loaded.configuration;
  const pushPayload = {
    contract_type: PAYMENT_ENTITY_CONTROL.pushContractType,
    contract_version: PAYMENT_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(),
    report_key: PAYMENT_ENTITY_CONTROL.reportKey,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: new Date().toISOString(),
    configuration
  };
  const serializedPayload = JSON.stringify(pushPayload);
  const envelope = {
    contract_type: PAYMENT_ENTITY_CONTROL.pushEnvelopeContractType,
    contract_version: PAYMENT_ENTITY_CONTROL.pushEnvelopeContractVersion,
    payload: serializedPayload,
    signature: hmacSha256Hex_(serializedPayload, secret)
  };
  const response = UrlFetchApp.fetch(endpointUrl, { method: 'post', contentType: 'application/json', payload: JSON.stringify(envelope), muteHttpExceptions: true, followRedirects: true });
  const responseCode = response.getResponseCode();
  const responseBody = response.getContentText();
  let parsedBody;
  try { parsedBody = JSON.parse(responseBody); } catch (error) { parsedBody = { success: false, status: 'invalid_response', rawResponse: responseBody }; }
  const result = { event: 'payment_entity_push_endpoint_debug', reportKey: PAYMENT_ENTITY_CONTROL.reportKey, endpointUrl, responseCode, response: parsedBody };
  Logger.log(JSON.stringify(result, null, 2));
  if (responseCode < 200 || responseCode >= 300 || parsedBody.success !== true) throw new Error('Payments entity push endpoint test failed: ' + JSON.stringify(result));
  return result;
}

function debugRefreshPaymentEntityConfigurationFromCentral() {
  const loaded = refreshPaymentEntityConfigurationFromCentral_();
  const result = { event: 'payment_entity_configuration_manual_refresh_completed', source: loaded.source, reportKey: loaded.configuration.report_key, configurationVersion: loaded.configuration.configuration_version, configurationHash: loaded.configuration.configuration_hash, entityCount: loaded.configuration.entities.length, persistence: loaded.persistence };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugClearPaymentEntityConfigurationCache() {
  CacheService.getScriptCache().remove(PAYMENT_ENTITY_CONTROL.cacheKey);
  const result = { event: 'payment_entity_configuration_cache_cleared', cacheKey: PAYMENT_ENTITY_CONTROL.cacheKey };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function initializePaymentOperationalDeployment() {
  const spreadsheet = getTargetSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const existingWorkerTriggerCount = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler).length;
  const result = { event: 'payment_operational_deployment_initialized', spreadsheetIdProperty: 'TARGET_SPREADSHEET_ID', spreadsheetId: spreadsheet.getId(), spreadsheetName: spreadsheet.getName(), workerHandler: PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler, existingWorkerTriggerCount };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentConfigurationDeployment() {
  const state = readPaymentDeploymentState_();
  const result = state ? { event: 'payment_configuration_deployment_debug', ...state } : { event: 'payment_configuration_deployment_debug', status: 'not_found' };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugQueueCurrentPaymentConfigurationDeployment() {
  const loaded = loadPaymentEntityConfiguration_();
  const result = queuePaymentConfigurationDeployment_({ request_id: Utilities.getUuid() }, loaded.configuration);
  Logger.log(JSON.stringify({ event: 'payment_configuration_deployment_debug_queued', ...result }, null, 2));
  return result;
}

function debugRunPaymentConfigurationDeploymentWorker() {
  const result = processPaymentConfigurationDeployment();
  Logger.log(JSON.stringify({ event: 'payment_configuration_deployment_debug_worker', result }, null, 2));
  return result;
}

function debugRequeueFailedPaymentConfigurationDeployment() {
  const state = readPaymentDeploymentState_();
  if (!state) throw new Error('No Payments deployment state exists.');
  if (state.status !== 'failed') throw new Error('The Payments deployment is not failed. CurrentStatus=' + state.status);
  const stage = getNextPaymentDeploymentStage_(state, true);
  if (!stage) throw new Error('No failed Payments stage is available to requeue.');
  state.status = 'pending';
  state.current_stage = stage;
  state.updated_at = new Date().toISOString();
  state.last_error = null;
  state.stages[stage].status = 'pending';
  state.stages[stage].attempts = 0;
  state.stages[stage].error = null;
  persistPaymentDeploymentState_(state);
  schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs);
  return summarizePaymentDeploymentState_(state, true);
}

function debugResetPaymentConfigurationDeployment() {
  const deletedTriggerCount = deletePaymentDeploymentWorkerTriggers_();
  PropertiesService.getScriptProperties().deleteProperty(PAYMENT_OPERATIONAL_DEPLOYMENT.statePropertyKey);
  const result = { event: 'payment_configuration_deployment_reset', deletedTriggerCount, stateDeleted: true };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugPaymentDeploymentTriggers() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler).map(trigger => ({ triggerId: trigger.getUniqueId(), handlerFunction: trigger.getHandlerFunction(), eventType: String(trigger.getEventType()), triggerSource: String(trigger.getTriggerSource()) }));
  const result = { event: 'payment_deployment_triggers_debug', workerHandler: PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler, triggerCount: triggers.length, triggers };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
