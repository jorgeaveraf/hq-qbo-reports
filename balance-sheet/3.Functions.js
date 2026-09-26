/***********************
 * QBO Balance Sheet - Functions
 ***********************/

function updateBalanceSheetExport() {
  Logger.log('--- BALANCE SHEET EXPORT START ---');
  const result = buildBalanceSheetSnapshot_();
  sortBalanceSheetRows_(result.sheetRows);
  writeBalanceSheetOutput_(result.sheetRows);

  const summary = {
    event: 'balance_sheet_export_completed',
    entityConfiguration: result.entityConfiguration,
    clientCount: result.clientCount,
    rawRowCount: result.rawRows.length,
    lineRowCount: result.lineRows.length,
    sheetRowCount: result.sheetRows.length
  };
  Logger.log(JSON.stringify(summary, null, 2));
  Logger.log('--- BALANCE SHEET EXPORT END ---');
  return summary;
}
const BS_RETIRE_INVOCING_SNAPSHOT_TRIGGER = true;

function retireInvokingBalanceSheetSnapshotTrigger_(event) {
  if (!BS_RETIRE_INVOCING_SNAPSHOT_TRIGGER || !event || event.triggerUid == null) return false;

  const triggerUid = String(event.triggerUid);
  const invokingTrigger = ScriptApp.getProjectTriggers().find(trigger => (
    String(trigger.getUniqueId()) === triggerUid &&
    trigger.getHandlerFunction() === 'snapshotBalanceSheetToBigQuery' &&
    trigger.getTriggerSource() === ScriptApp.TriggerSource.CLOCK
  ));

  if (!invokingTrigger) {
    Logger.log(JSON.stringify({
      event: 'balance_sheet_snapshot_trigger_retirement_not_found',
      triggerUid: triggerUid
    }));
    return false;
  }

  ScriptApp.deleteTrigger(invokingTrigger);
  Logger.log(JSON.stringify({
    event: 'balance_sheet_snapshot_trigger_retired',
    triggerUid: triggerUid
  }));
  return true;
}

