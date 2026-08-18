/***********************
 * Production Entry Point
 ***********************/

function snapshotJournalEntriesToBigQuery() {
  const loaded = loadJournalEntityConfiguration_();
  const deployment = queueJournalConfigurationDeployment_(
    {
      request_id: Utilities.getUuid(),
      source: 'weekly_snapshot',
      sent_at: new Date().toISOString()
    },
    loaded.configuration,
    {
      source: 'weekly_snapshot',
      range: getPreviousCompletedWeekRange_()
    }
  );

  if (!deployment.queued && deployment.status === 'completed') {
    Logger.log(JSON.stringify({
      event: 'journal_weekly_snapshot_idempotent',
      operationId: deployment.operationId,
      configurationVersion: deployment.configurationVersion,
      configurationHash: deployment.configurationHash,
      period: deployment.period
    }));
    return deployment;
  }

  return processJournalConfigurationDeployment();
}

function executeJournalBigQuerySnapshot_(loadedEntityConfiguration) {
  Logger.log('--- JOURNAL BIGQUERY SNAPSHOT START ---');
  const schemaValidation = validateJournalBigQuerySchema_();
  const result = buildJournalSnapshot_(loadedEntityConfiguration);
  const loadResult = replaceJournalSnapshotPartition_(result.range, result.lineRows);
  const verification = verifyJournalSnapshotPartition_(result.range.snapshotWeek, result.lineRows.length);

  const executionResult = {
    entityConfiguration: result.entityConfiguration,
    schemaValidation,
    period: result.range,
    clientCount: result.clientCount,
    transactionCount: result.transactionCount,
    sourceRowCount: result.lineRows.length,
    totals: result.totals,
    loadResult,
    verification
  };

  Logger.log(JSON.stringify(executionResult, null, 2));
  Logger.log('--- JOURNAL BIGQUERY SNAPSHOT END ---');

  return {
    entityConfiguration: result.entityConfiguration,
    period: result.range,
    clientCount: result.clientCount,
    transactionCount: result.transactionCount,
    rowCount: result.lineRows.length,
    jobId: loadResult.jobId,
    verification
  };
}

/***********************
 * Central Entity Configuration
 ***********************/

function loadJournalEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(JOURNAL_ENTITY_CONTROL.cacheKey);

  if (cachedValue) {
    try {
      return { source: 'script_cache', configuration: validateJournalEntityConfiguration_(JSON.parse(cachedValue)) };
    } catch (error) {
      Logger.log(JSON.stringify({ event: 'journal_entity_configuration_cache_invalid', error: error.message }));
      cache.remove(JOURNAL_ENTITY_CONTROL.cacheKey);
    }
  }

  const localConfiguration = readLocalJournalEntityConfiguration_();
  if (!localConfiguration) {
    throw new Error(
      'No valid local Journal Entries entity configuration is available. ' +
      'Publish the centralized configuration again or run debugRefreshJournalEntityConfigurationFromCentral().'
    );
  }

  cacheJournalEntityConfiguration_(localConfiguration);
  return { source: 'script_properties', configuration: localConfiguration };
}

function refreshJournalEntityConfigurationFromCentral_() {
  const spreadsheet = getJournalControlSpreadsheet_();
  const metadata = readJournalCentralMetadata_(spreadsheet);
  const configuration = readPublishedJournalConfiguration_(spreadsheet, metadata.currentVersion);
  const persistence = persistJournalEntityConfiguration_(configuration);
  cacheJournalEntityConfiguration_(configuration);

  Logger.log(JSON.stringify({
    event: 'journal_entity_configuration_refreshed_manually',
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return { source: 'central_sheet_manual', configuration, persistence };
}

function getJournalControlSpreadsheet_() {
  const spreadsheetId = String(PropertiesService.getScriptProperties()
    .getProperty(JOURNAL_ENTITY_CONTROL.spreadsheetIdProperty) || '').trim();

  if (!spreadsheetId) {
    throw new Error('Missing Script Property: ' + JOURNAL_ENTITY_CONTROL.spreadsheetIdProperty);
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open the QBO control spreadsheet. Property=' +
      JOURNAL_ENTITY_CONTROL.spreadsheetIdProperty + ', error=' + error.message
    );
  }
}

function readJournalCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(JOURNAL_ENTITY_CONTROL.metadataSheetName);
  if (!sheet) throw new Error('Central metadata sheet not found: ' + JOURNAL_ENTITY_CONTROL.metadataSheetName);

  assertJournalControlHeaders_(sheet, ['Key', 'Value', 'Updated At']);
  if (sheet.getLastRow() < 2) throw new Error('Central configuration metadata is empty.');

  const metadata = {};
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues().forEach(row => {
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

function readPublishedJournalConfiguration_(spreadsheet, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(JOURNAL_ENTITY_CONTROL.publishedSheetName);
  if (!sheet) {
    throw new Error('Published configuration sheet not found: ' + JOURNAL_ENTITY_CONTROL.publishedSheetName);
  }

  const expectedHeaders = [
    'Report Key', 'Report Name', 'Configuration Version', 'Configuration Hash',
    'Published At', 'Entity Count', 'Configuration JSON'
  ];
  assertJournalControlHeaders_(sheet, expectedHeaders);
  if (sheet.getLastRow() < 2) throw new Error('Published configuration sheet is empty.');

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, expectedHeaders.length).getValues();
  const reportRow = rows.find(row => String(row[0] || '').trim() === JOURNAL_ENTITY_CONTROL.reportKey);
  if (!reportRow) {
    throw new Error('No published configuration was found for report_key=' + JOURNAL_ENTITY_CONTROL.reportKey);
  }

  const rowVersion = Number(reportRow[2] || 0);
  const rowHash = String(reportRow[3] || '').trim();
  const entityCount = Number(reportRow[5] || 0);
  const configurationJson = String(reportRow[6] || '').trim();

  if (rowVersion !== Number(expectedVersion)) {
    throw new Error('Published Journal Entries configuration version mismatch. Expected=' + expectedVersion + ', actual=' + rowVersion);
  }
  if (!configurationJson) throw new Error('Published Journal Entries configuration JSON is empty.');

  let configuration;
  try {
    configuration = JSON.parse(configurationJson);
  } catch (error) {
    throw new Error('Published Journal Entries configuration contains invalid JSON: ' + error.message);
  }

  const validated = validateJournalEntityConfiguration_(configuration, expectedVersion);
  if (validated.configuration_hash !== rowHash) {
    throw new Error('Published Journal Entries configuration hash does not match its row hash.');
  }
  if (validated.entities.length !== entityCount) {
    throw new Error('Published Journal Entries entity count mismatch. Expected=' + entityCount + ', actual=' + validated.entities.length);
  }

  return validated;
}

function validateJournalEntityConfiguration_(configuration, expectedVersion) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Journal Entries entity configuration must be a JSON object.');
  }

  const contractType = String(configuration.contract_type || '').trim();
  const contractVersion = String(configuration.contract_version || '').trim();
  const schemaVersion = String(configuration.schema_version || '').trim();
  const reportKey = String(configuration.report_key || '').trim();
  const configurationVersion = Number(configuration.configuration_version || 0);
  const configurationHash = String(configuration.configuration_hash || '').trim().toLowerCase();

  if (contractType !== JOURNAL_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected entity configuration contract_type: ' + contractType);
  }
  if (contractVersion !== JOURNAL_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected entity configuration contract_version: ' + contractVersion);
  }
  if (schemaVersion !== JOURNAL_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected entity configuration schema_version: ' + schemaVersion);
  }
  if (reportKey !== JOURNAL_ENTITY_CONTROL.reportKey) {
    throw new Error('Unexpected entity configuration report_key: ' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid entity configuration version: ' + configuration.configuration_version);
  }
  if (expectedVersion !== undefined && configurationVersion !== Number(expectedVersion)) {
    throw new Error('Entity configuration version is stale. Expected=' + expectedVersion + ', actual=' + configurationVersion);
  }
  if (!Array.isArray(configuration.entities)) {
    throw new Error('Entity configuration must contain an entities array.');
  }
  if (!configuration.entities.length) {
    throw new Error('Journal Entries entity configuration contains no authorized entities.');
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

  const calculatedHash = sha256Hex_(JSON.stringify({
    schema_version: schemaVersion,
    report_key: reportKey,
    entities: normalizedEntities
  }));

  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error('Entity configuration contains an invalid configuration_hash.');
  }
  if (calculatedHash !== configurationHash) {
    throw new Error('Entity configuration hash validation failed. Expected=' + configurationHash + ', calculated=' + calculatedHash);
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

function persistJournalEntityConfiguration_(configuration) {
  const serialized = JSON.stringify(configuration);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > JOURNAL_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Journal Entries entity configuration exceeds the safe Script Property size. bytes=' +
      byteCount + ', maximum=' + JOURNAL_ENTITY_CONTROL.maxPropertyBytes
    );
  }

  PropertiesService.getScriptProperties().setProperty(JOURNAL_ENTITY_CONTROL.localPropertyKey, serialized);
  return { propertyKey: JOURNAL_ENTITY_CONTROL.localPropertyKey, byteCount };
}

function cacheJournalEntityConfiguration_(configuration) {
  CacheService.getScriptCache().put(
    JOURNAL_ENTITY_CONTROL.cacheKey,
    JSON.stringify(configuration),
    JOURNAL_ENTITY_CONTROL.cacheTtlSeconds
  );
}

function buildJournalEntityAuthorizationMaps_(configuration) {
  const firstWordAliases = {};
  const clientIdAliases = {};
  configuration.entities.forEach(entity => {
    if (entity.match_type === 'first_word') firstWordAliases[entity.match_value] = entity.entity_alias;
    else if (entity.match_type === 'client_id') clientIdAliases[entity.match_value] = entity.entity_alias;
  });
  return { firstWordAliases, clientIdAliases };
}

function assertJournalControlHeaders_(sheet, expectedHeaders) {
  const actualHeaders = sheet.getRange(1, 1, 1, expectedHeaders.length).getDisplayValues()[0]
    .map(value => String(value || '').trim());
  const mismatches = expectedHeaders.map((expected, index) => ({
    position: index + 1, expected, actual: actualHeaders[index]
  })).filter(header => header.expected !== header.actual);

  if (mismatches.length) {
    throw new Error('Unexpected headers in central sheet "' + sheet.getName() + '": ' + JSON.stringify(mismatches));
  }
}

/***********************
 * Entity Configuration Push Endpoint
 ***********************/

function doPost(e) {
  let response;
  try {
    response = handleJournalEntityConfigurationPush_(e);
  } catch (error) {
    response = { success: false, status: 'rejected', reportKey: JOURNAL_ENTITY_CONTROL.reportKey, error: error.message };
    Logger.log(JSON.stringify({ event: 'journal_entity_configuration_push_rejected', error: error.message }));
  }
  return createJournalJsonResponse_(response);
}

function handleJournalEntityConfigurationPush_(e) {
  const rawBody = String(e && e.postData && e.postData.contents || '').trim();
  if (!rawBody) throw new Error('Push request body is empty.');

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Push request contains invalid envelope JSON: ' + error.message);
  }

  validateJournalPushEnvelope_(envelope);
  const secret = getJournalEntityPushSecret_();
  const calculatedSignature = hmacSha256Hex_(envelope.payload, secret);
  if (!secureHexEquals_(calculatedSignature, envelope.signature)) {
    throw new Error('Push request signature is invalid.');
  }

  let pushPayload;
  try {
    pushPayload = JSON.parse(envelope.payload);
  } catch (error) {
    throw new Error('Push envelope contains invalid payload JSON: ' + error.message);
  }

  validateJournalPushPayload_(pushPayload);
  const configuration = validateJournalEntityConfiguration_(
    pushPayload.configuration,
    Number(pushPayload.configuration_version)
  );

  if (configuration.configuration_hash !== String(pushPayload.configuration_hash || '').trim().toLowerCase()) {
    throw new Error('Push payload configuration hash does not match the embedded configuration.');
  }

  const lock = LockService.getUserLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Unable to acquire the Journal Entries configuration request lock.');
  }

  try {
    return applyJournalPushedConfiguration_(pushPayload, configuration);
  } finally {
    lock.releaseLock();
  }
}

function validateJournalPushEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Push envelope must be a JSON object.');
  }

  const contractType = String(envelope.contract_type || '').trim();
  const contractVersion = String(envelope.contract_version || '').trim();
  const payload = String(envelope.payload || '').trim();
  const signature = String(envelope.signature || '').trim().toLowerCase();

  if (contractType !== JOURNAL_ENTITY_CONTROL.pushEnvelopeContractType) {
    throw new Error('Unexpected push envelope contract_type: ' + contractType);
  }
  if (contractVersion !== JOURNAL_ENTITY_CONTROL.pushEnvelopeContractVersion) {
    throw new Error('Unexpected push envelope contract_version: ' + contractVersion);
  }
  if (!payload) throw new Error('Push envelope payload is empty.');
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Push envelope signature must be a SHA-256 hex value.');
  }
}

function validateJournalPushPayload_(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Push payload must be a JSON object.');
  }

  const contractType = String(payload.contract_type || '').trim();
  const contractVersion = String(payload.contract_version || '').trim();
  const requestId = String(payload.request_id || '').trim();
  const reportKey = String(payload.report_key || '').trim();
  const configurationVersion = Number(payload.configuration_version || 0);
  const configurationHash = String(payload.configuration_hash || '').trim().toLowerCase();
  const sentAt = String(payload.sent_at || '').trim();
  const sentAtMilliseconds = Date.parse(sentAt);

  if (contractType !== JOURNAL_ENTITY_CONTROL.pushContractType) {
    throw new Error('Unexpected push payload contract_type: ' + contractType);
  }
  if (contractVersion !== JOURNAL_ENTITY_CONTROL.pushContractVersion) {
    throw new Error('Unexpected push payload contract_version: ' + contractVersion);
  }
  if (!requestId) throw new Error('Push payload is missing request_id.');
  if (reportKey !== JOURNAL_ENTITY_CONTROL.reportKey) {
    throw new Error('Push payload was sent to the wrong report. Expected=' + JOURNAL_ENTITY_CONTROL.reportKey + ', actual=' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Push payload contains an invalid configuration version.');
  }
  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error('Push payload contains an invalid configuration hash.');
  }
  if (!Number.isFinite(sentAtMilliseconds)) throw new Error('Push payload contains an invalid sent_at value.');

  const ageSeconds = (Date.now() - sentAtMilliseconds) / 1000;
  if (ageSeconds > JOURNAL_ENTITY_CONTROL.pushMaxAgeSeconds) {
    throw new Error('Push payload has expired. AgeSeconds=' + Math.floor(ageSeconds));
  }
  if (ageSeconds < -JOURNAL_ENTITY_CONTROL.pushFutureToleranceSeconds) {
    throw new Error('Push payload sent_at is too far in the future.');
  }
  if (!payload.configuration || typeof payload.configuration !== 'object' || Array.isArray(payload.configuration)) {
    throw new Error('Push payload is missing the configuration object.');
  }
}

function applyJournalPushedConfiguration_(pushPayload, incomingConfiguration) {
  const localConfiguration = readLocalJournalEntityConfiguration_();

  if (localConfiguration) {
    const localVersion = localConfiguration.configuration_version;
    const incomingVersion = incomingConfiguration.configuration_version;

    if (incomingVersion < localVersion) {
      const receipt = persistJournalPushReceipt_(pushPayload, incomingConfiguration, 'stale_ignored');
      return {
        success: true,
        status: 'stale_ignored',
        reportKey: JOURNAL_ENTITY_CONTROL.reportKey,
        incomingConfigurationVersion: incomingVersion,
        currentConfigurationVersion: localVersion,
        currentConfigurationHash: localConfiguration.configuration_hash,
        receipt
      };
    }

    if (incomingVersion === localVersion) {
      if (incomingConfiguration.configuration_hash !== localConfiguration.configuration_hash) {
        throw new Error('Configuration version conflict. Version=' + incomingVersion + ' has a different local hash.');
      }

      cacheJournalEntityConfiguration_(incomingConfiguration);
      const deployment = queueJournalConfigurationDeployment_(pushPayload, incomingConfiguration);
      const responseStatus = deployment.queued ? 'queued' : 'idempotent';
      const receipt = persistJournalPushReceipt_(pushPayload, incomingConfiguration, responseStatus, deployment);
      return {
        success: true,
        status: responseStatus,
        reportKey: JOURNAL_ENTITY_CONTROL.reportKey,
        configurationVersion: incomingVersion,
        configurationHash: incomingConfiguration.configuration_hash,
        operationId: deployment.operationId,
        deploymentStatus: deployment.status,
        currentStage: deployment.currentStage,
        receipt
      };
    }
  }

  const persistence = persistJournalEntityConfiguration_(incomingConfiguration);
  cacheJournalEntityConfiguration_(incomingConfiguration);
  const deployment = queueJournalConfigurationDeployment_(pushPayload, incomingConfiguration);
  const receipt = persistJournalPushReceipt_(pushPayload, incomingConfiguration, 'queued', deployment);

  Logger.log(JSON.stringify({
    event: 'journal_entity_configuration_push_queued',
    requestId: pushPayload.request_id,
    operationId: deployment.operationId,
    configurationVersion: incomingConfiguration.configuration_version,
    configurationHash: incomingConfiguration.configuration_hash,
    entityCount: incomingConfiguration.entities.length,
    byteCount: persistence.byteCount
  }));

  return {
    success: true,
    status: 'queued',
    reportKey: JOURNAL_ENTITY_CONTROL.reportKey,
    configurationVersion: incomingConfiguration.configuration_version,
    configurationHash: incomingConfiguration.configuration_hash,
    entityCount: incomingConfiguration.entities.length,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage,
    persistence,
    receipt
  };
}

function readLocalJournalEntityConfiguration_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(JOURNAL_ENTITY_CONTROL.localPropertyKey);
  if (!serialized) return null;

  try {
    return validateJournalEntityConfiguration_(JSON.parse(serialized));
  } catch (error) {
    Logger.log(JSON.stringify({ event: 'journal_local_entity_configuration_invalid', error: error.message }));
    return null;
  }
}

function persistJournalPushReceipt_(pushPayload, configuration, status, deployment) {
  const receipt = {
    request_id: pushPayload.request_id,
    report_key: JOURNAL_ENTITY_CONTROL.reportKey,
    status,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: pushPayload.sent_at,
    received_at: new Date().toISOString(),
    operation_id: deployment && deployment.operationId || null,
    deployment_status: deployment && deployment.status || null,
    current_stage: deployment && deployment.currentStage || null
  };

  PropertiesService.getScriptProperties().setProperty(
    JOURNAL_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );
  return receipt;
}

function getJournalEntityPushEndpointUrl_() {
  const endpointUrl = String(PropertiesService.getScriptProperties()
    .getProperty(JOURNAL_ENTITY_CONTROL.pushEndpointUrlProperty) || '').trim();

  if (!endpointUrl) throw new Error('Missing Script Property: ' + JOURNAL_ENTITY_CONTROL.pushEndpointUrlProperty);
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(endpointUrl)) {
    throw new Error(
      'Journal Entries push endpoint must be the deployed Web App URL ending in /exec. CurrentValue=' + endpointUrl
    );
  }
  return endpointUrl;
}

function getJournalEntityPushSecret_() {
  const secret = String(PropertiesService.getScriptProperties()
    .getProperty(JOURNAL_ENTITY_CONTROL.pushSecretProperty) || '').trim();

  if (!secret) throw new Error('Missing Script Property: ' + JOURNAL_ENTITY_CONTROL.pushSecretProperty);
  if (secret.length < 32) throw new Error('Journal Entries entity push secret must contain at least 32 characters.');
  return secret;
}

function hmacSha256Hex_(value, secret) {
  return Utilities.computeHmacSha256Signature(String(value), String(secret), Utilities.Charset.UTF_8)
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0')).join('');
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

function createJournalJsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
    .map(byte => (byte < 0 ? byte + 256 : byte).toString(16).padStart(2, '0')).join('');
}

