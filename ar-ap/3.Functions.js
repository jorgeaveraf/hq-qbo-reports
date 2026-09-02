/***********************
 * Runtime Configuration
 ***********************/

function getAgingQboApiKey_() {
  const apiKey = String(PropertiesService.getScriptProperties().getProperty(QBO_CONFIG.apiKeyProperty) || '').trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + QBO_CONFIG.apiKeyProperty);
  return apiKey;
}

function getTargetSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty('TARGET_SPREADSHEET_ID');

  if (!spreadsheetId) {
    throw new Error(
      'Missing Script Property: TARGET_SPREADSHEET_ID'
    );
  }

  return SpreadsheetApp.openById(spreadsheetId);
}

/***********************
 * Central Entity Configuration
 ***********************/

function loadAgingEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(AGING_ENTITY_CONTROL.cacheKey);

  if (cachedValue) {
    try {
      return {
        source: 'script_cache',
        configuration: validateAgingEntityConfiguration_(JSON.parse(cachedValue))
      };
    } catch (error) {
      Logger.log(JSON.stringify({
        event: 'aging_entity_configuration_cache_invalid',
        error: error.message
      }));
      cache.remove(AGING_ENTITY_CONTROL.cacheKey);
    }
  }

  const localConfiguration = readLocalAgingEntityConfiguration_();
  if (!localConfiguration) {
    throw new Error(
      'No valid local Aging entity configuration is available. ' +
      'Publish the centralized configuration again or run ' +
      'debugRefreshAgingEntityConfigurationFromCentral().'
    );
  }

  cacheAgingEntityConfiguration_(localConfiguration);
  return { source: 'script_properties', configuration: localConfiguration };
}

function readLocalAgingEntityConfiguration_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(AGING_ENTITY_CONTROL.localPropertyKey);
  return parseStoredAgingEntityConfiguration_(serialized, undefined, 'script_properties');
}

function refreshAgingEntityConfigurationFromCentral_() {
  const spreadsheet = getAgingControlSpreadsheet_();
  const metadata = readAgingCentralMetadata_(spreadsheet);
  const configuration = readPublishedAgingConfiguration_(spreadsheet, metadata.currentVersion);
  const persistence = persistAgingEntityConfiguration_(configuration);
  cacheAgingEntityConfiguration_(configuration);

  Logger.log(JSON.stringify({
    event: 'aging_entity_configuration_refreshed_manually',
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return { source: 'central_sheet_manual', configuration, persistence };
}

function getAgingControlSpreadsheet_() {
  const spreadsheetId = String(
    PropertiesService.getScriptProperties().getProperty(AGING_ENTITY_CONTROL.spreadsheetIdProperty) || ''
  ).trim();

  if (!spreadsheetId) {
    throw new Error('Missing Script Property: ' + AGING_ENTITY_CONTROL.spreadsheetIdProperty);
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open the QBO control spreadsheet. Property=' +
      AGING_ENTITY_CONTROL.spreadsheetIdProperty + ', error=' + error.message
    );
  }
}

function readAgingCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(AGING_ENTITY_CONTROL.metadataSheetName);
  if (!sheet) throw new Error('Central metadata sheet not found: ' + AGING_ENTITY_CONTROL.metadataSheetName);

  assertAgingControlHeaders_(sheet, ['Key', 'Value', 'Updated At']);
  if (sheet.getLastRow() < 2) throw new Error('Central configuration metadata is empty.');

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  const metadata = {};
  values.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) metadata[key] = row[1];
  });

  const currentVersion = Number(metadata.current_version || 0);
  const status = String(metadata.status || '').trim().toLowerCase();
  const publishedAt = String(metadata.published_at || '').trim();

  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error('Invalid central configuration version: ' + metadata.current_version);
  }
  if (status !== 'published') throw new Error('Central configuration is not published. Status=' + status);
  if (!publishedAt) throw new Error('Central configuration metadata is missing published_at.');

  return { currentVersion, publishedAt, status };
}

function readPublishedAgingConfiguration_(spreadsheet, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(AGING_ENTITY_CONTROL.publishedSheetName);
  if (!sheet) throw new Error('Published configuration sheet not found: ' + AGING_ENTITY_CONTROL.publishedSheetName);

  assertAgingControlHeaders_(sheet, [
    'Report Key', 'Report Name', 'Configuration Version', 'Configuration Hash',
    'Published At', 'Entity Count', 'Configuration JSON'
  ]);

  if (sheet.getLastRow() < 2) throw new Error('Published configuration sheet is empty.');
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues();
  const reportRow = rows.find(row => String(row[0] || '').trim() === AGING_ENTITY_CONTROL.reportKey);

  if (!reportRow) {
    throw new Error('No published configuration was found for report_key=' + AGING_ENTITY_CONTROL.reportKey);
  }

  const rowVersion = Number(reportRow[2] || 0);
  const rowHash = String(reportRow[3] || '').trim();
  const entityCount = Number(reportRow[5] || 0);
  const configurationJson = String(reportRow[6] || '').trim();

  if (rowVersion !== Number(expectedVersion)) {
    throw new Error('Published Aging configuration version mismatch. Expected=' + expectedVersion + ', actual=' + rowVersion);
  }
  if (!configurationJson) throw new Error('Published Aging configuration JSON is empty.');

  let configuration;
  try {
    configuration = JSON.parse(configurationJson);
  } catch (error) {
    throw new Error('Published Aging configuration contains invalid JSON: ' + error.message);
  }

  const validated = validateAgingEntityConfiguration_(configuration, expectedVersion);
  if (validated.configuration_hash !== rowHash) {
    throw new Error('Published Aging configuration hash does not match its row hash.');
  }
  if (validated.entities.length !== entityCount) {
    throw new Error('Published Aging entity count mismatch. Expected=' + entityCount + ', actual=' + validated.entities.length);
  }

  return validated;
}

function validateAgingEntityConfiguration_(configuration, expectedVersion) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Aging entity configuration must be a JSON object.');
  }

  const contractType = String(configuration.contract_type || '').trim();
  const contractVersion = String(configuration.contract_version || '').trim();
  const schemaVersion = String(configuration.schema_version || '').trim();
  const reportKey = String(configuration.report_key || '').trim();
  const configurationVersion = Number(configuration.configuration_version || 0);
  const configurationHash = String(configuration.configuration_hash || '').trim();

  if (contractType !== AGING_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected entity configuration contract_type: ' + contractType);
  }
  if (contractVersion !== AGING_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected entity configuration contract_version: ' + contractVersion);
  }
  if (schemaVersion !== AGING_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected entity configuration schema_version: ' + schemaVersion);
  }
  if (reportKey !== AGING_ENTITY_CONTROL.reportKey) {
    throw new Error('Unexpected entity configuration report_key: ' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid entity configuration version: ' + configuration.configuration_version);
  }
  if (expectedVersion !== undefined && configurationVersion !== Number(expectedVersion)) {
    throw new Error('Entity configuration version is stale. Expected=' + expectedVersion + ', actual=' + configurationVersion);
  }
  if (!Array.isArray(configuration.entities) || !configuration.entities.length) {
    throw new Error('Aging entity configuration contains no authorized entities.');
  }

  const duplicateKeys = {};
  const normalizedEntities = configuration.entities.map((entity, index) => {
    const matchType = String(entity && entity.match_type || '').trim().toLowerCase();
    const rawMatchValue = String(entity && entity.match_value || '').trim();
    const matchValue = matchType === 'first_word' ? getFirstWordNormalized_(rawMatchValue) : rawMatchValue;
    const entityAlias = String(entity && entity.entity_alias || '').trim().toLowerCase();

    if (!['first_word', 'client_id'].includes(matchType)) {
      throw new Error('Unsupported match_type at entity index ' + index + ': ' + matchType);
    }
    if (!matchValue) throw new Error('Missing match_value at entity index ' + index + '.');
    if (!entityAlias) throw new Error('Missing entity_alias at entity index ' + index + '.');
    if (!/^[a-z0-9_]+$/.test(entityAlias)) {
      throw new Error('Invalid entity_alias at entity index ' + index + ': ' + entityAlias);
    }

    const duplicateKey = matchType + '|' + matchValue;
    if (duplicateKeys[duplicateKey]) throw new Error('Duplicate entity authorization: ' + duplicateKey);
    duplicateKeys[duplicateKey] = true;

    return { match_type: matchType, match_value: matchValue, entity_alias: entityAlias };
  });

  const calculatedHash = agingSha256Hex_(JSON.stringify({
    schema_version: schemaVersion,
    report_key: reportKey,
    entities: normalizedEntities
  }));

  if (!configurationHash) throw new Error('Entity configuration is missing configuration_hash.');
  if (calculatedHash !== configurationHash) {
    throw new Error(
      'Entity configuration hash validation failed. Expected=' +
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
    published_at: String(configuration.published_at || '').trim(),
    entities: normalizedEntities
  };
}

function parseStoredAgingEntityConfiguration_(serialized, expectedVersion, source) {
  if (!serialized) return null;
  try {
    return validateAgingEntityConfiguration_(JSON.parse(serialized), expectedVersion);
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'aging_entity_configuration_rejected',
      source: source,
      expectedVersion: expectedVersion,
      error: error.message
    }));
    return null;
  }
}

function persistAgingEntityConfiguration_(configuration) {
  const serialized = JSON.stringify(configuration);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > AGING_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Aging entity configuration exceeds the safe Script Property size. bytes=' +
      byteCount + ', maximum=' + AGING_ENTITY_CONTROL.maxPropertyBytes
    );
  }

  PropertiesService.getScriptProperties().setProperty(AGING_ENTITY_CONTROL.localPropertyKey, serialized);
  return { propertyKey: AGING_ENTITY_CONTROL.localPropertyKey, byteCount };
}

function cacheAgingEntityConfiguration_(configuration) {
  CacheService.getScriptCache().put(
    AGING_ENTITY_CONTROL.cacheKey,
    JSON.stringify(configuration),
    AGING_ENTITY_CONTROL.cacheTtlSeconds
  );
}

function buildAgingEntityAuthorizationMaps_(configuration) {
  const firstWordAliases = {};
  const clientIdAliases = {};

  configuration.entities.forEach(entity => {
    if (entity.match_type === 'first_word') firstWordAliases[entity.match_value] = entity.entity_alias;
    if (entity.match_type === 'client_id') clientIdAliases[entity.match_value] = entity.entity_alias;
  });

  return { firstWordAliases, clientIdAliases };
}

function assertAgingControlHeaders_(sheet, expectedHeaders) {
  const actualHeaders = sheet.getRange(1, 1, 1, expectedHeaders.length)
    .getDisplayValues()[0]
    .map(value => String(value || '').trim());

  const mismatches = expectedHeaders.map((expected, index) => ({
    position: index + 1,
    expected,
    actual: actualHeaders[index]
  })).filter(header => header.expected !== header.actual);

  if (mismatches.length) {
    throw new Error('Unexpected headers in central sheet "' + sheet.getName() + '": ' + JSON.stringify(mismatches));
  }
}