function snapshotBalanceSheetToBigQuery(event) {
  if (retireInvokingBalanceSheetSnapshotTrigger_(event)) {
    return {
      event: 'balance_sheet_snapshot_trigger_retired',
      triggerUid: String(event.triggerUid)
    };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another Balance Sheet snapshot or deployment is already running.');
  try {
    Logger.log('--- BALANCE SHEET BQ SNAPSHOT START ---');
    const result = executeBalanceSheetBigQuerySnapshot_();
    Logger.log(JSON.stringify({
      event: 'balance_sheet_snapshot_completed',
      entityConfiguration: result.entityConfiguration,
      schemaValidation: result.schemaValidation,
      clientCount: result.clientCount,
      rawRowCount: result.rawRowCount,
      lineRowCount: result.lineRowCount,
      loadResult: result.loadResult,
      verification: result.verification
    }, null, 2));
    Logger.log('--- BALANCE SHEET BQ SNAPSHOT END ---');
    return result;
  } finally {
    lock.releaseLock();
  }
}
function buildBalanceSheetSnapshot_(loadedEntityConfigurationOverride, options) {
  const settings = options || {};
  const snapshotDate = String(settings.snapshotDate || todayIsoDate_()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    throw new Error('Invalid Balance Sheet SnapshotDate: ' + snapshotDate);
  }
  const requestedAsOfDate = String(settings.asOfDate || snapshotDate).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedAsOfDate)) {
    throw new Error('Invalid Balance Sheet as-of date: ' + requestedAsOfDate);
  }
  const snapshotWeek = getWeekStartSunday_(snapshotDate);
  const loadedAt = new Date().toISOString();
  const selection = resolveBalanceEntitySelection_(null, loadedEntityConfigurationOverride);
  const requestedClientIds = Array.from(new Set(
    (settings.clientIds || []).map(id => String(id || '').trim()).filter(Boolean)
  ));
  const clientsById = {};
  if (requestedClientIds.length) {
    requestedClientIds.forEach(clientId => {
      if (!selection.clientsById[clientId]) {
        throw new Error('Balance Sheet backfill client is not authorized: ' + clientId);
      }
      clientsById[clientId] = selection.clientsById[clientId];
    });
  } else {
    Object.keys(selection.clientsById).forEach(clientId => {
      clientsById[clientId] = selection.clientsById[clientId];
    });
  }
  const clientIds = Object.keys(clientsById);
  const rawRows = [];
  const lineRows = [];
  const sheetRows = [];
  const successfulClientIds = [];
  const clientFailures = [];

  Logger.log('Filtered Balance Sheet clients: ' + clientIds.length);

  clientIds.forEach(clientId => {
    const client = clientsById[clientId];
    const rawStart = rawRows.length;
    const lineStart = lineRows.length;
    const sheetStart = sheetRows.length;
    try {
      const payload = fetchBalanceSheet_(clientId, requestedAsOfDate);
      if (!payload) throw new Error('Balance Sheet endpoint returned an empty response.');

    const header = payload.data && payload.data.Header ? payload.data.Header : {};
    const asOfDate = extractBalanceSheetAsOfDate_(payload) || requestedAsOfDate;
    if (settings.requireAsOfDateMatch === true && asOfDate !== requestedAsOfDate) {
      throw new Error(
        'Balance Sheet historical response date mismatch. Requested=' +
          requestedAsOfDate + ', returned=' + asOfDate + ', clientId=' + clientId
      );
    }
    const fetchedAt = payload.fetched_at || '';
    const realmId = payload.realm_id || '';
    const reportName = header.ReportName || 'BalanceSheet';
    const currency = header.Currency || BS_CONFIG.currencyDefault;
    const entity = client.entity || slugifyEntity_(client.name);
    const flatRows = flattenBalanceSheet_(payload);

    rawRows.push({
      SnapshotDate: snapshotDate,
      SnapshotWeek: snapshotWeek,
      Entity: entity,
      ClientId: clientId,
      ClientName: client.name,
      RealmId: realmId,
      AsOfDate: asOfDate,
      FetchedAt: fetchedAt || null,
      LoadedAt: loadedAt,
      PayloadHash: md5Hash_(JSON.stringify(payload)),
      RawRowCount: flatRows.length,
      LineRowCount: flatRows.length,
      Status: 'loaded'
    });

    flatRows.forEach(line => {
      const bqRow = {
        ReportType: reportName,
        Entity: entity,
        ClientName: client.name,
        ClientId: clientId,
        RealmId: realmId,
        SnapshotDate: snapshotDate,
        SnapshotWeek: snapshotWeek,
        AsOfDate: asOfDate,
        FetchedAt: fetchedAt || null,
        LoadedAt: loadedAt,
        StatementSection: line.section,
        StatementSubsection: line.statementSubsection,
        ParentAccount: line.parentAccount,
        AccountName: line.accountName,
        AccountId: line.accountId,
        AccountPath: line.path,
        LineType: line.lineType,
        Level: line.level,
        NormalizedCategory: line.normalizedCategory,
        MetricName: line.metricName,
        IsKeyMetric: line.isKeyMetric,
        Amount: line.amount,
        Currency: currency,
        Source: BS_CONFIG.sourceDefault
      };

      lineRows.push(bqRow);
      sheetRows.push([
        bqRow.ReportType,
        bqRow.Entity,
        bqRow.ClientName,
        bqRow.ClientId,
        bqRow.RealmId,
        bqRow.SnapshotDate,
        bqRow.SnapshotWeek,
        bqRow.AsOfDate,
        bqRow.FetchedAt,
        bqRow.LoadedAt,
        bqRow.StatementSection,
        bqRow.StatementSubsection,
        bqRow.ParentAccount,
        bqRow.AccountName,
        bqRow.AccountId,
        bqRow.AccountPath,
        bqRow.LineType,
        bqRow.Level,
        bqRow.NormalizedCategory,
        bqRow.MetricName,
        bqRow.IsKeyMetric,
        bqRow.Amount,
        bqRow.Currency,
        bqRow.Source
      ]);
    });

      successfulClientIds.push(clientId);
      Logger.log(
        'BS rows clientId=' + clientId + ', clientName=' + client.name + ': ' + flatRows.length
      );
    } catch (error) {
      rawRows.splice(rawStart);
      lineRows.splice(lineStart);
      sheetRows.splice(sheetStart);
      if (settings.continueOnClientError !== true) throw error;
      const message = String(error && error.message || error);
      const statusMatch = message.match(/returned HTTP\s+(\d{3})\b/i);
      const failure = {
        clientId: String(clientId), clientName: String(client && client.name || ''),
        entity: String(client && (client.entity || client.entityAlias) || ''),
        httpStatus: statusMatch ? Number(statusMatch[1]) : null, error: message
      };
      clientFailures.push(failure);
      Logger.log(JSON.stringify({ event: 'balance_sheet_client_failed', failure: failure }));
    }
  });

  return {
    entityConfiguration: selection.entityConfiguration,
    snapshotDate,
    snapshotWeek,
    requestedAsOfDate,
    clientCount: clientIds.length,
    successfulClientIds,
    clientFailures,
    rawRows,
    lineRows,
    sheetRows
  };
}
function getBalanceQboApiKey_() {
  const apiKey = String(
    PropertiesService.getScriptProperties().getProperty(BS_CONFIG.apiKeyProperty) || ''
  ).trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + BS_CONFIG.apiKeyProperty);
  return apiKey;
}
function loadBalanceEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(BALANCE_ENTITY_CONTROL.cacheKey);

  if (cachedValue) {
    try {
      return {
        source: 'script_cache',
        configuration: validateBalanceEntityConfiguration_(JSON.parse(cachedValue))
      };
    } catch (error) {
      Logger.log(JSON.stringify({
        event: 'balance_entity_configuration_cache_invalid',
        error: error.message
      }));
      cache.remove(BALANCE_ENTITY_CONTROL.cacheKey);
    }
  }

  const localConfiguration = readLocalBalanceEntityConfiguration_();
  if (!localConfiguration) {
    throw new Error(
      'No valid local Balance Sheet entity configuration is available. ' +
      'Publish the centralized configuration again or run ' +
      'debugRefreshBalanceEntityConfigurationFromCentral().'
    );
  }

  cacheBalanceEntityConfiguration_(localConfiguration);
  return {
    source: 'script_properties',
    configuration: localConfiguration
  };
}
function refreshBalanceEntityConfigurationFromCentral_() {
  const spreadsheet = getBalanceControlSpreadsheet_();
  const metadata = readBalanceCentralMetadata_(spreadsheet);
  const configuration = readPublishedBalanceEntityConfiguration_(
    spreadsheet,
    metadata.currentVersion
  );
  const persistence = persistBalanceEntityConfiguration_(configuration);
  cacheBalanceEntityConfiguration_(configuration);

  Logger.log(JSON.stringify({
    event: 'balance_entity_configuration_refreshed_manually',
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return {
    source: 'central_sheet_manual',
    configuration,
    persistence
  };
}
function getBalanceControlSpreadsheet_() {
  const spreadsheetId = String(
    PropertiesService.getScriptProperties().getProperty(
      BALANCE_ENTITY_CONTROL.spreadsheetIdProperty
    ) || ''
  ).trim();
  if (!spreadsheetId) {
    throw new Error('Missing Script Property: ' + BALANCE_ENTITY_CONTROL.spreadsheetIdProperty);
  }
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open QBO Report Control. Property=' +
      BALANCE_ENTITY_CONTROL.spreadsheetIdProperty + ', error=' + error.message
    );
  }
}
function readBalanceCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(BALANCE_ENTITY_CONTROL.metadataSheetName);
  if (!sheet) {
    throw new Error('Central metadata sheet not found: ' + BALANCE_ENTITY_CONTROL.metadataSheetName);
  }
  if (sheet.getLastRow() < 2) throw new Error('Central configuration metadata is empty.');

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getDisplayValues();
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
function readPublishedBalanceEntityConfiguration_(spreadsheet, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(BALANCE_ENTITY_CONTROL.publishedSheetName);
  if (!sheet) {
    throw new Error('Central published sheet not found: ' + BALANCE_ENTITY_CONTROL.publishedSheetName);
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

  if (sheet.getLastRow() < 2) throw new Error('Published Configuration is empty.');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, expectedHeaders.length).getDisplayValues();
  const matchingRows = rows.filter(row =>
    String(row[0] || '').trim() === BALANCE_ENTITY_CONTROL.reportKey
  );
  if (matchingRows.length !== 1) {
    throw new Error(
      'Expected exactly one Published Configuration row for ' +
      BALANCE_ENTITY_CONTROL.reportKey + ', found=' + matchingRows.length
    );
  }

  const row = matchingRows[0];
  const rowVersion = Number(row[2]);
  if (rowVersion !== Number(expectedVersion)) {
    throw new Error(
      'Published Balance Sheet configuration version mismatch. Expected=' +
      expectedVersion + ', actual=' + rowVersion
    );
  }

  let configuration;
  try {
    configuration = JSON.parse(String(row[6] || ''));
  } catch (error) {
    throw new Error('Invalid Balance Sheet Configuration JSON: ' + error.message);
  }

  const validated = validateBalanceEntityConfiguration_(configuration, expectedVersion);
  if (validated.configuration_hash !== String(row[3] || '').trim()) {
    throw new Error('Published Balance Sheet row hash does not match Configuration JSON.');
  }
  if (validated.entities.length !== Number(row[5])) {
    throw new Error('Published Balance Sheet entity count does not match Configuration JSON.');
  }
  return validated;
}
function validateBalanceEntityConfiguration_(configuration, expectedVersion) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Balance Sheet entity configuration must be a JSON object.');
  }

  const contractType = String(configuration.contract_type || '').trim();
  const contractVersion = String(configuration.contract_version || '').trim();
  const schemaVersion = String(configuration.schema_version || '').trim();
  const reportKey = String(configuration.report_key || '').trim();
  const configurationVersion = Number(configuration.configuration_version);
  const configurationHash = String(configuration.configuration_hash || '').trim().toLowerCase();
  const publishedAt = String(configuration.published_at || '').trim();

  if (contractType !== BALANCE_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected entity configuration contract_type: ' + contractType);
  }
  if (contractVersion !== BALANCE_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected entity configuration contract_version: ' + contractVersion);
  }
  if (schemaVersion !== BALANCE_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected entity configuration schema_version: ' + schemaVersion);
  }
  if (reportKey !== BALANCE_ENTITY_CONTROL.reportKey) {
    throw new Error('Unexpected entity configuration report_key: ' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid configuration_version: ' + configuration.configuration_version);
  }
  if (expectedVersion !== undefined && configurationVersion !== Number(expectedVersion)) {
    throw new Error(
      'Balance Sheet entity configuration version mismatch. Expected=' + expectedVersion +
      ', actual=' + configurationVersion
    );
  }
  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error('Invalid configuration_hash for Balance Sheet.');
  }
  if (!publishedAt || isNaN(new Date(publishedAt).getTime())) {
    throw new Error('Invalid published_at for Balance Sheet.');
  }
  if (!Array.isArray(configuration.entities)) {
    throw new Error('Balance Sheet entity configuration entities must be an array.');
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
    if (matchType === 'first_word') matchValue = getFirstWordNormalized_(matchValue);
    if (!matchValue) throw new Error('Missing match_value at index ' + index + '.');
    if (!entityAlias || !/^[a-z0-9_]+$/.test(entityAlias)) {
      throw new Error('Invalid entity_alias at index ' + index + ': ' + entityAlias);
    }

    const matchKey = matchType + '|' + matchValue;
    if (seenMatches[matchKey]) throw new Error('Duplicate entity authorization: ' + matchKey);
    seenMatches[matchKey] = true;
    return { match_type: matchType, match_value: matchValue, entity_alias: entityAlias };
  }).sort((left, right) => {
    const typeDifference = left.match_type.localeCompare(right.match_type);
    return typeDifference || left.match_value.localeCompare(right.match_value);
  });

  if (!entities.length) {
    throw new Error('Balance Sheet entity configuration contains no authorizations.');
  }

  const calculatedHash = sha256Hex_(JSON.stringify({
    schema_version: schemaVersion,
    report_key: reportKey,
    entities
  }));
  if (calculatedHash !== configurationHash) {
    throw new Error(
      'Balance Sheet entity configuration hash mismatch. Expected=' +
      configurationHash + ', calculated=' + calculatedHash
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
function readLocalBalanceEntityConfiguration_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    BALANCE_ENTITY_CONTROL.localPropertyKey
  );
  if (!serialized) return null;
  try {
    return validateBalanceEntityConfiguration_(JSON.parse(serialized));
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'balance_local_entity_configuration_invalid',
      error: error.message
    }));
    return null;
  }
}
function persistBalanceEntityConfiguration_(configuration) {
  const validated = validateBalanceEntityConfiguration_(configuration);
  const serialized = JSON.stringify(validated);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > BALANCE_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Balance Sheet entity configuration exceeds Script Property safe size. bytes=' + byteCount
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    BALANCE_ENTITY_CONTROL.localPropertyKey,
    serialized
  );
  return { propertyKey: BALANCE_ENTITY_CONTROL.localPropertyKey, byteCount };
}
function cacheBalanceEntityConfiguration_(configuration) {
  const validated = validateBalanceEntityConfiguration_(configuration);
  CacheService.getScriptCache().put(
    BALANCE_ENTITY_CONTROL.cacheKey,
    JSON.stringify(validated),
    BALANCE_ENTITY_CONTROL.cacheTtlSeconds
  );
}
function fetchBalanceSourceClients_() {
  const payload = fetchJsonOrThrow_(BS_CONFIG.baseUrl + '/clients', '/clients');
  const sourceClients = extractClientsArray_(payload);
  const clientsById = {};

  sourceClients.forEach(client => {
    const id = String(client.id || client.clientId || client.client_id || '').trim();
    const name = String(
      client.name || client.clientName || client.displayName || client.companyName || ''
    ).trim();
    if (!id || !name) return;
    clientsById[id] = {
      id,
      name,
      firstWord: getFirstWordNormalized_(name)
    };
  });

  return Object.keys(clientsById)
    .map(id => clientsById[id])
    .sort((left, right) => left.name.localeCompare(right.name));
}
function resolveBalanceEntitySelection_(sourceClients, loadedEntityConfigurationOverride) {
  const loaded = loadedEntityConfigurationOverride
    ? {
        source: String(loadedEntityConfigurationOverride.source || 'configuration_deployment'),
        configuration: validateBalanceEntityConfiguration_(loadedEntityConfigurationOverride.configuration)
      }
    : loadBalanceEntityConfiguration_();
  const clients = Array.isArray(sourceClients) ? sourceClients.slice() : fetchBalanceSourceClients_();
  const firstWordAliases = {};
  const clientIdAliases = {};

  loaded.configuration.entities.forEach(entity => {
    if (entity.match_type === 'client_id') {
      clientIdAliases[entity.match_value] = entity.entity_alias;
    } else {
      firstWordAliases[entity.match_value] = entity.entity_alias;
    }
  });

  let clientIdMatchCount = 0;
  let firstWordMatchCount = 0;
  const clientsById = {};

  clients.forEach(client => {
    const clientIdAlias = clientIdAliases[client.id];
    const firstWordAlias = firstWordAliases[client.firstWord];
    const entityAlias = clientIdAlias || firstWordAlias;
    if (!entityAlias) return;

    if (clientIdAlias) clientIdMatchCount++;
    else firstWordMatchCount++;

    clientsById[client.id] = {
      id: client.id,
      name: client.name,
      entity: entityAlias,
      outputSheetName: entityAlias,
      firstWord: client.firstWord,
      authorizationMatchType: clientIdAlias ? 'client_id' : 'first_word',
      authorizationMatchValue: clientIdAlias ? client.id : client.firstWord
    };
  });

  const entityConfiguration = {
    source: loaded.source,
    reportKey: BALANCE_ENTITY_CONTROL.reportKey,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    publishedAt: loaded.configuration.published_at,
    authorizedEntityCount: loaded.configuration.entities.length
  };

  Logger.log(JSON.stringify({
    event: 'balance_sheet_clients_filtered',
    configurationSource: loaded.source,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    authorizationEntityCount: loaded.configuration.entities.length,
    sourceClientCount: clients.length,
    filteredClientCount: Object.keys(clientsById).length,
    clientIdMatchCount,
    firstWordMatchCount
  }));

  return {
    clientsById,
    entityConfiguration,
    sourceClientCount: clients.length,
    loaded
  };
}
function doPost(e) {
  try {
    return createBalanceJsonResponse_(handleBalanceEntityConfigurationPush_(e));
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'balance_entity_configuration_push_failed',
      error: error.message,
      stack: error.stack || null
    }));
    return createBalanceJsonResponse_({
      success: false,
      status: 'error',
      error: error.message
    });
  }
}
function createBalanceJsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
function handleBalanceEntityConfigurationPush_(e) {
  const rawBody = e && e.postData ? String(e.postData.contents || '') : '';
  if (!rawBody) throw new Error('Push request body is empty.');
  let envelope;
  try { envelope = JSON.parse(rawBody); } catch (error) { throw new Error('Push envelope is invalid JSON: ' + error.message); }
  if (String(envelope.contract_type || '') !== BALANCE_ENTITY_CONTROL.pushEnvelopeContractType) throw new Error('Unexpected push envelope contract_type.');
  if (String(envelope.contract_version || '') !== BALANCE_ENTITY_CONTROL.pushEnvelopeContractVersion) throw new Error('Unexpected push envelope contract_version.');
  const serializedPayload = String(envelope.payload || '');
  const signature = String(envelope.signature || '').trim().toLowerCase();
  if (!serializedPayload || !/^[a-f0-9]{64}$/.test(signature)) throw new Error('Push envelope payload or signature is invalid.');
  const expectedSignature = hmacSha256Hex_(serializedPayload, getBalanceEntityPushSecret_());
  if (!secureHexEquals_(signature, expectedSignature)) throw new Error('Push signature validation failed.');
  let pushPayload;
  try { pushPayload = JSON.parse(serializedPayload); } catch (error) { throw new Error('Push payload is invalid JSON: ' + error.message); }
  if (String(pushPayload.contract_type || '') !== BALANCE_ENTITY_CONTROL.pushContractType) throw new Error('Unexpected push payload contract_type.');
  if (String(pushPayload.contract_version || '') !== BALANCE_ENTITY_CONTROL.pushContractVersion) throw new Error('Unexpected push payload contract_version.');
  if (String(pushPayload.report_key || '') !== BALANCE_ENTITY_CONTROL.reportKey) throw new Error('Unexpected push report_key: ' + pushPayload.report_key);
  const requestId = String(pushPayload.request_id || '').trim();
  const sentAt = String(pushPayload.sent_at || '').trim();
  if (!requestId) throw new Error('Push request_id is required.');
  if (!sentAt || isNaN(new Date(sentAt).getTime())) throw new Error('Push sent_at is invalid.');
  const ageSeconds = (Date.now() - new Date(sentAt).getTime()) / 1000;
  if (ageSeconds > BALANCE_ENTITY_CONTROL.pushMaxAgeSeconds) throw new Error('Push request is too old. ageSeconds=' + Math.round(ageSeconds));
  if (ageSeconds < -BALANCE_ENTITY_CONTROL.pushFutureToleranceSeconds) throw new Error('Push request sent_at is too far in the future.');
  const incomingConfiguration = validateBalanceEntityConfiguration_(pushPayload.configuration, pushPayload.configuration_version);
  if (incomingConfiguration.configuration_hash !== String(pushPayload.configuration_hash || '').trim()) throw new Error('Push configuration_hash does not match the configuration object.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Balance Sheet configuration deployment lock is busy. Retry the publication.');
  try {
    const localConfiguration = readLocalBalanceEntityConfiguration_();
    const incomingVersion = incomingConfiguration.configuration_version;
    if (localConfiguration) {
      const localVersion = localConfiguration.configuration_version;
      if (incomingVersion < localVersion) throw new Error('Stale configuration rejected. Incoming=' + incomingVersion + ', local=' + localVersion);
      if (incomingVersion === localVersion && incomingConfiguration.configuration_hash !== localConfiguration.configuration_hash) {
        throw new Error('Configuration version ' + incomingVersion + ' conflicts with the local hash.');
      }
    }
    const existing = readBalanceDeploymentState_();
    const sameOperation = existing && existing.configuration_version === incomingVersion && existing.configuration_hash === incomingConfiguration.configuration_hash;
    if (sameOperation && ['pending', 'processing', 'completed', 'failed'].includes(existing.status)) {
      cacheBalanceEntityConfiguration_(incomingConfiguration);
      persistBalancePushReceipt_(pushPayload, incomingConfiguration, 'idempotent', existing);
      return {
        success: true,
        status: 'idempotent',
        reportKey: BALANCE_ENTITY_CONTROL.reportKey,
        configurationVersion: incomingVersion,
        configurationHash: incomingConfiguration.configuration_hash
      };
    }
    persistBalanceEntityConfiguration_(incomingConfiguration);
    cacheBalanceEntityConfiguration_(incomingConfiguration);
    const deployment = queueBalanceConfigurationDeployment_(pushPayload, incomingConfiguration);
    persistBalancePushReceipt_(pushPayload, incomingConfiguration, 'queued', deployment);
    return {
      success: true,
      status: 'queued',
      reportKey: BALANCE_ENTITY_CONTROL.reportKey,
      configurationVersion: incomingVersion,
      configurationHash: incomingConfiguration.configuration_hash,
      operationId: deployment.operationId,
      deploymentStatus: deployment.deploymentStatus,
      currentStage: deployment.currentStage
    };
  } finally {
    lock.releaseLock();
  }
}
function persistBalancePushReceipt_(pushPayload, configuration, status, deployment) {
  const receipt = {
    request_id: pushPayload.request_id,
    report_key: BALANCE_ENTITY_CONTROL.reportKey,
    status,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: pushPayload.sent_at,
    received_at: new Date().toISOString(),
    operation_id: deployment && (deployment.operationId || deployment.operation_id) || null,
    deployment_status: deployment && (deployment.deploymentStatus || deployment.status) || null,
    current_stage: deployment && (deployment.currentStage || deployment.current_stage) || null
  };
  PropertiesService.getScriptProperties().setProperty(BALANCE_ENTITY_CONTROL.pushReceiptProperty, JSON.stringify(receipt));
  return receipt;
}
function getBalanceEntityPushEndpointUrl_() {
  const endpointUrl = String(
    PropertiesService.getScriptProperties().getProperty(
      BALANCE_ENTITY_CONTROL.pushEndpointUrlProperty
    ) || ''
  ).trim();
  if (!endpointUrl) {
    throw new Error('Missing Script Property: ' + BALANCE_ENTITY_CONTROL.pushEndpointUrlProperty);
  }
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(endpointUrl)) {
    throw new Error('Balance Sheet push endpoint must be a deployed Web App URL ending in /exec.');
  }
  return endpointUrl;
}
function getBalanceEntityPushSecret_() {
  const secret = String(
    PropertiesService.getScriptProperties().getProperty(
      BALANCE_ENTITY_CONTROL.pushSecretProperty
    ) || ''
  ).trim();
  if (!secret) throw new Error('Missing Script Property: ' + BALANCE_ENTITY_CONTROL.pushSecretProperty);
  if (secret.length < 32) {
    throw new Error('Balance Sheet entity push secret must contain at least 32 characters.');
  }
  return secret;
}
function hmacSha256Hex_(value, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(value),
    String(secret),
    Utilities.Charset.UTF_8
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
function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(byte => {
    const unsignedByte = byte < 0 ? byte + 256 : byte;
    return unsignedByte.toString(16).padStart(2, '0');
  }).join('');
}
function fetchClients_() {
  return resolveBalanceEntitySelection_().clientsById;
}
function fetchBalanceSheet_(clientId, asOfDate) {
  const url =
    BS_CONFIG.baseUrl +
    '/qbo/' +
    encodeURIComponent(clientId) +
    '/reports/balance-sheet' +
    '?environment=' +
    encodeURIComponent(BS_CONFIG.environment) +
    '&as_of_date=' +
    encodeURIComponent(asOfDate || todayIsoDate_());

  const response = fetchJsonResponse_(url);

  if (response.error) {
    Logger.log('Error BS clientId=' + clientId + ': ' + response.error);
    return null;
  }

  if (response.status < 200 || response.status >= 300) {
    Logger.log(
      'HTTP BS ' +
        response.status +
        ' clientId=' +
        clientId +
        ', body=' +
        response.body.slice(0, 500)
    );
    return null;
  }

  if (response.parseError) {
    Logger.log('JSON inválido BS clientId=' + clientId + ': ' + response.parseError);
    return null;
  }

  return response.json;
}
function fetchJsonOrThrow_(url, contextLabel) {
  const response = fetchJsonResponse_(url);

  if (response.error) {
    throw new Error('Error de red en ' + contextLabel + ': ' + response.error);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      'Error en ' +
        contextLabel +
        ' HTTP ' +
        response.status +
        ': ' +
        response.body.slice(0, 500)
    );
  }

  if (response.parseError) {
    throw new Error('JSON inválido en ' + contextLabel + ': ' + response.parseError);
  }

  return response.json;
}
function fetchJsonResponse_(url) {
  const options = {
    method: 'get',
    headers: {
      'X-API-Key': getBalanceQboApiKey_()
    },
    muteHttpExceptions: true
  };

  try {
    const resp = UrlFetchApp.fetch(url, options);
    const body = resp.getContentText();
    let json = null;
    let parseError = null;

    try {
      json = JSON.parse(body);
    } catch (error) {
      parseError = String(error);
    }

    return {
      status: resp.getResponseCode(),
      body,
      json,
      parseError
    };
  } catch (error) {
    return {
      status: 0,
      body: '',
      json: null,
      parseError: null,
      error: String(error)
    };
  }
}
function flattenBalanceSheet_(payload) {
  const rows =
    payload &&
    payload.data &&
    payload.data.Rows &&
    Array.isArray(payload.data.Rows.Row)
      ? payload.data.Rows.Row
      : [];

  const out = [];
  flattenBalanceSheetRowsRecursive_(rows, [], out);
  return out;
}
function flattenBalanceSheetRowsRecursive_(rows, pathParts, out) {
  if (!Array.isArray(rows)) return;

  rows.forEach(row => {
    const headerName = getBalanceSheetNameFromColData_(row.Header && row.Header.ColData);
    const headerId = getBalanceSheetIdFromColData_(row.Header && row.Header.ColData);
    const headerAmount = getBalanceSheetAmountFromColData_(row.Header && row.Header.ColData);

    let currentPath = pathParts.slice();

    if (headerName) {
      currentPath.push(headerName);

      if (headerAmount !== null && headerAmount !== '') {
        pushBalanceSheetLine_(out, {
          lineType: 'Header',
          pathParts: currentPath,
          accountName: headerName,
          accountId: headerId,
          amount: headerAmount
        });
      }
    }

    const nestedRows = row.Rows && row.Rows.Row;

    if (Array.isArray(nestedRows) && nestedRows.length) {
      flattenBalanceSheetRowsRecursive_(nestedRows, currentPath, out);
    }

    const dataName = getBalanceSheetNameFromColData_(row.ColData);
    const dataId = getBalanceSheetIdFromColData_(row.ColData);
    const dataAmount = getBalanceSheetAmountFromColData_(row.ColData);

    if (dataName) {
      const dataPath = currentPath.concat([dataName]);

      pushBalanceSheetLine_(out, {
        lineType: 'Data',
        pathParts: dataPath,
        accountName: dataName,
        accountId: dataId,
        amount: dataAmount
      });
    }

    const summaryName = getBalanceSheetNameFromColData_(row.Summary && row.Summary.ColData);
    const summaryAmount = getBalanceSheetAmountFromColData_(row.Summary && row.Summary.ColData);

    if (summaryName) {
      const summaryPath = currentPath.concat([summaryName]);

      pushBalanceSheetLine_(out, {
        lineType: 'Summary',
        pathParts: summaryPath,
        accountName: summaryName,
        accountId: '',
        amount: summaryAmount
      });
    }
  });
}
function pushBalanceSheetLine_(out, line) {
  const pathParts = line.pathParts || [];
  const normalizedCategory = normalizeBalanceSheetCategory_(
    line.accountName,
    line.lineType,
    pathParts
  );

  out.push({
    lineType: line.lineType || '',
    level: pathParts.length,
    path: pathParts.join(' > '),
    section: pathParts[0] || '',
    statementSubsection: pathParts[1] || '',
    parentAccount: pathParts.length >= 2 ? pathParts[pathParts.length - 2] : '',
    accountName: line.accountName || '',
    accountId: line.accountId || '',
    amount: line.amount === null || line.amount === '' ? 0 : roundTo2_(line.amount),
    normalizedCategory: normalizedCategory,
    metricName: metricNameFromCategory_(normalizedCategory),
    isKeyMetric: normalizedCategory ? true : false
  });
}
function normalizeBalanceSheetCategory_(accountName, lineType, pathParts) {
  const name = normalizeBsText_(accountName);
  const path = normalizeBsText_((pathParts || []).join(' > '));

  if (name === 'total assets') return 'total_assets';
  if (name === 'total liabilities') return 'total_liabilities';
  if (name === 'total equity') return 'total_equity';
  if (name === 'total liabilities and equity') return 'total_liabilities_and_equity';

  if (
    lineType === 'Summary' &&
    (
      name.includes('total accounts receivable') ||
      name.includes('total account receivable')
    )
  ) {
    return 'ar_total';
  }

  if (
    lineType === 'Summary' &&
    name.includes('total accounts payable')
  ) {
    return 'ap_total';
  }

  if (lineType === 'Summary' && name === 'total bank accounts') {
    return 'cash_total';
  }

  if (lineType === 'Summary' && name === 'total fixed assets') {
    return 'fixed_assets_total';
  }

  if (lineType === 'Summary' && name === 'total current assets') {
    return 'current_assets_total';
  }

  if (lineType === 'Summary' && name === 'total current liabilities') {
    return 'current_liabilities_total';
  }

  if (lineType === 'Summary' && name === 'total long term liabilities') {
    return 'long_term_liabilities_total';
  }

  if (name === 'net income') return 'net_income';

  // Inventory root total ONLY
  if (
    lineType === 'Summary' &&
    isInventoryRootTotal_(name, path)
  ) {
    return 'inventory_total';
  }

  // Optional sub-metrics
  if (lineType === 'Summary' && name.includes('retail inventory')) {
    return 'inventory_retail_total';
  }

  if (lineType === 'Summary' && name.includes('wholesale inventory')) {
    return 'inventory_wholesale_total';
  }

  if (lineType === 'Summary' && name.includes('finished goods')) {
    return 'inventory_finished_goods_total';
  }

  return '';
}
function metricNameFromCategory_(category) {
  const map = {
    cash_total: 'Cash',
    ar_total: 'Accounts Receivable',
    inventory_total: 'Inventory',
    inventory_retail_total: 'Inventory - Retail',
    inventory_wholesale_total: 'Inventory - Wholesale',
    inventory_finished_goods_total: 'Inventory - Finished Goods',
    current_assets_total: 'Current Assets',
    fixed_assets_total: 'Fixed Assets',
    total_assets: 'Total Assets',
    ap_total: 'Accounts Payable',
    current_liabilities_total: 'Current Liabilities',
    long_term_liabilities_total: 'Long-Term Liabilities',
    total_liabilities: 'Total Liabilities',
    total_equity: 'Total Equity',
    total_liabilities_and_equity: 'Total Liabilities and Equity',
    net_income: 'Net Income'
  };

  return map[category] || '';
}
function isInventoryRootTotal_(name, path) {
  // Nova / MA style
  if (name === 'total 13000 inventory') return true;

  // Eaze / PT style
  if (name === 'total 1500 00 inventory asset') return true;

  // Pura / generic style
  if (name === 'total inventory') return true;

  // Evita subtotales hijos
  const childInventoryTotals = [
    'retail inventory',
    'wholesale inventory',
    'finished goods',
    'packaging inventory',
    'promotional',
    'marketing inventory',
    'raw materials',
    'work in progress',
    'wip',
    'flower',
    'distillate',
    'powder',
    'terpenes',
    'rosin'
  ];

  for (let i = 0; i < childInventoryTotals.length; i++) {
    if (name.includes(childInventoryTotals[i])) return false;
  }

  if (
    name.includes('total') &&
    name.includes('inventory') &&
    path.includes('other current assets')
  ) {
    return true;
  }

  return false;
}
function normalizeBsText_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function insertRowsToBigQuery_(datasetId, tableId, rows, insertIdFn) {
  const targetTable = [BQ_CONFIG.projectId, datasetId, tableId].join('.');

  if (!rows.length) {
    Logger.log('No hay filas para insertar en ' + targetTable);
    return;
  }

  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    const request = {
      rows: batch.map((row, idx) => ({
        insertId: insertIdFn(row, i + idx),
        json: row
      }))
    };

    const response = BigQuery.Tabledata.insertAll(
      request,
      BQ_CONFIG.projectId,
      datasetId,
      tableId
    );

    if (response.insertErrors && response.insertErrors.length) {
      throw new Error(
        'BigQuery insert errors table=' +
          targetTable +
          ': ' +
          JSON.stringify(response.insertErrors)
      );
    }

    Logger.log('BQ batch inserted table=' + targetTable + ': ' + batch.length);
  }
}
function getBalanceSheetNameFromColData_(colData) {
  if (!Array.isArray(colData) || !colData.length) return '';
  return String((colData[0] && colData[0].value) || '').trim();
}
function getBalanceSheetIdFromColData_(colData) {
  if (!Array.isArray(colData) || !colData.length) return '';
  return String((colData[0] && colData[0].id) || '').trim();
}
function getBalanceSheetAmountFromColData_(colData) {
  if (!Array.isArray(colData) || colData.length < 2) return null;
  return parseAmount_(colData[1] && colData[1].value);
}
function parseAmount_(value) {
  if (value === null || typeof value === 'undefined' || value === '') return 0;
  if (typeof value === 'number') return roundTo2_(value);

  let text = String(value).trim();
  if (!text) return 0;

  text = text.replace(/,/g, '').replace(/\$/g, '');

  if (text[0] === '(' && text[text.length - 1] === ')') {
    text = '-' + text.slice(1, -1);
  }

  const parsed = Number(text);
  if (isNaN(parsed)) return 0;

  return roundTo2_(parsed);
}
function roundTo2_(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
function md5Hash_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    text,
    Utilities.Charset.UTF_8
  );

  return bytes
    .map(function(byte) {
      const v = (byte + 256) % 256;
      return ('0' + v.toString(16)).slice(-2);
    })
    .join('');
}
function extractBalanceSheetAsOfDate_(payload) {
  const header = payload && payload.data && payload.data.Header ? payload.data.Header : null;

  if (header) {
    return normalizeDateForOutput_(
      header.EndPeriod ||
        header.ReportDate ||
        header.AsOfDate ||
        header.Time
    );
  }

  return todayIsoDate_();
}
function todayIsoDate_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTimeZone_(), 'yyyy-MM-dd');
}
function getWeekStartSunday_(isoDate) {
  const date = safeParseDate_(isoDate);
  if (!date) return isoDate;

  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - day);

  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}
