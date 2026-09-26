/***********************
 * QBO Profit and Loss - Functions
 ***********************/

function getPnlEntityControlDefinition_(variantOrReportKey) {
  const value = String(variantOrReportKey || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === PNL_VARIANT_NORMAL || value === 'profit_and_loss') {
    return {
      variantKey: PNL_VARIANT_NORMAL,
      ...PNL_ENTITY_CONTROL.reports.normal
    };
  }
  if (value === PNL_VARIANT_BY_CLASS || value === 'profit_and_loss_by_class') {
    return {
      variantKey: PNL_VARIANT_BY_CLASS,
      ...PNL_ENTITY_CONTROL.reports.by_class
    };
  }
  throw new Error('Unsupported P&L entity configuration target: ' + variantOrReportKey);
}
function loadPnlEntityConfiguration_(variantOrReportKey) {
  const definition = getPnlEntityControlDefinition_(variantOrReportKey);
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(definition.cacheKey);

  if (cachedValue) {
    try {
      return {
        source: 'script_cache',
        definition,
        configuration: validatePnlEntityConfiguration_(JSON.parse(cachedValue), definition)
      };
    } catch (error) {
      Logger.log(JSON.stringify({
        event: 'pnl_entity_configuration_cache_invalid',
        reportKey: definition.reportKey,
        error: error.message
      }));
      cache.remove(definition.cacheKey);
    }
  }

  const localConfiguration = readLocalPnlEntityConfiguration_(definition);
  if (!localConfiguration) {
    throw new Error(
      'No valid local entity configuration is available for ' + definition.reportKey + '. ' +
      'Publish the centralized configuration again or run ' +
      'debugRefreshProfitAndLossEntityConfigurationsFromCentral().'
    );
  }

  cachePnlEntityConfiguration_(localConfiguration, definition);
  return {
    source: 'script_properties',
    definition,
    configuration: localConfiguration
  };
}
function refreshPnlEntityConfigurationFromCentral_(variantOrReportKey, sharedContext) {
  const definition = getPnlEntityControlDefinition_(variantOrReportKey);
  const context = sharedContext || {};
  const spreadsheet = context.spreadsheet || getPnlControlSpreadsheet_();
  const metadata = context.metadata || readPnlCentralMetadata_(spreadsheet);
  const configuration = readPublishedPnlEntityConfiguration_(
    spreadsheet, definition, metadata.currentVersion
  );
  const persistence = persistPnlEntityConfiguration_(configuration, definition);
  cachePnlEntityConfiguration_(configuration, definition);

  Logger.log(JSON.stringify({
    event: 'pnl_entity_configuration_refreshed_manually',
    reportKey: definition.reportKey,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return {
    source: 'central_sheet_manual',
    definition,
    configuration,
    persistence
  };
}
function getPnlControlSpreadsheet_() {
  const spreadsheetId = String(
    PropertiesService.getScriptProperties().getProperty(
      PNL_ENTITY_CONTROL.spreadsheetIdProperty
    ) || ''
  ).trim();

  if (!spreadsheetId) {
    throw new Error('Missing Script Property: ' + PNL_ENTITY_CONTROL.spreadsheetIdProperty);
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open the QBO control spreadsheet. Property=' +
      PNL_ENTITY_CONTROL.spreadsheetIdProperty + ', error=' + error.message
    );
  }
}
function readPnlCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(PNL_ENTITY_CONTROL.metadataSheetName);
  if (!sheet) {
    throw new Error('Central metadata sheet not found: ' + PNL_ENTITY_CONTROL.metadataSheetName);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Central configuration metadata is empty.');
  const values = sheet.getRange(2, 1, lastRow - 1, 2).getDisplayValues();
  const metadata = {};
  values.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) metadata[key] = String(row[1] || '').trim();
  });

  const currentVersion = Number(metadata.current_version || 0);
  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error('Central configuration current_version is invalid: ' + metadata.current_version);
  }

  const status = String(metadata.status || '').trim();
  if (!status.startsWith('published')) {
    throw new Error('Central configuration is not published. status=' + status);
  }

  return {
    currentVersion,
    currentHash: String(metadata.current_hash || '').trim(),
    status,
    publishedAt: String(metadata.published_at || '').trim()
  };
}
function readPublishedPnlEntityConfiguration_(spreadsheet, definition, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(PNL_ENTITY_CONTROL.publishedSheetName);
  if (!sheet) {
    throw new Error('Central published sheet not found: ' + PNL_ENTITY_CONTROL.publishedSheetName);
  }

  const expectedHeaders = [
    'Report Key', 'Report Name', 'Configuration Version', 'Configuration Hash',
    'Published At', 'Entity Count', 'Configuration JSON'
  ];
  const actualHeaders = sheet.getRange(1, 1, 1, expectedHeaders.length).getDisplayValues()[0];
  expectedHeaders.forEach((header, index) => {
    if (String(actualHeaders[index] || '').trim() !== header) {
      throw new Error(
        'Unexpected Published Configuration header at column ' + (index + 1) +
        '. Expected="' + header + '", actual="' + actualHeaders[index] + '".'
      );
    }
  });

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error('Published Configuration is empty.');
  const rows = sheet.getRange(2, 1, lastRow - 1, expectedHeaders.length).getDisplayValues();
  const matchingRows = rows.filter(row => String(row[0] || '').trim() === definition.reportKey);
  if (matchingRows.length !== 1) {
    throw new Error(
      'Expected exactly one Published Configuration row for ' + definition.reportKey +
      ', found=' + matchingRows.length
    );
  }

  const row = matchingRows[0];
  const rowVersion = Number(row[2]);
  if (rowVersion !== Number(expectedVersion)) {
    throw new Error(
      'Published configuration version mismatch for ' + definition.reportKey +
      '. Expected=' + expectedVersion + ', actual=' + rowVersion
    );
  }

  let configuration;
  try {
    configuration = JSON.parse(String(row[6] || ''));
  } catch (error) {
    throw new Error(
      'Invalid Configuration JSON for ' + definition.reportKey + ': ' + error.message
    );
  }

  const validated = validatePnlEntityConfiguration_(configuration, definition, expectedVersion);
  if (validated.configuration_hash !== String(row[3] || '').trim()) {
    throw new Error('Published row hash does not match Configuration JSON for ' + definition.reportKey + '.');
  }
  if (validated.entities.length !== Number(row[5])) {
    throw new Error('Published row entity count does not match Configuration JSON for ' + definition.reportKey + '.');
  }
  return validated;
}
function validatePnlEntityConfiguration_(configuration, definitionOrTarget, expectedVersion) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget
    : getPnlEntityControlDefinition_(definitionOrTarget);

  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Entity configuration must be a JSON object.');
  }

  const contractType = String(configuration.contract_type || '').trim();
  const contractVersion = String(configuration.contract_version || '').trim();
  const schemaVersion = String(configuration.schema_version || '').trim();
  const reportKey = String(configuration.report_key || '').trim();
  const configurationVersion = Number(configuration.configuration_version);
  const configurationHash = String(configuration.configuration_hash || '').trim().toLowerCase();
  const publishedAt = String(configuration.published_at || '').trim();

  if (contractType !== PNL_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected entity configuration contract_type: ' + contractType);
  }
  if (contractVersion !== PNL_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected entity configuration contract_version: ' + contractVersion);
  }
  if (schemaVersion !== PNL_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected entity configuration schema_version: ' + schemaVersion);
  }
  if (reportKey !== definition.reportKey) {
    throw new Error(
      'Entity configuration report_key mismatch. Expected=' + definition.reportKey +
      ', actual=' + reportKey
    );
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid configuration_version: ' + configuration.configuration_version);
  }
  if (expectedVersion !== undefined && configurationVersion !== Number(expectedVersion)) {
    throw new Error(
      'Entity configuration version mismatch. Expected=' + expectedVersion +
      ', actual=' + configurationVersion
    );
  }
  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error('Invalid configuration_hash for ' + reportKey + '.');
  }
  if (!publishedAt || isNaN(new Date(publishedAt).getTime())) {
    throw new Error('Invalid published_at for ' + reportKey + '.');
  }
  if (!Array.isArray(configuration.entities)) {
    throw new Error('Entity configuration entities must be an array.');
  }

  const seenMatches = {};
  const entities = configuration.entities.map((entity, index) => {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
      throw new Error('Invalid entity authorization at index ' + index + '.');
    }
    const matchType = String(entity.match_type || '').trim().toLowerCase();
    let matchValue = String(entity.match_value || '').trim();
    const entityAlias = String(entity.entity_alias || '').trim().toLowerCase();

    if (!['first_word', 'client_id'].includes(matchType)) {
      throw new Error('Unsupported match_type at index ' + index + ': ' + matchType);
    }
    if (matchType === 'first_word') matchValue = getPnlFirstWordNormalized_(matchValue);
    if (!matchValue) throw new Error('Missing match_value at index ' + index + '.');
    if (!entityAlias || !/^[a-z0-9_]+$/.test(entityAlias)) {
      throw new Error('Invalid entity_alias at index ' + index + ': ' + entityAlias);
    }

    const matchKey = matchType + '|' + matchValue;
    if (seenMatches[matchKey]) {
      throw new Error('Duplicate entity authorization: ' + matchKey);
    }
    seenMatches[matchKey] = true;
    return { match_type: matchType, match_value: matchValue, entity_alias: entityAlias };
  }).sort((left, right) => {
    const typeDifference = left.match_type.localeCompare(right.match_type);
    return typeDifference || left.match_value.localeCompare(right.match_value);
  });

  if (!entities.length) {
    throw new Error('Entity configuration contains no authorizations for ' + reportKey + '.');
  }

  const calculatedHash = sha256Hex_(JSON.stringify({
    schema_version: schemaVersion,
    report_key: reportKey,
    entities
  }));
  if (calculatedHash !== configurationHash) {
    throw new Error(
      'Entity configuration hash mismatch for ' + reportKey +
      '. Expected=' + configurationHash + ', calculated=' + calculatedHash
    );
  }

  return {
    contract_type: contractType,
    contract_version: contractVersion,
    schema_version: schemaVersion,
    report_key: reportKey,
    configuration_version: configurationVersion,
    configuration_hash: configurationHash,
    published_at: new Date(publishedAt).toISOString(),
    entities
  };
}
function readLocalPnlEntityConfiguration_(definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget
    : getPnlEntityControlDefinition_(definitionOrTarget);
  const serialized = PropertiesService.getScriptProperties().getProperty(definition.localPropertyKey);
  if (!serialized) return null;

  try {
    return validatePnlEntityConfiguration_(JSON.parse(serialized), definition);
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'pnl_local_entity_configuration_invalid',
      reportKey: definition.reportKey,
      error: error.message
    }));
    return null;
  }
}
function persistPnlEntityConfiguration_(configuration, definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget
    : getPnlEntityControlDefinition_(definitionOrTarget);
  const validated = validatePnlEntityConfiguration_(configuration, definition);
  const serialized = JSON.stringify(validated);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PNL_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Entity configuration exceeds the Script Property safe size. reportKey=' +
      definition.reportKey + ', bytes=' + byteCount
    );
  }
  PropertiesService.getScriptProperties().setProperty(definition.localPropertyKey, serialized);
  return { propertyKey: definition.localPropertyKey, byteCount };
}
function cachePnlEntityConfiguration_(configuration, definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget
    : getPnlEntityControlDefinition_(definitionOrTarget);
  const validated = validatePnlEntityConfiguration_(configuration, definition);
  CacheService.getScriptCache().put(
    definition.cacheKey,
    JSON.stringify(validated),
    PNL_ENTITY_CONTROL.cacheTtlSeconds
  );
}
function fetchPnlSourceClients_() {
  const payload = fetchPnlJsonOrThrow_(PNL_CONFIG.baseUrl + '/clients', '/clients');
  const sourceClients = extractPnlClientsArray_(payload);
  const clientsById = {};

  sourceClients.forEach(client => {
    const id = String(client.id || client.clientId || client.client_id || '').trim();
    const name = String(
      client.name || client.clientName || client.displayName || client.companyName || ''
    ).trim();
    if (!id || !name) return;
    clientsById[id] = { id, name, firstWord: getPnlFirstWordNormalized_(name) };
  });

  return Object.keys(clientsById).map(id => clientsById[id]).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}