function fetchAgingSourceClients_() {
  const url = QBO_CONFIG.baseUrl + '/clients';
  return extractClientsArray_(fetchJsonOrThrow_(url, '/clients'));
}

function resolveAgingEntitySelection_(loadedEntityConfiguration) {
  const loaded = loadedEntityConfiguration && loadedEntityConfiguration.configuration
    ? loadedEntityConfiguration
    : loadAgingEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildAgingEntityAuthorizationMaps_(configuration);
  const sourceClients = fetchAgingSourceClients_();
  const clientsById = {};
  let clientIdMatchCount = 0;
  let firstWordMatchCount = 0;

  sourceClients.forEach(client => {
    const id = String(client.id || client.clientId || client.client_id || '').trim();
    const name = String(client.name || client.clientName || client.displayName || client.companyName || '').trim();
    if (!id || !name) return;

    let entityAlias = authorizationMaps.clientIdAliases[id] || '';
    let matchType = '';

    if (entityAlias) {
      clientIdMatchCount++;
      matchType = 'client_id';
    } else {
      entityAlias = authorizationMaps.firstWordAliases[getFirstWordNormalized_(name)] || '';
      if (entityAlias) {
        firstWordMatchCount++;
        matchType = 'first_word';
      }
    }

    if (!entityAlias) return;

    const sourceEntity = String(client.entity || client.slug || '').trim() || slugifyEntity_(name);

    clientsById[id] = {
      id: id,
      name: name,
      entity: sourceEntity,
      entityAlias: entityAlias,
      outputSheetName: entityAlias,
      authorizationMatchType: matchType
    };
  });

  Logger.log(JSON.stringify({
    event: 'aging_clients_filtered',
    configurationSource: loaded.source,
    reportKey: configuration.report_key,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    authorizationEntityCount: configuration.entities.length,
    sourceClientCount: sourceClients.length,
    filteredClientCount: Object.keys(clientsById).length,
    clientIdMatchCount: clientIdMatchCount,
    firstWordMatchCount: firstWordMatchCount
  }));

  return {
    source: loaded.source,
    configuration,
    sourceClients,
    clientsById,
    clientIdMatchCount,
    firstWordMatchCount
  };
}

function fetchClients_() {
  return resolveAgingEntitySelection_().clientsById;
}

function buildAgingEntityConfigurationSummary_(selection) {
  return {
    source: selection.source,
    reportKey: selection.configuration.report_key,
    configurationVersion: selection.configuration.configuration_version,
    configurationHash: selection.configuration.configuration_hash,
    publishedAt: selection.configuration.published_at,
    authorizedEntityCount: selection.configuration.entities.length
  };
}

/***********************
 * Entity Configuration Push Endpoint
 ***********************/

function doPost(e) {
  let response;
  try {
    response = handleAgingEntityConfigurationPush_(e);
  } catch (error) {
    response = {
      success: false,
      status: 'rejected',
      reportKey: AGING_ENTITY_CONTROL.reportKey,
      error: error.message
    };
    Logger.log(JSON.stringify({ event: 'aging_entity_configuration_push_rejected', error: error.message }));
  }
  return createAgingJsonResponse_(response);
}

function handleAgingEntityConfigurationPush_(e) {
  const rawBody = String(e && e.postData && e.postData.contents || '').trim();
  if (!rawBody) throw new Error('Push request body is empty.');

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Push request contains invalid envelope JSON: ' + error.message);
  }

  validateAgingPushEnvelope_(envelope);
  const calculatedSignature = agingHmacSha256Hex_(envelope.payload, getAgingEntityPushSecret_());
  if (!agingSecureHexEquals_(calculatedSignature, envelope.signature)) {
    throw new Error('Push request signature is invalid.');
  }

  let pushPayload;
  try {
    pushPayload = JSON.parse(envelope.payload);
  } catch (error) {
    throw new Error('Push envelope contains invalid payload JSON: ' + error.message);
  }

  validateAgingPushPayload_(pushPayload);
  const configuration = validateAgingEntityConfiguration_(
    pushPayload.configuration,
    Number(pushPayload.configuration_version)
  );

  if (configuration.configuration_hash !== String(pushPayload.configuration_hash || '').trim()) {
    throw new Error('Push payload configuration hash does not match the embedded configuration.');
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Unable to acquire the Aging configuration push lock.');

  try {
    return applyAgingPushedConfiguration_(pushPayload, configuration);
  } finally {
    lock.releaseLock();
  }
}

function validateAgingPushEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Push envelope must be a JSON object.');
  }

  if (String(envelope.contract_type || '').trim() !== AGING_ENTITY_CONTROL.pushEnvelopeContractType) {
    throw new Error('Unexpected push envelope contract_type.');
  }
  if (String(envelope.contract_version || '').trim() !== AGING_ENTITY_CONTROL.pushEnvelopeContractVersion) {
    throw new Error('Unexpected push envelope contract_version.');
  }
  if (typeof envelope.payload !== 'string' || !envelope.payload) {
    throw new Error('Push envelope payload must be a non-empty string.');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(envelope.signature || '').trim())) {
    throw new Error('Push envelope signature must be a SHA256 hex string.');
  }
}

function validateAgingPushPayload_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Push payload must be a JSON object.');
  }
  if (String(payload.contract_type || '').trim() !== AGING_ENTITY_CONTROL.pushContractType) {
    throw new Error('Unexpected push payload contract_type.');
  }
  if (String(payload.contract_version || '').trim() !== AGING_ENTITY_CONTROL.pushContractVersion) {
    throw new Error('Unexpected push payload contract_version.');
  }
  if (!String(payload.request_id || '').trim()) throw new Error('Push payload is missing request_id.');
  if (String(payload.report_key || '').trim() !== AGING_ENTITY_CONTROL.reportKey) {
    throw new Error('Unexpected push payload report_key: ' + payload.report_key);
  }

  const configurationVersion = Number(payload.configuration_version || 0);
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid push payload configuration_version.');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(payload.configuration_hash || '').trim())) {
    throw new Error('Push payload configuration_hash must be a SHA256 hex string.');
  }

  const sentAtMs = Date.parse(String(payload.sent_at || ''));
  if (!Number.isFinite(sentAtMs)) throw new Error('Push payload sent_at is invalid.');

  const ageSeconds = (Date.now() - sentAtMs) / 1000;
  if (ageSeconds > AGING_ENTITY_CONTROL.pushMaxAgeSeconds) {
    throw new Error('Push payload is older than the accepted maximum age.');
  }
  if (ageSeconds < -AGING_ENTITY_CONTROL.pushFutureToleranceSeconds) {
    throw new Error('Push payload sent_at is too far in the future.');
  }
  if (!payload.configuration || typeof payload.configuration !== 'object') {
    throw new Error('Push payload is missing configuration.');
  }
}

function applyAgingPushedConfiguration_(pushPayload, configuration) {
  const existing = readLocalAgingEntityConfiguration_();
  const incomingVersion = configuration.configuration_version;
  const incomingHash = configuration.configuration_hash;

  if (existing) {
    if (incomingVersion < existing.configuration_version) {
      throw new Error(
        'Incoming Aging configuration is stale. Current=' +
          existing.configuration_version +
          ', incoming=' +
          incomingVersion
      );
    }

    if (
      incomingVersion === existing.configuration_version &&
      incomingHash !== existing.configuration_hash
    ) {
      throw new Error(
        'Incoming Aging configuration conflicts with the current version hash.'
      );
    }
  }

  if (
    !existing ||
    incomingVersion > existing.configuration_version
  ) {
    persistAgingEntityConfiguration_(configuration);
  }
  cacheAgingEntityConfiguration_(configuration);

  const deployment = queueAgingConfigurationDeployment_(
    pushPayload,
    configuration,
    {
      source: 'configuration_push',
      range: buildAgingSnapshotRange_()
    }
  );
  const responseStatus = deployment.queued ? 'queued' : 'idempotent';
  const receipt = buildAgingPushReceipt_(pushPayload, responseStatus);
  receipt.operation_id = deployment.operationId;
  receipt.deployment_status = deployment.status;
  receipt.current_stage = deployment.currentStage;
  receipt.snapshot_date = deployment.range &&
    deployment.range.snapshotDate || null;
  receipt.snapshot_week = deployment.range &&
    deployment.range.snapshotWeek || null;
  persistAgingPushReceipt_(receipt);

  Logger.log(JSON.stringify({
    event: deployment.queued
      ? 'aging_entity_configuration_push_queued'
      : 'aging_entity_configuration_push_idempotent',
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage,
    snapshotDate: receipt.snapshot_date,
    entityCount: configuration.entities.length
  }));

  return {
    success: true,
    status: responseStatus,
    reportKey: AGING_ENTITY_CONTROL.reportKey,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage,
    snapshotDate: receipt.snapshot_date
  };
}


function buildAgingPushReceipt_(pushPayload, status) {
  return {
    request_id: String(pushPayload.request_id || '').trim(),
    report_key: AGING_ENTITY_CONTROL.reportKey,
    status: status,
    configuration_version: Number(pushPayload.configuration_version),
    configuration_hash: String(pushPayload.configuration_hash || '').trim(),
    sent_at: String(pushPayload.sent_at || '').trim(),
    received_at: new Date().toISOString()
  };
}

function persistAgingPushReceipt_(receipt) {
  PropertiesService.getScriptProperties().setProperty(
    AGING_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );
}

function getAgingEntityPushSecret_() {
  const secret = String(
    PropertiesService.getScriptProperties().getProperty(AGING_ENTITY_CONTROL.pushSecretProperty) || ''
  ).trim();
  if (!secret) throw new Error('Missing Script Property: ' + AGING_ENTITY_CONTROL.pushSecretProperty);
  return secret;
}

function createAgingJsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function agingSha256Hex_(value) {
  return agingBytesToHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ''),
    Utilities.Charset.UTF_8
  ));
}

function agingHmacSha256Hex_(value, secret) {
  return agingBytesToHex_(Utilities.computeHmacSha256Signature(
    String(value || ''),
    String(secret || ''),
    Utilities.Charset.UTF_8
  ));
}

function agingBytesToHex_(bytes) {
  return bytes.map(byte => {
    const normalized = (byte + 256) % 256;
    return normalized.toString(16).padStart(2, '0');
  }).join('');
}

