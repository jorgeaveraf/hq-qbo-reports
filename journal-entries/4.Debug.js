/***********************
 * Journal Entries Debug Functions
 ***********************/

function debugJournalEntityConfiguration() {
  const loaded = loadJournalEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildJournalEntityAuthorizationMaps_(configuration);
  const result = {
    event: 'journal_entity_configuration_loaded',
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

function debugFilteredJournalClients() {
  const loadedEntityConfiguration = loadJournalEntityConfiguration_();
  const clientsById = fetchClients_(loadedEntityConfiguration);
  const filteredClients = Object.keys(clientsById).map(clientId => clientsById[clientId]).sort((left, right) => {
    const entityDifference = String(left.entityAlias).localeCompare(String(right.entityAlias));
    return entityDifference || String(left.name).localeCompare(String(right.name));
  });

  const clientsByEntity = {};
  const clientsByMatchType = {};
  filteredClients.forEach(client => {
    clientsByEntity[client.entityAlias] = (clientsByEntity[client.entityAlias] || 0) + 1;
    clientsByMatchType[client.authorizationMatchType] = (clientsByMatchType[client.authorizationMatchType] || 0) + 1;
  });

  const result = {
    event: 'journal_filtered_clients_debug',
    configurationSource: loadedEntityConfiguration.source,
    configurationVersion: loadedEntityConfiguration.configuration.configuration_version,
    configurationHash: loadedEntityConfiguration.configuration.configuration_hash,
    authorizedEntityCount: loadedEntityConfiguration.configuration.entities.length,
    totalFilteredClients: filteredClients.length,
    clientsByEntity,
    clientsByMatchType,
    clients: filteredClients
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugJournalSnapshotAssembly() {
  const result = buildJournalSnapshot_();
  if (!result || !Array.isArray(result.lineRows)) {
    throw new Error('Journal Entries snapshot assembly did not return a valid lineRows array.');
  }

  const clients = {};
  const entities = {};
  const transactions = {};
  result.lineRows.forEach((row, index) => {
    const clientId = String(row.ClientId || '').trim();
    const entity = String(row.Entity || '').trim();
    const transactionId = String(row.TransactionId || '').trim();
    if (!clientId) throw new Error('Snapshot row ' + index + ' is missing ClientId.');
    if (!entity) throw new Error('Snapshot row ' + index + ' is missing Entity.');
    if (!transactionId) throw new Error('Snapshot row ' + index + ' is missing TransactionId.');

    clients[clientId] = {
      clientName: String(row.ClientName || '').trim(),
      rowCount: (clients[clientId] && clients[clientId].rowCount || 0) + 1
    };
    entities[entity] = (entities[entity] || 0) + 1;
    transactions[clientId + '|' + transactionId] = true;
  });

  const output = {
    event: 'journal_snapshot_assembly_debug',
    bigQueryModified: false,
    period: result.range,
    entityConfiguration: result.entityConfiguration,
    clientCount: result.clientCount,
    observedClientCount: Object.keys(clients).length,
    transactionCount: Object.keys(transactions).length,
    rowCount: result.lineRows.length,
    totals: result.totals,
    rowsByEntity: entities,
    clients
  };
  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function initializeJournalEntityPushSecret() {
  const properties = PropertiesService.getScriptProperties();
  const existingSecret = String(properties.getProperty(JOURNAL_ENTITY_CONTROL.pushSecretProperty) || '').trim();
  if (existingSecret) {
    return { status: 'already_exists', property: JOURNAL_ENTITY_CONTROL.pushSecretProperty, secretLength: existingSecret.length };
  }

  const secret = sha256Hex_([Utilities.getUuid(), Utilities.getUuid(), Date.now(), Session.getScriptTimeZone()].join('|'));
  properties.setProperty(JOURNAL_ENTITY_CONTROL.pushSecretProperty, secret);
  return { status: 'created', property: JOURNAL_ENTITY_CONTROL.pushSecretProperty, secretLength: secret.length };
}

function debugJournalEntityPushEndpoint() {
  const endpointUrl = getJournalEntityPushEndpointUrl_();
  const secret = getJournalEntityPushSecret_();
  const loaded = loadJournalEntityConfiguration_();
  const configuration = loaded.configuration;

  const pushPayload = {
    contract_type: JOURNAL_ENTITY_CONTROL.pushContractType,
    contract_version: JOURNAL_ENTITY_CONTROL.pushContractVersion,
    request_id: Utilities.getUuid(),
    report_key: JOURNAL_ENTITY_CONTROL.reportKey,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: new Date().toISOString(),
    configuration
  };
  const serializedPayload = JSON.stringify(pushPayload);
  const envelope = {
    contract_type: JOURNAL_ENTITY_CONTROL.pushEnvelopeContractType,
    contract_version: JOURNAL_ENTITY_CONTROL.pushEnvelopeContractVersion,
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
  try {
    parsedBody = JSON.parse(responseBody);
  } catch (error) {
    parsedBody = { success: false, status: 'invalid_response', rawResponse: responseBody };
  }

  const result = { event: 'journal_entity_push_endpoint_debug', endpointUrl, responseCode, response: parsedBody };
  Logger.log(JSON.stringify(result, null, 2));
  if (responseCode < 200 || responseCode >= 300 || parsedBody.success !== true) {
    throw new Error('Journal Entries entity push endpoint test failed: ' + JSON.stringify(result));
  }
  return result;
}

function debugRefreshJournalEntityConfigurationFromCentral() {
  const loaded = refreshJournalEntityConfigurationFromCentral_();
  const result = {
    event: 'journal_entity_configuration_manual_refresh_completed',
    source: loaded.source,
    reportKey: loaded.configuration.report_key,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    entityCount: loaded.configuration.entities.length,
    persistence: loaded.persistence
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugClearJournalEntityConfigurationCache() {
  CacheService.getScriptCache().remove(JOURNAL_ENTITY_CONTROL.cacheKey);
  const result = { event: 'journal_entity_configuration_cache_cleared', cacheKey: JOURNAL_ENTITY_CONTROL.cacheKey };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function initializeJournalOperationalDeployment() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  if (!spreadsheet) {
    throw new Error(
      'Open the Journal Entries spreadsheet before running this function.'
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .reportSpreadsheetIdProperty,
      spreadsheet.getId()
    );

  SpreadsheetApp.enableBigQueryExecution();

  const workerTriggers =
    ScriptApp
      .getProjectTriggers()
      .filter(trigger =>
        trigger.getHandlerFunction() ===
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .workerHandler
      );

  const checkpoint =
    readJournalBigQueryCheckpoint_();

  const result = {
    event:
      'journal_operational_deployment_initialized',
    modifiesBigQuery: false,
    spreadsheetIdProperty:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .reportSpreadsheetIdProperty,
    spreadsheetId:
      spreadsheet.getId(),
    spreadsheetName:
      spreadsheet.getName(),
    workerHandler:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .workerHandler,
    existingWorkerTriggerCount:
      workerTriggers.length,
    checkpointPropertyKey:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .checkpointPropertyKey,
    checkpointExists:
      Boolean(checkpoint),
    maxClientsPerExecution:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .maxClientsPerExecution,
    executionBudgetMs:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .executionBudgetMs,
    watchdogDelayMs:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .watchdogDelayMs
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugJournalConfigurationDeployment() {
  const state = readJournalDeploymentState_();
  const result = state
    ? { event: 'journal_configuration_deployment_debug', ...state }
    : { event: 'journal_configuration_deployment_debug', status: 'not_found' };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugQueueCurrentJournalConfigurationDeployment() {
  const loaded = loadJournalEntityConfiguration_();
  const deployment = queueJournalConfigurationDeployment_({ request_id: Utilities.getUuid() }, loaded.configuration);
  const result = { event: 'journal_configuration_deployment_queued_manually', ...deployment };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugRunJournalConfigurationDeploymentWorker() {
  const result = processJournalConfigurationDeployment();
  Logger.log(JSON.stringify({ event: 'journal_configuration_deployment_worker_debug', result }, null, 2));
  return result;
}

function debugResetJournalConfigurationDeployment() {
  const properties =
    PropertiesService.getScriptProperties();

  properties.deleteProperty(
    JOURNAL_OPERATIONAL_DEPLOYMENT
      .statePropertyKey
  );

  const checkpointDeleted =
    deleteJournalBigQueryCheckpoint_();
  const deletedTriggerCount =
    deleteJournalDeploymentWorkerTriggers_();

  const result = {
    event:
      'journal_configuration_deployment_reset',
    modifiesBigQuery: false,
    statePropertyKey:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .statePropertyKey,
    checkpointPropertyKey:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .checkpointPropertyKey,
    checkpointDeleted,
    deletedTriggerCount
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}


function debugJournalBigQueryCheckpoint() {
  const checkpoint =
    readJournalBigQueryCheckpoint_();

  const result = checkpoint
    ? {
      event:
        'journal_bigquery_checkpoint_debug',
      modifiesBigQuery: false,
      ...checkpoint
    }
    : {
      event:
        'journal_bigquery_checkpoint_debug',
      modifiesBigQuery: false,
      status: 'not_found'
    };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugJournalBigQueryBatchAssembly() {
  const loaded =
    loadJournalEntityConfiguration_();
  const range =
    getPreviousCompletedWeekRange_();
  const loadedAt =
    new Date().toISOString();
  const clients =
    getJournalSnapshotClients_(loaded);
  const batchClients =
    clients.slice(
      0,
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .maxClientsPerExecution
    );

  const results =
    batchClients.map(client => {
      const snapshot =
        buildJournalClientSnapshot_(
          client,
          range,
          loadedAt
        );

      return {
        clientId:
          client.id,
        clientName:
          client.name,
        entity:
          client.entityAlias,
        transactionCount:
          snapshot.transactionCount,
        accountingTransactionCount:
          snapshot.accountingTransactionCount,
        rowCount:
          snapshot.rowCount,
        debitAmount:
          centsToAmount_(
            snapshot.debitCents
          ),
        creditAmount:
          centsToAmount_(
            snapshot.creditCents
          )
      };
    });

  const output = {
    event:
      'journal_bigquery_batch_assembly_debug',
    modifiesBigQuery: false,
    period: range,
    maxClientsPerExecution:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .maxClientsPerExecution,
    totalFilteredClientCount:
      clients.length,
    assembledClientCount:
      results.length,
    clients: results
  };

  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function debugRunJournalBigQueryContinuation() {
  const result =
    processJournalConfigurationDeployment();

  const output = {
    event:
      'journal_bigquery_continuation_debug',
    modifiesBigQuery: true,
    result
  };

  Logger.log(JSON.stringify(output, null, 2));
  return output;
}

function debugJournalDeploymentTriggers() {
  const triggers =
    ScriptApp
      .getProjectTriggers()
      .filter(trigger =>
        trigger.getHandlerFunction() ===
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .workerHandler
      )
      .map(trigger => ({
        triggerId:
          trigger.getUniqueId(),
        handler:
          trigger.getHandlerFunction(),
        eventType:
          String(trigger.getEventType()),
        triggerSource:
          String(trigger.getTriggerSource())
      }));

  const result = {
    event:
      'journal_deployment_triggers_debug',
    modifiesBigQuery: false,
    workerHandler:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .workerHandler,
    triggerCount:
      triggers.length,
    triggers
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugCleanupJournalBigQueryCheckpoint() {
  const checkpointDeleted =
    deleteJournalBigQueryCheckpoint_();

  const result = {
    event:
      'journal_bigquery_checkpoint_cleaned',
    modifiesBigQuery: false,
    checkpointPropertyKey:
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .checkpointPropertyKey,
    checkpointDeleted
  };

  Logger.log(JSON.stringify(result, null, 2));
  return result;
}