function resolvePnlEntitySelection_(variantOrReportKey, sourceClients, loadedOverride) {
  const definition = getPnlEntityControlDefinition_(variantOrReportKey);
  let loaded;
  if (loadedOverride) {
    const overrideDefinition = loadedOverride.definition && loadedOverride.definition.reportKey
      ? loadedOverride.definition : definition;
    if (overrideDefinition.reportKey !== definition.reportKey) {
      throw new Error('Loaded P&L configuration belongs to another reportKey. Expected=' +
        definition.reportKey + ', actual=' + overrideDefinition.reportKey);
    }
    loaded = {
      source: String(loadedOverride.source || 'provided_configuration'),
      definition,
      configuration: validatePnlEntityConfiguration_(
        loadedOverride.configuration, definition,
        loadedOverride.configuration && loadedOverride.configuration.configuration_version
      )
    };
  } else {
    loaded = loadPnlEntityConfiguration_(definition.reportKey);
  }

  const clients = Array.isArray(sourceClients) ? sourceClients.slice() : fetchPnlSourceClients_();
  const firstWordAliases = {};
  const clientIdAliases = {};

  loaded.configuration.entities.forEach(entity => {
    if (entity.match_type === 'client_id') clientIdAliases[entity.match_value] = entity.entity_alias;
    else firstWordAliases[entity.match_value] = entity.entity_alias;
  });

  let clientIdMatchCount = 0;
  let firstWordMatchCount = 0;
  const filteredById = {};
  clients.forEach(client => {
    const clientIdAlias = clientIdAliases[client.id];
    const firstWordAlias = firstWordAliases[client.firstWord];
    const entityAlias = clientIdAlias || firstWordAlias;
    if (!entityAlias) return;
    const authorizationMatchType = clientIdAlias ? 'client_id' : 'first_word';
    if (clientIdAlias) clientIdMatchCount++;
    else firstWordMatchCount++;
    filteredById[client.id] = {
      id: client.id, name: client.name, entityAlias, firstWord: client.firstWord,
      authorizationMatchType,
      authorizationMatchValue: clientIdAlias ? client.id : client.firstWord
    };
  });

  const filteredClients = Object.keys(filteredById).map(id => filteredById[id]).sort((a, b) => {
    const entityDifference = a.entityAlias.localeCompare(b.entityAlias);
    return entityDifference || a.name.localeCompare(b.name);
  });
  const entityConfiguration = {
    source: loaded.source,
    reportKey: definition.reportKey,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    publishedAt: loaded.configuration.published_at,
    authorizedEntityCount: loaded.configuration.entities.length
  };

  Logger.log(JSON.stringify({
    event: 'pnl_clients_filtered',
    variant: definition.variantKey,
    configurationSource: loaded.source,
    reportKey: definition.reportKey,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    authorizationEntityCount: loaded.configuration.entities.length,
    sourceClientCount: clients.length,
    filteredClientCount: filteredClients.length,
    clientIdMatchCount,
    firstWordMatchCount
  }));
  return { clients: filteredClients, entityConfiguration, loaded };
}
function doPost(e) {
  try {
    const result = handlePnlEntityConfigurationPush_(e);
    return createPnlJsonResponse_(result);
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'pnl_entity_configuration_push_failed',
      error: error.message,
      stack: error.stack || null
    }));
    return createPnlJsonResponse_({
      success: false,
      status: 'error',
      error: error.message
    });
  }
}
function createPnlJsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function handlePnlEntityConfigurationPush_(e) {
  const rawBody = e && e.postData ? String(e.postData.contents || '') : '';
  if (!rawBody) throw new Error('Push request body is empty.');

  let envelope;
  try { envelope = JSON.parse(rawBody); }
  catch (error) { throw new Error('Push envelope is invalid JSON: ' + error.message); }
  if (String(envelope.contract_type || '') !== PNL_ENTITY_CONTROL.pushEnvelopeContractType) {
    throw new Error('Unexpected push envelope contract_type.');
  }
  if (String(envelope.contract_version || '') !== PNL_ENTITY_CONTROL.pushEnvelopeContractVersion) {
    throw new Error('Unexpected push envelope contract_version.');
  }

  const serializedPayload = String(envelope.payload || '');
  const signature = String(envelope.signature || '').trim().toLowerCase();
  if (!serializedPayload || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Push envelope payload or signature is invalid.');
  }
  const expectedSignature = hmacSha256Hex_(serializedPayload, getPnlEntityPushSecret_());
  if (!secureHexEquals_(signature, expectedSignature)) throw new Error('Push signature validation failed.');

  let pushPayload;
  try { pushPayload = JSON.parse(serializedPayload); }
  catch (error) { throw new Error('Push payload is invalid JSON: ' + error.message); }
  if (String(pushPayload.contract_type || '') !== PNL_ENTITY_CONTROL.pushContractType) {
    throw new Error('Unexpected push payload contract_type.');
  }
  if (String(pushPayload.contract_version || '') !== PNL_ENTITY_CONTROL.pushContractVersion) {
    throw new Error('Unexpected push payload contract_version.');
  }

  const definition = getPnlEntityControlDefinition_(pushPayload.report_key);
  const requestId = String(pushPayload.request_id || '').trim();
  const sentAt = String(pushPayload.sent_at || '').trim();
  if (!requestId) throw new Error('Push request_id is required.');
  if (!sentAt || isNaN(new Date(sentAt).getTime())) throw new Error('Push sent_at is invalid.');
  const ageSeconds = (Date.now() - new Date(sentAt).getTime()) / 1000;
  if (ageSeconds > PNL_ENTITY_CONTROL.pushMaxAgeSeconds) {
    throw new Error('Push request is too old. ageSeconds=' + Math.round(ageSeconds));
  }
  if (ageSeconds < -PNL_ENTITY_CONTROL.pushFutureToleranceSeconds) {
    throw new Error('Push request sent_at is too far in the future.');
  }

  const incomingConfiguration = validatePnlEntityConfiguration_(
    pushPayload.configuration, definition, pushPayload.configuration_version
  );
  if (incomingConfiguration.configuration_hash !== String(pushPayload.configuration_hash || '').trim()) {
    throw new Error('Push configuration_hash does not match the configuration object.');
  }

  const localConfiguration = readLocalPnlEntityConfiguration_(definition);
  const incomingVersion = incomingConfiguration.configuration_version;
  if (localConfiguration) {
    const localVersion = localConfiguration.configuration_version;
    if (incomingVersion < localVersion) {
      throw new Error('Stale configuration rejected. Incoming=' + incomingVersion + ', local=' + localVersion);
    }
    if (incomingVersion === localVersion) {
      if (incomingConfiguration.configuration_hash !== localConfiguration.configuration_hash) {
        throw new Error('Configuration version ' + incomingVersion + ' conflicts with the local hash.');
      }
      cachePnlEntityConfiguration_(incomingConfiguration, definition);
      const existingDeployment = readPnlDeploymentState_(definition);
      const matchingDeployment = existingDeployment &&
        Number(existingDeployment.configurationVersion || 0) === incomingVersion &&
        String(existingDeployment.configurationHash || '') === incomingConfiguration.configuration_hash
        ? summarizePnlDeploymentState_(existingDeployment, false) : null;
      const existingReceipt = readPnlPushReceipt_(definition);
      const matchingReceipt = existingReceipt &&
        Number(existingReceipt.configuration_version || 0) === incomingVersion &&
        String(existingReceipt.configuration_hash || '') === incomingConfiguration.configuration_hash;
      if (matchingDeployment || matchingReceipt) {
        const receipt = persistPnlPushReceipt_(
          pushPayload, incomingConfiguration, definition, 'idempotent', matchingDeployment
        );
        return {
          success: true,
          status: 'idempotent',
          reportKey: definition.reportKey,
          configurationVersion: incomingVersion,
          configurationHash: incomingConfiguration.configuration_hash,
          receipt
        };
      }
    }
  }

  const persistence = persistPnlEntityConfiguration_(incomingConfiguration, definition);
  cachePnlEntityConfiguration_(incomingConfiguration, definition);
  const deployment = queuePnlConfigurationDeployment_(pushPayload, incomingConfiguration, definition);
  const responseStatus = deployment.queued ? 'queued' : 'idempotent';
  const receipt = persistPnlPushReceipt_(
    pushPayload, incomingConfiguration, definition, responseStatus, deployment
  );

  Logger.log(JSON.stringify({
    event: 'pnl_entity_configuration_push_' + responseStatus,
    requestId,
    reportKey: definition.reportKey,
    configurationVersion: incomingVersion,
    configurationHash: incomingConfiguration.configuration_hash,
    entityCount: incomingConfiguration.entities.length,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage,
    byteCount: persistence.byteCount
  }));

  if (responseStatus === 'idempotent') {
    return {
      success: true,
      status: 'idempotent',
      reportKey: definition.reportKey,
      configurationVersion: incomingVersion,
      configurationHash: incomingConfiguration.configuration_hash,
      receipt
    };
  }
  return {
    success: true,
    status: 'queued',
    reportKey: definition.reportKey,
    configurationVersion: incomingVersion,
    configurationHash: incomingConfiguration.configuration_hash,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage,
    receipt
  };
}
function persistPnlPushReceipt_(pushPayload, configuration, definition, status, deployment) {
  const receipt = {
    request_id: pushPayload.request_id,
    report_key: definition.reportKey,
    status,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: pushPayload.sent_at,
    received_at: new Date().toISOString(),
    operation_id: deployment && deployment.operationId || null,
    deployment_status: deployment && deployment.status || null,
    current_stage: deployment && deployment.currentStage || null,
    deployment_updated_at: deployment && deployment.updatedAt || null,
    deployment_completed_at: deployment && deployment.completedAt || null,
    deployment_error: deployment && deployment.lastError || null
  };
  PropertiesService.getScriptProperties().setProperty(
    definition.pushReceiptProperty, JSON.stringify(receipt)
  );
  return receipt;
}
function readPnlPushReceipt_(definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget);
  const serialized = PropertiesService.getScriptProperties().getProperty(definition.pushReceiptProperty);
  if (!serialized) return null;
  try {
    const receipt = JSON.parse(serialized);
    return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? receipt : null;
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'pnl_push_receipt_invalid',
      reportKey: definition.reportKey,
      error: error.message
    }));
    return null;
  }
}
function getPnlEntityPushEndpointUrl_() {
  const endpointUrl = String(
    PropertiesService.getScriptProperties().getProperty(
      PNL_ENTITY_CONTROL.pushEndpointUrlProperty
    ) || ''
  ).trim();
  if (!endpointUrl) {
    throw new Error('Missing Script Property: ' + PNL_ENTITY_CONTROL.pushEndpointUrlProperty);
  }
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(endpointUrl)) {
    throw new Error('P&L push endpoint must be a deployed Web App URL ending in /exec.');
  }
  return endpointUrl;
}
function getPnlEntityPushSecret_() {
  const secret = String(
    PropertiesService.getScriptProperties().getProperty(
      PNL_ENTITY_CONTROL.pushSecretProperty
    ) || ''
  ).trim();
  if (!secret) throw new Error('Missing Script Property: ' + PNL_ENTITY_CONTROL.pushSecretProperty);
  if (secret.length < 32) throw new Error('P&L entity push secret must contain at least 32 characters.');
  return secret;
}
function hmacSha256Hex_(value, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(value), String(secret), Utilities.Charset.UTF_8
  );
  return bytes.map(byte => {
    const unsignedByte = byte < 0 ? byte + 256 : byte;
    return unsignedByte.toString(16).padStart(2, '0');
  }).join('');
}
function secureHexEquals_(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');
  if (leftValue.length !== rightValue.length) return false;
  let difference = 0;
  for (let index = 0; index < leftValue.length; index++) {
    difference |= leftValue.charCodeAt(index) ^ rightValue.charCodeAt(index);
  }
  return difference === 0;
}