function agingSecureHexEquals_(left, right) {
  const a = String(left || '').trim().toLowerCase();
  const b = String(right || '').trim().toLowerCase();
  if (a.length !== b.length || !a.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/***********************
 * Sheet Export
 ***********************/

function updateAgingExport() {
  const executionStartedAt = Date.now();
  Logger.log('--- AGING EXPORT START ---');
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(AGING_DIRECT_EXPORT_CONFIG.lockWaitMs)) {
    const deferred = {
      status: 'deferred_lock_busy',
      event: 'aging_sheet_export_deferred',
      durationMs: Date.now() - executionStartedAt
    };
    Logger.log(JSON.stringify(deferred));
    return deferred;
  }

  try {
    const deploymentState = readAgingDeploymentState_();
    if (isAgingDeploymentActive_(deploymentState)) {
      const delegated = {
        status: 'delegated_to_configuration_deployment',
        event: 'aging_sheet_export_delegated',
        operationId: deploymentState.operation_id,
        currentStage: deploymentState.current_stage,
        durationMs: Date.now() - executionStartedAt
      };
      Logger.log(JSON.stringify(delegated));
      return delegated;
    }

    const selectionStartedAt = Date.now();
    const selection = resolveAgingEntitySelection_();
    const clientIds = Object.keys(selection.clientsById);
    const selectionDurationMs = Date.now() - selectionStartedAt;
    const directExport = fetchAgingDirectExport_(selection);
    const failedSheetNames = directExport.sheets
      .filter(sheet => sheet.status !== 'fresh_qbo')
      .map(sheet => sheet.sheetName);
    const fallback = failedSheetNames.length
      ? loadAgingCompletedSnapshotFallback_(selection, deploymentState)
      : { available: false, reason: 'not_needed', rowsBySheet: {} };
    const spreadsheet = getTargetSpreadsheet_();
    const sheetResults = [];
    let writtenRowCount = 0;
    const writeStartedAt = Date.now();

    directExport.sheets.forEach(sheetExport => {
      let source = 'fresh_qbo';
      let rows = sheetExport.rows;
      let fallbackReason = null;

      if (sheetExport.status !== 'fresh_qbo') {
        const fallbackDecision = chooseAgingSheetFallback_(
          spreadsheet,
          sheetExport.sheetName,
          fallback
        );
        source = fallbackDecision.source;
        rows = fallbackDecision.rows;
        fallbackReason = fallbackDecision.reason;
      }

      if (source === 'preserved') {
        sheetResults.push({
          sheetName: sheetExport.sheetName,
          status: 'preserved',
          source,
          rowCount: null,
          failedReportCount: sheetExport.failures.length,
          reason: fallbackReason,
          failures: sheetExport.failures
        });
        return;
      }

      try {
        sortExportRows_(rows);
        writeOutputSheet_(rows, sheetExport.sheetName, spreadsheet);
        writtenRowCount += rows.length;
        sheetResults.push({
          sheetName: sheetExport.sheetName,
          status: source === 'fresh_qbo' ? 'updated' : 'fallback_applied',
          source,
          rowCount: rows.length,
          failedReportCount: sheetExport.failures.length,
          fallbackSnapshotDate: source === 'fallback_bigquery'
            ? fallback.snapshotDate
            : null,
          failures: sheetExport.failures
        });
      } catch (error) {
        sheetResults.push({
          sheetName: sheetExport.sheetName,
          status: 'write_failed',
          source,
          rowCount: null,
          failedReportCount: sheetExport.failures.length,
          error: String(error && error.message || error),
          failures: sheetExport.failures
        });
      }
    });

    const warningCount = sheetResults.filter(sheet => sheet.status !== 'updated').length;
    const failedWriteCount = sheetResults.filter(sheet => sheet.status === 'write_failed').length;
    const preservedSheetCount = sheetResults.filter(sheet => sheet.status === 'preserved').length;
    const fallbackSheetCount = sheetResults.filter(sheet => sheet.source === 'fallback_bigquery').length;
    const result = {
      status: warningCount ? 'completed_with_warnings' : 'passed',
      event: 'aging_sheet_export_completed',
      entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
      clientCount: clientIds.length,
      outputSheetCount: directExport.sheets.length,
      freshSheetCount: sheetResults.filter(sheet => sheet.source === 'fresh_qbo' && sheet.status === 'updated').length,
      fallbackSheetCount,
      preservedSheetCount,
      failedWriteCount,
      failedReportCount: directExport.failedReportCount,
      writtenRowCount,
      durations: {
        selectionMs: selectionDurationMs,
        gatewayMs: directExport.durationMs,
        writeMs: Date.now() - writeStartedAt,
        totalMs: Date.now() - executionStartedAt
      },
      gateway: {
        requestCount: directExport.requestCount,
        batchCount: directExport.batchCount,
        maxConcurrentRequests: AGING_DIRECT_EXPORT_CONFIG.maxConcurrentRequests
      },
      fallback: {
        available: fallback.available,
        reason: fallback.reason,
        snapshotDate: fallback.snapshotDate || null
      },
      sheets: sheetResults
    };

    Logger.log(JSON.stringify(result));
    Logger.log('--- AGING EXPORT END ---');
    return result;
  } finally {
    lock.releaseLock();
  }
}

function isAgingDeploymentActive_(state) {
  return Boolean(state && ['pending', 'processing'].includes(String(state.status || '')));
}

function fetchAgingDirectExport_(selection) {
  const startedAt = Date.now();
  const requests = buildAgingReportRequests_(selection);
  const results = [];
  const batchSize = Math.max(1, Number(AGING_DIRECT_EXPORT_CONFIG.maxConcurrentRequests || 1));
  let batchCount = 0;

  for (let index = 0; index < requests.length; index += batchSize) {
    const batch = requests.slice(index, index + batchSize);
    const batchStartedAt = Date.now();
    const batchResults = fetchAgingReportBatch_(batch);
    results.push.apply(results, batchResults);
    batchCount++;
    Logger.log(JSON.stringify({
      event: 'aging_gateway_batch_completed',
      batchNumber: batchCount,
      requestCount: batch.length,
      successCount: batchResults.filter(result => result.success).length,
      durationMs: Date.now() - batchStartedAt
    }));
  }

  const sheetsByName = {};
  getAgingOutputSheetNames_(selection).forEach(sheetName => {
    sheetsByName[sheetName] = {
      sheetName,
      rows: [],
      expectedReportCount: 0,
      successfulReportCount: 0,
      failures: []
    };
  });

  requests.forEach(request => {
    if (!sheetsByName[request.sheetName]) {
      sheetsByName[request.sheetName] = {
        sheetName: request.sheetName,
        rows: [],
        expectedReportCount: 0,
        successfulReportCount: 0,
        failures: []
      };
    }
    sheetsByName[request.sheetName].expectedReportCount++;
  });

  results.forEach(reportResult => {
    const sheet = sheetsByName[reportResult.sheetName];
    if (!reportResult.success) {
      sheet.failures.push(compactAgingReportFailure_(reportResult));
      return;
    }

    try {
      const asOfDate = extractAsOfDate_(reportResult.payload);
      const flatRows = flattenReport_(reportResult.payload);
      const exportRows = mapToExportRows_(
        flatRows,
        reportResult.client,
        reportResult.reportKind,
        asOfDate
      );
      sheet.rows.push.apply(sheet.rows, exportRows);
      sheet.successfulReportCount++;
    } catch (error) {
      sheet.failures.push(compactAgingReportFailure_({
        ...reportResult,
        success: false,
        error: 'Report mapping failed: ' + String(error && error.message || error)
      }));
    }
  });

  const sheets = Object.keys(sheetsByName).sort().map(sheetName => {
    const sheet = sheetsByName[sheetName];
    return {
      ...sheet,
      status: sheet.successfulReportCount === sheet.expectedReportCount &&
        !sheet.failures.length
        ? 'fresh_qbo'
        : 'incomplete_qbo'
    };
  });

  return {
    requestCount: requests.length,
    batchCount,
    failedReportCount: sheets.reduce((total, sheet) => total + sheet.failures.length, 0),
    durationMs: Date.now() - startedAt,
    sheets
  };
}

function buildAgingReportRequests_(selection) {
  const requests = [];
  Object.keys(selection.clientsById).sort().forEach(clientId => {
    const client = selection.clientsById[clientId];
    const sheetName = String(client.outputSheetName || QBO_CONFIG.outputSheetName).trim();
    ['customer', 'vendor'].forEach(reportKind => {
      requests.push({
        clientId,
        client,
        sheetName,
        reportKind,
        url: buildAgingReportUrl_(clientId, reportKind)
      });
    });
  });
  return requests;
}

function fetchAgingReportBatch_(requests) {
  const maxAttempts = Math.max(1, Number(AGING_DIRECT_EXPORT_CONFIG.maxFetchAttempts || 1));
  let pending = requests.slice();
  const completed = [];

  for (let attempt = 1; attempt <= maxAttempts && pending.length; attempt++) {
    let responses;
    try {
      const apiKey = getAgingQboApiKey_();
      responses = UrlFetchApp.fetchAll(pending.map(request => ({
        url: request.url,
        method: 'get',
        headers: { 'X-API-Key': apiKey },
        muteHttpExceptions: true
      })));
    } catch (error) {
      if (attempt < maxAttempts) {
        Utilities.sleep(AGING_DIRECT_EXPORT_CONFIG.retryDelayMs * attempt);
        continue;
      }
      return completed.concat(fetchAgingReportsIndividually_(pending, attempt, error));
    }

    const retry = [];
    pending.forEach((request, index) => {
      const result = parseAgingReportHttpResponse_(request, responses[index], attempt);
      if (!result.success && isRetryableAgingReportResult_(result) && attempt < maxAttempts) {
        retry.push(request);
      } else {
        completed.push(result);
      }
    });
    pending = retry;
    if (pending.length && attempt < maxAttempts) {
      Utilities.sleep(AGING_DIRECT_EXPORT_CONFIG.retryDelayMs * attempt);
    }
  }

  return completed;
}

function fetchAgingReportsIndividually_(requests, attempt, batchError) {
  return requests.map(request => {
    const response = fetchJsonResponse_(request.url);
    if (response.error) {
      return {
        ...request,
        success: false,
        status: response.status,
        attempts: attempt + 1,
        error: response.error + '; batchError=' + String(batchError)
      };
    }
    return parseAgingReportPayload_(request, response, attempt + 1);
  });
}

function parseAgingReportHttpResponse_(request, response, attempt) {
  if (!response) {
    return {
      ...request,
      success: false,
      status: 0,
      attempts: attempt,
      error: 'Gateway did not return a response.'
    };
  }

  const body = response.getContentText();
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(body);
  } catch (error) {
    parseError = String(error);
  }
  return parseAgingReportPayload_(request, {
    status: response.getResponseCode(),
    body,
    json,
    parseError
  }, attempt);
}