function getPreviousCompletedWeekRange_(referenceIsoDate) {
  let timeZone;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    timeZone = (ss && ss.getSpreadsheetTimeZone()) || Session.getScriptTimeZone() || 'Etc/UTC';
  } catch (error) {
    timeZone = Session.getScriptTimeZone() || 'Etc/UTC';
  }
  const today = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');
  const referenceDateText = normalizeDateForOutput_(referenceIsoDate || today);
  const referenceDate = safeParseDate_(referenceDateText);
  if (!referenceDate) {
    throw new Error(
      'Unable to calculate the journal week range. Invalid reference date: ' + referenceIsoDate
    );
  }
  const currentWeekMonday = new Date(referenceDate.getTime());
  currentWeekMonday.setUTCDate(
    currentWeekMonday.getUTCDate() - ((referenceDate.getUTCDay() + 6) % 7)
  );
  const dateFrom = new Date(currentWeekMonday.getTime());
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 7);
  const dateTo = new Date(currentWeekMonday.getTime());
  dateTo.setUTCDate(dateTo.getUTCDate() - 1);
  const snapshotDate = formatUtcDate_(currentWeekMonday);
  const snapshotWeek = formatUtcDate_(dateFrom);
  const dateToIso = formatUtcDate_(dateTo);
  return {
    snapshotDate,
    snapshotWeek,
    dateFrom: snapshotWeek,
    dateTo: dateToIso,
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
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    const year = Number(match[3].length === 2 ? '20' + match[3] : match[3]);
    return new Date(Date.UTC(year, Number(match[1]) - 1, Number(match[2])));
  }
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

/***********************
 * HTTP and Journal Fetching
 ***********************/

function fetchJsonOrThrow_(url, contextLabel) {
  const apiKey = String(
    PropertiesService.getScriptProperties().getProperty(JOURNAL_CONFIG.apiKeyProperty) || ''
  ).trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + JOURNAL_CONFIG.apiKeyProperty);
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { 'X-API-Key': apiKey },
      muteHttpExceptions: true
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

function fetchJournalReport_(clientId, dateFrom, dateTo) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedDateFrom = normalizeDateForOutput_(dateFrom);
  const normalizedDateTo = normalizeDateForOutput_(dateTo);
  if (!normalizedClientId) throw new Error('Client ID is required to fetch the journal report.');
  if (!normalizedDateFrom || !normalizedDateTo) {
    throw new Error(
      'A valid journal date range is required. dateFrom=' + dateFrom + ', dateTo=' + dateTo
    );
  }
  if (safeParseDate_(normalizedDateFrom).getTime() > safeParseDate_(normalizedDateTo).getTime()) {
    throw new Error(
      'Journal dateFrom cannot be later than dateTo. ' +
        normalizedDateFrom +
        ' > ' +
        normalizedDateTo
    );
  }
  const query = [
    'environment=' + encodeURIComponent(JOURNAL_CONFIG.environment),
    'start_date=' + encodeURIComponent(normalizedDateFrom),
    'end_date=' + encodeURIComponent(normalizedDateTo)
  ].join('&');
  const payload = fetchJsonOrThrow_(
    JOURNAL_CONFIG.baseUrl +
      '/qbo/' +
      encodeURIComponent(normalizedClientId) +
      '/reports/journal?' +
      query,
    '/qbo/' + normalizedClientId + '/reports/journal'
  );
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(
      'Invalid journal response for client ' + normalizedClientId + '. Expected a JSON object.'
    );
  }
  const responseClientId = stringOrNull_(payload.client_id);
  if (responseClientId && responseClientId !== normalizedClientId) {
    throw new Error(
      'Journal response client mismatch. Requested=' +
        normalizedClientId +
        ', received=' +
        responseClientId
    );
  }
  const responseEnvironment = stringOrNull_(payload.environment);
  if (responseEnvironment && responseEnvironment !== JOURNAL_CONFIG.environment) {
    throw new Error(
      'Journal response environment mismatch. Expected=' +
        JOURNAL_CONFIG.environment +
        ', received=' +
        responseEnvironment
    );
  }
  const report = payload.data && typeof payload.data === 'object' ? payload.data : null;
  const header = report && report.Header && typeof report.Header === 'object' ? report.Header : null;
  if (!report || !header) {
    throw new Error(
      'Invalid journal response for client ' + normalizedClientId + '. Expected data.Header.'
    );
  }
  if (String(header.ReportName || '') !== JOURNAL_CONFIG.reportName) {
    throw new Error(
      'Unexpected journal report name for client ' +
        normalizedClientId +
        ': ' +
        String(header.ReportName || '')
    );
  }
  const headerStart = normalizeDateForOutput_(header.StartPeriod);
  const headerEnd = normalizeDateForOutput_(header.EndPeriod);
  if (headerStart && headerStart !== normalizedDateFrom) {
    throw new Error(
      'Journal start period mismatch. Requested=' + normalizedDateFrom + ', received=' + headerStart
    );
  }
  if (headerEnd && headerEnd !== normalizedDateTo) {
    throw new Error(
      'Journal end period mismatch. Requested=' + normalizedDateTo + ', received=' + headerEnd
    );
  }
  const columns = report.Columns && Array.isArray(report.Columns.Column) ? report.Columns.Column : [];
  if (!columns.length) {
    throw new Error(
      'Invalid journal response for client ' +
        normalizedClientId +
        '. Expected data.Columns.Column.'
    );
  }
  const columnMap = {};
  columns.forEach((column, index) => {
    const metadata = column && Array.isArray(column.MetaData) ? column.MetaData : [];
    const keyEntry = metadata.find((entry) => String(entry.Name || '').trim() === 'ColKey');
    const columnKey = keyEntry ? String(keyEntry.Value || '').trim() : '';
    if (!columnKey) {
      throw new Error('Journal column at index ' + index + ' does not contain a ColKey.');
    }
    if (columnMap[columnKey] !== undefined) {
      throw new Error('Duplicate journal ColKey detected: ' + columnKey);
    }
    columnMap[columnKey] = index;
  });
  const missingColumns = JOURNAL_REQUIRED_COLUMN_KEYS.filter(
    (columnKey) => columnMap[columnKey] === undefined
  );
  if (missingColumns.length) {
    throw new Error(
      'Journal report is missing required columns for client ' +
        normalizedClientId +
        ': ' +
        missingColumns.join(', ')
    );
  }
  return {
    clientId: normalizedClientId,
    realmId: stringOrNull_(payload.realm_id),
    environment: responseEnvironment || JOURNAL_CONFIG.environment,
    reportTime: stringOrNull_(header.Time),
    currency: stringOrNull_(header.Currency) || JOURNAL_CONFIG.currencyDefault,
    columnMap,
    rows: report.Rows && Array.isArray(report.Rows.Row) ? report.Rows.Row : []
  };
}

/***********************
 * Journal Normalization
 ***********************/