function normalizeDateForOutput_(value) {
  const date = safeParseDate_(value);
  if (!date) return '';
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}
function safeParseDate_(value) {
  if (!value) return null;

  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }

  const text = String(value).trim();
  if (!text) return null;

  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

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
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const tz = ss ? ss.getSpreadsheetTimeZone() : null;
    return tz || Session.getScriptTimeZone() || 'Etc/UTC';
  } catch (e) {
    return Session.getScriptTimeZone() || 'Etc/UTC';
  }
}
function writeBalanceSheetOutput_(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(BS_CONFIG.outputSheetName);

  if (!sheet) sheet = ss.insertSheet(BS_CONFIG.outputSheetName);

  sheet.clearContents();

  sheet
    .getRange(1, 1, 1, BS_EXPORT_COLUMNS.length)
    .setValues([BS_EXPORT_COLUMNS]);

  if (!rows.length) return;

  sheet
    .getRange(2, 1, rows.length, BS_EXPORT_COLUMNS.length)
    .setValues(rows);

  sheet.getRange(2, 22, rows.length, 1).setNumberFormat('0.00');

  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, BS_EXPORT_COLUMNS.length);
}
function sortBalanceSheetRows_(rows) {
  rows.sort((a, b) => {
    const entityDiff = String(a[1]).localeCompare(String(b[1]));
    if (entityDiff !== 0) return entityDiff;

    const sectionDiff = String(a[10]).localeCompare(String(b[10]));
    if (sectionDiff !== 0) return sectionDiff;

    return Number(a[17] || 0) - Number(b[17] || 0);
  });
}
function extractClientsArray_(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.clients)) return payload.clients;
  if (payload.data && Array.isArray(payload.data.clients)) return payload.data.clients;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (Array.isArray(payload.items)) return payload.items;

  return [];
}
function getFirstWordNormalized_(name) {
  const tokens = String(name || '')
    .trim()
    .toLowerCase()
    .split(/[\s_-]+/)
    .filter(Boolean);

  return tokens.length ? tokens[0].toLowerCase() : '';
}
function slugifyEntity_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/***********************
 * Validated BigQuery Snapshot
 ***********************/