function parseAgingReportPayload_(request, response, attempt) {
  const status = Number(response.status || 0);
  const success = status >= 200 && status < 300 && !response.parseError;
  return {
    ...request,
    success,
    status,
    attempts: attempt,
    payload: success ? response.json : null,
    parseError: response.parseError || null,
    error: success
      ? null
      : response.error || response.parseError ||
        ('Gateway returned HTTP ' + status + ': ' + String(response.body || '').slice(0, 300))
  };
}

function isRetryableAgingReportResult_(result) {
  return Boolean(
    result && (
      result.status === 0 ||
      result.status === 429 ||
      result.status >= 500 ||
      result.parseError
    )
  );
}

function compactAgingReportFailure_(result) {
  return {
    clientId: result.clientId,
    reportKind: result.reportKind,
    status: result.status || 0,
    attempts: result.attempts || 0,
    error: String(result.error || 'Unknown Aging report failure.').slice(0, 500)
  };
}

function loadAgingCompletedSnapshotFallback_(selection, state) {
  try {
    if (!isAgingCompletedSnapshotFallbackValid_(selection, state)) {
      return {
        available: false,
        reason: 'no_matching_completed_snapshot',
        rowsBySheet: {}
      };
    }

    const snapshotDate = state.range.snapshotDate;
    const queryResult = queryAgingSnapshotExportRows_(snapshotDate);
    const expectedRowCount = Number(state.stages.bigquery.result.rowCount);
    if (!Number.isFinite(expectedRowCount) || queryResult.rows.length !== expectedRowCount) {
      throw new Error(
        'Completed snapshot row count mismatch. Expected=' + expectedRowCount +
        ', actual=' + queryResult.rows.length
      );
    }

    const rowsBySheet = {};
    getAgingOutputSheetNames_(selection).forEach(sheetName => rowsBySheet[sheetName] = []);
    queryResult.rows.forEach(item => {
      const client = selection.clientsById[item.clientId];
      if (!client) {
        throw new Error('Snapshot contains an unauthorized clientId=' + item.clientId);
      }
      rowsBySheet[client.outputSheetName].push(item.exportRow);
    });

    return {
      available: true,
      reason: 'completed_snapshot_available',
      snapshotDate,
      rowsBySheet
    };
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'aging_sheet_export_fallback_unavailable',
      error: String(error && error.message || error)
    }));
    return {
      available: false,
      reason: 'snapshot_validation_failed',
      error: String(error && error.message || error),
      rowsBySheet: {}
    };
  }
}

function isAgingCompletedSnapshotFallbackValid_(selection, state) {
  return Boolean(
    state &&
    state.status === 'completed' &&
    Number(state.pipeline_version || 0) === Number(AGING_OPERATIONAL_DEPLOYMENT.pipelineVersion) &&
    Number(state.configuration_version || 0) === Number(selection.configuration.configuration_version) &&
    String(state.configuration_hash || '') === String(selection.configuration.configuration_hash || '') &&
    state.range && /^\d{4}-\d{2}-\d{2}$/.test(String(state.range.snapshotDate || '')) &&
    state.stages &&
    state.stages.bigquery && state.stages.bigquery.status === 'completed' &&
    state.stages.bigquery.result &&
    state.stages.output_sheet_export && state.stages.output_sheet_export.status === 'completed'
  );
}

function chooseAgingSheetFallback_(spreadsheet, sheetName, fallback) {
  if (!fallback || !fallback.available || !Object.prototype.hasOwnProperty.call(fallback.rowsBySheet, sheetName)) {
    return { source: 'preserved', rows: null, reason: fallback && fallback.reason || 'fallback_unavailable' };
  }

  const currentAsOfDate = getAgingSheetLatestAsOfDate_(spreadsheet, sheetName);
  if (currentAsOfDate && currentAsOfDate >= fallback.snapshotDate) {
    return {
      source: 'preserved',
      rows: null,
      reason: 'existing_sheet_is_same_or_newer_than_snapshot'
    };
  }

  return {
    source: 'fallback_bigquery',
    rows: fallback.rowsBySheet[sheetName],
    reason: 'completed_snapshot_selected'
  };
}

function getAgingSheetLatestAsOfDate_(spreadsheet, sheetName) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return '';
  const values = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getDisplayValues();
  return values.reduce((latest, row) => {
    const value = String(row[0] || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && value > latest ? value : latest;
  }, '');
}

function getOrCreateAgingSheet_(spreadsheet, sheetName) {
  const finalName = String(sheetName || QBO_CONFIG.outputSheetName || '').trim();
  if (!finalName) throw new Error('Aging output sheet name is required.');
  const sheet = spreadsheet.getSheetByName(finalName) || spreadsheet.insertSheet(finalName);
  if (sheet.isSheetHidden()) sheet.showSheet();
  return sheet;
}

function writeOutputSheet_(rows, sheetName, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getTargetSpreadsheet_();
  const sheet = getOrCreateAgingSheet_(spreadsheet, sheetName);
  const requiredRowCount = rows.length + 1;
  if (sheet.getMaxRows() < requiredRowCount) {
    sheet.insertRowsAfter(
      sheet.getMaxRows(),
      requiredRowCount - sheet.getMaxRows()
    );
  }
  const clearRowCount = Math.max(requiredRowCount, sheet.getLastRow(), 1);
  sheet.getRange(1, 1, clearRowCount, EXPORT_COLUMNS.length).clearContent();
  sheet.getRange(1, 1, 1, EXPORT_COLUMNS.length).setValues([EXPORT_COLUMNS]);
  if (!rows.length) return;
  sheet.getRange(2, 1, rows.length, EXPORT_COLUMNS.length).setValues(rows);
  sheet.getRange(2, 11, rows.length, 1).setNumberFormat('0.00');
}

function getAgingOutputSheetNames_(selection) {
  return [...new Set(Object.keys(selection.clientsById)
    .map(clientId => String(selection.clientsById[clientId].outputSheetName || '').trim())
    .filter(Boolean))]
    .sort();
}

function resolveAgingDeploymentSelection_(state, source) {
  if (!state || typeof state !== 'object') {
    throw new Error('Aging deployment state is required for sheet processing.');
  }

  const configuration = validateAgingEntityConfiguration_(
    state.configuration,
    state.configuration_version
  );
  if (configuration.configuration_hash !== state.configuration_hash) {
    throw new Error(
      'Deployment configuration hash no longer matches the sheet operation.'
    );
  }

  return resolveAgingEntitySelection_({
    source: String(source || 'configuration_deployment'),
    configuration
  });
}

function executeAgingOutputSheetsProvisionStage_(state) {
  const selection = resolveAgingDeploymentSelection_(
    state,
    'configuration_deployment_output_sheets'
  );
  const spreadsheet = getTargetSpreadsheet_();
  const sheetNames = getAgingOutputSheetNames_(selection);
  const sheets = sheetNames.map(sheetName => {
    const existing = spreadsheet.getSheetByName(sheetName);
    const wasHidden = Boolean(existing && existing.isSheetHidden());
    const sheet = getOrCreateAgingSheet_(spreadsheet, sheetName);

    if (!existing) {
      sheet.getRange(1, 1, 1, EXPORT_COLUMNS.length).setValues([EXPORT_COLUMNS]);
    }

    return {
      sheetName,
      status: existing ? (wasHidden ? 'shown' : 'existing') : 'created'
    };
  });

  const result = {
    status: 'passed',
    event: 'aging_output_sheets_provisioned',
    entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
    sheetCount: sheets.length,
    createdSheetCount: sheets.filter(item => item.status === 'created').length,
    shownSheetCount: sheets.filter(item => item.status === 'shown').length,
    sheets
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function executeAgingOutputSheetExportStage_(state) {
  const bigQueryStage = state && state.stages && state.stages.bigquery;
  if (!bigQueryStage || bigQueryStage.status !== 'completed') {
    throw new Error('Aging output sheet export requires a completed BigQuery stage.');
  }

  const selection = resolveAgingDeploymentSelection_(
    state,
    'configuration_deployment_output_sheet_export'
  );
  const sheetNames = getAgingOutputSheetNames_(selection);
  const rowsBySheet = {};
  sheetNames.forEach(sheetName => rowsBySheet[sheetName] = []);

  const snapshotDate = state.range && state.range.snapshotDate;
  const queryResult = queryAgingSnapshotExportRows_(snapshotDate);
  const reportRowCounts = { AR: 0, AP: 0 };

  queryResult.rows.forEach(item => {
    const client = selection.clientsById[item.clientId];
    if (!client) {
      throw new Error(
        'Aging snapshot contains an unauthorized client during sheet export. ClientId=' +
        item.clientId
      );
    }

    const sheetName = String(client.outputSheetName || '').trim();
    if (!rowsBySheet[sheetName]) rowsBySheet[sheetName] = [];
    rowsBySheet[sheetName].push(item.exportRow);
    reportRowCounts[item.exportRow[0]] =
      Number(reportRowCounts[item.exportRow[0]] || 0) + 1;
  });

  const expectedRowCountValue = bigQueryStage.result &&
    bigQueryStage.result.rowCount;
  const expectedRowCount = expectedRowCountValue === null ||
    expectedRowCountValue === undefined
    ? null
    : Number(expectedRowCountValue);
  if (
    expectedRowCount !== null &&
    Number.isFinite(expectedRowCount) &&
    queryResult.rows.length !== expectedRowCount
  ) {
    throw new Error(
      'Aging sheet export row count does not match the completed BigQuery stage. Expected=' +
      expectedRowCount + ', actual=' + queryResult.rows.length
    );
  }

  const spreadsheet = getTargetSpreadsheet_();
  const sheets = Object.keys(rowsBySheet).sort().map(sheetName => {
    const rows = rowsBySheet[sheetName];
    sortExportRows_(rows);
    writeOutputSheet_(rows, sheetName, spreadsheet);
    return { sheetName, rowCount: rows.length };
  });

  const result = {
    status: 'passed',
    event: 'aging_output_sheet_export_completed',
    entityConfiguration: buildAgingEntityConfigurationSummary_(selection),
    snapshotDate,
    sheetCount: sheets.length,
    rowCount: queryResult.rows.length,
    reportRowCounts,
    sheets
  };
  Logger.log(JSON.stringify(result));
  return result;
}

function queryAgingSnapshotExportRows_(snapshotDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshotDate || ''))) {
    throw new Error('Invalid Aging snapshot date for sheet export: ' + snapshotDate);
  }

  const query = `
    SELECT
      report_type,
      entity,
      as_of_date,
      bucket,
      counterparty,
      document_number,
      document_type,
      transaction_date,
      due_date,
      days_overdue,
      open_amount,
      currency,
      source,
      client_id
    FROM \`${AGING_BIGQUERY_TABLE}\`
    WHERE snapshot_date = @snapshot_date
  `;
  const request = {
    query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [{
      name: 'snapshot_date',
      parameterType: { type: 'DATE' },
      parameterValue: { value: snapshotDate }
    }],
    maxResults: 10000,
    timeoutMs: 120000
  };

  let response = BigQuery.Jobs.query(request, BQ_CONFIG.projectId);
  if (!response || !response.jobReference) {
    throw new Error('BigQuery did not return a job reference for Aging sheet export.');
  }

  const jobId = response.jobReference.jobId;
  while (!response.jobComplete) {
    Utilities.sleep(500);
    response = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobId, {
      maxResults: 10000
    });
  }

  const rows = [];
  let page = response;
  while (page) {
    if (page.errors && page.errors.length) {
      throw new Error('Aging sheet export query failed: ' + JSON.stringify(page.errors));
    }

    (page.rows || []).forEach(row => {
      const values = row.f || [];
      const valueAt = index => values[index] ? values[index].v : null;
      const daysOverdue = valueAt(9);
      const openAmount = Number(valueAt(10) || 0);
      if (!Number.isFinite(openAmount)) {
        throw new Error('Invalid open amount returned for Aging sheet export.');
      }

      rows.push({
        clientId: String(valueAt(13) || '').trim(),
        exportRow: [
          String(valueAt(0) || ''),
          String(valueAt(1) || ''),
          String(valueAt(2) || ''),
          String(valueAt(3) || ''),
          String(valueAt(4) || ''),
          valueAt(5) === null ? '' : String(valueAt(5)),
          String(valueAt(6) || ''),
          valueAt(7) === null ? '' : String(valueAt(7)),
          valueAt(8) === null ? '' : String(valueAt(8)),
          daysOverdue === null ? '' : Number(daysOverdue),
          openAmount,
          String(valueAt(11) || ''),
          String(valueAt(12) || '')
        ]
      });
    });

    page = page.pageToken
      ? BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobId, {
          pageToken: page.pageToken,
          maxResults: 10000
        })
      : null;
  }

  return { jobId, snapshotDate, rows };
}