// NORMALIZATION FIX v3 (2026-08-04): skip QBO informational rows without debit/credit
// and accept an empty transaction summary only when the transaction has no accounting impact.
function normalizeJournalReport_(journalReport) {
  if (!journalReport || !Array.isArray(journalReport.rows) || !journalReport.columnMap) {
    throw new Error('A valid fetched journal report is required for normalization.');
  }

  const rows = [];
  let currentTransaction = null;
  let pendingSplitRow = null;
  let transactionCount = 0;
  let reportDebitCents = 0;
  let reportCreditCents = 0;
  let finalTotalSeen = false;
  let implicitTransactionBoundarySeen = false;

  journalReport.rows.forEach((sourceRow, sourceIndex) => {
    const rowType = String((sourceRow && sourceRow.type) || '').trim();

    if (rowType === 'Data') {
      const colData = Array.isArray(sourceRow.ColData) ? sourceRow.ColData : [];
      const blankRow = colData.every((cell) => {
        if (!cell || typeof cell !== 'object') return true;

        const value = String(
          cell.value === null || cell.value === undefined ? '' : cell.value
        ).trim();
        const id = String(
          cell.id === null || cell.id === undefined ? '' : cell.id
        ).trim();

        return !value && !id;
      });

      if (blankRow) return;

      const dateValue = getJournalCellValue_(
        colData,
        journalReport.columnMap,
        'tx_date'
      );
      const isContinuation = dateValue === '0-00-00';

      if (!isContinuation) {
        if (pendingSplitRow) {
          throw new Error(
            'A new journal transaction started before a split row was completed. Pending transaction=' +
              pendingSplitRow.transactionId +
              ', source row=' +
              (sourceIndex + 1)
          );
        }

        const transactionDate = normalizeDateForOutput_(dateValue);

        if (!transactionDate) {
          throw new Error(
            'Invalid journal transaction date at source row ' +
              (sourceIndex + 1) +
              ': ' +
              dateValue
          );
        }

        if (currentTransaction) {
          /*
           * Some QBO journal responses omit the per-transaction Section and
           * begin the next transaction immediately. An implicit boundary is
           * safe only when the rows accumulated for the previous transaction
           * are independently balanced.
           */
          assertJournalBalanced_(
            currentTransaction.debitCents,
            currentTransaction.creditCents,
            'Journal transaction ' +
              currentTransaction.transactionId +
              ' before source row ' +
              (sourceIndex + 1)
          );
          transactionCount++;
          implicitTransactionBoundarySeen = true;
          currentTransaction = null;
        }

        currentTransaction = createJournalTransactionContext_(
          colData,
          journalReport.columnMap,
          transactionDate,
          sourceIndex
        );
      } else {
        if (!currentTransaction) {
          throw new Error(
            'Journal continuation row found before a transaction header at source row ' +
              (sourceIndex + 1)
          );
        }

        const repeatedId = getJournalCellId_(
          colData,
          journalReport.columnMap,
          'txn_type'
        );

        if (repeatedId && repeatedId !== currentTransaction.transactionId) {
          throw new Error(
            'Journal continuation transaction ID mismatch at source row ' +
              (sourceIndex + 1) +
              '. Expected=' +
              currentTransaction.transactionId +
              ', received=' +
              repeatedId
          );
        }
      }

      const accountName = getJournalCellValue_(
        colData,
        journalReport.columnMap,
        'account_name'
      );
      const amountDebit = parseJournalAmountCell_(
        getJournalCellValue_(colData, journalReport.columnMap, 'debt_amt'),
        'debit',
        currentTransaction.transactionId,
        sourceIndex
      );
      const amountCredit = parseJournalAmountCell_(
        getJournalCellValue_(colData, journalReport.columnMap, 'credit_amt'),
        'credit',
        currentTransaction.transactionId,
        sourceIndex
      );
      const amountPresent = amountDebit.present || amountCredit.present;
      const amountIsZero =
        amountDebit.cents === 0 && amountCredit.cents === 0;

      /*
       * QBO can return informational transaction rows without an accounting
       * amount. They must not become snapshot rows or require an account.
       */
      if (!amountPresent && !pendingSplitRow) return;

      /*
       * QBO can split a zero-value accounting line between a metadata row
       * and a following account continuation row.
       */
      if (!accountName && amountPresent && amountIsZero) {
        if (pendingSplitRow) {
          throw new Error(
            'Multiple incomplete journal split rows detected for transaction ' +
              currentTransaction.transactionId
          );
        }

        pendingSplitRow = {
          transactionId: currentTransaction.transactionId,
          sourceIndex,
          colData
        };
        return;
      }

      let effectiveColData = colData;
      let effectiveSourceIndex = sourceIndex;
      const completesSplit =
        accountName &&
        pendingSplitRow &&
        (!amountPresent || amountIsZero);
      const replacesZeroValuePlaceholder =
        accountName &&
        pendingSplitRow &&
        amountPresent &&
        !amountIsZero;

      if (completesSplit) {
        if (
          pendingSplitRow.transactionId !==
          currentTransaction.transactionId
        ) {
          throw new Error(
            'Journal split row transaction mismatch. Pending=' +
              pendingSplitRow.transactionId +
              ', current=' +
              currentTransaction.transactionId
          );
        }

        effectiveColData = mergeJournalSplitColData_(
          pendingSplitRow.colData,
          colData
        );
        effectiveSourceIndex = pendingSplitRow.sourceIndex;
        pendingSplitRow = null;
      } else if (replacesZeroValuePlaceholder) {
        /*
         * QBO can also emit a zero-value, account-less placeholder before a
         * regular accounting continuation. Prefer the accounting row's
         * account and amounts while retaining missing transaction metadata
         * from the placeholder.
         */
        effectiveColData = mergeJournalSplitColData_(
          colData,
          pendingSplitRow.colData
        );
        pendingSplitRow = null;
      } else if (pendingSplitRow) {
        throw new Error(
          'Journal split row was not completed by an account continuation row with no amount or a ' +
            'zero amount for transaction ' +
            currentTransaction.transactionId +
            '. Pending source row=' +
            (pendingSplitRow.sourceIndex + 1) +
            ', current source row=' +
            (sourceIndex + 1)
        );
      }

      const normalizedRow = normalizeJournalAccountingRow_(
        effectiveColData,
        journalReport.columnMap,
        currentTransaction,
        effectiveSourceIndex
      );

      rows.push(normalizedRow);
      currentTransaction.lineCount++;
      currentTransaction.debitCents += normalizedRow.debitCents;
      currentTransaction.creditCents += normalizedRow.creditCents;
      reportDebitCents += normalizedRow.debitCents;
      reportCreditCents += normalizedRow.creditCents;
      return;
    }

    if (rowType === 'Section') {
      if (pendingSplitRow) {
        throw new Error(
          'Journal transaction section was reached before a split row was completed. Transaction=' +
            pendingSplitRow.transactionId +
            ', source row=' +
            (pendingSplitRow.sourceIndex + 1)
        );
      }

      const summaryColData =
        sourceRow.Summary && Array.isArray(sourceRow.Summary.ColData)
          ? sourceRow.Summary.ColData
          : [];

      if (!summaryColData.length) {
        throw new Error(
          'Journal section does not contain Summary.ColData at source row ' +
            (sourceIndex + 1)
        );
      }

      const sectionLabel = getJournalCellValue_(
        summaryColData,
        journalReport.columnMap,
        'tx_date'
      ).toUpperCase();

      if (sectionLabel === 'TOTAL') {
        if (currentTransaction) {
          throw new Error(
            'Journal TOTAL section was received before transaction ' +
              currentTransaction.transactionId +
              ' was closed.'
          );
        }

        if (finalTotalSeen) {
          throw new Error('Duplicate journal TOTAL section detected.');
        }

        const totalSummary = readJournalSummaryAmounts_(
          summaryColData,
          journalReport.columnMap,
          'journal TOTAL section'
        );

        assertJournalAmountsEqual_(
          reportDebitCents,
          totalSummary.debitCents,
          'Calculated journal debit total',
          'reported journal debit total'
        );
        assertJournalAmountsEqual_(
          reportCreditCents,
          totalSummary.creditCents,
          'Calculated journal credit total',
          'reported journal credit total'
        );
        assertJournalBalanced_(
          totalSummary.debitCents,
          totalSummary.creditCents,
          'Journal report total'
        );

        finalTotalSeen = true;
        return;
      }

      if (!currentTransaction) {
        throw new Error(
          'Journal transaction section found without an active transaction at source row ' +
            (sourceIndex + 1)
        );
      }

      const summaryDebit = parseJournalAmountCell_(
        getJournalCellValue_(
          summaryColData,
          journalReport.columnMap,
          'debt_amt'
        ),
        'debit',
        'transaction ' + currentTransaction.transactionId + ' section',
        sourceIndex
      );
      const summaryCredit = parseJournalAmountCell_(
        getJournalCellValue_(
          summaryColData,
          journalReport.columnMap,
          'credit_amt'
        ),
        'credit',
        'transaction ' + currentTransaction.transactionId + ' section',
        sourceIndex
      );

      const summaryHasAmount =
        summaryDebit.present || summaryCredit.present;
      const transactionHasAccountingImpact =
        currentTransaction.lineCount > 0 ||
        currentTransaction.debitCents !== 0 ||
        currentTransaction.creditCents !== 0;

      /*
       * QBO can emit informational transactions with no accounting rows and
       * an empty transaction summary.
       */
      if (!summaryHasAmount && !transactionHasAccountingImpact) {
        transactionCount++;
        currentTransaction = null;
        return;
      }

      if (!summaryHasAmount) {
        throw new Error(
          'Journal summary does not contain debit or credit values for transaction ' +
            currentTransaction.transactionId +
            ' section'
        );
      }

      const transactionSummary = {
        debitCents: summaryDebit.cents,
        creditCents: summaryCredit.cents
      };

      assertJournalAmountsEqual_(
        currentTransaction.debitCents,
        transactionSummary.debitCents,
        'Calculated debit for transaction ' +
          currentTransaction.transactionId,
        'reported debit'
      );
      assertJournalAmountsEqual_(
        currentTransaction.creditCents,
        transactionSummary.creditCents,
        'Calculated credit for transaction ' +
          currentTransaction.transactionId,
        'reported credit'
      );
      assertJournalBalanced_(
        transactionSummary.debitCents,
        transactionSummary.creditCents,
        'Journal transaction ' + currentTransaction.transactionId
      );

      transactionCount++;
      currentTransaction = null;
      return;
    }

    throw new Error(
      'Unsupported journal row type at source row ' +
        (sourceIndex + 1) +
        ': ' +
        (rowType || '(empty)')
    );
  });

  if (pendingSplitRow) {
    throw new Error(
      'Journal split row was not completed for transaction ' +
        pendingSplitRow.transactionId
    );
  }

  if (currentTransaction) {
    /*
     * Compact QBO journal responses can end immediately after their final
     * transaction. Apply the same balance requirement used for an omitted
     * section between transactions before accepting the implicit EOF boundary.
     */
    assertJournalBalanced_(
      currentTransaction.debitCents,
      currentTransaction.creditCents,
      'Journal transaction ' + currentTransaction.transactionId + ' at end of report'
    );
    transactionCount++;
    implicitTransactionBoundarySeen = true;
    currentTransaction = null;
  }

  if (
    rows.length &&
    !finalTotalSeen &&
    !implicitTransactionBoundarySeen
  ) {
    throw new Error(
      'Journal report contains accounting rows but no TOTAL section.'
    );
  }

  assertJournalBalanced_(
    reportDebitCents,
    reportCreditCents,
    'Calculated journal report'
  );

  return { rows, transactionCount };
}

function createJournalTransactionContext_(colData, columnMap, transactionDate, sourceIndex) {
  const transactionId = getJournalCellId_(colData, columnMap, 'txn_type');
  const transactionType = getJournalCellValue_(colData, columnMap, 'txn_type');
  if (!transactionId) {
    throw new Error('Journal transaction ID is missing at source row ' + (sourceIndex + 1));
  }
  if (!transactionType) {
    throw new Error('Journal transaction type is missing for transaction ' + transactionId);
  }
  return {
    transactionId: transactionId,
    transactionDate: transactionDate,
    transactionType: transactionType,
    documentNumber: getJournalCellValue_(colData, columnMap, 'doc_num'),
    name: getJournalCellValue_(colData, columnMap, 'name'),
    nameId: getJournalCellId_(colData, columnMap, 'name'),
    locationName: getJournalCellValue_(colData, columnMap, 'dept_name'),
    locationId: getJournalCellId_(colData, columnMap, 'dept_name'),
    className: getJournalCellValue_(colData, columnMap, 'klass_name'),
    classId: getJournalCellId_(colData, columnMap, 'klass_name'),
    lineCount: 0,
    debitCents: 0,
    creditCents: 0
  };
}