function executeBalanceSheetBigQuerySnapshot_(loadedEntityConfigurationOverride, options) {
  const settings = options || {};
  const snapshot = buildBalanceSheetSnapshot_(loadedEntityConfigurationOverride, {
    continueOnClientError: true,
    snapshotDate: settings.snapshotDate || null,
    asOfDate: settings.asOfDate || null,
    clientIds: settings.clientIds || null,
    requireAsOfDateMatch: settings.requireAsOfDateMatch === true
  });
  const hasClientFailures = snapshot.clientFailures.length > 0;
  if (!snapshot.successfulClientIds.length) {
    throw new Error(
      'Balance Sheet snapshot did not produce any valid client rows: ' +
        JSON.stringify({
          snapshotDate: snapshot.snapshotDate,
          requestedAsOfDate: snapshot.requestedAsOfDate,
          failures: snapshot.clientFailures
        })
    );
  }
  const useClientScope = settings.forceClientScope === true || hasClientFailures;
  const schemaValidation = validateBalanceSheetBigQuerySchema_();
  const loadResult = useClientScope
    ? replaceBalanceSheetSnapshotClients_(snapshot)
    : replaceBalanceSheetSnapshotPartition_(snapshot);
  const verification = verifyBalanceSheetSnapshotPartition_(
    snapshot.snapshotDate,
    snapshot.lineRows.length,
    useClientScope ? snapshot.successfulClientIds : null
  );
  const result = {
    status: hasClientFailures ? 'completed_with_entity_errors' : 'completed',
    entityConfiguration: snapshot.entityConfiguration,
    schemaValidation,
    snapshotDate: snapshot.snapshotDate,
    snapshotWeek: snapshot.snapshotWeek,
    requestedAsOfDate: snapshot.requestedAsOfDate,
    clientCount: snapshot.clientCount,
    rawRowCount: snapshot.rawRows.length,
    lineRowCount: snapshot.lineRows.length,
    successfulClientIds: snapshot.successfulClientIds,
    clientFailures: snapshot.clientFailures,
    loadResult,
    verification
  };
  if (hasClientFailures) {
    Logger.log(JSON.stringify(result, null, 2));
    throw new Error('Balance Sheet snapshot loaded successful entities but completed with entity errors: ' +
      JSON.stringify({ snapshotDate: snapshot.snapshotDate,
        successfulClientCount: snapshot.successfulClientIds.length,
        failedClientCount: snapshot.clientFailures.length, failures: snapshot.clientFailures }));
  }
  return result;
}