function fetchJsonResponse_(url) {
  const options = {
    method: 'get',
    headers: { 'X-API-Key': getAgingQboApiKey_() },
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
      body: body,
      json: json,
      parseError: parseError
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

/***********************
 * BigQuery Snapshot
 ***********************/

function snapshotAgingToBigQuery() {
  const loaded = loadAgingEntityConfiguration_();
  const range = buildAgingSnapshotRange_();
  const deployment = queueAgingConfigurationDeployment_(
    { request_id: Utilities.getUuid() },
    loaded.configuration,
    {
      source: 'scheduled_snapshot',
      range
    }
  );

  if (deployment.status === 'completed' && deployment.queued !== true) {
    Logger.log(JSON.stringify({
      event: 'aging_snapshot_deployment_idempotent',
      operationId: deployment.operationId,
      snapshotDate: range.snapshotDate,
      configurationVersion: deployment.configurationVersion,
      configurationHash: deployment.configurationHash
    }));
    return deployment;
  }

  return processAgingConfigurationDeployment();
}


function executeAgingBigQuerySnapshot_(loadedEntityConfiguration) {
  Logger.log('--- BQ AGING SNAPSHOT START ---');
  const schemaValidation = validateAgingBigQuerySchema_();
  const assembly = buildAgingSnapshot_(loadedEntityConfiguration);
  const loadResult = replaceAgingSnapshotPartition_(assembly.snapshotDate, assembly.rows);
  const expectedUniqueRowCount = countUniqueAgingRows_(assembly.rows);
  const verification = verifyAgingSnapshotPartition_(assembly.snapshotDate, assembly.rows.length, expectedUniqueRowCount);
  const result = {
    event: 'aging_snapshot_completed',
    entityConfiguration: assembly.entityConfiguration,
    schemaValidation,
    snapshotDate: assembly.snapshotDate,
    snapshotWeek: assembly.snapshotWeek,
    clientCount: assembly.clientCount,
    reportRowCounts: assembly.reportRowCounts,
    rowCount: assembly.rows.length,
    loadResult,
    verification
  };
  Logger.log(JSON.stringify(result, null, 2));
  Logger.log('--- BQ AGING SNAPSHOT END ---');
  return result;
}

function buildAgingSnapshot_(loadedEntityConfiguration) {
  const range = buildAgingSnapshotRange_();
  const loadedAt = new Date().toISOString();
  const snapshotClients = getAgingSnapshotClients_(loadedEntityConfiguration);
  const rows = [];
  const reportRowCounts = { AR: 0, AP: 0 };

  Logger.log('Clientes filtrados: ' + snapshotClients.clients.length);

  snapshotClients.clients.forEach(client => {
    const clientSnapshot = buildAgingClientSnapshot_(client, range, loadedAt);
    clientSnapshot.rows.forEach(row => rows.push(row));
    reportRowCounts.AR += clientSnapshot.reportRowCounts.AR;
    reportRowCounts.AP += clientSnapshot.reportRowCounts.AP;
  });

  return {
    entityConfiguration: buildAgingEntityConfigurationSummary_(snapshotClients.selection),
    snapshotDate: range.snapshotDate,
    snapshotWeek: range.snapshotWeek,
    clientCount: snapshotClients.clients.length,
    reportRowCounts,
    rows
  };
}


function buildAgingSnapshotRange_(snapshotDateOverride) {
  const snapshotDate = String(snapshotDateOverride || todayIsoDate_()).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
    throw new Error('Invalid Aging snapshot date: ' + snapshotDate);
  }
  const snapshotWeek = getWeekStartMonday_(snapshotDate);
  return {
    snapshotDate,
    snapshotWeek,
    periodKey: snapshotDate
  };
}

function normalizeAgingLoadedEntityConfiguration_(loadedEntityConfiguration) {
  if (loadedEntityConfiguration && loadedEntityConfiguration.configuration) {
    return {
      source: String(loadedEntityConfiguration.source || 'provided_configuration'),
      configuration: validateAgingEntityConfiguration_(loadedEntityConfiguration.configuration)
    };
  }
  if (loadedEntityConfiguration && loadedEntityConfiguration.report_key) {
    return {
      source: 'provided_configuration',
      configuration: validateAgingEntityConfiguration_(loadedEntityConfiguration)
    };
  }
  return loadAgingEntityConfiguration_();
}

function getAgingSnapshotClients_(loadedEntityConfiguration) {
  const loaded = normalizeAgingLoadedEntityConfiguration_(loadedEntityConfiguration);
  const selection = resolveAgingEntitySelection_(loaded);
  const clients = Object.keys(selection.clientsById)
    .map(clientId => selection.clientsById[clientId])
    .sort((left, right) => {
      const byName = String(left.name || '').localeCompare(String(right.name || ''));
      return byName || String(left.id || '').localeCompare(String(right.id || ''));
    })
    .map(client => ({
      id: String(client.id || '').trim(),
      name: String(client.name || '').trim(),
      entity: String(client.entity || '').trim(),
      entityAlias: String(client.entityAlias || '').trim(),
      outputSheetName: String(client.outputSheetName || '').trim(),
      authorizationMatchType: String(client.authorizationMatchType || '').trim()
    }));

  return { loaded, selection, clients };
}

function buildAgingClientSnapshot_(client, range, loadedAt) {
  if (!client || !String(client.id || '').trim()) {
    throw new Error('A valid Aging client is required.');
  }

  const clientId = String(client.id).trim();
  const rows = [];
  const reportRowCounts = { AR: 0, AP: 0 };
  const openAmountCents = { AR: 0, AP: 0 };

  ['customer', 'vendor'].forEach(reportKind => {
    const payload = fetchReport_(clientId, reportKind);
    if (!payload) return;

    const reportType = reportKind === 'customer' ? 'AR' : 'AP';
    const asOfDate = extractAsOfDate_(payload);
    const flatRows = flattenReport_(payload);

    if (!flatRows.length) {
      Logger.log('Sin filas para clientId=' + clientId + ', reportKind=' + reportKind);
      return;
    }

    const exportRows = mapToExportRows_(flatRows, client, reportKind, asOfDate);
    exportRows.forEach(exportRow => {
      const row = {
        snapshot_date: range.snapshotDate,
        snapshot_week: range.snapshotWeek,
        report_type: exportRow[0],
        entity: exportRow[1],
        as_of_date: exportRow[2],
        bucket: exportRow[3],
        counterparty: exportRow[4],
        document_number: exportRow[5] || null,
        document_type: exportRow[6],
        transaction_date: exportRow[7] || null,
        due_date: exportRow[8] || null,
        days_overdue: exportRow[9] === '' ? null : Number(exportRow[9]),
        open_amount: Number(exportRow[10] || 0),
        currency: exportRow[11],
        source: exportRow[12],
        client_id: clientId,
        client_name: client.name,
        loaded_at: loadedAt
      };
      rows.push(row);
      openAmountCents[reportType] += agingAmountToCents_(row.open_amount);
    });

    reportRowCounts[reportType] += exportRows.length;
    Logger.log(
      'BQ filas preparadas: ' + exportRows.length +
      ' para clientId=' + clientId +
      ', reportKind=' + reportKind
    );
  });

  return {
    client,
    rows,
    rowCount: rows.length,
    uniqueRowCount: countUniqueAgingRows_(rows),
    reportRowCounts,
    openAmountCents
  };
}

function agingAmountToCents_(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) {
    throw new Error('Invalid Aging amount: ' + value);
  }
  return Math.round((amount + Number.EPSILON) * 100);
}

function validateAgingBigQuerySchema_() {
  const table = BigQuery.Tables.get(BQ_CONFIG.projectId, BQ_CONFIG.datasetId, BQ_CONFIG.tableId);
  const actualFields = table && table.schema && Array.isArray(table.schema.fields) ? table.schema.fields : [];
  const actual = {};
  actualFields.forEach(field => actual[String(field.name || '')] = { type: String(field.type || ''), mode: String(field.mode || 'NULLABLE') });
  const missing = [], mismatches = [];
  AGING_BIGQUERY_SCHEMA.forEach(expected => {
    const found = actual[expected.name];
    if (!found) missing.push(expected.name);
    else {
      const typeMatches = found.type === expected.type;
      const modeMatches = found.mode === expected.mode || (expected.mode === 'REQUIRED' && found.mode === 'NULLABLE');
      if (!typeMatches || !modeMatches) mismatches.push({ name: expected.name, expected, actual: found });
    }
  });
  if (missing.length || mismatches.length) throw new Error('Aging BigQuery schema validation failed: ' + JSON.stringify({ missing, mismatches }));
  const partitionField = table && table.timePartitioning && table.timePartitioning.field;
  if (String(partitionField || '') !== 'snapshot_date') throw new Error('Aging BigQuery partition field must be snapshot_date. Actual=' + partitionField);
  return { status: 'passed', fieldCount: actualFields.length, partitionField: 'snapshot_date' };
}