function normalizeJournalAccountingRow_(colData, columnMap, transaction, sourceIndex) {
  const accountName = getJournalCellValue_(colData, columnMap, 'account_name');
  const accountId = getJournalCellId_(colData, columnMap, 'account_name');
  if (!accountName) {
    throw new Error(
      'Journal account name is missing for transaction ' +
        transaction.transactionId +
        ' at source row ' +
        (sourceIndex + 1)
    );
  }
  const debit = parseJournalAmountCell_(
    getJournalCellValue_(colData, columnMap, 'debt_amt'),
    'debit',
    transaction.transactionId,
    sourceIndex
  );
  const credit = parseJournalAmountCell_(
    getJournalCellValue_(colData, columnMap, 'credit_amt'),
    'credit',
    transaction.transactionId,
    sourceIndex
  );
  const directName = getJournalCellValue_(colData, columnMap, 'name');
  const directNameId = getJournalCellId_(colData, columnMap, 'name');
  const directLocationName = getJournalCellValue_(colData, columnMap, 'dept_name');
  const directLocationId = getJournalCellId_(colData, columnMap, 'dept_name');
  const directClassName = getJournalCellValue_(colData, columnMap, 'klass_name');
  const directClassId = getJournalCellId_(colData, columnMap, 'klass_name');
  return {
    transactionId: transaction.transactionId,
    transactionDate: transaction.transactionDate,
    transactionType: transaction.transactionType,
    documentNumber: transaction.documentNumber || null,
    name: directName || transaction.name || null,
    nameId: directNameId || transaction.nameId || null,
    locationName: directLocationName || transaction.locationName || null,
    locationId: directLocationId || transaction.locationId || null,
    className: directClassName || transaction.className || null,
    classId: directClassId || transaction.classId || null,
    lineNumber: transaction.lineCount + 1,
    memoDescription: getJournalCellValue_(colData, columnMap, 'memo') || null,
    accountName,
    accountId: accountId || null,
    debitAmount: debit.amount,
    creditAmount: credit.amount,
    netAmount: centsToAmount_(debit.cents - credit.cents),
    debitCents: debit.cents,
    creditCents: credit.cents
  };
}

function readJournalSummaryAmounts_(colData, columnMap, contextLabel) {
  const debit = parseJournalAmountCell_(
    getJournalCellValue_(colData, columnMap, 'debt_amt'),
    'debit',
    contextLabel,
    -1
  );
  const credit = parseJournalAmountCell_(
    getJournalCellValue_(colData, columnMap, 'credit_amt'),
    'credit',
    contextLabel,
    -1
  );
  if (!debit.present && !credit.present) {
    throw new Error('Journal summary does not contain debit or credit values for ' + contextLabel);
  }
  return {
    debitCents: debit.cents,
    creditCents: credit.cents
  };
}

function mergeJournalSplitColData_(amountRowColData, accountRowColData) {
  const length = Math.max(
    Array.isArray(amountRowColData) ? amountRowColData.length : 0,
    Array.isArray(accountRowColData) ? accountRowColData.length : 0
  );
  const merged = [];
  for (let index = 0; index < length; index++) {
    const primary =
      amountRowColData[index] && typeof amountRowColData[index] === 'object'
        ? amountRowColData[index]
        : {};
    const secondary =
      accountRowColData[index] && typeof accountRowColData[index] === 'object'
        ? accountRowColData[index]
        : {};
    const primaryValue = String(
      primary.value === null || primary.value === undefined ? '' : primary.value
    ).trim();
    const secondaryValue = String(
      secondary.value === null || secondary.value === undefined ? '' : secondary.value
    ).trim();
    const primaryId = String(
      primary.id === null || primary.id === undefined ? '' : primary.id
    ).trim();
    const secondaryId = String(
      secondary.id === null || secondary.id === undefined ? '' : secondary.id
    ).trim();
    const cell = {
      value: primaryValue !== '' ? primary.value : secondaryValue !== '' ? secondary.value : ''
    };
    if (primaryId !== '') {
      cell.id = primary.id;
    } else if (secondaryId !== '') {
      cell.id = secondary.id;
    } else if (
      Object.prototype.hasOwnProperty.call(primary, 'id') ||
      Object.prototype.hasOwnProperty.call(secondary, 'id')
    ) {
      cell.id = '';
    }
    merged.push(cell);
  }
  return merged;
}

function parseJournalAmountCell_(value, amountType, transactionLabel, sourceIndex) {
  const raw = String(value === null || value === undefined ? '' : value).trim();
  if (!raw) {
    return {
      present: false,
      amount: 0,
      cents: 0
    };
  }
  const isParenthesesNegative = /^\(.*\)$/.test(raw);
  const normalized = raw.replace(/^\((.*)\)$/, '$1').replace(/[$,\s]/g, '');
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    const sourceLabel = sourceIndex >= 0 ? ' at source row ' + (sourceIndex + 1) : '';
    throw new Error(
      'Invalid journal ' + amountType + ' amount for ' + transactionLabel + sourceLabel + ': ' + raw
    );
  }
  const signedAmount = isParenthesesNegative ? -parsed : parsed;
  const cents = Math.round(signedAmount * 100);
  return {
    present: true,
    amount: centsToAmount_(cents),
    cents: cents
  };
}

function getJournalCell_(colData, columnMap, columnKey) {
  const columnIndex = columnMap[columnKey];
  if (
    columnIndex === undefined ||
    !Array.isArray(colData) ||
    columnIndex < 0 ||
    columnIndex >= colData.length
  ) {
    return null;
  }
  const cell = colData[columnIndex];
  return cell && typeof cell === 'object' ? cell : null;
}

function getJournalCellValue_(colData, columnMap, columnKey) {
  const cell = getJournalCell_(colData, columnMap, columnKey);
  return cell
    ? String(cell.value === null || cell.value === undefined ? '' : cell.value).trim()
    : '';
}

function getJournalCellId_(colData, columnMap, columnKey) {
  const cell = getJournalCell_(colData, columnMap, columnKey);
  return cell ? String(cell.id === null || cell.id === undefined ? '' : cell.id).trim() : '';
}

function assertJournalAmountsEqual_(
  calculatedCents,
  reportedCents,
  calculatedLabel,
  reportedLabel
) {
  const difference = Math.abs(calculatedCents - reportedCents);
  if (difference > JOURNAL_BALANCE_TOLERANCE_CENTS) {
    throw new Error(
      calculatedLabel +
        ' does not match ' +
        reportedLabel +
        '. Calculated=' +
        centsToAmount_(calculatedCents) +
        ', reported=' +
        centsToAmount_(reportedCents)
    );
  }
}

function assertJournalBalanced_(debitCents, creditCents, contextLabel) {
  const difference = Math.abs(debitCents - creditCents);
  if (difference > JOURNAL_BALANCE_TOLERANCE_CENTS) {
    throw new Error(
      contextLabel +
        ' is not balanced. Debit=' +
        centsToAmount_(debitCents) +
        ', credit=' +
        centsToAmount_(creditCents) +
        ', difference=' +
        centsToAmount_(difference)
    );
  }
}

function centsToAmount_(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

/***********************
 * Client Selection and Snapshot Assembly
 ***********************/

/***********************
 * Client Selection and Snapshot Assembly
 ***********************/

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

function getFirstWordNormalized_(value) {
  return String(value || '').trim().toLowerCase().split(/[\s_-]+/).filter(Boolean)[0] || '';
}

function fetchClients_(loadedEntityConfiguration) {
  const loaded = loadedEntityConfiguration || loadJournalEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildJournalEntityAuthorizationMaps_(configuration);
  const payload = fetchJsonOrThrow_(JOURNAL_CONFIG.baseUrl + '/clients', '/clients');
  const clients = extractClientsArray_(payload);

  if (!clients.length) {
    throw new Error('The QBO /clients endpoint returned no clients. Journal Entries processing was stopped before BigQuery.');
  }

  const clientsById = {};
  let clientIdMatchCount = 0;
  let firstWordMatchCount = 0;

  clients.forEach(client => {
    const id = String(client.id || client.clientId || client.client_id || '').trim();
    const name = String(client.name || client.clientName || client.displayName || client.companyName || '').trim();
    if (!id || !name) return;

    const firstWord = getFirstWordNormalized_(name);
    const clientIdAlias = authorizationMaps.clientIdAliases[id] || '';
    const firstWordAlias = authorizationMaps.firstWordAliases[firstWord] || '';
    const entityAlias = clientIdAlias || firstWordAlias;
    if (!entityAlias) return;

    const authorizationMatchType = clientIdAlias ? 'client_id' : 'first_word';
    const authorizationMatchValue = clientIdAlias ? id : firstWord;
    if (authorizationMatchType === 'client_id') clientIdMatchCount++;
    else firstWordMatchCount++;

    clientsById[id] = {
      id,
      name,
      entity: String(client.entity || client.slug || entityAlias).trim(),
      entityAlias,
      firstWord,
      authorizationMatchType,
      authorizationMatchValue
    };
  });

  const filteredClientCount = Object.keys(clientsById).length;
  if (!filteredClientCount) {
    throw new Error(
      'No QBO clients matched the published Journal Entries entity configuration. ConfigurationVersion=' +
      configuration.configuration_version + '. Processing was stopped before BigQuery.'
    );
  }

  Logger.log(JSON.stringify({
    event: 'journal_clients_filtered',
    configurationSource: loaded.source,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    authorizationEntityCount: configuration.entities.length,
    sourceClientCount: clients.length,
    filteredClientCount,
    clientIdMatchCount,
    firstWordMatchCount
  }));

  return clientsById;
}

function buildJournalSnapshot_(loadedEntityConfigurationOverride) {
  const range = getPreviousCompletedWeekRange_();
  const loadedAt = new Date().toISOString();
  const loadedEntityConfiguration = normalizeJournalLoadedEntityConfiguration_(
    loadedEntityConfigurationOverride
  );
  const clients = getJournalSnapshotClients_(loadedEntityConfiguration);

  const lineRows = [];
  let transactionCount = 0;
  let accountingTransactionCount = 0;
  let totalDebitCents = 0;
  let totalCreditCents = 0;

  Logger.log('Filtered journal clients: ' + clients.length);

  clients.forEach(client => {
    const clientSnapshot = buildJournalClientSnapshot_(
      client,
      range,
      loadedAt
    );

    Array.prototype.push.apply(lineRows, clientSnapshot.lineRows);
    transactionCount += clientSnapshot.transactionCount;
    accountingTransactionCount += clientSnapshot.accountingTransactionCount;
    totalDebitCents += clientSnapshot.debitCents;
    totalCreditCents += clientSnapshot.creditCents;
  });

  sortJournalRows_(lineRows);
  validateJournalSnapshotIdentity_(lineRows);
  assertJournalBalanced_(
    totalDebitCents,
    totalCreditCents,
    'Combined journal snapshot'
  );

  return {
    entityConfiguration: buildJournalEntityConfigurationSummary_(
      loadedEntityConfiguration
    ),
    range,
    clientCount: clients.length,
    transactionCount,
    accountingTransactionCount,
    lineRows,
    totals: {
      debitAmount: centsToAmount_(totalDebitCents),
      creditAmount: centsToAmount_(totalCreditCents),
      netAmount: centsToAmount_(totalDebitCents - totalCreditCents)
    }
  };
}

function normalizeJournalLoadedEntityConfiguration_(loadedEntityConfigurationOverride) {
  if (!loadedEntityConfigurationOverride) {
    return loadJournalEntityConfiguration_();
  }

  return {
    source: String(
      loadedEntityConfigurationOverride.source ||
      'configuration_deployment'
    ),
    configuration: validateJournalEntityConfiguration_(
      loadedEntityConfigurationOverride.configuration
    )
  };
}

function getJournalSnapshotClients_(loadedEntityConfiguration) {
  const clientsById = fetchClients_(loadedEntityConfiguration);

  return Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) => {
      const entityDifference = String(left.entityAlias || '')
        .localeCompare(String(right.entityAlias || ''));
      return entityDifference ||
        String(left.name || '').localeCompare(String(right.name || ''));
    });
}