function validateBalanceSheetBigQuerySchema_() {
  const snapshotTable = BigQuery.Tables.get(
    BQ_CONFIG.projectId,
    BQ_CONFIG.snapshotsDatasetId,
    BQ_CONFIG.snapshotsTableId
  );
  const auditTable = BigQuery.Tables.get(
    BQ_CONFIG.projectId,
    BQ_CONFIG.auditDatasetId,
    BQ_CONFIG.auditTableId
  );

  const expectedSnapshotColumns = BS_EXPORT_COLUMNS;
  const expectedAuditColumns = [
    'SnapshotDate',
    'SnapshotWeek',
    'Entity',
    'ClientId',
    'ClientName',
    'RealmId',
    'AsOfDate',
    'FetchedAt',
    'LoadedAt',
    'PayloadHash',
    'RawRowCount',
    'LineRowCount',
    'Status'
  ];

  const actualSnapshotFields = snapshotTable.schema && snapshotTable.schema.fields || [];
  const actualSnapshotColumns = actualSnapshotFields.map(field => String(field.name || ''));
  const missingSnapshotColumns = expectedSnapshotColumns.filter(
    name => !actualSnapshotColumns.includes(name)
  );

  const actualAuditFields = auditTable.schema && auditTable.schema.fields || [];
  const actualAuditColumns = actualAuditFields.map(field => String(field.name || ''));
  const missingAuditColumns = expectedAuditColumns.filter(
    name => !actualAuditColumns.includes(name)
  );

  const snapshotPartitionField = String(
    snapshotTable.timePartitioning && snapshotTable.timePartitioning.field || ''
  );
  const snapshotPartitionType = String(
    snapshotTable.timePartitioning && snapshotTable.timePartitioning.type || ''
  ).toUpperCase();
  const auditPartitionField = String(
    auditTable.timePartitioning && auditTable.timePartitioning.field || ''
  );
  const auditPartitionType = String(
    auditTable.timePartitioning && auditTable.timePartitioning.type || ''
  ).toUpperCase();

  const snapshotMismatch =
    missingSnapshotColumns.length ||
    snapshotPartitionField !== BALANCE_BIGQUERY_PARTITION_FIELD ||
    snapshotPartitionType !== 'DAY';
  const auditMismatch =
    missingAuditColumns.length ||
    auditPartitionField !== BALANCE_BIGQUERY_PARTITION_FIELD ||
    auditPartitionType !== 'DAY';

  if (snapshotMismatch || auditMismatch) {
    throw new Error('Balance Sheet BigQuery schema mismatch: ' + JSON.stringify({
      snapshot: {
        table: BALANCE_SNAPSHOT_TABLE,
        missingColumns: missingSnapshotColumns,
        partition: {
          expectedField: BALANCE_BIGQUERY_PARTITION_FIELD,
          expectedType: 'DAY',
          actualField: snapshotPartitionField,
          actualType: snapshotPartitionType
        }
      },
      audit: {
        table: BALANCE_AUDIT_TABLE,
        missingColumns: missingAuditColumns,
        partition: {
          expectedField: BALANCE_BIGQUERY_PARTITION_FIELD,
          expectedType: 'DAY',
          actualField: auditPartitionField,
          actualType: auditPartitionType
        }
      }
    }));
  }

  return {
    status: 'passed',
    snapshotTable: BALANCE_SNAPSHOT_TABLE,
    auditTable: BALANCE_AUDIT_TABLE,
    expectedColumnCount: expectedSnapshotColumns.length,
    actualColumnCount: actualSnapshotFields.length,
    partition: {
      field: snapshotPartitionField,
      type: snapshotPartitionType
    },
    clustering: snapshotTable.clustering && snapshotTable.clustering.fields || [],
    auditColumnCount: actualAuditFields.length,
    auditPartition: {
      field: auditPartitionField,
      type: auditPartitionType
    },
    auditClustering: auditTable.clustering && auditTable.clustering.fields || []
  };
}