function validateAgingBigQueryRow_(row, index, snapshotDate) {
  AGING_BIGQUERY_SCHEMA.filter(field => field.mode === 'REQUIRED').forEach(field => {
    const value = row[field.name];
    if (value === null || value === undefined || value === '') throw new Error('Aging row ' + index + ' is missing required field ' + field.name);
  });
  if (row.snapshot_date !== snapshotDate) throw new Error('Aging row ' + index + ' belongs to another snapshot_date.');
  ['snapshot_date', 'snapshot_week', 'as_of_date'].forEach(name => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row[name] || ''))) throw new Error('Aging row ' + index + ' has invalid date in ' + name + ': ' + row[name]);
  });
  ['transaction_date', 'due_date'].forEach(name => {
    if (row[name] !== null && row[name] !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(row[name]))) throw new Error('Aging row ' + index + ' has invalid date in ' + name + ': ' + row[name]);
  });
  if (!Number.isFinite(Number(row.open_amount))) throw new Error('Aging row ' + index + ' has invalid open_amount.');
  if (row.days_overdue !== null && !Number.isInteger(Number(row.days_overdue))) throw new Error('Aging row ' + index + ' has invalid days_overdue.');
}

function replaceAgingSnapshotPartition_(snapshotDate, rows) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(snapshotDate || ''))) throw new Error('Invalid Aging snapshot_date: ' + snapshotDate);
  if (!Array.isArray(rows)) throw new Error('Aging snapshot rows must be an array.');
  if (!rows.length) return clearEmptyAgingPartition_(snapshotDate);
  const preparedRows = rows.map((row, index) => {
    validateAgingBigQueryRow_(row, index, snapshotDate);
    return AGING_BIGQUERY_COLUMNS.reduce((json, column) => { json[column] = row[column] === undefined ? null : row[column]; return json; }, {});
  });
  const ndjson = preparedRows.map(JSON.stringify).join('\n');
  const partitionId = snapshotDate.replace(/-/g, '');
  const destinationTableId = BQ_CONFIG.tableId + '$' + partitionId;
  const jobId = ['aging_snapshot', partitionId, Date.now(), Utilities.getUuid().replace(/-/g, '')].join('_');
  const blob = Utilities.newBlob(ndjson, 'application/octet-stream', 'aging_snapshot_' + partitionId + '.ndjson');
  const insertedJob = BigQuery.Jobs.insert({
    jobReference: { projectId: BQ_CONFIG.projectId, jobId },
    configuration: { load: {
      destinationTable: { projectId: BQ_CONFIG.projectId, datasetId: BQ_CONFIG.datasetId, tableId: destinationTableId },
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      createDisposition: 'CREATE_NEVER',
      writeDisposition: 'WRITE_TRUNCATE_DATA',
      autodetect: false,
      ignoreUnknownValues: false,
      maxBadRecords: 0
    }}
  }, BQ_CONFIG.projectId, blob);
  if (!insertedJob || !insertedJob.jobReference) throw new Error('BigQuery did not return a job reference for the Aging load.');
  const completedJob = waitForAgingBigQueryJob_(insertedJob.jobReference, 180000);
  const outputRows = completedJob.statistics && completedJob.statistics.load && completedJob.statistics.load.outputRows !== undefined ? Number(completedJob.statistics.load.outputRows) : null;
  if (outputRows !== null && outputRows !== rows.length) throw new Error('Aging BigQuery load output row mismatch. Expected=' + rows.length + ', actual=' + outputRows);
  return { mode: 'partition_replace', jobId: completedJob.jobReference.jobId, destinationTable: AGING_BIGQUERY_TABLE + '$' + partitionId, snapshotDate, partitionId, rowCount: rows.length, outputRows, payloadBytes: blob.getBytes().length, state: completedJob.status.state };
}

function waitForAgingBigQueryJob_(jobReference, timeoutMs) {
  const startedAt = Date.now();
  let job;
  while (true) {
    job = BigQuery.Jobs.get(jobReference.projectId || BQ_CONFIG.projectId, jobReference.jobId);
    if (job.status && job.status.state === 'DONE') break;
    if (Date.now() - startedAt > Number(timeoutMs || 180000)) throw new Error('Aging BigQuery job timed out: ' + jobReference.jobId);
    Utilities.sleep(1000);
  }
  if (job.status && job.status.errorResult) throw new Error('Aging BigQuery job failed: ' + JSON.stringify({ jobId: jobReference.jobId, errorResult: job.status.errorResult, errors: job.status.errors || [] }));
  return job;
}

function countUniqueAgingRows_(rows) {
  const seen = {};
  (rows || []).forEach(row => {
    const key = JSON.stringify(AGING_BIGQUERY_COLUMNS.map(name => row[name] === undefined ? null : row[name]));
    seen[key] = true;
  });
  return Object.keys(seen).length;
}

function verifyAgingSnapshotPartition_(snapshotDate, expectedRowCount, expectedUniqueRowCount) {
  return verifyAgingSnapshotPartitionDetailed_(snapshotDate, {
    rowCount: Number(expectedRowCount || 0),
    uniqueRowCount: Number(
      expectedUniqueRowCount === undefined ? expectedRowCount : expectedUniqueRowCount
    )
  });
}


function escapeAgingBigQueryString_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function buildAgingPartitionClearQuery_(snapshotDate) {
  return (
    'DELETE FROM `' + AGING_BIGQUERY_TABLE + '` ' +
    "WHERE snapshot_date = DATE '" + escapeAgingBigQueryString_(snapshotDate) + "'"
  );
}

function buildAgingClientDeleteQuery_(snapshotDate, clientId) {
  return (
    'DELETE FROM `' + AGING_BIGQUERY_TABLE + '` ' +
    "WHERE snapshot_date = DATE '" + escapeAgingBigQueryString_(snapshotDate) + "' " +
    "AND client_id = '" + escapeAgingBigQueryString_(clientId) + "'"
  );
}

function buildAgingVerificationQuery_(snapshotDate) {
  return [
    'SELECT',
    '  COUNT(*) AS row_count,',
    "  COUNTIF(client_id IS NULL OR TRIM(client_id) = '' OR entity IS NULL OR TRIM(entity) = '' OR report_type IS NULL OR TRIM(report_type) = '') AS missing_key_count,",
    '  COUNT(DISTINCT FARM_FINGERPRINT(TO_JSON_STRING(t))) AS unique_row_count,',
    '  COUNT(DISTINCT client_id) AS client_count,',
    "  COUNTIF(report_type = 'AR') AS ar_row_count,",
    "  COUNTIF(report_type = 'AP') AS ap_row_count,",
    "  COUNTIF(report_type NOT IN ('AR', 'AP')) AS invalid_report_type_count,",
    "  COALESCE(SUM(IF(report_type = 'AR', open_amount, 0)), 0) AS ar_open_amount,",
    "  COALESCE(SUM(IF(report_type = 'AP', open_amount, 0)), 0) AS ap_open_amount",
    'FROM `' + AGING_BIGQUERY_TABLE + '` AS t',
    "WHERE snapshot_date = DATE '" + escapeAgingBigQueryString_(snapshotDate) + "'"
  ].join('\n');
}

function buildAgingBigQueryJobId_(operationId, snapshotDate, jobKind, clientId, generation) {
  const operationToken = String(operationId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  const dateToken = String(snapshotDate || '').replace(/-/g, '');
  const clientToken = clientId ? agingSha256Hex_(String(clientId)).slice(0, 16) : 'all';
  const kindToken = String(jobKind || 'job').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30);
  return [
    'aging',
    kindToken,
    dateToken,
    operationToken || 'operation',
    clientToken,
    'g' + Number(generation || 0)
  ].join('_');
}

function getAgingBigQueryJobIfExists_(jobId) {
  try {
    return BigQuery.Jobs.get(BQ_CONFIG.projectId, jobId);
  } catch (error) {
    const message = String(error && error.message || error);
    if (/not[ -]?found|notFound/i.test(message)) return null;
    throw error;
  }
}

function assertAgingBigQueryJobSucceeded_(job) {
  if (!job || !job.status || job.status.state !== 'DONE') {
    throw new Error('Aging BigQuery job is not complete.');
  }
  if (job.status.errorResult) {
    throw new Error('Aging BigQuery job failed: ' + JSON.stringify({
      jobId: job.jobReference && job.jobReference.jobId || null,
      errorResult: job.status.errorResult,
      errors: job.status.errors || []
    }));
  }
  return job;
}

function waitForAgingBigQueryJobOrYield_(jobReference, timeoutMs) {
  const startedAt = Date.now();
  const projectId = jobReference.projectId || BQ_CONFIG.projectId;
  let job;

  while (true) {
    job = BigQuery.Jobs.get(projectId, jobReference.jobId);
    if (job.status && job.status.state === 'DONE') {
      return { done: true, job: assertAgingBigQueryJobSucceeded_(job) };
    }
    if (Date.now() - startedAt >= Number(timeoutMs || AGING_OPERATIONAL_DEPLOYMENT.bigQueryJobWaitMs)) {
      return { done: false, job };
    }
    Utilities.sleep(1000);
  }
}

function ensureAgingBigQueryQueryJob_(jobId, query) {
  let job = getAgingBigQueryJobIfExists_(jobId);
  if (!job) {
    job = BigQuery.Jobs.insert({
      jobReference: {
        projectId: BQ_CONFIG.projectId,
        jobId
      },
      configuration: {
        query: {
          query,
          useLegacySql: false
        }
      }
    }, BQ_CONFIG.projectId);
  }

  if (!job || !job.jobReference) {
    throw new Error('BigQuery did not return a job reference for Aging query job ' + jobId + '.');
  }

  const waited = waitForAgingBigQueryJobOrYield_(
    job.jobReference,
    AGING_OPERATIONAL_DEPLOYMENT.bigQueryJobWaitMs
  );
  return {
    done: waited.done,
    job: waited.job,
    jobId
  };
}