function buildJournalEntityConfigurationSummary_(loadedEntityConfiguration) {
  return {
    source: loadedEntityConfiguration.source,
    reportKey: loadedEntityConfiguration.configuration.report_key,
    configurationVersion:
      loadedEntityConfiguration.configuration.configuration_version,
    configurationHash:
      loadedEntityConfiguration.configuration.configuration_hash,
    publishedAt: loadedEntityConfiguration.configuration.published_at,
    authorizedEntityCount:
      loadedEntityConfiguration.configuration.entities.length
  };
}

function buildJournalClientSnapshot_(client, range, loadedAt) {
  if (!client || !String(client.id || '').trim()) {
    throw new Error('A valid Journal Entries client is required.');
  }

  Logger.log(
    'Fetching journal report for ' +
      client.name +
      ' [' +
      client.id +
      ']'
  );

  const journalReport = fetchJournalReport_(
    client.id,
    range.dateFrom,
    range.dateTo
  );
  const normalized = normalizeJournalReport_(journalReport);
  const lineRows = [];
  const transactionIds = {};
  let debitCents = 0;
  let creditCents = 0;

  normalized.rows.forEach(row => {
    lineRows.push(
      buildJournalSnapshotRow_(
        client,
        range,
        journalReport,
        row,
        loadedAt
      )
    );
    debitCents += row.debitCents;
    creditCents += row.creditCents;
    transactionIds[row.transactionId] = true;
  });

  sortJournalRows_(lineRows);
  validateJournalSnapshotIdentity_(lineRows);
  assertJournalBalanced_(
    debitCents,
    creditCents,
    'Journal client ' + client.name
  );

  const result = {
    client,
    transactionCount: normalized.transactionCount,
    accountingTransactionCount: Object.keys(transactionIds).length,
    lineRows,
    rowCount: lineRows.length,
    debitCents,
    creditCents
  };

  Logger.log(
    client.name +
      ': transactions=' +
      result.transactionCount +
      ', accountingTransactions=' +
      result.accountingTransactionCount +
      ', snapshotRows=' +
      result.rowCount
  );

  return result;
}

function buildJournalIdempotencyKey_(
  environment,
  clientId,
  snapshotWeek,
  transactionId,
  lineNumber
) {
  const parts = [
    'journal_entry',
    environment,
    clientId,
    snapshotWeek,
    transactionId,
    lineNumber
  ].map((value) =>
    String(value === null || value === undefined ? '' : value).trim()
  );
  if (parts.slice(1).some((value) => !value)) {
    throw new Error(
      'Unable to build Journal Entries idempotency key: ' +
        JSON.stringify({
          environment: environment,
          clientId: clientId,
          snapshotWeek: snapshotWeek,
          transactionId: transactionId,
          lineNumber: lineNumber
        })
    );
  }
  const canonicalKey = parts.join('|');
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    canonicalKey,
    Utilities.Charset.UTF_8
  );
  return digest
    .map((byte) => {
      const unsignedByte = byte < 0 ? byte + 256 : byte;
      return unsignedByte.toString(16).padStart(2, '0');
    })
    .join('');
}

function buildJournalSnapshotRow_(
  client,
  range,
  journalReport,
  row,
  loadedAt
) {
  const environment =
    stringOrNull_(journalReport.environment) ||
    JOURNAL_CONFIG.environment;
  return {
    idempotency_key: buildJournalIdempotencyKey_(
      environment,
      client.id,
      range.snapshotWeek,
      row.transactionId,
      row.lineNumber
    ),
    ReportType: JOURNAL_CONFIG.reportType,
    Entity: client.entityAlias,
    ClientName: client.name,
    ClientId: client.id,
    RealmId: stringOrNull_(journalReport.realmId),
    Environment: environment,
    SnapshotDate: range.snapshotDate,
    SnapshotWeek: range.snapshotWeek,
    DateFrom: range.dateFrom,
    DateTo: range.dateTo,
    LoadedAt: loadedAt,
    ReportTime: stringOrNull_(journalReport.reportTime),
    Currency:
      stringOrNull_(journalReport.currency) ||
      JOURNAL_CONFIG.currencyDefault,
    TransactionId: row.transactionId,
    TransactionDate: row.transactionDate,
    TransactionType: row.transactionType,
    DocumentNumber: row.documentNumber,
    NameId: row.nameId,
    Name: row.name,
    LocationId: row.locationId,
    LocationName: row.locationName,
    ClassId: row.classId,
    ClassName: row.className,
    LineNumber: row.lineNumber,
    AccountId: row.accountId,
    AccountName: row.accountName,
    MemoDescription: row.memoDescription,
    DebitAmount: row.debitAmount,
    CreditAmount: row.creditAmount,
    NetAmount: row.netAmount,
    Source: JOURNAL_CONFIG.sourceDefault
  };
}

function sortJournalRows_(rows) {
  rows.sort((a, b) => {
    const entityDiff = String(a.Entity || '').localeCompare(String(b.Entity || ''));
    if (entityDiff !== 0) {
      return entityDiff;
    }
    const clientDiff = String(a.ClientName || '').localeCompare(String(b.ClientName || ''));
    if (clientDiff !== 0) {
      return clientDiff;
    }
    const dateDiff = String(a.TransactionDate || '').localeCompare(String(b.TransactionDate || ''));
    if (dateDiff !== 0) {
      return dateDiff;
    }
    const transactionDiff = String(a.TransactionId || '').localeCompare(
      String(b.TransactionId || '')
    );
    if (transactionDiff !== 0) {
      return transactionDiff;
    }
    return Number(a.LineNumber || 0) - Number(b.LineNumber || 0);
  });
}

function validateJournalSnapshotIdentity_(rows) {
  const identities = new Set();
  rows.forEach((row, index) => {
    const identity = String(row.idempotency_key || '').trim();
    if (!identity) {
      throw new Error(
        'Journal snapshot row does not contain idempotency_key at row ' + index
      );
    }
    if (identities.has(identity)) {
      throw new Error(
        'Duplicate Journal Entries idempotency_key detected at row ' +
          index +
          ': ' +
          identity
      );
    }
    identities.add(identity);
  });
}

/***********************
 * BigQuery Schema Validation
 ***********************/

function validateJournalBigQuerySchema_() {
  const duplicateNames = JOURNAL_EXPORT_COLUMNS.filter(
    (name, index) => JOURNAL_EXPORT_COLUMNS.indexOf(name) !== index
  );
  if (duplicateNames.length) {
    throw new Error(
      'Duplicate Journal Entries schema columns detected: ' + duplicateNames.join(', ')
    );
  }
  let table;
  try {
    table = BigQuery.Tables.get(
      BQ_CONFIG.projectId,
      BQ_CONFIG.rawDatasetId,
      BQ_CONFIG.snapshotsTableId
    );
  } catch (error) {
    throw new Error(
      'Unable to read Journal Entries BigQuery table ' +
        JOURNAL_BIGQUERY_TABLE +
        ': ' +
        String(error)
    );
  }
  const actualFields =
    table.schema && Array.isArray(table.schema.fields) ? table.schema.fields : [];
  const actualNames = actualFields.map((field) => String(field.name || ''));
  const missingColumns = JOURNAL_EXPORT_COLUMNS.filter((name) => !actualNames.includes(name));
  const unexpectedColumns = actualNames.filter((name) => !JOURNAL_EXPORT_COLUMNS.includes(name));
  const fieldMismatches = [];
  JOURNAL_BIGQUERY_SCHEMA.forEach((expected, index) => {
    const actual = actualFields[index];
    if (!actual) {
      fieldMismatches.push({ index, expected, actual: null });
      return;
    }
    const definition = {
      name: String(actual.name || ''),
      type: String(actual.type || '').toUpperCase(),
      mode: String(actual.mode || 'NULLABLE').toUpperCase()
    };
    if (
      definition.name !== expected.name ||
      definition.type !== expected.type ||
      definition.mode !== expected.mode
    ) {
      fieldMismatches.push({ index, expected, actual: definition });
    }
  });
  for (let index = JOURNAL_BIGQUERY_SCHEMA.length; index < actualFields.length; index++) {
    const actual = actualFields[index];
    fieldMismatches.push({
      index,
      expected: null,
      actual: {
        name: String(actual.name || ''),
        type: String(actual.type || '').toUpperCase(),
        mode: String(actual.mode || 'NULLABLE').toUpperCase()
      }
    });
  }
  const actualPartitionField = String(
    (table.timePartitioning && table.timePartitioning.field) || ''
  ).trim();
  const actualPartitionType = String(
    (table.timePartitioning && table.timePartitioning.type) || ''
  ).toUpperCase();
  const partitionMatches =
    actualPartitionField === JOURNAL_BIGQUERY_PARTITION_FIELD && actualPartitionType === 'DAY';
  const actualClusterFields =
    table.clustering && Array.isArray(table.clustering.fields)
      ? table.clustering.fields.map(String)
      : [];
  const clusterMatches =
    JOURNAL_BIGQUERY_CLUSTER_FIELDS.length === actualClusterFields.length &&
    JOURNAL_BIGQUERY_CLUSTER_FIELDS.every((field, index) => actualClusterFields[index] === field);
  if (
    missingColumns.length ||
    unexpectedColumns.length ||
    fieldMismatches.length ||
    !partitionMatches ||
    !clusterMatches
  ) {
    throw new Error(
      'Journal Entries BigQuery schema mismatch. ' +
        JSON.stringify({
          table: JOURNAL_BIGQUERY_TABLE,
          missingColumns,
          unexpectedColumns,
          fieldMismatches,
          partition: {
            expectedField: JOURNAL_BIGQUERY_PARTITION_FIELD,
            expectedType: 'DAY',
            actualField: actualPartitionField,
            actualType: actualPartitionType,
            matches: partitionMatches
          },
          clustering: {
            expected: JOURNAL_BIGQUERY_CLUSTER_FIELDS,
            actual: actualClusterFields,
            matches: clusterMatches
          }
        })
    );
  }
  return {
    status: 'passed',
    table: JOURNAL_BIGQUERY_TABLE,
    expectedColumnCount: JOURNAL_BIGQUERY_SCHEMA.length,
    actualColumnCount: actualFields.length,
    orderMatches: true,
    typesMatch: true,
    modesMatch: true,
    partition: { field: actualPartitionField, type: actualPartitionType },
    clustering: actualClusterFields
  };
}