function getQboApiKey_() {
  const apiKey = String(PropertiesService.getScriptProperties().getProperty(PNL_CONFIG.apiKeyProperty) || '').trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + PNL_CONFIG.apiKeyProperty);
  return apiKey;
}

function getPnlVariantConfig_(variant) {
  const variantKey = String(variant || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const variantConfig = PNL_CONFIG.variants[variantKey];
  if (!variantConfig) {
    throw new Error('Unsupported P&L variant: ' + variant + '. Accepted variants: ' +
      Object.keys(PNL_CONFIG.variants).join(', '));
  }
  return { variantKey: variantKey, variantConfig: variantConfig };
}

function todayIsoDate_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTimeZone_(), 'yyyy-MM-dd');
}

function getPreviousCompletedWeekRange_(referenceIsoDate) {
  const referenceText = normalizeDateForOutput_(referenceIsoDate || todayIsoDate_());
  const referenceDate = safeParseDate_(referenceText);
  if (!referenceDate) throw new Error('Invalid P&L reference date: ' + referenceIsoDate);
  const currentMonday = new Date(referenceDate.getTime());
  currentMonday.setUTCDate(currentMonday.getUTCDate() - ((currentMonday.getUTCDay() + 6) % 7));
  const dateFrom = new Date(currentMonday.getTime());
  const dateTo = new Date(currentMonday.getTime());
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 7);
  dateTo.setUTCDate(dateTo.getUTCDate() - 1);
  const snapshotDate = formatUtcDate_(currentMonday);
  const snapshotWeek = formatUtcDate_(dateFrom);
  const dateToIso = formatUtcDate_(dateTo);
  return {
    snapshotType: PNL_SNAPSHOT_TYPE_WEEKLY,
    snapshotDate: snapshotDate, snapshotWeek: snapshotWeek, dateFrom: snapshotWeek, dateTo: dateToIso,
    periodKey: snapshotWeek + '|' + dateToIso
  };
}

function formatUtcDate_(date) {
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}

function normalizeDateForOutput_(value) {
  const date = safeParseDate_(value);
  return date ? formatUtcDate_(date) : '';
}

function safeParseDate_(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  const text = String(value).trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = Number(match[3].length === 2 ? '20' + match[3] : match[3]);
    return new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  }
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return null;
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function getSpreadsheetTimeZone_() {
  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    return (spreadsheet && spreadsheet.getSpreadsheetTimeZone()) || Session.getScriptTimeZone() || 'Etc/UTC';
  } catch (error) {
    return Session.getScriptTimeZone() || 'Etc/UTC';
  }
}

/***********************
 * Clients and HTTP
 ***********************/

function fetchPnlClients_(variant) {
  return resolvePnlEntitySelection_(variant || PNL_VARIANT_NORMAL).clients;
}

function extractPnlClientsArray_(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.clients)) return payload.clients;
  if (payload.data && Array.isArray(payload.data.clients)) return payload.data.clients;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  return Array.isArray(payload.items) ? payload.items : [];
}

function getPnlFirstWordNormalized_(value) {
  return String(value || '').trim().toLowerCase().split(/[\s_-]+/).filter(Boolean)[0] || '';
}

function comparePnlClients_(a, b) {
  return String(a.entityAlias || '').localeCompare(String(b.entityAlias || '')) ||
    String(a.name || '').localeCompare(String(b.name || ''));
}

function fetchPnlJsonOrThrow_(url, contextLabel) {
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get', headers: { 'X-API-Key': getQboApiKey_() }, muteHttpExceptions: true
    });
  } catch (error) {
    throw new Error('Network error for ' + contextLabel + ': ' + String(error));
  }
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(contextLabel + ' returned HTTP ' + status + ': ' + body.slice(0, 500));
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('Invalid JSON returned by ' + contextLabel + ': ' + String(error));
  }
}

function buildProfitAndLossUrl_(clientId, dateFrom, dateTo, variant) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedDateFrom = normalizeDateForOutput_(dateFrom);
  const normalizedDateTo = normalizeDateForOutput_(dateTo);
  const variantDefinition = getPnlVariantConfig_(variant);
  if (!normalizedClientId) throw new Error('Client ID is required to build the P&L URL.');
  if (!normalizedDateFrom || !normalizedDateTo) {
    throw new Error('A valid P&L date range is required. dateFrom=' + dateFrom + ', dateTo=' + dateTo);
  }
  if (safeParseDate_(normalizedDateFrom).getTime() > safeParseDate_(normalizedDateTo).getTime()) {
    throw new Error('P&L dateFrom cannot be later than dateTo. ' + normalizedDateFrom + ' > ' + normalizedDateTo);
  }
  const query = [
    'environment=' + encodeURIComponent(PNL_CONFIG.environment),
    'start_date=' + encodeURIComponent(normalizedDateFrom),
    'end_date=' + encodeURIComponent(normalizedDateTo),
    'accounting_method=' + encodeURIComponent(PNL_CONFIG.accountingMethod)
  ];
  if (variantDefinition.variantConfig.summarizeColumnBy) {
    query.push('summarize_column_by=' + encodeURIComponent(variantDefinition.variantConfig.summarizeColumnBy));
  }
  return PNL_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(normalizedClientId) +
    '/reports/profit-and-loss?' + query.join('&');
}

function fetchProfitAndLossReport_(clientId, dateFrom, dateTo, variant) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedDateFrom = normalizeDateForOutput_(dateFrom);
  const normalizedDateTo = normalizeDateForOutput_(dateTo);
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  const context = '/qbo/' + normalizedClientId + '/reports/profit-and-loss [' + variantKey + ']';
  const payload = fetchPnlJsonOrThrow_(
    buildProfitAndLossUrl_(normalizedClientId, normalizedDateFrom, normalizedDateTo, variantKey), context
  );
  validateProfitAndLossResponse_(
    payload, normalizedClientId, normalizedDateFrom, normalizedDateTo, variantKey
  );
  return payload;
}

/***********************
 * Response and Column Validation
 ***********************/

function validateProfitAndLossResponse_(payload, clientId, dateFrom, dateTo, variant) {
  const variantDefinition = getPnlVariantConfig_(variant);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid P&L response for client ' + clientId + '. Expected a JSON object.');
  }
  const responseClientId = String(payload.client_id || '').trim();
  if (responseClientId && responseClientId !== clientId) {
    throw new Error('P&L response client mismatch. Requested=' + clientId + ', received=' + responseClientId);
  }
  const reportData = payload.data;
  if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
    throw new Error('Invalid P&L response for client ' + clientId + '. Expected payload.data.');
  }
  const header = reportData.Header || {};
  const columns = reportData.Columns && Array.isArray(reportData.Columns.Column)
    ? reportData.Columns.Column : null;
  if (String(header.ReportName || '') !== PNL_CONFIG.reportName) {
    throw new Error('Unexpected P&L report name for client ' + clientId + '. Expected=' +
      PNL_CONFIG.reportName + ', received=' + String(header.ReportName || ''));
  }
  if (String(header.ReportBasis || '').trim().toLowerCase() !== PNL_CONFIG.accountingMethod.toLowerCase()) {
    throw new Error('Unexpected P&L accounting method for client ' + clientId + '. Expected=' +
      PNL_CONFIG.accountingMethod + ', received=' + String(header.ReportBasis || ''));
  }
  const expectedSummary = String(variantDefinition.variantConfig.expectedSummarizeColumnsBy).toLowerCase();
  const actualSummary = String(header.SummarizeColumnsBy || '').trim().toLowerCase();
  if (actualSummary !== expectedSummary) {
    throw new Error('Unexpected P&L summarization for client ' + clientId + '. Variant=' +
      variantDefinition.variantKey + ', expected=' + variantDefinition.variantConfig.expectedSummarizeColumnsBy +
      ', received=' + String(header.SummarizeColumnsBy || ''));
  }
  const actualDateFrom = normalizeDateForOutput_(header.StartPeriod);
  const actualDateTo = normalizeDateForOutput_(header.EndPeriod);
  if (actualDateFrom !== dateFrom || actualDateTo !== dateTo) {
    throw new Error('P&L response period mismatch for client ' + clientId + '. Requested=' + dateFrom + '|' + dateTo +
      ', received=' + String(header.StartPeriod || '') + '|' + String(header.EndPeriod || ''));
  }
  if (!columns || !columns.length) {
    throw new Error('Invalid P&L columns for client ' + clientId + '. Expected at least an Account column.');
  }
  const hasAccount = columns.some(column => {
    const key = getPnlColumnKey_(column).trim().toLowerCase();
    const type = String(column.ColType || '').trim().toLowerCase();
    return key === 'account' || type === 'account';
  });
  if (!hasAccount) throw new Error('Invalid P&L columns for client ' + clientId + '. Account column was not found.');
  const moneyColumnCount = columns.filter(column =>
    String(column.ColType || '').trim().toLowerCase() === 'money').length;
  if (!moneyColumnCount && !isPnlNoDataReport_(reportData)) {
    throw new Error('Invalid P&L columns for client ' + clientId +
      '. Financial rows were returned without a Money column.');
  }
}

function getPnlColumnKey_(column) {
  const metadata = column && Array.isArray(column.MetaData) ? column.MetaData : [];
  const entry = metadata.find(item => String(item.Name || '').trim().toLowerCase() === 'colkey');
  return entry ? String(entry.Value || '') : '';
}

function getPnlColumnDefinitions_(reportData, variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  const columns = reportData && reportData.Columns && Array.isArray(reportData.Columns.Column)
    ? reportData.Columns.Column : [];
  const definitions = columns.map((column, index) => ({
    index: index, title: String(column.ColTitle || '').trim(),
    type: String(column.ColType || '').trim(), key: getPnlColumnKey_(column)
  }));
  const accountColumn = definitions.find(column =>
    column.key.toLowerCase() === 'account' || column.type.toLowerCase() === 'account');
  if (!accountColumn) throw new Error('P&L response does not contain an Account column.');
  const isNoData = isPnlNoDataReport_(reportData);
  const moneyColumns = definitions.filter(column => column.type.toLowerCase() === 'money').map(column => {
    const result = Object.assign({}, column);
    result.role = variantKey === PNL_VARIANT_NORMAL ? 'total' : classifyPnlClassColumn_(column);
    return result;
  });
  if (!moneyColumns.length && !isNoData) throw new Error('P&L response does not contain Money columns.');
  if (!isNoData && variantKey === PNL_VARIANT_NORMAL && moneyColumns.length !== 1) {
    throw new Error('P&L Normal must contain exactly one Money column. Received=' + moneyColumns.length);
  }
  if (!isNoData && variantKey === PNL_VARIANT_BY_CLASS) {
    const totalCount = moneyColumns.filter(column =>
      column.role === PNL_CLASS_COLUMN_ROLES.grandTotal).length;
    if (totalCount !== 1) {
      throw new Error('P&L by Class must contain exactly one TOTAL column. Received=' + totalCount);
    }
  }
  return {
    columns: definitions, accountColumnIndex: accountColumn.index,
    moneyColumns: moneyColumns, isNoData: isNoData
  };
}