function ensureAgingBigQueryLoadJob_(jobId, snapshotDate, rows) {
  let job = getAgingBigQueryJobIfExists_(jobId);
  let payloadBytes = null;

  if (!job) {
    if (!Array.isArray(rows)) {
      throw new Error('Aging rows are required to create load job ' + jobId + '.');
    }

    const preparedRows = rows.map((row, index) => {
      validateAgingBigQueryRow_(row, index, snapshotDate);
      return AGING_BIGQUERY_COLUMNS.reduce((json, column) => {
        json[column] = row[column] === undefined ? null : row[column];
        return json;
      }, {});
    });

    const ndjson = preparedRows.map(JSON.stringify).join('\n');
    const partitionId = snapshotDate.replace(/-/g, '');
    const blob = Utilities.newBlob(
      ndjson,
      'application/octet-stream',
      'aging_client_' + partitionId + '.ndjson'
    );
    payloadBytes = blob.getBytes().length;

    job = BigQuery.Jobs.insert({
      jobReference: {
        projectId: BQ_CONFIG.projectId,
        jobId
      },
      configuration: {
        load: {
          destinationTable: {
            projectId: BQ_CONFIG.projectId,
            datasetId: BQ_CONFIG.datasetId,
            tableId: BQ_CONFIG.tableId + '$' + partitionId
          },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          createDisposition: 'CREATE_NEVER',
          writeDisposition: 'WRITE_APPEND',
          autodetect: false,
          ignoreUnknownValues: false,
          maxBadRecords: 0
        }
      }
    }, BQ_CONFIG.projectId, blob);
  }

  if (!job || !job.jobReference) {
    throw new Error('BigQuery did not return a job reference for Aging load job ' + jobId + '.');
  }

  const waited = waitForAgingBigQueryJobOrYield_(
    job.jobReference,
    AGING_OPERATIONAL_DEPLOYMENT.bigQueryJobWaitMs
  );
  const outputRows = waited.done && waited.job.statistics && waited.job.statistics.load &&
    waited.job.statistics.load.outputRows !== undefined
    ? Number(waited.job.statistics.load.outputRows)
    : null;

  return {
    done: waited.done,
    job: waited.job,
    jobId,
    outputRows,
    payloadBytes
  };
}

function getAgingBigQueryQueryResult_(jobId) {
  let result = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobId, { maxResults: 10 });
  if (!result.jobComplete) {
    return { done: false, result };
  }
  if (result.errors && result.errors.length) {
    throw new Error('Aging BigQuery query failed: ' + JSON.stringify(result.errors));
  }
  return { done: true, result };
}

function parseAgingVerificationResult_(snapshotDate, queryResult, expected) {
  const values = queryResult.rows && queryResult.rows.length ? queryResult.rows[0].f : [];
  const actual = {
    rowCount: Number(values[0] ? values[0].v : 0),
    missingKeyCount: Number(values[1] ? values[1].v : 0),
    uniqueRowCount: Number(values[2] ? values[2].v : 0),
    clientCount: Number(values[3] ? values[3].v : 0),
    arRowCount: Number(values[4] ? values[4].v : 0),
    apRowCount: Number(values[5] ? values[5].v : 0),
    invalidReportTypeCount: Number(values[6] ? values[6].v : 0),
    arOpenAmountCents: agingAmountToCents_(values[7] ? values[7].v : 0),
    apOpenAmountCents: agingAmountToCents_(values[8] ? values[8].v : 0)
  };

  const normalizedExpected = {
    rowCount: Number(expected.rowCount || 0),
    uniqueRowCount: Number(expected.uniqueRowCount === undefined ? expected.rowCount : expected.uniqueRowCount),
    clientCount: expected.clientCount === undefined ? null : Number(expected.clientCount),
    arRowCount: expected.reportRowCounts ? Number(expected.reportRowCounts.AR || 0) : null,
    apRowCount: expected.reportRowCounts ? Number(expected.reportRowCounts.AP || 0) : null,
    arOpenAmountCents: expected.openAmountCents ? Number(expected.openAmountCents.AR || 0) : null,
    apOpenAmountCents: expected.openAmountCents ? Number(expected.openAmountCents.AP || 0) : null
  };

  if (actual.rowCount !== normalizedExpected.rowCount) {
    throw new Error('Aging partition row count mismatch. Expected=' + normalizedExpected.rowCount + ', actual=' + actual.rowCount);
  }
  if (actual.missingKeyCount !== 0) {
    throw new Error('Aging partition contains rows with missing operational keys. Missing=' + actual.missingKeyCount);
  }
  if (actual.uniqueRowCount !== normalizedExpected.uniqueRowCount) {
    throw new Error('Aging partition unique-row mismatch. ExpectedUnique=' + normalizedExpected.uniqueRowCount + ', actualUnique=' + actual.uniqueRowCount);
  }
  if (actual.invalidReportTypeCount !== 0) {
    throw new Error('Aging partition contains invalid report_type values. Count=' + actual.invalidReportTypeCount);
  }
  if (normalizedExpected.clientCount !== null && actual.clientCount !== normalizedExpected.clientCount) {
    throw new Error('Aging partition client count mismatch. Expected=' + normalizedExpected.clientCount + ', actual=' + actual.clientCount);
  }
  if (normalizedExpected.arRowCount !== null && actual.arRowCount !== normalizedExpected.arRowCount) {
    throw new Error('Aging AR row count mismatch. Expected=' + normalizedExpected.arRowCount + ', actual=' + actual.arRowCount);
  }
  if (normalizedExpected.apRowCount !== null && actual.apRowCount !== normalizedExpected.apRowCount) {
    throw new Error('Aging AP row count mismatch. Expected=' + normalizedExpected.apRowCount + ', actual=' + actual.apRowCount);
  }
  if (normalizedExpected.arOpenAmountCents !== null && actual.arOpenAmountCents !== normalizedExpected.arOpenAmountCents) {
    throw new Error('Aging AR open amount mismatch. ExpectedCents=' + normalizedExpected.arOpenAmountCents + ', actualCents=' + actual.arOpenAmountCents);
  }
  if (normalizedExpected.apOpenAmountCents !== null && actual.apOpenAmountCents !== normalizedExpected.apOpenAmountCents) {
    throw new Error('Aging AP open amount mismatch. ExpectedCents=' + normalizedExpected.apOpenAmountCents + ', actualCents=' + actual.apOpenAmountCents);
  }

  return {
    status: 'passed',
    snapshotDate,
    partitionId: snapshotDate.replace(/-/g, ''),
    expected: normalizedExpected,
    actual,
    sourceDuplicateRowCount: normalizedExpected.rowCount - normalizedExpected.uniqueRowCount
  };
}

function verifyAgingSnapshotPartitionDetailed_(snapshotDate, expected) {
  const queryResult = runAgingBigQueryQuery_(buildAgingVerificationQuery_(snapshotDate));
  return parseAgingVerificationResult_(snapshotDate, queryResult, expected);
}

function runAgingBigQueryQuery_(query) {
  let result = BigQuery.Jobs.query({ query, useLegacySql: false, timeoutMs: 120000 }, BQ_CONFIG.projectId);
  if (!result || !result.jobReference) throw new Error('BigQuery did not return a query job reference.');
  const jobReference = result.jobReference;
  while (!result.jobComplete) { Utilities.sleep(500); result = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobReference.jobId); }
  if (result.errors && result.errors.length) throw new Error('BigQuery query failed: ' + JSON.stringify(result.errors));
  if (!result.jobReference) result.jobReference = jobReference;
  return result;
}

function clearEmptyAgingPartition_(snapshotDate) {
  const result = runAgingBigQueryQuery_("DELETE FROM `" + AGING_BIGQUERY_TABLE + "` WHERE snapshot_date = DATE '" + snapshotDate + "'");
  return { mode: 'empty_partition_clear', jobId: result.jobReference.jobId, destinationTable: AGING_BIGQUERY_TABLE, snapshotDate, rowCount: 0, outputRows: 0, state: 'DONE' };
}

/***********************
 * Report Extraction and Mapping
 ***********************/

function fetchReport_(clientId, reportKind) {
  const url = buildAgingReportUrl_(clientId, reportKind);
  if (!url) return null;
  const response = fetchJsonResponse_(url);

  if (response.error) {
    Logger.log(
      'Error llamando reporte clientId=' +
        clientId +
        ', reportKind=' +
        reportKind +
        ': ' +
        response.error
    );
    return null;
  }

  if (response.status < 200 || response.status >= 300) {
    Logger.log(
      'HTTP ' +
        response.status +
        ' en clientId=' +
        clientId +
        ', reportKind=' +
        reportKind +
        ', body=' +
        response.body.slice(0, 500)
    );
    return null;
  }

  if (response.parseError) {
    Logger.log(
      'JSON inválido en clientId=' +
        clientId +
        ', reportKind=' +
        reportKind +
        ', error=' +
        response.parseError
    );
    return null;
  }

  return response.json;
}