/***********************
 * BigQuery Row Validation
 ***********************/

function validateJournalBigQueryRow_(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('Journal row ' + index + ' is not a valid object.');
  }
  const missingRequired = JOURNAL_REQUIRED_EXPORT_COLUMNS.filter((column) => {
    const value = row[column];
    return value === null || value === undefined || String(value).trim() === '';
  });
  if (missingRequired.length) {
    throw new Error(
      'Journal row ' + index + ' is missing required fields: ' + missingRequired.join(', ')
    );
  }
  JOURNAL_DATE_COLUMNS.forEach((column) => {
    const value = row[column];
    if (
      value !== null &&
      value !== undefined &&
      value !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ) {
      throw new Error(
        'Journal row ' + index + ' contains an invalid date in ' + column + ': ' + value
      );
    }
  });
  JOURNAL_TIMESTAMP_COLUMNS.forEach((column) => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && isNaN(new Date(value).getTime())) {
      throw new Error(
        'Journal row ' + index + ' contains an invalid timestamp in ' + column + ': ' + value
      );
    }
  });
  JOURNAL_NUMERIC_COLUMNS.forEach((column) => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && !Number.isFinite(Number(value))) {
      throw new Error(
        'Journal row ' + index + ' contains an invalid number in ' + column + ': ' + value
      );
    }
  });
  const lineNumber = Number(row.LineNumber);
  if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
    throw new Error('Journal row ' + index + ' contains an invalid LineNumber: ' + row.LineNumber);
  }
  const expectedIdempotencyKey = buildJournalIdempotencyKey_(
    row.Environment,
    row.ClientId,
    row.SnapshotWeek,
    row.TransactionId,
    lineNumber
  );
  if (String(row.idempotency_key || '').trim() !== expectedIdempotencyKey) {
    throw new Error(
      'Journal row ' +
        index +
        ' contains an inconsistent idempotency_key. Expected=' +
        expectedIdempotencyKey +
        ', actual=' +
        row.idempotency_key
    );
  }
  const debitCents = Math.round(Number(row.DebitAmount) * 100);
  const creditCents = Math.round(Number(row.CreditAmount) * 100);
  const netCents = Math.round(Number(row.NetAmount) * 100);
  if (Math.abs(netCents - (debitCents - creditCents)) > JOURNAL_BALANCE_TOLERANCE_CENTS) {
    throw new Error(
      'Journal row ' +
        index +
        ' contains an inconsistent NetAmount. DebitAmount=' +
        row.DebitAmount +
        ', CreditAmount=' +
        row.CreditAmount +
        ', NetAmount=' +
        row.NetAmount
    );
  }
}

/***********************
 * BigQuery Load and Verification
 ***********************/

function replaceJournalSnapshotPartition_(range, rows) {
  const snapshotWeek = String((range && range.snapshotWeek) || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotWeek)) {
    throw new Error(
      'Invalid SnapshotWeek for Journal Entries partition replacement: ' + snapshotWeek
    );
  }
  if (!Array.isArray(rows)) throw new Error('Journal snapshot rows must be an array.');
  rows.forEach((row, index) => {
    if (String(row.SnapshotWeek || '') !== snapshotWeek) {
      throw new Error(
        'Journal row ' +
          index +
          ' belongs to a different partition. Expected=' +
          snapshotWeek +
          ', actual=' +
          row.SnapshotWeek
      );
    }
  });
  if (!rows.length) return clearEmptyJournalPartition_(snapshotWeek);
  const preparedRows = rows.map((row, index) => {
    validateJournalBigQueryRow_(row, index);
    return JOURNAL_EXPORT_COLUMNS.reduce((json, column) => {
      json[column] = row[column] === undefined ? null : row[column];
      return json;
    }, {});
  });
  const ndjson = preparedRows.map(JSON.stringify).join('\n');
  const partitionId = snapshotWeek.replace(/-/g, '');
  const destinationTableId = BQ_CONFIG.snapshotsTableId + '$' + partitionId;
  const jobId = [
    'journal_snapshot',
    partitionId,
    Date.now(),
    Utilities.getUuid().replace(/-/g, '')
  ].join('_');
  const blob = Utilities.newBlob(
    ndjson,
    'application/octet-stream',
    'journal_snapshot_' + partitionId + '.ndjson'
  );
  const insertedJob = BigQuery.Jobs.insert(
    {
      jobReference: { projectId: BQ_CONFIG.projectId, jobId },
      configuration: {
        load: {
          destinationTable: {
            projectId: BQ_CONFIG.projectId,
            datasetId: BQ_CONFIG.rawDatasetId,
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
    },
    BQ_CONFIG.projectId,
    blob
  );
  if (!insertedJob || !insertedJob.jobReference) {
    throw new Error('BigQuery did not return a job reference for the Journal Entries load.');
  }
  const completedJob = waitForBigQueryJob_(insertedJob.jobReference, 120000);
  const outputRows =
    completedJob.statistics &&
    completedJob.statistics.load &&
    completedJob.statistics.load.outputRows !== undefined
      ? Number(completedJob.statistics.load.outputRows)
      : null;
  return {
    mode: 'partition_replace',
    jobId: completedJob.jobReference.jobId,
    destinationTable: [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, destinationTableId].join('.'),
    snapshotWeek,
    partitionId,
    rowCount: rows.length,
    outputRows,
    payloadBytes: blob.getBytes().length,
    state: completedJob.status.state
  };
}


function buildJournalBigQueryJobId_(
  prefix,
  operationId,
  snapshotWeek,
  clientId
) {
  const normalizedPrefix = String(prefix || 'journal_job')
    .replace(/[^A-Za-z0-9_]/g, '_');
  const normalizedOperationId = String(operationId || '')
    .replace(/[^A-Za-z0-9]/g, '');
  const normalizedSnapshotWeek = String(snapshotWeek || '')
    .replace(/[^0-9]/g, '');
  const normalizedClientId = String(clientId || '')
    .replace(/[^A-Za-z0-9]/g, '');

  return [
    normalizedPrefix,
    normalizedSnapshotWeek,
    normalizedOperationId,
    normalizedClientId
  ].filter(Boolean).join('_').slice(0, 900);
}

function escapeJournalBigQueryString_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

function getJournalBigQueryJobIfExists_(jobId) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) return null;

  try {
    return BigQuery.Jobs.get(
      BQ_CONFIG.projectId,
      normalizedJobId
    );
  } catch (error) {
    const message = String(
      error && error.message || error
    ).toLowerCase();

    if (
      message.includes('not found') ||
      message.includes('404')
    ) {
      return null;
    }

    throw error;
  }
}

function assertJournalBigQueryJobSucceeded_(job) {
  if (!job || !job.status || job.status.state !== 'DONE') {
    throw new Error(
      'Journal Entries BigQuery job is not complete.'
    );
  }

  if (job.status.errorResult) {
    throw new Error(
      'BigQuery job failed: ' +
        JSON.stringify({
          jobId:
            job.jobReference &&
            job.jobReference.jobId ||
            null,
          errorResult: job.status.errorResult,
          errors: job.status.errors || []
        })
    );
  }

  return job;
}

function waitForJournalBigQueryJobOrYield_(
  jobId,
  timeoutMs
) {
  const startedAt = Date.now();
  const waitLimitMs = Math.max(
    1000,
    Number(timeoutMs || 30000)
  );

  while (Date.now() - startedAt < waitLimitMs) {
    const job = getJournalBigQueryJobIfExists_(jobId);

    if (!job) {
      return {
        done: false,
        missing: true,
        job: null
      };
    }

    if (job.status && job.status.state === 'DONE') {
      assertJournalBigQueryJobSucceeded_(job);
      return {
        done: true,
        missing: false,
        job
      };
    }

    Utilities.sleep(1000);
  }

  return {
    done: false,
    missing: false,
    job: getJournalBigQueryJobIfExists_(jobId)
  };
}

function ensureJournalBigQueryQueryJob_(
  jobId,
  query
) {
  let job = getJournalBigQueryJobIfExists_(jobId);

  if (!job) {
    try {
      job = BigQuery.Jobs.insert(
        {
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
        },
        BQ_CONFIG.projectId
      );
    } catch (error) {
      job = getJournalBigQueryJobIfExists_(jobId);
      if (!job) throw error;
    }
  }

  return waitForJournalBigQueryJobOrYield_(
    jobId,
    JOURNAL_OPERATIONAL_DEPLOYMENT.bigQueryJobWaitMs
  );
}