function replaceBalanceSheetSnapshotPartition_(snapshot) {
  const snapshotDate = String(snapshot && snapshot.snapshotDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error('Invalid Balance Sheet SnapshotDate: ' + snapshotDate);
  snapshot.lineRows.forEach((row, index) => {
    if (String(row.SnapshotDate || '') !== snapshotDate) throw new Error('Balance Sheet row ' + index + ' belongs to another partition.');
  });
  const partitionId = snapshotDate.replace(/-/g, '');
  const snapshotLoad = loadBalanceRowsToPartition_(
    BQ_CONFIG.snapshotsDatasetId,
    BQ_CONFIG.snapshotsTableId,
    snapshot.lineRows,
    partitionId,
    'balance_sheet_snapshot'
  );
  const auditLoad = loadBalanceRowsToPartition_(
    BQ_CONFIG.auditDatasetId,
    BQ_CONFIG.auditTableId,
    snapshot.rawRows,
    partitionId,
    'balance_sheet_audit'
  );
  return {
    mode: 'partition_replace',
    state: snapshotLoad.state === 'DONE' && auditLoad.state === 'DONE' ? 'DONE' : 'UNKNOWN',
    snapshotDate,
    partitionId,
    snapshot: snapshotLoad,
    audit: auditLoad
  };
}

function escapeBalanceBigQueryString_(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildBalanceClientScopeSql_(clientIds) {
  const ids = Array.from(new Set((clientIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) throw new Error('At least one successful Balance Sheet client is required.');
  return ids.map(id => "'" + escapeBalanceBigQueryString_(id) + "'").join(', ');
}

function loadBalanceRowsToStaging_(datasetId, sourceTableId, stagingTableId, rows, jobPrefix) {
  if (!rows.length) return null;
  const source = BigQuery.Tables.get(BQ_CONFIG.projectId, datasetId, sourceTableId);
  BigQuery.Tables.insert({
    tableReference: { projectId: BQ_CONFIG.projectId, datasetId: datasetId, tableId: stagingTableId },
    schema: { fields: source.schema && source.schema.fields || [] }
  }, BQ_CONFIG.projectId, datasetId);
  const blob = Utilities.newBlob(rows.map(JSON.stringify).join('\n'), 'application/octet-stream', stagingTableId + '.ndjson');
  const inserted = BigQuery.Jobs.insert({
    jobReference: { projectId: BQ_CONFIG.projectId, jobId: jobPrefix + '_' + Utilities.getUuid().replace(/-/g, ''),
      location: getBalanceBigQueryLocation_(datasetId) },
    configuration: { load: {
      destinationTable: { projectId: BQ_CONFIG.projectId, datasetId: datasetId, tableId: stagingTableId },
      sourceFormat: 'NEWLINE_DELIMITED_JSON', createDisposition: 'CREATE_NEVER', writeDisposition: 'WRITE_TRUNCATE',
      autodetect: false, ignoreUnknownValues: false, maxBadRecords: 0
    } }
  }, BQ_CONFIG.projectId, blob);
  return waitForBalanceBigQueryJob_(inserted.jobReference, 120000, datasetId);
}

function replaceBalanceSheetSnapshotClients_(snapshot) {
  const snapshotDate = String(snapshot && snapshot.snapshotDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) throw new Error('Invalid Balance Sheet SnapshotDate: ' + snapshotDate);
  const ids = Array.from(new Set((snapshot.successfulClientIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  if (!ids.length) return { mode: 'client_scope_noop', snapshotDate: snapshotDate,
    successfulClientCount: 0, lineRowCount: 0, auditRowCount: 0, state: 'SKIPPED' };
  const allowed = {};
  ids.forEach(id => { allowed[id] = true; });
  snapshot.lineRows.forEach((row, index) => {
    if (String(row.SnapshotDate || '') !== snapshotDate || !allowed[String(row.ClientId || '')]) {
      throw new Error('Balance Sheet line row ' + index + ' is outside the successful client replacement scope.');
    }
  });
  snapshot.rawRows.forEach((row, index) => {
    if (String(row.SnapshotDate || '') !== snapshotDate || !allowed[String(row.ClientId || '')]) {
      throw new Error('Balance Sheet audit row ' + index + ' is outside the successful client replacement scope.');
    }
  });
  const token = Utilities.getUuid().replace(/-/g, '');
  const snapshotStage = 'balance_sheet_snapshot_stage_' + token;
  const auditStage = 'balance_sheet_audit_stage_' + token;
  const auditColumns = ['SnapshotDate', 'SnapshotWeek', 'Entity', 'ClientId', 'ClientName', 'RealmId',
    'AsOfDate', 'FetchedAt', 'LoadedAt', 'PayloadHash', 'RawRowCount', 'LineRowCount', 'Status'];
  try {
    loadBalanceRowsToStaging_(BQ_CONFIG.snapshotsDatasetId, BQ_CONFIG.snapshotsTableId,
      snapshotStage, snapshot.lineRows, 'balance_snapshot_stage');
    loadBalanceRowsToStaging_(BQ_CONFIG.auditDatasetId, BQ_CONFIG.auditTableId,
      auditStage, snapshot.rawRows, 'balance_audit_stage');
    const clientScope = buildBalanceClientScopeSql_(ids);
    const statements = [
      'BEGIN TRANSACTION;',
      'DELETE FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
      "WHERE SnapshotDate = DATE '" + snapshotDate + "' AND ClientId IN (" + clientScope + ');',
      'DELETE FROM `' + BALANCE_AUDIT_TABLE + '`',
      "WHERE SnapshotDate = DATE '" + snapshotDate + "' AND ClientId IN (" + clientScope + ');'
    ];
    if (snapshot.lineRows.length) {
      const columns = BS_EXPORT_COLUMNS.map(column => '`' + column + '`').join(', ');
      statements.push('INSERT INTO `' + BALANCE_SNAPSHOT_TABLE + '` (' + columns + ')', 'SELECT ' + columns,
        'FROM `' + [BQ_CONFIG.projectId, BQ_CONFIG.snapshotsDatasetId, snapshotStage].join('.') + '`;');
    }
    if (snapshot.rawRows.length) {
      const columns = auditColumns.map(column => '`' + column + '`').join(', ');
      statements.push('INSERT INTO `' + BALANCE_AUDIT_TABLE + '` (' + columns + ')', 'SELECT ' + columns,
        'FROM `' + [BQ_CONFIG.projectId, BQ_CONFIG.auditDatasetId, auditStage].join('.') + '`;');
    }
    statements.push('COMMIT TRANSACTION;');
    const queryResult = runBalanceBigQueryQuery_(statements.join('\n'), BQ_CONFIG.snapshotsDatasetId);
    return { mode: 'successful_clients_replace', jobId: queryResult.jobReference.jobId,
      snapshotDate: snapshotDate, successfulClientCount: ids.length,
      lineRowCount: snapshot.lineRows.length, auditRowCount: snapshot.rawRows.length, state: 'DONE' };
  } finally {
    [[BQ_CONFIG.snapshotsDatasetId, snapshotStage], [BQ_CONFIG.auditDatasetId, auditStage]].forEach(pair => {
      try { BigQuery.Tables.remove(BQ_CONFIG.projectId, pair[0], pair[1]); }
      catch (error) { Logger.log('Balance Sheet staging cleanup failed: ' + String(error && error.message || error)); }
    });
  }
}

function loadBalanceRowsToPartition_(datasetId, tableId, rows, partitionId, jobPrefix) {
  const resolvedDatasetId = String(datasetId || '').trim();
  if (!resolvedDatasetId) {
    throw new Error('A Balance Sheet BigQuery dataset ID is required for ' + tableId + '.');
  }

  const destinationTableId = tableId + '$' + partitionId;
  const destinationTable = [
    BQ_CONFIG.projectId,
    resolvedDatasetId,
    destinationTableId
  ].join('.');

  if (!rows.length) {
    const snapshotDate = [
      partitionId.slice(0, 4),
      partitionId.slice(4, 6),
      partitionId.slice(6, 8)
    ].join('-');
    const cleared = runBalanceBigQueryQuery_(
      'DELETE FROM `' + [BQ_CONFIG.projectId, resolvedDatasetId, tableId].join('.') +
        '` WHERE SnapshotDate = DATE \'' + snapshotDate + '\'',
      resolvedDatasetId
    );
    return {
      state: 'DONE',
      mode: 'empty_partition_clear',
      jobId: cleared.jobReference.jobId,
      destinationTable,
      outputRows: 0
    };
  }

  const blob = Utilities.newBlob(
    rows.map(JSON.stringify).join('\n'),
    'application/octet-stream',
    jobPrefix + '_' + partitionId + '.ndjson'
  );
  const jobId = [
    jobPrefix,
    partitionId,
    Date.now(),
    Utilities.getUuid().replace(/-/g, '')
  ].join('_');
  const location = getBalanceBigQueryLocation_(resolvedDatasetId);
  const inserted = BigQuery.Jobs.insert({
    jobReference: {
      projectId: BQ_CONFIG.projectId,
      jobId,
      location
    },
    configuration: {
      load: {
        destinationTable: {
          projectId: BQ_CONFIG.projectId,
          datasetId: resolvedDatasetId,
          tableId: destinationTableId
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        createDisposition: 'CREATE_NEVER',
        writeDisposition: 'WRITE_TRUNCATE_DATA',
        autodetect: false,
        ignoreUnknownValues: false,
        maxBadRecords: 0
      }
    }
  }, BQ_CONFIG.projectId, blob);

  const completed = waitForBalanceBigQueryJob_(
    inserted.jobReference,
    120000,
    resolvedDatasetId
  );
  const outputRows = completed.statistics &&
    completed.statistics.load &&
    completed.statistics.load.outputRows !== undefined
      ? Number(completed.statistics.load.outputRows)
      : null;

  if (outputRows !== null && outputRows !== rows.length) {
    throw new Error(
      'Balance Sheet BigQuery output row mismatch for ' +
      [resolvedDatasetId, tableId].join('.') +
      '. Expected=' + rows.length +
      ', actual=' + outputRows
    );
  }

  return {
    state: completed.status.state,
    jobId: completed.jobReference.jobId,
    destinationTable,
    rowCount: rows.length,
    outputRows,
    payloadBytes: blob.getBytes().length
  };
}

function getBalanceBigQueryLocation_(datasetId) {
  const resolvedDatasetId = String(datasetId || '').trim();
  if (!resolvedDatasetId) {
    throw new Error('A Balance Sheet BigQuery dataset ID is required.');
  }

  const cache = CacheService.getScriptCache();
  const cacheKey =
    'BALANCE_BIGQUERY_DATASET_LOCATION_' +
    resolvedDatasetId.toUpperCase();
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const dataset = BigQuery.Datasets.get(
    BQ_CONFIG.projectId,
    resolvedDatasetId
  );
  const location = String(dataset && dataset.location || '').trim();
  if (!location) {
    throw new Error(
      'Unable to resolve BigQuery dataset location for ' +
      BQ_CONFIG.projectId +
      '.' +
      resolvedDatasetId
    );
  }

  cache.put(cacheKey, location, 21600);
  return location;
}

function waitForBalanceBigQueryJob_(jobReference, timeoutMs, datasetId) {
  if (!jobReference || !jobReference.jobId) {
    throw new Error('A valid Balance Sheet BigQuery job reference is required.');
  }

  const startedAt = Date.now();
  let job;
  while (true) {
    const location =
      jobReference.location ||
      getBalanceBigQueryLocation_(datasetId);
    job = BigQuery.Jobs.get(
      jobReference.projectId || BQ_CONFIG.projectId,
      jobReference.jobId,
      { location }
    );
    if (job.status && job.status.state === 'DONE') break;
    if (Date.now() - startedAt > Number(timeoutMs || 120000)) {
      throw new Error(
        'Balance Sheet BigQuery job timed out: ' + jobReference.jobId
      );
    }
    Utilities.sleep(1000);
  }

  if (job.status && job.status.errorResult) {
    throw new Error(
      'Balance Sheet BigQuery job failed: ' + JSON.stringify({
        jobId: jobReference.jobId,
        errorResult: job.status.errorResult,
        errors: job.status.errors || []
      })
    );
  }
  return job;
}

function verifyBalanceSheetSnapshotPartition_(snapshotDate, expectedRowCount, clientIds) {
  const keyExpression = "CONCAT(COALESCE(ClientId,''),'|',COALESCE(CAST(SnapshotDate AS STRING),''),'|',COALESCE(LineType,''),'|',COALESCE(AccountPath,''),'|',COALESCE(AccountId,''),'|',COALESCE(NormalizedCategory,''),'|',COALESCE(CAST(Amount AS STRING),''))";
  const scopedClientIds = Array.from(new Set((clientIds || []).map(id => String(id || '').trim()).filter(Boolean)));
  const result = runBalanceBigQueryQuery_([
    'SELECT COUNT(*) AS row_count,',
    "COUNTIF(ClientId IS NULL OR TRIM(ClientId) = '' OR SnapshotDate IS NULL OR LineType IS NULL OR TRIM(LineType) = '' OR AccountPath IS NULL OR TRIM(AccountPath) = '') AS missing_key_count,",
    'COUNT(DISTINCT ' + keyExpression + ') AS unique_key_count',
    'FROM `' + BALANCE_SNAPSHOT_TABLE + '`',
    "WHERE SnapshotDate = DATE '" + snapshotDate + "'",
    scopedClientIds.length ? '  AND ClientId IN (' + buildBalanceClientScopeSql_(scopedClientIds) + ')' : null
  ].filter(line => line !== null).join('\n'), BQ_CONFIG.snapshotsDatasetId);
  const values = result.rows && result.rows.length ? result.rows[0].f : [];
  const actualRowCount = Number(values[0] ? values[0].v : 0);
  const missingKeyCount = Number(values[1] ? values[1].v : 0);
  const uniqueKeyCount = Number(values[2] ? values[2].v : 0);
  if (actualRowCount !== Number(expectedRowCount)) throw new Error('Balance Sheet partition row count mismatch. Expected=' + expectedRowCount + ', actual=' + actualRowCount);
  if (missingKeyCount !== 0) throw new Error('Balance Sheet partition contains missing identity fields. Missing=' + missingKeyCount);
  if (uniqueKeyCount !== actualRowCount) throw new Error('Balance Sheet partition contains duplicate row identities. Rows=' + actualRowCount + ', uniqueKeys=' + uniqueKeyCount);
  return { status: 'passed', snapshotDate, partitionId: snapshotDate.replace(/-/g, ''), expectedRowCount: Number(expectedRowCount), actualRowCount, missingKeyCount, uniqueKeyCount };
}

function runBalanceBigQueryQuery_(query, datasetId) {
  const location = getBalanceBigQueryLocation_(datasetId);
  let result = BigQuery.Jobs.query({
    query,
    useLegacySql: false,
    timeoutMs: 120000,
    location
  }, BQ_CONFIG.projectId);

  if (!result || !result.jobReference) {
    throw new Error('BigQuery did not return a query job reference.');
  }

  const reference = result.jobReference;
  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(
      BQ_CONFIG.projectId,
      reference.jobId,
      { location: reference.location || location }
    );
  }

  if (result.errors && result.errors.length) {
    throw new Error('BigQuery query failed: ' + JSON.stringify(result.errors));
  }
  if (!result.jobReference) result.jobReference = reference;
  return result;
}