function classifyPnlClassColumn_(column) {
  const title = String(column.title || '').trim();
  const key = String(column.key || '').trim();
  if (key.toLowerCase() === 'total' || title.toLowerCase() === 'total') {
    return PNL_CLASS_COLUMN_ROLES.grandTotal;
  }
  if (key.toLowerCase() === 'not_specified' || title.toLowerCase() === 'not specified') {
    return PNL_CLASS_COLUMN_ROLES.notSpecified;
  }
  return /^total(?:\s|$)/i.test(title)
    ? PNL_CLASS_COLUMN_ROLES.classSubtotal : PNL_CLASS_COLUMN_ROLES.directClass;
}

/***********************
 * Recursive Report Normalization
 ***********************/

function buildPnlLogicalLines_(reportData, variant) {
  const columnDefinitions = getPnlColumnDefinitions_(reportData, variant);
  const rootRows = reportData && reportData.Rows && Array.isArray(reportData.Rows.Row)
    ? reportData.Rows.Row : [];
  const logicalLines = [];
  let sourceOrder = 0;

  function appendLine_(colData, lineType, context, rowPath, fallbackId, fallbackName, pathPrefix) {
    if (!hasPnlColData_(colData)) return;
    const accountCell = colData[columnDefinitions.accountColumnIndex] || {};
    const accountName = String(accountCell.value || fallbackName || '').trim();
    const accountId = String(accountCell.id || fallbackId || '').trim();
    const effectiveName = accountName || context.statementSection || context.groupName || 'Unlabeled P&L Line';
    const accountPath = (pathPrefix || context.accountPath || []).concat(effectiveName);
    const normalizedMetric = getPnlNormalizedMetric_(effectiveName);
    logicalLines.push({
      colData: colData, groupName: context.groupName || null,
      statementSection: context.statementSection || effectiveName,
      statementSubsection: context.statementSubsection || null,
      parentAccountId: context.parentAccount && context.parentAccount.id ? context.parentAccount.id : null,
      parentAccountName: context.parentAccount && context.parentAccount.name ? context.parentAccount.name : null,
      accountId: accountId || null, accountName: effectiveName, accountPath: accountPath.join(' > '),
      lineType: lineType, level: context.level, rowPath: rowPath, rowOrder: sourceOrder++,
      normalizedMetric: normalizedMetric || null, metricName: normalizedMetric ? effectiveName : null,
      isKeyMetric: Boolean(normalizedMetric)
    });
  }

  function walkRows_(rows, context, parentPath) {
    rows.forEach((row, index) => {
      if (!row || typeof row !== 'object') return;
      const nodePath = parentPath ? parentPath + '.' + index : String(index);
      const groupName = String(row.group || context.groupName || '').trim() || null;
      const groupLabel = getPnlGroupLabel_(groupName);
      const headerColData = row.Header && Array.isArray(row.Header.ColData) ? row.Header.ColData : null;
      const headerCell = headerColData ? headerColData[columnDefinitions.accountColumnIndex] || {} : {};
      const headerName = String(headerCell.value || '').trim();
      const headerId = String(headerCell.id || '').trim();
      let statementSection = context.statementSection || null;
      let statementSubsection = context.statementSubsection || null;
      if (!statementSection) statementSection = headerName || groupLabel || null;
      else if (!statementSubsection && headerName && context.level > 0) statementSubsection = headerName;
      const nodeContext = {
        groupName: groupName, statementSection: statementSection, statementSubsection: statementSubsection,
        parentAccount: context.parentAccount, accountPath: context.accountPath.slice(), level: context.level
      };
      if (headerColData) {
        appendLine_(headerColData, PNL_LINE_TYPES.header, nodeContext, nodePath + '.H',
          headerId, headerName, context.accountPath);
      }
      if (Array.isArray(row.ColData)) {
        appendLine_(row.ColData, PNL_LINE_TYPES.data, nodeContext, nodePath + '.D', null, null, context.accountPath);
      }
      const childPath = headerName ? context.accountPath.concat(headerName) : context.accountPath.slice();
      const childParent = headerName ? { id: headerId || null, name: headerName } : context.parentAccount;
      const children = row.Rows && Array.isArray(row.Rows.Row) ? row.Rows.Row : [];
      if (children.length) {
        walkRows_(children, {
          groupName: groupName, statementSection: statementSection || headerName || groupLabel,
          statementSubsection: statementSubsection, parentAccount: childParent,
          accountPath: childPath, level: context.level + 1
        }, nodePath);
      }
      const summaryColData = row.Summary && Array.isArray(row.Summary.ColData) ? row.Summary.ColData : null;
      if (summaryColData) {
        appendLine_(summaryColData, PNL_LINE_TYPES.summary, nodeContext, nodePath + '.S',
          headerId, headerName || groupLabel, childPath);
      }
    });
  }

  walkRows_(rootRows, {
    groupName: null, statementSection: null, statementSubsection: null,
    parentAccount: null, accountPath: [], level: 0
  }, '');
  return { logicalLines: logicalLines, columnDefinitions: columnDefinitions };
}

function hasPnlColData_(colData) {
  return Array.isArray(colData) && colData.some(cell => cell && typeof cell === 'object' &&
    (String(cell.value || '').trim() !== '' || String(cell.id || '').trim() !== ''));
}

function getPnlHeaderOption_(header, optionName) {
  const options = header && Array.isArray(header.Option) ? header.Option : [];
  const normalizedName = String(optionName || '').trim().toLowerCase();
  const option = options.find(item => String(item.Name || '').trim().toLowerCase() === normalizedName);
  return option ? String(option.Value || '').trim() : null;
}

function isPnlNoDataReport_(reportData) {
  const header = reportData && reportData.Header ? reportData.Header : {};
  if (String(getPnlHeaderOption_(header, 'NoReportData') || '').toLowerCase() === 'true') return true;
  const rows = reportData && reportData.Rows && Array.isArray(reportData.Rows.Row) ? reportData.Rows.Row : [];
  return !hasPnlFinancialValues_(rows);
}

function hasPnlFinancialValues_(rows) {
  if (!Array.isArray(rows)) return false;
  return rows.some(row => {
    if (!row || typeof row !== 'object') return false;
    const groups = [
      Array.isArray(row.ColData) ? row.ColData : null,
      row.Header && Array.isArray(row.Header.ColData) ? row.Header.ColData : null,
      row.Summary && Array.isArray(row.Summary.ColData) ? row.Summary.ColData : null
    ];
    if (groups.some(colData => colData && colData.slice(1).some(cell =>
      String(cell && cell.value !== undefined ? cell.value : '').trim() !== ''))) return true;
    const children = row.Rows && Array.isArray(row.Rows.Row) ? row.Rows.Row : [];
    return hasPnlFinancialValues_(children);
  });
}

function getPnlGroupLabel_(groupName) {
  const labels = {
    Income: 'Income', COGS: 'Cost of Goods Sold', GrossProfit: 'Gross Profit', Expenses: 'Expenses',
    NetOperatingIncome: 'Net Operating Income', OtherIncome: 'Other Income',
    OtherExpenses: 'Other Expenses', NetOtherIncome: 'Net Other Income', NetIncome: 'Net Income'
  };
  return labels[groupName] || groupName || null;
}

function getPnlNormalizedMetric_(accountName) {
  const normalized = String(accountName || '').trim().toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const metrics = {
    'total income': 'total_income', 'total cost of goods sold': 'total_cost_of_goods_sold',
    'gross profit': 'gross_profit', 'total expenses': 'total_expenses',
    'net operating income': 'net_operating_income', 'total other income': 'total_other_income',
    'total other expenses': 'total_other_expenses', 'net other income': 'net_other_income',
    'net income': 'net_income'
  };
  return metrics[normalized] || null;
}

function parsePnlAmount_(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric P&L amount: ' + value);
    return value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw);
  const amount = Number(raw.replace(/[$,\s]/g, '').replace(/[()]/g, ''));
  if (!Number.isFinite(amount)) throw new Error('Invalid P&L amount: ' + raw);
  return negative ? -Math.abs(amount) : amount;
}

function getPnlRecordType_(lineType) {
  const types = {};
  types[PNL_LINE_TYPES.header] = 'HEADER';
  types[PNL_LINE_TYPES.data] = 'LINE';
  types[PNL_LINE_TYPES.summary] = 'SUMMARY';
  const recordType = types[String(lineType || '')];
  if (!recordType) throw new Error('Unsupported P&L line type: ' + lineType);
  return recordType;
}

function getPnlRecordGroupKey_(line) {
  const groupName = String(line.groupName || '').trim();
  const statementSection = String(line.statementSection || '').trim();
  const source = groupName || statementSection || line.accountName || 'unclassified';
  const normalized = String(source).trim().toLowerCase().replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const known = {
    income: 'Income', cogs: 'COGS', 'cost of goods sold': 'COGS',
    grossprofit: 'GrossProfit', 'gross profit': 'GrossProfit',
    expenses: 'Expenses', netoperatingincome: 'NetOperatingIncome',
    'net operating income': 'NetOperatingIncome', otherincome: 'OtherIncome',
    'other income': 'OtherIncome', otherexpenses: 'OtherExpenses',
    'other expenses': 'OtherExpenses', netotherincome: 'NetOtherIncome',
    'net other income': 'NetOtherIncome', netincome: 'NetIncome',
    'net income': 'NetIncome'
  };
  return known[normalized] || normalized.replace(/\s+(.)/g, (_, letter) => letter.toUpperCase())
    .replace(/^[a-z]/, letter => letter.toUpperCase()) || 'Unclassified';
}

function assignPnlPresentationOrder_(logicalLines) {
  const groupOrders = new Map();
  const nextRecordOrders = new Map();
  logicalLines.forEach(line => {
    const groupKey = getPnlRecordGroupKey_(line);
    if (!groupOrders.has(groupKey)) {
      groupOrders.set(groupKey, groupOrders.size);
      nextRecordOrders.set(groupKey, 0);
    }
    line.recordGroupKey = groupKey;
    line.recordGroupOrder = groupOrders.get(groupKey);
    line.recordType = getPnlRecordType_(line.lineType);
    line.recordOrder = nextRecordOrders.get(groupKey);
    line.sourceRowOrder = line.rowOrder;
    nextRecordOrders.set(groupKey, line.recordOrder + 1);
  });
  return logicalLines;
}