function ensureJournalBigQueryLoadJob_(
  jobId,
  snapshotWeek,
  rows
) {
  let job = getJournalBigQueryJobIfExists_(jobId);

  if (!job) {
    if (!Array.isArray(rows) || !rows.length) {
      throw new Error(
        'Journal Entries rows are required to submit load job ' +
          jobId
      );
    }

    const preparedRows = rows.map((row, index) => {
      validateJournalBigQueryRow_(row, index);

      if (
        String(row.SnapshotWeek || '') !==
        String(snapshotWeek || '')
      ) {
        throw new Error(
          'Journal Entries client row belongs to a different partition. Expected=' +
            snapshotWeek +
            ', actual=' +
            row.SnapshotWeek
        );
      }

      return JOURNAL_EXPORT_COLUMNS.reduce(
        (json, column) => {
          json[column] =
            row[column] === undefined
              ? null
              : row[column];
          return json;
        },
        {}
      );
    });

    const partitionId = String(snapshotWeek)
      .replace(/-/g, '');
    const destinationTableId =
      BQ_CONFIG.snapshotsTableId +
      '$' +
      partitionId;
    const blob = Utilities.newBlob(
      preparedRows.map(JSON.stringify).join('\n'),
      'application/octet-stream',
      'journal_client_' +
        partitionId +
        '.ndjson'
    );

    try {
      job = BigQuery.Jobs.insert(
        {
          jobReference: {
            projectId: BQ_CONFIG.projectId,
            jobId
          },
          configuration: {
            load: {
              destinationTable: {
                projectId: BQ_CONFIG.projectId,
                datasetId: BQ_CONFIG.rawDatasetId,
                tableId: destinationTableId
              },
              sourceFormat: 'NEWLINE_DELIMITED_JSON',
              createDisposition: 'CREATE_NEVER',
              writeDisposition: 'WRITE_APPEND',
              autodetect: false,
              ignoreUnknownValues: false,
              maxBadRecords: 0
            }
          }
        },
        BQ_CONFIG.projectId,
        blob
      );
    } catch (error) {
      job = getJournalBigQueryJobIfExists_(jobId);
      if (!job) throw error;
    }
  }

  return waitForJournalBigQueryJobOrYield_(
    jobId,
    JOURNAL_OPERATIONAL_DEPLOYMENT.bigQueryJobWaitMs
  );
}

function buildJournalPartitionClearQuery_(snapshotWeek) {
  return [
    'DELETE FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek = DATE '" +
      escapeJournalBigQueryString_(snapshotWeek) +
      "'"
  ].join('\n');
}

function buildJournalClientDeleteQuery_(
  snapshotWeek,
  clientId
) {
  return [
    'DELETE FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek = DATE '" +
      escapeJournalBigQueryString_(snapshotWeek) +
      "'",
    "  AND ClientId = '" +
      escapeJournalBigQueryString_(clientId) +
      "'"
  ].join('\n');
}

function waitForBigQueryJob_(jobReference, timeoutMs) {
  if (!jobReference || !jobReference.jobId) {
    throw new Error('A valid BigQuery job reference is required.');
  }
  const projectId = jobReference.projectId || BQ_CONFIG.projectId;
  const jobId = jobReference.jobId;
  const startedAt = Date.now();
  let job = null;
  while (true) {
    job = BigQuery.Jobs.get(projectId, jobId);
    if (job.status && job.status.state === 'DONE') {
      break;
    }
    if (Date.now() - startedAt > Number(timeoutMs || 120000)) {
      throw new Error('BigQuery job timed out: ' + jobId);
    }
    Utilities.sleep(1000);
  }
  if (job.status && job.status.errorResult) {
    throw new Error(
      'BigQuery job failed: ' +
        JSON.stringify({
          jobId: jobId,
          errorResult: job.status.errorResult,
          errors: job.status.errors || []
        })
    );
  }
  return job;
}

function verifyJournalSnapshotPartition_(snapshotWeek, expectedRowCount) {
  return verifyJournalSnapshotPartitionDetailed_(
    snapshotWeek,
    {
      rowCount: expectedRowCount
    }
  );
}

function verifyJournalSnapshotPartitionDetailed_(
  snapshotWeek,
  expected
) {
  const normalizedSnapshotWeek = String(snapshotWeek || '').trim();
  const expectedValues = expected || {};
  const expectedRowCount = Number(expectedValues.rowCount);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedSnapshotWeek)) {
    throw new Error(
      'Invalid SnapshotWeek for Journal Entries partition verification: ' +
        normalizedSnapshotWeek
    );
  }

  if (
    !Number.isInteger(expectedRowCount) ||
    expectedRowCount < 0
  ) {
    throw new Error(
      'Invalid expected Journal Entries row count: ' +
        expectedValues.rowCount
    );
  }

  const result = runBigQueryQuery_(
    [
      'SELECT',
      '  COUNT(*) AS row_count,',
      '  COUNTIF(',
      '    idempotency_key IS NULL',
      "    OR TRIM(idempotency_key) = ''",
      '  ) AS missing_key_count,',
      '  COUNT(DISTINCT idempotency_key) AS unique_key_count,',
      "  COUNT(DISTINCT CONCAT(ClientId, '|', TransactionId)) AS transaction_count,",
      '  CAST(ROUND(COALESCE(SUM(DebitAmount), 0) * 100) AS INT64) AS debit_cents,',
      '  CAST(ROUND(COALESCE(SUM(CreditAmount), 0) * 100) AS INT64) AS credit_cents',
      'FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
      "WHERE SnapshotWeek = DATE '" + normalizedSnapshotWeek + "'"
    ].join('\n')
  );

  const values =
    result.rows && result.rows.length
      ? result.rows[0].f
      : [];

  const actualRowCount = Number(values[0] ? values[0].v : 0);
  const missingKeyCount = Number(values[1] ? values[1].v : 0);
  const uniqueKeyCount = Number(values[2] ? values[2].v : 0);
  const actualTransactionCount = Number(values[3] ? values[3].v : 0);
  const actualDebitCents = Number(values[4] ? values[4].v : 0);
  const actualCreditCents = Number(values[5] ? values[5].v : 0);

  if (actualRowCount !== expectedRowCount) {
    throw new Error(
      'Journal Entries partition row count mismatch. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', expected=' +
        expectedRowCount +
        ', actual=' +
        actualRowCount
    );
  }

  if (missingKeyCount !== 0) {
    throw new Error(
      'Journal Entries partition contains rows without idempotency_key. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', missing=' +
        missingKeyCount
    );
  }

  if (uniqueKeyCount !== actualRowCount) {
    throw new Error(
      'Journal Entries partition contains duplicate idempotency_key values. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', rows=' +
        actualRowCount +
        ', uniqueKeys=' +
        uniqueKeyCount
    );
  }

  if (
    expectedValues.accountingTransactionCount !== undefined &&
    actualTransactionCount !==
      Number(expectedValues.accountingTransactionCount)
  ) {
    throw new Error(
      'Journal Entries partition transaction count mismatch. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', expected=' +
        expectedValues.accountingTransactionCount +
        ', actual=' +
        actualTransactionCount
    );
  }

  if (
    expectedValues.debitCents !== undefined &&
    actualDebitCents !== Number(expectedValues.debitCents)
  ) {
    throw new Error(
      'Journal Entries partition debit total mismatch. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', expected=' +
        centsToAmount_(expectedValues.debitCents) +
        ', actual=' +
        centsToAmount_(actualDebitCents)
    );
  }

  if (
    expectedValues.creditCents !== undefined &&
    actualCreditCents !== Number(expectedValues.creditCents)
  ) {
    throw new Error(
      'Journal Entries partition credit total mismatch. SnapshotWeek=' +
        normalizedSnapshotWeek +
        ', expected=' +
        centsToAmount_(expectedValues.creditCents) +
        ', actual=' +
        centsToAmount_(actualCreditCents)
    );
  }

  assertJournalBalanced_(
    actualDebitCents,
    actualCreditCents,
    'Journal Entries BigQuery partition ' +
      normalizedSnapshotWeek
  );

  return {
    status: 'passed',
    snapshotWeek: normalizedSnapshotWeek,
    partitionId: normalizedSnapshotWeek.replace(/-/g, ''),
    expectedRowCount,
    actualRowCount,
    missingKeyCount,
    uniqueKeyCount,
    expectedAccountingTransactionCount:
      expectedValues.accountingTransactionCount === undefined
        ? null
        : Number(expectedValues.accountingTransactionCount),
    actualAccountingTransactionCount: actualTransactionCount,
    expectedDebitAmount:
      expectedValues.debitCents === undefined
        ? null
        : centsToAmount_(expectedValues.debitCents),
    actualDebitAmount: centsToAmount_(actualDebitCents),
    expectedCreditAmount:
      expectedValues.creditCents === undefined
        ? null
        : centsToAmount_(expectedValues.creditCents),
    actualCreditAmount: centsToAmount_(actualCreditCents)
  };
}

function runBigQueryQuery_(query) {
  let result = BigQuery.Jobs.query(
    { query, useLegacySql: false, timeoutMs: 120000 },
    BQ_CONFIG.projectId
  );
  if (!result || !result.jobReference) {
    throw new Error('BigQuery did not return a query job reference.');
  }
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

function clearEmptyJournalPartition_(snapshotWeek) {
  const normalizedSnapshotWeek = String(snapshotWeek || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedSnapshotWeek)) {
    throw new Error(
      'Invalid SnapshotWeek for empty Journal Entries partition: ' + normalizedSnapshotWeek
    );
  }
  const result = runBigQueryQuery_(
    [
      'DELETE FROM `' + JOURNAL_BIGQUERY_TABLE + '`',
      "WHERE SnapshotWeek = DATE '" + normalizedSnapshotWeek + "'"
    ].join('\n')
  );
  return {
    mode: 'empty_partition_clear',
    jobId: result.jobReference.jobId,
    destinationTable: JOURNAL_BIGQUERY_TABLE,
    snapshotWeek: normalizedSnapshotWeek,
    rowCount: 0,
    state: 'DONE'
  };
}

/***********************
 * Shared Helpers
 ***********************/

function stringOrNull_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}