function buildAgingReportUrl_(clientId, reportKind) {
  const suffix =
    reportKind === 'customer'
      ? 'customer-balance-detailed'
      : reportKind === 'vendor'
        ? 'vendor-balance-detailed'
        : '';

  if (!suffix) {
    Logger.log('reportKind inválido: ' + reportKind + ' (clientId=' + clientId + ')');
    return '';
  }

  return (
    QBO_CONFIG.baseUrl +
    '/qbo/' +
    encodeURIComponent(clientId) +
    '/reports/' +
    suffix +
    '?environment=' +
    encodeURIComponent(QBO_CONFIG.environment)
  );
}
function flattenReport_(payload) {
  const topRows = payload && payload.data && payload.data.Rows ? payload.data.Rows.Row : null;
  if (!Array.isArray(topRows)) return [];

  const columnMap = buildReportColumnMap_(payload);
  const out = [];

  flattenRowsRecursive_(topRows, '', out, columnMap);

  return out;
}
function flattenRowsRecursive_(rows, inheritedCounterparty, out, columnMap) {
  rows.forEach(row => {
    const sectionCounterparty =
      (row.Header && row.Header.ColData && row.Header.ColData[0] && row.Header.ColData[0].value) ||
      inheritedCounterparty ||
      '';

    const nestedRows = row.Rows && row.Rows.Row;

    if (Array.isArray(nestedRows) && nestedRows.length) {
      flattenRowsRecursive_(nestedRows, sectionCounterparty, out, columnMap);
    }

    const colData = row.ColData;
    if (!Array.isArray(colData) || !colData.length) return;
    if (isNonDataRow_(row, colData)) return;

    const transactionDate = getColDataValueByRole_(colData, columnMap, 'transactionDate');
    const documentType = getColDataValueByRole_(colData, columnMap, 'documentType');
    const documentNumber = getColDataValueByRole_(colData, columnMap, 'documentNumber');
    const dueDate = getColDataValueByRole_(colData, columnMap, 'dueDate');

    const openAmountRaw = firstNonEmpty_(
      getColDataValueByRole_(colData, columnMap, 'openAmount'),
      getColDataValueByRole_(colData, columnMap, 'balance'),
      getColDataValueByRole_(colData, columnMap, 'amount'),
      0
    );

    out.push({
      counterpartyName: sectionCounterparty,
      transactionDate: transactionDate,
      documentType: documentType,
      documentNumber: documentNumber,
      dueDate: dueDate,
      openAmount: parseAmount_(openAmountRaw)
    });
  });
}
function mapToExportRows_(flatRows, client, reportKind, asOfDate) {
  const reportType = reportKind === 'customer' ? 'AR' : 'AP';
  const entity = client.entity || slugifyEntity_(client.name);
  const allowedDocTypesSet = getAllowedDocTypesSet_();

  return flatRows.reduce((acc, row) => {
    if (!shouldIncludeDocumentType_(row.documentType, allowedDocTypesSet)) return acc;

    const txDate = normalizeDateForOutput_(row.transactionDate);
    const dueDate = normalizeDateForOutput_(row.dueDate);
    const daysOverdue = calculateDaysOverdue_(asOfDate, dueDate);
    const normalizedDocumentType = normalizeDocumentType_(row.documentType);

    acc.push([
      reportType,
      entity,
      asOfDate,
      bucketFromDaysOverdue_(daysOverdue),
      row.counterpartyName || '',
      row.documentNumber || '',
      normalizedDocumentType,
      txDate,
      dueDate,
      daysOverdue,
      roundTo2_(row.openAmount),
      QBO_CONFIG.currencyDefault,
      QBO_CONFIG.sourceDefault
    ]);

    return acc;
  }, []);
}
function buildReportColumnMap_(payload) {
  const columns =
    payload &&
    payload.data &&
    payload.data.Columns &&
    payload.data.Columns.Column
      ? payload.data.Columns.Column
      : [];

  const map = {
    transactionDate: null,
    documentType: null,
    documentNumber: null,
    dueDate: null,
    amount: null,
    openAmount: null,
    balance: null
  };

  if (!Array.isArray(columns)) return map;

  columns.forEach((column, idx) => {
    const title = normalizeColumnToken_(column.ColTitle || column.colTitle || '');
    const type = normalizeColumnToken_(column.ColType || column.colType || '');
    const colKey = normalizeColumnToken_(extractColumnMetaValue_(column, 'ColKey'));

    if (colKey === 'txdate' || title === 'date') {
      map.transactionDate = idx;
      return;
    }

    if (colKey === 'txntype' || title === 'transactiontype') {
      map.documentType = idx;
      return;
    }

    if (colKey === 'docnum' || title === 'num' || title === 'documentnumber') {
      map.documentNumber = idx;
      return;
    }

    if (colKey === 'duedate' || title === 'duedate') {
      map.dueDate = idx;
      return;
    }

    if (
      colKey === 'subtopenbal' ||
      colKey === 'subtnegopenbal' ||
      title === 'openbalance'
    ) {
      map.openAmount = idx;
      return;
    }

    if (
      colKey === 'rbalopenbal' ||
      colKey === 'rbalnegopenbal' ||
      title === 'balance'
    ) {
      map.balance = idx;
      return;
    }

    if (
      colKey === 'subtamount' ||
      colKey === 'subtnegamount' ||
      title === 'amount'
    ) {
      map.amount = idx;
      return;
    }

    if (!map.transactionDate && type === 'date') {
      map.transactionDate = idx;
    }
  });

  return applyFallbackColumnMap_(map);
}
function applyFallbackColumnMap_(map) {
  if (map.transactionDate === null) map.transactionDate = 0;
  if (map.documentType === null) map.documentType = 1;
  if (map.documentNumber === null) map.documentNumber = 2;

  // Fallback viejo, pero solo si no se detectó por headers.
  if (map.dueDate === null) map.dueDate = 3;

  if (map.openAmount === null) map.openAmount = 5;
  if (map.balance === null) map.balance = 6;
  if (map.amount === null) map.amount = 4;

  return map;
}
function getColDataValueByRole_(colData, columnMap, role) {
  const idx = columnMap && typeof columnMap[role] === 'number' ? columnMap[role] : null;
  if (idx === null || idx < 0 || idx >= colData.length) return '';
  return String((colData[idx] && colData[idx].value) || '').trim();
}
function extractColumnMetaValue_(column, name) {
  const metadata = column.MetaData || column.metaData || [];
  if (!Array.isArray(metadata)) return '';

  const target = String(name || '').toLowerCase();

  for (let i = 0; i < metadata.length; i++) {
    const metaName = String(metadata[i].Name || metadata[i].name || '').toLowerCase();
    if (metaName === target) {
      return metadata[i].Value || metadata[i].value || '';
    }
  }

  return '';
}
function normalizeColumnToken_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function bucketFromDaysOverdue_(daysOverdue) {
  if (daysOverdue === '' || daysOverdue === null || typeof daysOverdue === 'undefined') {
    return 'Current';
  }

  if (daysOverdue <= 0) return 'Current';
  if (daysOverdue <= 30) return '1–30';
  if (daysOverdue <= 60) return '31–60';
  if (daysOverdue <= 90) return '61–90';

  return '91+';
}
function slugifyEntity_(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
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
function normalizeDateForOutput_(value) {
  const date = safeParseDate_(value);
  if (!date) return '';
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}
function calculateDaysOverdue_(asOfDate, dueDate) {
  if (!dueDate) return '';

  const asOf = safeParseDate_(asOfDate);
  const due = safeParseDate_(dueDate);

  if (!asOf || !due) return '';

  const diffMs = asOf.getTime() - due.getTime();
  return Math.floor(diffMs / 86400000);
}
function sortExportRows_(rows) {
  const bucketRank = {};

  BUCKET_ORDER.forEach((label, idx) => {
    bucketRank[label] = idx;
  });

  rows.sort((a, b) => {
    const leftBucketRank =
      Object.prototype.hasOwnProperty.call(bucketRank, a[3]) ? bucketRank[a[3]] : 999;

    const rightBucketRank =
      Object.prototype.hasOwnProperty.call(bucketRank, b[3]) ? bucketRank[b[3]] : 999;

    const bucketDiff = leftBucketRank - rightBucketRank;
    if (bucketDiff !== 0) return bucketDiff;

    const entityDiff = String(a[1]).localeCompare(String(b[1]));
    if (entityDiff !== 0) return entityDiff;

    return (Number(b[10]) || 0) - (Number(a[10]) || 0);
  });
}
function extractAsOfDate_(payload) {
  const header = payload && payload.data ? payload.data.Header || payload.Header : payload && payload.Header;
  const candidates = [];

  if (header) {
    candidates.push(
      header.ReportDate,
      header.reportDate,
      header.AsOfDate,
      header.asOfDate,
      header.EndPeriod,
      header.endPeriod,
      header.Time
    );

    const options = header.Option || header.Options || [];

    if (Array.isArray(options)) {
      options.forEach(option => {
        const optionName = String(option.Name || option.name || '').toLowerCase();
        const optionValue = option.Value || option.value;

        if (
          optionName.indexOf('report_date') >= 0 ||
          optionName.indexOf('as_of') >= 0 ||
          optionName.indexOf('end_period') >= 0
        ) {
          candidates.push(optionValue);
        }
      });
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const normalized = normalizeDateForOutput_(candidates[i]);
    if (normalized) return normalized;
  }

  return todayIsoDate_();
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
        ' (HTTP ' +
        response.status +
        '): ' +
        response.body.slice(0, 500)
    );
  }

  if (response.parseError) {
    throw new Error('JSON inválido en ' + contextLabel + ': ' + response.parseError);
  }

  return response.json;
}
function deleteSnapshotDate_(snapshotDate) {
  const query = `
    DELETE FROM \`${BQ_CONFIG.projectId}.${BQ_CONFIG.datasetId}.${BQ_CONFIG.tableId}\`
    WHERE snapshot_date = @snapshot_date
  `;

  const request = {
    query: query,
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: [
      {
        name: 'snapshot_date',
        parameterType: { type: 'DATE' },
        parameterValue: { value: snapshotDate }
      }
    ]
  };

  const response = BigQuery.Jobs.query(request, BQ_CONFIG.projectId);

  if (response.errors && response.errors.length) {
    throw new Error('Error deleting snapshot: ' + JSON.stringify(response.errors));
  }

  Logger.log('Snapshot borrado para snapshot_date=' + snapshotDate);
}
function insertRowsToBigQuery_(rows) {
  if (!rows.length) {
    Logger.log('No hay filas para insertar en BigQuery.');
    return;
  }

  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);

    const request = {
      rows: batch.map((row, idx) => ({
        insertId: [
          row.snapshot_date,
          row.entity,
          row.report_type,
          row.client_id,
          row.counterparty,
          row.document_number,
          row.document_type,
          row.transaction_date,
          row.due_date,
          i + idx
        ].join('|'),
        json: row
      }))
    };

    const response = BigQuery.Tabledata.insertAll(
      request,
      BQ_CONFIG.projectId,
      BQ_CONFIG.datasetId,
      BQ_CONFIG.tableId
    );

    if (response.insertErrors && response.insertErrors.length) {
      throw new Error('BigQuery insert errors: ' + JSON.stringify(response.insertErrors));
    }

    Logger.log('BQ batch inserted: ' + batch.length);
  }
}
function getWeekStartMonday_(isoDate) {
  const date = safeParseDate_(isoDate);
  if (!date) return isoDate;

  const day = date.getUTCDay(); // 0 domingo, 1 lunes
  const diff = day === 0 ? -6 : 1 - day;

  date.setUTCDate(date.getUTCDate() + diff);

  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
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
function normalizeDocumentType_(value) {
  const type = String(value || '').trim();
  if (!type) return '';
  return type.toLowerCase() === 'other / adjustments' ? 'Other' : type;
}
function normalizeDocumentTypeForMatch_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
function getAllowedDocTypesSet_() {
  const normalized = (QBO_CONFIG.allowedDocTypes || [])
    .map(type => normalizeDocumentTypeForMatch_(type))
    .filter(Boolean);

  return new Set(normalized);
}
function shouldIncludeDocumentType_(documentType, allowedDocTypesSet) {
  if (!allowedDocTypesSet || !allowedDocTypesSet.size) return true;

  const normalizedTypeForMatch = normalizeDocumentTypeForMatch_(
    normalizeDocumentType_(documentType)
  );

  return allowedDocTypesSet.has(normalizedTypeForMatch);
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
function firstNonEmpty_() {
  for (let i = 0; i < arguments.length; i++) {
    const candidate = arguments[i];

    if (candidate !== null && typeof candidate !== 'undefined' && String(candidate) !== '') {
      return candidate;
    }
  }

  return '';
}
function isNonDataRow_(row, colData) {
  const rowType = String(row.type || row.RowType || '').toLowerCase();

  if (rowType.indexOf('summary') >= 0) return true;
  if (row.Summary) return true;

  const firstCell = String((colData[0] && colData[0].value) || '').trim().toLowerCase();

  if (!firstCell && colData.length <= 1) return true;
  if (firstCell === 'date') return true;
  if (firstCell.indexOf('total') === 0) return true;

  return false;
}
function todayIsoDate_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTimeZone_(), 'yyyy-MM-dd');
}
function getSpreadsheetTimeZone_() {
  try {
    const tz = getTargetSpreadsheet_().getSpreadsheetTimeZone();

    return tz || Session.getScriptTimeZone() || 'Etc/UTC';
  } catch (e) {
    return Session.getScriptTimeZone() || 'Etc/UTC';
  }
}