function buildPnlCommonRow_(payload, client, range, variant, line, loadedAt) {
  const reportData = payload.data || {};
  const header = reportData.Header || {};
  return {
    idempotency_key: '', ReportType: PNL_CONFIG.reportType, ReportVariant: variant,
    SnapshotType: normalizePnlSnapshotType_(range.snapshotType || PNL_SNAPSHOT_TYPE_WEEKLY),
    Entity: client.entityAlias, ClientName: client.name,
    ClientId: String(payload.client_id || client.id), RealmId: String(payload.realm_id || '') || null,
    Environment: String(payload.environment || PNL_CONFIG.environment),
    SnapshotDate: range.snapshotDate, SnapshotWeek: range.snapshotWeek,
    DateFrom: range.dateFrom, DateTo: range.dateTo,
    AccountingMethod: String(header.ReportBasis || PNL_CONFIG.accountingMethod),
    AccountingStandard: getPnlHeaderOption_(header, 'AccountingStandard'),
    SummarizeColumnsBy: String(header.SummarizeColumnsBy || ''),
    LoadedAt: loadedAt, FetchedAt: payload.fetched_at || null, ReportTime: header.Time || null,
    Currency: String(header.Currency || PNL_CONFIG.currencyDefault),
    RecordGroupKey: line.recordGroupKey, RecordGroupOrder: line.recordGroupOrder,
    RecordType: line.recordType, RecordOrder: line.recordOrder, SourceRowOrder: line.sourceRowOrder,
    GroupName: line.groupName, StatementSection: line.statementSection,
    StatementSubsection: line.statementSubsection, ParentAccountId: line.parentAccountId,
    ParentAccountName: line.parentAccountName, AccountId: line.accountId,
    AccountName: line.accountName, AccountPath: line.accountPath,
    LineType: line.lineType, Level: line.level, RowPath: line.rowPath,
    NormalizedMetric: line.normalizedMetric, MetricName: line.metricName, IsKeyMetric: line.isKeyMetric
  };
}

function normalizeProfitAndLossReport_(payload, client, range, loadedAt) {
  const normalized = buildPnlLogicalLines_(payload.data || {}, PNL_VARIANT_NORMAL);
  if (normalized.columnDefinitions.isNoData) return [];
  const totalColumn = normalized.columnDefinitions.moneyColumns[0];
  const logicalLines = assignPnlPresentationOrder_(normalized.logicalLines.filter(line => {
    const amount = parsePnlAmount_((line.colData[totalColumn.index] || {}).value);
    return amount !== null || line.lineType === PNL_LINE_TYPES.header;
  }));
  const rows = logicalLines.map(line => {
    const row = buildPnlCommonRow_(
      payload, client, range, PNL_VARIANT_NORMAL, line, loadedAt || new Date().toISOString()
    );
    row.Amount = parsePnlAmount_((line.colData[totalColumn.index] || {}).value);
    row.Source = PNL_CONFIG.sourceDefault;
    return row;
  });
  applyPnlIdempotencyKeys_(rows, PNL_VARIANT_NORMAL);
  validatePnlPreparedRows_(rows, PNL_VARIANT_NORMAL);
  return rows;
}

function normalizeProfitAndLossByClassReport_(payload, client, range, loadedAt) {
  const normalized = buildPnlLogicalLines_(payload.data || {}, PNL_VARIANT_BY_CLASS);
  if (normalized.columnDefinitions.isNoData) return [];
  const logicalLines = assignPnlPresentationOrder_(normalized.logicalLines.filter(line =>
    line.lineType === PNL_LINE_TYPES.header ||
    normalized.columnDefinitions.moneyColumns.some(column =>
      parsePnlAmount_((line.colData[column.index] || {}).value) !== null)
  ));
  const rows = [];
  logicalLines.forEach(line => {
    let emitted = 0;
    normalized.columnDefinitions.moneyColumns.forEach(column => {
      const amount = parsePnlAmount_((line.colData[column.index] || {}).value);
      if (amount === null) return;
      const row = buildPnlCommonRow_(
        payload, client, range, PNL_VARIANT_BY_CLASS, line, loadedAt || new Date().toISOString()
      );
      row.ClassColumnIndex = column.index;
      row.ClassKey = column.key;
      row.ClassName = column.title;
      row.ClassColumnRole = column.role;
      row.IsClassSubtotal = column.role === PNL_CLASS_COLUMN_ROLES.classSubtotal;
      row.IsGrandTotal = column.role === PNL_CLASS_COLUMN_ROLES.grandTotal;
      row.Amount = amount;
      row.Source = PNL_CONFIG.sourceDefault;
      rows.push(row);
      emitted++;
    });
    if (!emitted) {
      const row = buildPnlCommonRow_(
        payload, client, range, PNL_VARIANT_BY_CLASS, line, loadedAt || new Date().toISOString()
      );
      row.ClassColumnIndex = null;
      row.ClassKey = null;
      row.ClassName = null;
      row.ClassColumnRole = null;
      row.IsClassSubtotal = null;
      row.IsGrandTotal = null;
      row.Amount = null;
      row.Source = PNL_CONFIG.sourceDefault;
      rows.push(row);
    }
  });
  applyPnlIdempotencyKeys_(rows, PNL_VARIANT_BY_CLASS);
  validatePnlPreparedRows_(rows, PNL_VARIANT_BY_CLASS);
  return rows;
}

function reconcilePnlByClassRows_(rows) {
  const groups = {};
  rows.forEach(row => {
    const key = [row.ClientId, row.RowPath, row.LineType].join('|');
    if (!groups[key]) {
      groups[key] = {
        clientId: row.ClientId, clientName: row.ClientName, rowPath: row.RowPath,
        accountName: row.AccountName, directAmount: 0, grandTotal: null
      };
    }
    if (row.ClassColumnRole === PNL_CLASS_COLUMN_ROLES.directClass ||
        row.ClassColumnRole === PNL_CLASS_COLUMN_ROLES.notSpecified) {
      groups[key].directAmount += row.Amount;
    }
    if (row.ClassColumnRole === PNL_CLASS_COLUMN_ROLES.grandTotal) groups[key].grandTotal = row.Amount;
  });
  const mismatches = Object.keys(groups).map(key => groups[key]).filter(group =>
    group.grandTotal !== null && Math.abs(group.directAmount - group.grandTotal) > 0.01).map(group => ({
      clientId: group.clientId, clientName: group.clientName, rowPath: group.rowPath,
      accountName: group.accountName, directAmount: roundPnlAmount_(group.directAmount),
      grandTotal: roundPnlAmount_(group.grandTotal),
      difference: roundPnlAmount_(group.directAmount - group.grandTotal)
    }));
  return {
    checkedLineCount: Object.keys(groups).filter(key => groups[key].grandTotal !== null).length,
    mismatchCount: mismatches.length, mismatches: mismatches
  };
}

function roundPnlAmount_(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

/***********************
 * Idempotency and Row Validation
 ***********************/

function applyPnlIdempotencyKeys_(rows, variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  rows.forEach(row => row.idempotency_key = buildPnlIdempotencyKey_(row, variantKey));
  return rows;
}

function buildPnlIdempotencyKey_(row, variant) {
  const components = [
    'qbo_pnl_snapshot', 'v3', row.Environment, row.ClientId, variant, row.SnapshotType, row.SnapshotWeek,
    row.DateFrom, row.DateTo, row.AccountingMethod, row.RecordGroupKey,
    row.RecordGroupOrder, row.RecordType, row.RecordOrder, row.SourceRowOrder,
    row.LineType, row.RowPath, row.AccountId, row.AccountPath
  ];
  if (variant === PNL_VARIANT_BY_CLASS) {
    components.push(row.ClassColumnIndex, row.ClassKey, row.ClassName, row.ClassColumnRole);
  }
  return sha256Hex_(components.map(normalizePnlKeyComponent_).join('|'));
}

function normalizePnlKeyComponent_(value) {
  return value === null || value === undefined ? '' : String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function sha256Hex_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8
  ).map(byte => ((byte + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function validatePnlPreparedRows_(rows, variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  const schema = PNL_BIGQUERY_SCHEMAS[variantKey];
  if (!Array.isArray(rows)) throw new Error('Prepared P&L rows must be an array.');
  const fieldNames = new Set(schema.map(field => field.name));
  const lineTypes = new Set(Object.keys(PNL_LINE_TYPES).map(key => PNL_LINE_TYPES[key]));
  const recordTypes = new Set(['HEADER', 'LINE', 'SUMMARY']);
  const classRoles = new Set(Object.keys(PNL_CLASS_COLUMN_ROLES).map(key => PNL_CLASS_COLUMN_ROLES[key]));
  const keys = new Set();
  const errors = [];
  const duplicates = [];

  rows.forEach((row, rowIndex) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ rowIndex: rowIndex, field: null, error: 'Row is not an object.' });
      return;
    }
    Object.keys(row).forEach(fieldName => {
      if (!fieldNames.has(fieldName)) {
        errors.push({ rowIndex: rowIndex, field: fieldName, error: 'Field is not present in the BigQuery schema.' });
      }
    });
    schema.forEach(field => {
      const value = row[field.name];
      if (field.mode === 'REQUIRED' && isPnlMissingRequiredValue_(value)) {
        errors.push({ rowIndex: rowIndex, field: field.name, error: 'Required value is missing.' });
        return;
      }
      if (value === null || value === undefined || value === '') return;
      if (!isValidPnlFieldType_(value, field.type)) {
        errors.push({
          rowIndex: rowIndex, field: field.name, value: value,
          expectedType: field.type, error: 'Value does not match the BigQuery type.'
        });
      }
    });
    if (row.ReportVariant !== variantKey) {
      errors.push({
        rowIndex: rowIndex, field: 'ReportVariant', value: row.ReportVariant,
        error: 'ReportVariant does not match the requested variant.'
      });
    }
    if (!lineTypes.has(row.LineType)) {
      errors.push({
        rowIndex: rowIndex, field: 'LineType', value: row.LineType,
        error: 'Unsupported P&L line type.'
      });
    }
    if (!recordTypes.has(row.RecordType) || row.RecordType !== getPnlRecordType_(row.LineType)) {
      errors.push({
        rowIndex: rowIndex, field: 'RecordType', value: row.RecordType,
        error: 'RecordType does not match LineType.'
      });
    }
    if (variantKey === PNL_VARIANT_NORMAL) {
      if (row.Amount === null && row.RecordType !== 'HEADER') {
        errors.push({
          rowIndex: rowIndex, field: 'Amount', value: row.Amount,
          error: 'Only structural HEADER rows may have a null Amount.'
        });
      }
    } else {
      const hasClassMetadata = row.ClassColumnRole !== null && row.ClassColumnRole !== undefined;
      if (!hasClassMetadata) {
        const nullableClassFields = [
          'ClassColumnIndex', 'ClassKey', 'ClassName', 'ClassColumnRole',
          'IsClassSubtotal', 'IsGrandTotal', 'Amount'
        ];
        const populated = nullableClassFields.filter(field =>
          row[field] !== null && row[field] !== undefined && row[field] !== '');
        if (row.RecordType !== 'HEADER' || populated.length) {
          errors.push({
            rowIndex: rowIndex, field: 'ClassColumnRole',
            error: 'Rows without class metadata must be structural HEADER rows with null class fields and Amount.'
          });
        }
      } else {
        if (!classRoles.has(row.ClassColumnRole)) {
          errors.push({
            rowIndex: rowIndex, field: 'ClassColumnRole', value: row.ClassColumnRole,
            error: 'Unsupported class column role.'
          });
        }
        ['ClassColumnIndex', 'ClassKey', 'ClassName', 'IsClassSubtotal', 'IsGrandTotal', 'Amount']
          .forEach(field => {
            if (isPnlMissingRequiredValue_(row[field])) {
              errors.push({
                rowIndex: rowIndex, field: field,
                error: 'Financial by-class rows require complete class metadata and Amount.'
              });
            }
          });
        validatePnlClassFlags_(row, rowIndex, errors);
      }
    }
    const key = String(row.idempotency_key || '').trim();
    if (key && !/^[a-f0-9]{64}$/.test(key)) {
      errors.push({
        rowIndex: rowIndex, field: 'idempotency_key', value: key,
        error: 'Idempotency key must be a lowercase SHA-256 hexadecimal value.'
      });
    }
    if (key && keys.has(key)) duplicates.push({ rowIndex: rowIndex, idempotencyKey: key });
    else if (key) keys.add(key);
  });

  validatePnlPresentationOrder_(rows, errors);
  if (errors.length || duplicates.length) {
    throw new Error('P&L prepared row validation failed. ' + JSON.stringify({
      variant: variantKey, rowCount: rows.length, validationErrorCount: errors.length,
      duplicateIdempotencyKeyCount: duplicates.length,
      validationErrors: errors.slice(0, 20), duplicateIdempotencyKeys: duplicates.slice(0, 20)
    }, null, 2));
  }
  return {
    variant: variantKey, rowCount: rows.length, uniqueIdempotencyKeyCount: keys.size,
    duplicateIdempotencyKeyCount: 0, valid: true
  };
}

function validatePnlPresentationOrder_(rows, errors) {
  const clients = new Map();
  rows.forEach((row, rowIndex) => {
    const clientKey = String(row.ClientId || '');
    if (!clients.has(clientKey)) clients.set(clientKey, new Map());
    const groups = clients.get(clientKey);
    const groupKey = String(row.RecordGroupKey || '');
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        groupOrder: row.RecordGroupOrder,
        logicalOrders: new Map(),
        orderLines: new Map()
      });
    }
    const group = groups.get(groupKey);
    if (group.groupOrder !== row.RecordGroupOrder) {
      errors.push({
        rowIndex: rowIndex, field: 'RecordGroupOrder', value: row.RecordGroupOrder,
        error: 'RecordGroupKey is assigned to more than one RecordGroupOrder.'
      });
    }
    const logicalKey = String(row.RowPath || '') + '|' + String(row.LineType || '');
    if (group.logicalOrders.has(logicalKey) && group.logicalOrders.get(logicalKey) !== row.RecordOrder) {
      errors.push({
        rowIndex: rowIndex, field: 'RecordOrder', value: row.RecordOrder,
        error: 'A logical P&L line is assigned to more than one RecordOrder within its group.'
      });
    } else {
      group.logicalOrders.set(logicalKey, row.RecordOrder);
    }
    if (group.orderLines.has(row.RecordOrder) && group.orderLines.get(row.RecordOrder) !== logicalKey) {
      errors.push({
        rowIndex: rowIndex, field: 'RecordOrder', value: row.RecordOrder,
        error: 'RecordOrder is assigned to more than one logical P&L line within its group.'
      });
    } else {
      group.orderLines.set(row.RecordOrder, logicalKey);
    }
  });

  clients.forEach((groups, clientKey) => {
    const groupOrderKeys = new Map();
    groups.forEach((group, groupKey) => {
      if (groupOrderKeys.has(group.groupOrder) && groupOrderKeys.get(group.groupOrder) !== groupKey) {
        errors.push({
          rowIndex: null, field: 'RecordGroupOrder', value: group.groupOrder, clientId: clientKey,
          error: 'RecordGroupOrder is assigned to more than one RecordGroupKey.'
        });
      } else {
        groupOrderKeys.set(group.groupOrder, groupKey);
      }
      const orders = Array.from(group.orderLines.keys()).map(Number).sort((a, b) => a - b);
      orders.forEach((order, index) => {
        if (order !== index) {
          errors.push({
            rowIndex: null, field: 'RecordOrder', value: order,
            clientId: clientKey, recordGroupKey: groupKey,
            error: 'RecordOrder must be contiguous and start at 0 within each group. Expected=' + index
          });
        }
      });
    });
    const groupOrders = Array.from(groupOrderKeys.keys()).map(Number).sort((a, b) => a - b);
    groupOrders.forEach((order, index) => {
      if (order !== index) {
        errors.push({
          rowIndex: null, field: 'RecordGroupOrder', value: order, clientId: clientKey,
          error: 'RecordGroupOrder must be contiguous and start at 0. Expected=' + index
        });
      }
    });
  });
}

function isPnlMissingRequiredValue_(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function isValidPnlFieldType_(value, type) {
  switch (type) {
    case 'STRING': return typeof value === 'string';
    case 'DATE': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Boolean(safeParseDate_(value));
    case 'TIMESTAMP': return typeof value === 'string' && !isNaN(new Date(value).getTime());
    case 'INTEGER': return typeof value === 'number' && Number.isInteger(value);
    case 'NUMERIC': return typeof value === 'number' && Number.isFinite(value);
    case 'BOOLEAN': return typeof value === 'boolean';
    default: return false;
  }
}

function validatePnlClassFlags_(row, rowIndex, errors) {
  const isSubtotal = row.ClassColumnRole === PNL_CLASS_COLUMN_ROLES.classSubtotal;
  const isGrandTotal = row.ClassColumnRole === PNL_CLASS_COLUMN_ROLES.grandTotal;
  if (row.IsClassSubtotal !== isSubtotal) {
    errors.push({ rowIndex: rowIndex, field: 'IsClassSubtotal', value: row.IsClassSubtotal,
      error: 'IsClassSubtotal does not match ClassColumnRole.' });
  }
  if (row.IsGrandTotal !== isGrandTotal) {
    errors.push({ rowIndex: rowIndex, field: 'IsGrandTotal', value: row.IsGrandTotal,
      error: 'IsGrandTotal does not match ClassColumnRole.' });
  }
  if (row.IsClassSubtotal === true && row.IsGrandTotal === true) {
    errors.push({ rowIndex: rowIndex, field: 'ClassColumnRole', value: row.ClassColumnRole,
      error: 'A class column cannot be both subtotal and grand total.' });
  }
}

/***********************
 * BigQuery Contracts and Snapshot Assembly
 ***********************/

function getPnlBigQueryContract_(variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  return {
    variant: variantKey, schema: PNL_BIGQUERY_SCHEMAS[variantKey],
    exportColumns: PNL_EXPORT_COLUMNS[variantKey], partitionField: PNL_BIGQUERY_PARTITION_FIELD,
    clusterFields: PNL_BIGQUERY_CLUSTER_FIELDS[variantKey],
    tableId: BQ_CONFIG.snapshotsTableIds[variantKey], tableName: PNL_BIGQUERY_TABLES[variantKey]
  };
}

function validatePnlBigQuerySchema_(variant) {
  const contract = getPnlBigQueryContract_(variant);
  const table = BigQuery.Tables.get(BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, contract.tableId);
  const actualFields = table.schema && Array.isArray(table.schema.fields) ? table.schema.fields : [];
  const mismatches = [];
  const maxLength = Math.max(contract.schema.length, actualFields.length);
  for (let index = 0; index < maxLength; index++) {
    const expected = contract.schema[index] || null;
    const actual = actualFields[index] || null;
    if (!expected || !actual) {
      mismatches.push({ position: index + 1, expected: expected, actual: actual });
      continue;
    }
    const normalizedActual = {
      name: String(actual.name || ''), type: normalizePnlBigQueryType_(actual.type),
      mode: String(actual.mode || 'NULLABLE').trim().toUpperCase()
    };
    if (normalizedActual.name !== expected.name || normalizedActual.type !== expected.type ||
        normalizedActual.mode !== expected.mode) {
      mismatches.push({ position: index + 1, expected: expected, actual: normalizedActual });
    }
  }
  const tableType = String(table.type || 'TABLE').trim().toUpperCase();
  const partitionField = String(table.timePartitioning && table.timePartitioning.field || '').trim();
  const partitionType = String(table.timePartitioning && table.timePartitioning.type || '').trim().toUpperCase();
  const clusterFields = table.clustering && Array.isArray(table.clustering.fields)
    ? table.clustering.fields.map(String) : [];
  const clusterMatches = contract.clusterFields.length === clusterFields.length &&
    contract.clusterFields.every((field, index) => field === clusterFields[index]);
  if (tableType !== 'TABLE' || mismatches.length || partitionField !== contract.partitionField ||
      partitionType !== 'DAY' || !clusterMatches) {
    throw new Error('P&L BigQuery schema validation failed. ' + JSON.stringify({
      variant: contract.variant, table: contract.tableName, tableType: tableType,
      expectedColumnCount: contract.schema.length, actualColumnCount: actualFields.length,
      fieldMismatches: mismatches, partition: {
        expectedField: contract.partitionField, actualField: partitionField,
        expectedType: 'DAY', actualType: partitionType
      }, clustering: { expected: contract.clusterFields, actual: clusterFields }
    }, null, 2));
  }
  return {
    status: 'passed', variant: contract.variant, table: contract.tableName,
    columnCount: actualFields.length, partitionField: partitionField, clustering: clusterFields
  };
}

function normalizePnlBigQueryType_(type) {
  const normalized = String(type || '').trim().toUpperCase();
  return ({ INT64: 'INTEGER', BOOL: 'BOOLEAN', DECIMAL: 'NUMERIC', BIGDECIMAL: 'BIGNUMERIC',
    FLOAT64: 'FLOAT', STRUCT: 'RECORD' })[normalized] || normalized;
}

function buildProfitAndLossVariantSnapshot_(variant, options) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  const config = options && typeof options === 'object' ? options : {};
  const range = config.range || getPreviousCompletedWeekRange_();
  const loadedAt = config.loadedAt || new Date().toISOString();
  const selection = Array.isArray(config.clients)
    ? { clients: config.clients.slice().sort(comparePnlClients_), entityConfiguration: config.entityConfiguration || null }
    : resolvePnlEntitySelection_(variantKey);
  const clients = selection.clients;
  if (!clients.length) throw new Error('No filtered clients were found for P&L variant: ' + variantKey);
  const rows = [];
  const clientResults = [];
  const successfulClientIds = [];
  const clientFailures = [];
  clients.forEach(client => {
    try {
      const payload = fetchProfitAndLossReport_(client.id, range.dateFrom, range.dateTo, variantKey);
      const definitions = getPnlColumnDefinitions_(payload.data || {}, variantKey);
      const clientRows = variantKey === PNL_VARIANT_NORMAL
        ? normalizeProfitAndLossReport_(payload, client, range, loadedAt)
        : normalizeProfitAndLossByClassReport_(payload, client, range, loadedAt);
      let reconciliation = null;
      if (variantKey === PNL_VARIANT_BY_CLASS) {
        reconciliation = reconcilePnlByClassRows_(clientRows);
        if (reconciliation.mismatchCount) {
          throw new Error('P&L by Class reconciliation failed for client ' + client.name + '. ' +
            JSON.stringify(reconciliation, null, 2));
        }
      }
      Array.prototype.push.apply(rows, clientRows);
      const clientResult = {
        clientId: client.id, clientName: client.name, entity: client.entityAlias,
        noReportData: definitions.isNoData, columnCount: definitions.columns.length,
        moneyColumnCount: definitions.moneyColumns.length, rowCount: clientRows.length
      };
      if (reconciliation) clientResult.reconciledLineCount = reconciliation.checkedLineCount;
      clientResults.push(clientResult);
      successfulClientIds.push(client.id);
      Logger.log(JSON.stringify({
        event: 'profit_and_loss_client_prepared', variant: variantKey,
        clientId: client.id, clientName: client.name, rowCount: clientRows.length,
        noReportData: definitions.isNoData
      }));
    } catch (error) {
      if (config.continueOnClientError !== true) throw error;
      const message = String(error && error.message || error);
      const statusMatch = message.match(/returned HTTP\s+(\d{3})\b/i);
      const failure = {
        clientId: String(client.id || ''), clientName: String(client.name || ''),
        entity: String(client.entityAlias || ''), httpStatus: statusMatch ? Number(statusMatch[1]) : null,
        error: message
      };
      clientFailures.push(failure);
      Logger.log(JSON.stringify({ event: 'profit_and_loss_client_failed', variant: variantKey, failure: failure }));
    }
  });
  sortPnlSnapshotRows_(rows, variantKey);
  const validation = validatePnlPreparedRows_(rows, variantKey);
  const reconciliation = variantKey === PNL_VARIANT_BY_CLASS ? reconcilePnlByClassRows_(rows) : null;
  if (reconciliation && reconciliation.mismatchCount) {
    throw new Error('Combined P&L by Class reconciliation failed. ' + JSON.stringify(reconciliation, null, 2));
  }
  return {
    variant: variantKey, range: range, loadedAt: loadedAt, clientCount: clients.length,
    rowCount: rows.length, rows: rows, clientResults: clientResults,
    successfulClientIds: successfulClientIds, clientFailures: clientFailures,
    validation: validation, reconciliation: reconciliation,
    entityConfiguration: selection.entityConfiguration
  };
}

function sortPnlSnapshotRows_(rows, variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  rows.sort((a, b) =>
    String(a.Entity || '').localeCompare(String(b.Entity || '')) ||
    String(a.ClientName || '').localeCompare(String(b.ClientName || '')) ||
    Number(a.RecordGroupOrder) - Number(b.RecordGroupOrder) ||
    Number(a.RecordOrder) - Number(b.RecordOrder) ||
    (variantKey === PNL_VARIANT_BY_CLASS
      ? comparePnlNullableNumbers_(a.ClassColumnIndex, b.ClassColumnIndex) : 0) ||
    Number(a.SourceRowOrder) - Number(b.SourceRowOrder) ||
    String(a.RowPath || '').localeCompare(String(b.RowPath || ''))
  );
  return rows;
}

function comparePnlNullableNumbers_(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  return Number(a) - Number(b);
}

/***********************
 * BigQuery Load and Verification
 ***********************/

function buildPnlBigQueryRows_(rows, variant) {
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  validatePnlPreparedRows_(rows, variantKey);
  return rows.map(row => {
    const json = {};
    PNL_EXPORT_COLUMNS[variantKey].forEach(column =>
      json[column] = row[column] === undefined ? null : row[column]);
    return json;
  });
}

function replacePnlSnapshotPartition_(range, rows, variant) {
  return replacePnlSnapshotScope_(range, rows, variant, null);
}

function clearEmptyPnlPartition_(snapshotWeek, variant, snapshotType) {
  const contract = getPnlBigQueryContract_(variant);
  const normalizedType = normalizePnlSnapshotType_(snapshotType || PNL_SNAPSHOT_TYPE_WEEKLY);
  const result = runPnlBigQueryQuery_('DELETE FROM `' + contract.tableName + '`\n' +
    "WHERE SnapshotWeek = DATE '" + snapshotWeek + "'\n" +
    "  AND COALESCE(SnapshotType, 'WEEKLY') = '" + normalizedType + "'");
  return {
    mode: 'empty_partition_clear', variant: contract.variant, jobId: result.jobReference.jobId,
    destinationTable: contract.tableName, snapshotWeek: snapshotWeek, snapshotType: normalizedType,
    partitionId: snapshotWeek.replace(/-/g, ''), rowCount: 0, outputRows: 0, payloadBytes: 0, state: 'DONE'
  };
}

function escapePnlBigQueryString_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildPnlClientScopeSql_(clientIds) {
  const ids = Array.from(new Set((clientIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) throw new Error('At least one successful P&L client is required.');
  return ids.map(id => "'" + escapePnlBigQueryString_(id) + "'").join(', ');
}

function replacePnlSnapshotScope_(range, rows, variant, successfulClientIds) {
  const contract = getPnlBigQueryContract_(variant);
  const snapshotWeek = String(range && range.snapshotWeek || '').trim();
  const snapshotType = normalizePnlSnapshotType_(range && range.snapshotType || PNL_SNAPSHOT_TYPE_WEEKLY);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotWeek)) throw new Error('Invalid P&L SnapshotWeek: ' + snapshotWeek);
  if (!Array.isArray(rows)) throw new Error('P&L snapshot rows must be an array. Variant=' + contract.variant);
  const ids = successfulClientIds === null ? [] : Array.from(new Set(
    (successfulClientIds || []).map(id => String(id || '').trim()).filter(Boolean)
  ));
  if (successfulClientIds !== null && !ids.length) return {
    mode: 'client_scope_noop', variant: contract.variant, destinationTable: contract.tableName,
    snapshotWeek: snapshotWeek, snapshotType: snapshotType, successfulClientCount: 0,
    rowCount: 0, state: 'SKIPPED'
  };
  const allowed = {};
  ids.forEach(id => { allowed[id] = true; });
  const prepared = buildPnlBigQueryRows_(rows, contract.variant).map((row, index) => {
    if (String(row.SnapshotWeek || '') !== snapshotWeek ||
        normalizePnlSnapshotType_(row.SnapshotType) !== snapshotType ||
        String(row.ReportVariant || '') !== contract.variant ||
        (ids.length && !allowed[String(row.ClientId || '')])) {
      throw new Error('P&L row ' + index + ' is outside the requested snapshot replacement scope.');
    }
    return row;
  });
  const partitionId = snapshotWeek.replace(/-/g, '');
  const token = Utilities.getUuid().replace(/-/g, '');
  const stagingTableId = 'pnl_' + contract.variant + '_stage_' + partitionId + '_' + token;
  try {
    if (prepared.length) {
      const blob = Utilities.newBlob(prepared.map(JSON.stringify).join('\n'), 'application/octet-stream', stagingTableId + '.ndjson');
      const inserted = BigQuery.Jobs.insert({
        jobReference: { projectId: BQ_CONFIG.projectId, jobId: 'pnl_stage_' + contract.variant + '_' + partitionId + '_' + token },
        configuration: { load: {
          destinationTable: { projectId: BQ_CONFIG.projectId, datasetId: BQ_CONFIG.rawDatasetId, tableId: stagingTableId },
          sourceFormat: 'NEWLINE_DELIMITED_JSON', createDisposition: 'CREATE_IF_NEEDED', writeDisposition: 'WRITE_TRUNCATE',
          autodetect: false, ignoreUnknownValues: false, maxBadRecords: 0,
          schema: { fields: PNL_BIGQUERY_SCHEMAS[contract.variant] }
        } }
      }, BQ_CONFIG.projectId, blob);
      waitForPnlBigQueryJob_(inserted.jobReference, 120000);
    }
    const statements = [
      'BEGIN TRANSACTION;',
      'DELETE FROM `' + contract.tableName + '`',
      "WHERE SnapshotWeek = DATE '" + snapshotWeek + "'",
      "  AND COALESCE(SnapshotType, 'WEEKLY') = '" + snapshotType + "'" +
        (ids.length ? ' AND ClientId IN (' + buildPnlClientScopeSql_(ids) + ')' : '') + ';'
    ];
    if (prepared.length) {
      const columns = PNL_EXPORT_COLUMNS[contract.variant].map(column => '`' + column + '`').join(', ');
      statements.push('INSERT INTO `' + contract.tableName + '` (' + columns + ')', 'SELECT ' + columns,
        'FROM `' + [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, stagingTableId].join('.') + '`;');
    }
    statements.push('COMMIT TRANSACTION;');
    const queryResult = runPnlBigQueryQuery_(statements.join('\n'));
    return {
      mode: ids.length ? 'successful_clients_replace' : 'snapshot_type_replace',
      variant: contract.variant, jobId: queryResult.jobReference && queryResult.jobReference.jobId || null,
      destinationTable: contract.tableName, snapshotWeek: snapshotWeek, snapshotType: snapshotType,
      successfulClientCount: ids.length || null, rowCount: prepared.length, state: 'DONE'
    };
  } finally {
    if (prepared.length) {
      try { BigQuery.Tables.remove(BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, stagingTableId); }
      catch (error) { Logger.log('P&L staging cleanup failed: ' + String(error && error.message || error)); }
    }
  }
}

function replacePnlSnapshotClients_(range, rows, variant, successfulClientIds) {
  return replacePnlSnapshotScope_(range, rows, variant, successfulClientIds);
}

function verifyPnlSnapshotPartition_(snapshotWeek, expectedRowCount, variant, clientIds, snapshotType) {
  const contract = getPnlBigQueryContract_(variant);
  const normalizedType = normalizePnlSnapshotType_(snapshotType || PNL_SNAPSHOT_TYPE_WEEKLY);
  const expected = Number(expectedRowCount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotWeek)) {
    throw new Error('Invalid SnapshotWeek for P&L verification: ' + snapshotWeek);
  }
  if (!Number.isInteger(expected) || expected < 0) {
    throw new Error('Invalid expected P&L row count. Variant=' + contract.variant + ', value=' + expectedRowCount);
  }
  const structureCheck = contract.variant === PNL_VARIANT_NORMAL
    ? "COUNTIF(Amount IS NULL AND RecordType != 'HEADER') AS invalid_structure_count"
    : [
        'COUNTIF(',
        '  (ClassColumnRole IS NULL AND NOT (',
        "    RecordType = 'HEADER' AND ClassColumnIndex IS NULL AND ClassKey IS NULL AND",
        '    ClassName IS NULL AND IsClassSubtotal IS NULL AND IsGrandTotal IS NULL AND Amount IS NULL',
        '  )) OR',
        '  (ClassColumnRole IS NOT NULL AND (',
        "    ClassColumnIndex IS NULL OR ClassKey IS NULL OR TRIM(ClassKey) = '' OR",
        "    ClassName IS NULL OR TRIM(ClassName) = '' OR IsClassSubtotal IS NULL OR",
        '    IsGrandTotal IS NULL OR Amount IS NULL',
        '  ))',
        ') AS invalid_structure_count'
      ].join('\n');
  const scopedClientIds = Array.from(new Set((clientIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  const result = runPnlBigQueryQuery_([
    'SELECT', '  COUNT(*) AS row_count,',
    "  COUNTIF(idempotency_key IS NULL OR TRIM(idempotency_key) = '') AS missing_key_count,",
    '  COUNT(DISTINCT idempotency_key) AS unique_key_count,',
    "  COUNTIF(ReportVariant != '" + contract.variant + "') AS invalid_variant_count,",
    "  COUNTIF(RecordType NOT IN ('HEADER', 'LINE', 'SUMMARY')) AS invalid_record_type_count,",
    '  COUNTIF(RecordGroupOrder < 0 OR RecordOrder < 0 OR SourceRowOrder < 0) AS invalid_order_count,',
    '  ' + structureCheck,
    'FROM `' + contract.tableName + '`', "WHERE SnapshotWeek = DATE '" + snapshotWeek + "'",
    "  AND COALESCE(SnapshotType, 'WEEKLY') = '" + normalizedType + "'",
    scopedClientIds.length ? '  AND ClientId IN (' + buildPnlClientScopeSql_(scopedClientIds) + ')' : null
  ].filter(line => line !== null).join('\n'));
  const values = result.rows && result.rows.length ? result.rows[0].f : [];
  const actual = Number(values[0] ? values[0].v : 0);
  const missing = Number(values[1] ? values[1].v : 0);
  const unique = Number(values[2] ? values[2].v : 0);
  const invalidVariant = Number(values[3] ? values[3].v : 0);
  const invalidRecordType = Number(values[4] ? values[4].v : 0);
  const invalidOrder = Number(values[5] ? values[5].v : 0);
  const invalidStructure = Number(values[6] ? values[6].v : 0);
  if (actual !== expected || missing || unique !== actual || invalidVariant ||
      invalidRecordType || invalidOrder || invalidStructure) {
    throw new Error('P&L partition verification failed. ' + JSON.stringify({
      variant: contract.variant, snapshotWeek: snapshotWeek, snapshotType: normalizedType, expectedRowCount: expected,
      actualRowCount: actual, missingKeyCount: missing, uniqueKeyCount: unique,
      invalidVariantCount: invalidVariant, invalidRecordTypeCount: invalidRecordType,
      invalidOrderCount: invalidOrder, invalidStructureCount: invalidStructure
    }, null, 2));
  }
  return {
    status: 'passed', variant: contract.variant, table: contract.tableName,
    snapshotWeek: snapshotWeek, snapshotType: normalizedType, partitionId: snapshotWeek.replace(/-/g, ''),
    expectedRowCount: expected, actualRowCount: actual, missingKeyCount: missing,
    uniqueKeyCount: unique, invalidVariantCount: invalidVariant,
    invalidRecordTypeCount: invalidRecordType, invalidOrderCount: invalidOrder,
    invalidStructureCount: invalidStructure
  };
}

function waitForPnlBigQueryJob_(jobReference, timeoutMs) {
  if (!jobReference || !jobReference.jobId) throw new Error('A valid BigQuery job reference is required.');
  const projectId = jobReference.projectId || BQ_CONFIG.projectId;
  const startedAt = Date.now();
  let job;
  while (true) {
    job = BigQuery.Jobs.get(projectId, jobReference.jobId);
    if (job.status && job.status.state === 'DONE') break;
    if (Date.now() - startedAt > Number(timeoutMs || 120000)) {
      throw new Error('BigQuery job timed out: ' + jobReference.jobId);
    }
    Utilities.sleep(1000);
  }
  if (job.status && job.status.errorResult) {
    throw new Error('BigQuery job failed: ' + JSON.stringify({
      jobId: jobReference.jobId, errorResult: job.status.errorResult, errors: job.status.errors || []
    }, null, 2));
  }
  return job;
}

function runPnlBigQueryQuery_(query) {
  let result = BigQuery.Jobs.query({ query: query, useLegacySql: false, timeoutMs: 120000 }, BQ_CONFIG.projectId);
  if (!result || !result.jobReference) throw new Error('BigQuery did not return a query job reference.');
  const jobReference = result.jobReference;
  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobReference.jobId);
  }
  if (result.errors && result.errors.length) {
    throw new Error('BigQuery query failed: ' + JSON.stringify(result.errors));
  }
  if (!result.jobReference) result.jobReference = jobReference;
  return result;
}

function updateProfitAndLossSheetExport() {
  const ss = getPnlReportSpreadsheet_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    ss.toast('Another P&L snapshot, deployment, or sheet refresh is already running.', 'QBO', 5);
    return { status: 'skipped_locked', spreadsheetId: ss.getId() };
  }
  try {
    ss.toast('Refreshing P&L Data Source Sheets and extracts.', 'QBO', 5);
    const pipeline = refreshPnlConnectedSheetsPipeline_(ss, null);
    const output = {
      event: 'profit_and_loss_sheet_refresh_completed',
      spreadsheetId: ss.getId(),
      spreadsheetName: ss.getName(),
      ...pipeline
    };
    Logger.log(JSON.stringify(output, null, 2));
    ss.toast('P&L Sheet Export updated successfully.', 'QBO', 5);
    return output;
  } catch (error) {
    ss.toast('P&L Sheet Export refresh failed. Review the execution log.', 'QBO', 8);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function loadPnlVariantSnapshot_(snapshot) {
  const hasClientFailures = Array.isArray(snapshot.clientFailures) && snapshot.clientFailures.length > 0;
  const loadResult = hasClientFailures
    ? replacePnlSnapshotClients_(snapshot.range, snapshot.rows, snapshot.variant, snapshot.successfulClientIds)
    : replacePnlSnapshotPartition_(snapshot.range, snapshot.rows, snapshot.variant);
  const verification = verifyPnlSnapshotPartition_(
    snapshot.range.snapshotWeek, snapshot.rowCount, snapshot.variant,
    hasClientFailures ? snapshot.successfulClientIds : null,
    snapshot.range.snapshotType
  );
  return {
    variant: snapshot.variant, rowCount: snapshot.rowCount, clientResults: snapshot.clientResults,
    validation: snapshot.validation, reconciliation: snapshot.reconciliation,
    entityConfiguration: snapshot.entityConfiguration || null,
    successfulClientIds: snapshot.successfulClientIds || [],
    clientFailures: snapshot.clientFailures || [],
    loadResult: loadResult, verification: verification
  };
}

/***********************
 * Operational Entry Point
 ***********************/

function countPnlRowsByField_(rows, fieldName) {
  return (rows || []).reduce((counts, row) => {
    const key = String(row && row[fieldName] !== null && row[fieldName] !== undefined ? row[fieldName] : 'null');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function executeProfitAndLossVariantSnapshot_(variant, loadedEntityConfiguration, options) {
  const settings = options || {};
  const variantKey = getPnlVariantConfig_(variant).variantKey;
  const startedAt = new Date();
  Logger.log(JSON.stringify({
    event: 'profit_and_loss_variant_snapshot_started',
    variant: variantKey,
    configurationSource: loadedEntityConfiguration && loadedEntityConfiguration.source || null,
    startedAt: startedAt.toISOString()
  }));

  const schemaValidation = validatePnlBigQuerySchema_(variantKey);
  const range = settings.range || getPreviousCompletedWeekRange_();
  const loadedAt = new Date().toISOString();
  const selection = resolvePnlEntitySelection_(variantKey, null, loadedEntityConfiguration || null);
  if (!selection.clients.length) throw new Error('No filtered clients were found for P&L variant: ' + variantKey);
  const snapshot = buildProfitAndLossVariantSnapshot_(variantKey, {
    range, loadedAt, clients: selection.clients,
    entityConfiguration: selection.entityConfiguration,
    continueOnClientError: true
  });
  const loaded = loadPnlVariantSnapshot_(snapshot);

  if (!schemaValidation || schemaValidation.status !== 'passed') {
    throw new Error('P&L schema validation did not pass for variant: ' + variantKey);
  }
  if (!loaded.loadResult || loaded.loadResult.state !== 'DONE') {
    throw new Error('P&L BigQuery load did not finish in DONE state for variant: ' + variantKey);
  }
  if (!loaded.verification || loaded.verification.status !== 'passed' ||
      loaded.verification.expectedRowCount !== loaded.verification.actualRowCount ||
      loaded.verification.missingKeyCount !== 0 ||
      loaded.verification.uniqueKeyCount !== loaded.verification.actualRowCount) {
    throw new Error('P&L BigQuery verification did not pass for variant: ' + variantKey + '. ' +
      JSON.stringify(loaded.verification || null));
  }

  const completedAt = new Date();
  const result = {
    event: 'profit_and_loss_variant_snapshot_completed',
    success: true,
    variant: variantKey,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    period: range,
    clientCount: selection.clients.length,
    entityConfiguration: selection.entityConfiguration,
    schemaValidation,
    rowCount: loaded.rowCount,
    jobId: loaded.loadResult.jobId,
    loadResult: loaded.loadResult,
    reconciliation: loaded.reconciliation,
    verification: loaded.verification,
    clientResults: loaded.clientResults
  };
  Logger.log(JSON.stringify(result, null, 2));
  if (loaded.clientFailures.length) {
    throw new Error('P&L snapshot loaded successful entities but completed with entity errors: ' +
      JSON.stringify({ variant: variantKey, snapshotWeek: range.snapshotWeek,
        successfulClientCount: loaded.successfulClientIds.length,
        failedClientCount: loaded.clientFailures.length, failures: loaded.clientFailures }));
  }
  return result;
}

function runProfitAndLossVariantSnapshot_(variant) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another P&L snapshot or deployment execution is already running.');
  try {
    return executeProfitAndLossVariantSnapshot_(variant, null);
  } finally {
    lock.releaseLock();
  }
}

function snapshotProfitAndLossToBigQuery() {
  return runProfitAndLossVariantSnapshot_(PNL_VARIANT_NORMAL);
}

function snapshotProfitAndLossByClassToBigQuery() {
  return runProfitAndLossVariantSnapshot_(PNL_VARIANT_BY_CLASS);
}

function executeAllProfitAndLossReports_(range) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another P&L snapshot or deployment execution is already running.');
  const startedAt = new Date();
  try {
    Logger.log(JSON.stringify({ event: 'profit_and_loss_snapshot_started', startedAt: startedAt.toISOString() }));
    const schemaValidation = {
      normal: validatePnlBigQuerySchema_(PNL_VARIANT_NORMAL),
      byClass: validatePnlBigQuerySchema_(PNL_VARIANT_BY_CLASS)
    };
    if (!range || !range.snapshotType) throw new Error('A typed P&L snapshot range is required.');
    const loadedAt = new Date().toISOString();
    const sourceClients = fetchPnlSourceClients_();
    const normalSelection = resolvePnlEntitySelection_(PNL_VARIANT_NORMAL, sourceClients);
    const byClassSelection = resolvePnlEntitySelection_(PNL_VARIANT_BY_CLASS, sourceClients);
    if (!normalSelection.clients.length) throw new Error('No filtered clients were found for P&L normal.');
    if (!byClassSelection.clients.length) throw new Error('No filtered clients were found for P&L by Class.');

    const normalSnapshot = buildProfitAndLossVariantSnapshot_(PNL_VARIANT_NORMAL, {
      range, loadedAt, clients: normalSelection.clients,
      entityConfiguration: normalSelection.entityConfiguration,
      continueOnClientError: true
    });
    const byClassSnapshot = buildProfitAndLossVariantSnapshot_(PNL_VARIANT_BY_CLASS, {
      range, loadedAt, clients: byClassSelection.clients,
      entityConfiguration: byClassSelection.entityConfiguration,
      continueOnClientError: true
    });
    const normal = loadPnlVariantSnapshot_(normalSnapshot);
    const byClass = loadPnlVariantSnapshot_(byClassSnapshot);
    const completedAt = new Date();
    const result = {
      event: 'profit_and_loss_snapshot_completed', success: true,
      startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(), period: range,
      loadedAt,
      clientCounts: { normal: normalSelection.clients.length, byClass: byClassSelection.clients.length },
      entityConfigurations: {
        normal: normalSelection.entityConfiguration,
        byClass: byClassSelection.entityConfiguration
      },
      schemaValidation,
      reports: {
        normal: {
          rowCount: normal.rowCount, jobId: normal.loadResult.jobId,
          loadResult: normal.loadResult, verification: normal.verification,
          clientResults: normal.clientResults
        },
        byClass: {
          rowCount: byClass.rowCount, jobId: byClass.loadResult.jobId,
          loadResult: byClass.loadResult, reconciliation: byClass.reconciliation,
          verification: byClass.verification, clientResults: byClass.clientResults
        }
      }
    };
    Logger.log(JSON.stringify(result, null, 2));
    const failures = normal.clientFailures.concat(byClass.clientFailures);
    if (failures.length) {
      throw new Error('P&L snapshots loaded successful entities but completed with entity errors: ' +
        JSON.stringify({ snapshotWeek: range.snapshotWeek, failedClientCount: failures.length, failures: failures }));
    }
    return result;
  } finally {
    lock.releaseLock();
  }
}

function snapshotAllProfitAndLossReports() {
  return executeAllProfitAndLossReports_(getPreviousCompletedWeekRange_());
}

function snapshotWeeklyProfitAndLossReports() {
  return executeAllProfitAndLossReports_(getPreviousCompletedWeekRange_());
}

function snapshotMonthlyProfitAndLossReports() {
  return executeAllProfitAndLossReports_(getPreviousCompletedMonthRange_());
}
