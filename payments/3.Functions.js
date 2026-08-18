/***********************
 * Production Entry Point
 ***********************/

function snapshotPaymentsToBigQuery() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another Payments snapshot or deployment execution is already running.');
  }

  try {
    return executePaymentBigQuerySnapshot_();
  } finally {
    lock.releaseLock();
  }
}

function executePaymentBigQuerySnapshot_(loadedEntityConfiguration) {
  Logger.log('--- PAYMENT BIGQUERY SNAPSHOT START ---');
  const schemaValidation = validatePaymentBigQuerySchema_();
  const result = buildPaymentSnapshot_(loadedEntityConfiguration);
  const loadResult = replacePaymentSnapshotPartition_(result.range, result.rows);
  const verification = verifyPaymentSnapshotPartition_(result.range.snapshotWeek, result.hierarchyValidation);
  const executionResult = {
    entityConfiguration: result.entityConfiguration,
    schemaValidation,
    period: result.range,
    clientCount: result.clientCount,
    sourcePaymentCount: result.sourcePaymentCount,
    paymentCount: result.paymentCount,
    pageCount: result.pageCount,
    sourceRowCount: result.rows.length,
    hierarchyValidation: result.hierarchyValidation,
    schemaMonitoring: result.schemaMonitoring,
    baselinePersistence: result.baselinePersistence,
    loadResult,
    verification
  };
  Logger.log(JSON.stringify(executionResult, null, 2));
  Logger.log('--- PAYMENT BIGQUERY SNAPSHOT END ---');
  return {
    entityConfiguration: result.entityConfiguration,
    period: result.range,
    clientCount: result.clientCount,
    paymentCount: result.paymentCount,
    rowCount: result.rows.length,
    headerRowCount: result.hierarchyValidation.headerRowCount,
    lineRowCount: result.hierarchyValidation.lineRowCount,
    jobId: loadResult.jobId,
    verification
  };
}

/***********************
 * Central Entity Configuration
 ***********************/

function loadPaymentEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(PAYMENT_ENTITY_CONTROL.cacheKey);

  if (cachedValue) {
    try {
      return { source: 'script_cache', configuration: validatePaymentEntityConfiguration_(JSON.parse(cachedValue)) };
    } catch (error) {
      Logger.log(JSON.stringify({ event: 'payment_entity_configuration_cache_invalid', error: error.message }));
      cache.remove(PAYMENT_ENTITY_CONTROL.cacheKey);
    }
  }

  const localConfiguration = readLocalPaymentEntityConfiguration_();
  if (!localConfiguration) {
    throw new Error(
      'No valid local Payments entity configuration is available. ' +
      'Publish the centralized configuration again or run debugRefreshPaymentEntityConfigurationFromCentral().'
    );
  }

  cachePaymentEntityConfiguration_(localConfiguration);
  return { source: 'script_properties', configuration: localConfiguration };
}

function refreshPaymentEntityConfigurationFromCentral_() {
  const spreadsheet = getPaymentControlSpreadsheet_();
  const metadata = readPaymentCentralMetadata_(spreadsheet);
  const configuration = readPublishedPaymentConfiguration_(spreadsheet, metadata.currentVersion);
  const persistence = persistPaymentEntityConfiguration_(configuration);
  cachePaymentEntityConfiguration_(configuration);

  Logger.log(JSON.stringify({
    event: 'payment_entity_configuration_refreshed_manually',
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return { source: 'central_sheet_manual', configuration, persistence };
}

function getPaymentControlSpreadsheet_() {
  const spreadsheetId = String(PropertiesService.getScriptProperties()
    .getProperty(PAYMENT_ENTITY_CONTROL.spreadsheetIdProperty) || '').trim();

  if (!spreadsheetId) {
    throw new Error('Missing Script Property: ' + PAYMENT_ENTITY_CONTROL.spreadsheetIdProperty);
  }

  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw new Error(
      'Unable to open the QBO control spreadsheet. Property=' +
      PAYMENT_ENTITY_CONTROL.spreadsheetIdProperty + ', error=' + error.message
    );
  }
}

function readPaymentCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(PAYMENT_ENTITY_CONTROL.metadataSheetName);
  if (!sheet) throw new Error('Central metadata sheet not found: ' + PAYMENT_ENTITY_CONTROL.metadataSheetName);

  assertPaymentControlHeaders_(sheet, ['Key', 'Value', 'Updated At']);
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

function readPublishedPaymentConfiguration_(spreadsheet, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(PAYMENT_ENTITY_CONTROL.publishedSheetName);
  if (!sheet) {
    throw new Error('Published configuration sheet not found: ' + PAYMENT_ENTITY_CONTROL.publishedSheetName);
  }

  const expectedHeaders = [
    'Report Key', 'Report Name', 'Configuration Version', 'Configuration Hash',
    'Published At', 'Entity Count', 'Configuration JSON'
  ];
  assertPaymentControlHeaders_(sheet, expectedHeaders);
  if (sheet.getLastRow() < 2) throw new Error('Published configuration sheet is empty.');

  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, expectedHeaders.length).getValues();
  const reportRow = rows.find(row => String(row[0] || '').trim() === PAYMENT_ENTITY_CONTROL.reportKey);
  if (!reportRow) {
    throw new Error('No published configuration was found for report_key=' + PAYMENT_ENTITY_CONTROL.reportKey);
  }

  const rowVersion = Number(reportRow[2] || 0);
  const rowHash = String(reportRow[3] || '').trim();
  const entityCount = Number(reportRow[5] || 0);
  const configurationJson = String(reportRow[6] || '').trim();

  if (rowVersion !== Number(expectedVersion)) {
    throw new Error('Published Payments configuration version mismatch. Expected=' + expectedVersion + ', actual=' + rowVersion);
  }
  if (!configurationJson) throw new Error('Published Payments configuration JSON is empty.');

  let configuration;
  try {
    configuration = JSON.parse(configurationJson);
  } catch (error) {
    throw new Error('Published Payments configuration contains invalid JSON: ' + error.message);
  }

  const validated = validatePaymentEntityConfiguration_(configuration, expectedVersion);
  if (validated.configuration_hash !== rowHash) {
    throw new Error('Published Payments configuration hash does not match its row hash.');
  }
  if (validated.entities.length !== entityCount) {
    throw new Error('Published Payments entity count mismatch. Expected=' + entityCount + ', actual=' + validated.entities.length);
  }

  return validated;
}

function validatePaymentEntityConfiguration_(configuration, expectedVersion) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Payments entity configuration must be a JSON object.');
  }

  const contractType = String(configuration.contract_type || '').trim();
  const contractVersion = String(configuration.contract_version || '').trim();
  const schemaVersion = String(configuration.schema_version || '').trim();
  const reportKey = String(configuration.report_key || '').trim();
  const configurationVersion = Number(configuration.configuration_version || 0);
  const configurationHash = String(configuration.configuration_hash || '').trim().toLowerCase();

  if (contractType !== PAYMENT_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected entity configuration contract_type: ' + contractType);
  }
  if (contractVersion !== PAYMENT_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected entity configuration contract_version: ' + contractVersion);
  }
  if (schemaVersion !== PAYMENT_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected entity configuration schema_version: ' + schemaVersion);
  }
  if (reportKey !== PAYMENT_ENTITY_CONTROL.reportKey) {
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
    throw new Error('Payments entity configuration contains no authorized entities.');
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

function persistPaymentEntityConfiguration_(configuration) {
  const serialized = JSON.stringify(configuration);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PAYMENT_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Payments entity configuration exceeds the safe Script Property size. bytes=' +
      byteCount + ', maximum=' + PAYMENT_ENTITY_CONTROL.maxPropertyBytes
    );
  }

  PropertiesService.getScriptProperties().setProperty(PAYMENT_ENTITY_CONTROL.localPropertyKey, serialized);
  return { propertyKey: PAYMENT_ENTITY_CONTROL.localPropertyKey, byteCount };
}

function cachePaymentEntityConfiguration_(configuration) {
  CacheService.getScriptCache().put(
    PAYMENT_ENTITY_CONTROL.cacheKey,
    JSON.stringify(configuration),
    PAYMENT_ENTITY_CONTROL.cacheTtlSeconds
  );
}

function buildPaymentEntityAuthorizationMaps_(configuration) {
  const firstWordAliases = {};
  const clientIdAliases = {};
  configuration.entities.forEach(entity => {
    if (entity.match_type === 'first_word') firstWordAliases[entity.match_value] = entity.entity_alias;
    else if (entity.match_type === 'client_id') clientIdAliases[entity.match_value] = entity.entity_alias;
  });
  return { firstWordAliases, clientIdAliases };
}

function assertPaymentControlHeaders_(sheet, expectedHeaders) {
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
    response = handlePaymentEntityConfigurationPush_(e);
  } catch (error) {
    response = { success: false, status: 'rejected', reportKey: PAYMENT_ENTITY_CONTROL.reportKey, error: error.message };
    Logger.log(JSON.stringify({ event: 'payment_entity_configuration_push_rejected', error: error.message }));
  }
  return createPaymentJsonResponse_(response);
}

function handlePaymentEntityConfigurationPush_(e) {
  const rawBody = String(e && e.postData && e.postData.contents || '').trim();
  if (!rawBody) throw new Error('Push request body is empty.');

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Push request contains invalid envelope JSON: ' + error.message);
  }

  validatePaymentPushEnvelope_(envelope);
  const secret = getPaymentEntityPushSecret_();
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

  validatePaymentPushPayload_(pushPayload);
  const configuration = validatePaymentEntityConfiguration_(
    pushPayload.configuration,
    Number(pushPayload.configuration_version)
  );

  if (configuration.configuration_hash !== String(pushPayload.configuration_hash || '').trim().toLowerCase()) {
    throw new Error('Push payload configuration hash does not match the embedded configuration.');
  }

  const lock = LockService.getUserLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Unable to acquire the Payments configuration request lock.');
  }

  try {
    return applyPaymentPushedConfiguration_(pushPayload, configuration);
  } finally {
    lock.releaseLock();
  }
}

function validatePaymentPushEnvelope_(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Push envelope must be a JSON object.');
  }

  const contractType = String(envelope.contract_type || '').trim();
  const contractVersion = String(envelope.contract_version || '').trim();
  const payload = String(envelope.payload || '').trim();
  const signature = String(envelope.signature || '').trim().toLowerCase();

  if (contractType !== PAYMENT_ENTITY_CONTROL.pushEnvelopeContractType) {
    throw new Error('Unexpected push envelope contract_type: ' + contractType);
  }
  if (contractVersion !== PAYMENT_ENTITY_CONTROL.pushEnvelopeContractVersion) {
    throw new Error('Unexpected push envelope contract_version: ' + contractVersion);
  }
  if (!payload) throw new Error('Push envelope payload is empty.');
  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Push envelope signature must be a SHA-256 hex value.');
  }
}

function validatePaymentPushPayload_(payload) {
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

  if (contractType !== PAYMENT_ENTITY_CONTROL.pushContractType) {
    throw new Error('Unexpected push payload contract_type: ' + contractType);
  }
  if (contractVersion !== PAYMENT_ENTITY_CONTROL.pushContractVersion) {
    throw new Error('Unexpected push payload contract_version: ' + contractVersion);
  }
  if (!requestId) throw new Error('Push payload is missing request_id.');
  if (reportKey !== PAYMENT_ENTITY_CONTROL.reportKey) {
    throw new Error('Push payload was sent to the wrong report. Expected=' + PAYMENT_ENTITY_CONTROL.reportKey + ', actual=' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Push payload contains an invalid configuration version.');
  }
  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error('Push payload contains an invalid configuration hash.');
  }
  if (!Number.isFinite(sentAtMilliseconds)) throw new Error('Push payload contains an invalid sent_at value.');

  const ageSeconds = (Date.now() - sentAtMilliseconds) / 1000;
  if (ageSeconds > PAYMENT_ENTITY_CONTROL.pushMaxAgeSeconds) {
    throw new Error('Push payload has expired. AgeSeconds=' + Math.floor(ageSeconds));
  }
  if (ageSeconds < -PAYMENT_ENTITY_CONTROL.pushFutureToleranceSeconds) {
    throw new Error('Push payload sent_at is too far in the future.');
  }
  if (!payload.configuration || typeof payload.configuration !== 'object' || Array.isArray(payload.configuration)) {
    throw new Error('Push payload is missing the configuration object.');
  }
}

function applyPaymentPushedConfiguration_(pushPayload, incomingConfiguration) {
  const localConfiguration = readLocalPaymentEntityConfiguration_();

  if (localConfiguration) {
    const localVersion = localConfiguration.configuration_version;
    const incomingVersion = incomingConfiguration.configuration_version;

    if (incomingVersion < localVersion) {
      const receipt = persistPaymentPushReceipt_(pushPayload, incomingConfiguration, 'stale_ignored');
      return {
        success: true,
        status: 'stale_ignored',
        reportKey: PAYMENT_ENTITY_CONTROL.reportKey,
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

      cachePaymentEntityConfiguration_(incomingConfiguration);
      const deployment = queuePaymentConfigurationDeployment_(pushPayload, incomingConfiguration);
      const responseStatus = deployment.queued ? 'queued' : 'idempotent';
      const receipt = persistPaymentPushReceipt_(pushPayload, incomingConfiguration, responseStatus, deployment);
      return {
        success: true,
        status: responseStatus,
        reportKey: PAYMENT_ENTITY_CONTROL.reportKey,
        configurationVersion: incomingVersion,
        configurationHash: incomingConfiguration.configuration_hash,
        operationId: deployment.operationId,
        deploymentStatus: deployment.status,
        currentStage: deployment.currentStage,
        receipt
      };
    }
  }

  const persistence = persistPaymentEntityConfiguration_(incomingConfiguration);
  cachePaymentEntityConfiguration_(incomingConfiguration);
  const deployment = queuePaymentConfigurationDeployment_(pushPayload, incomingConfiguration);
  const receipt = persistPaymentPushReceipt_(pushPayload, incomingConfiguration, 'queued', deployment);

  Logger.log(JSON.stringify({
    event: 'payment_entity_configuration_push_queued',
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
    reportKey: PAYMENT_ENTITY_CONTROL.reportKey,
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

function readLocalPaymentEntityConfiguration_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(PAYMENT_ENTITY_CONTROL.localPropertyKey);
  if (!serialized) return null;

  try {
    return validatePaymentEntityConfiguration_(JSON.parse(serialized));
  } catch (error) {
    Logger.log(JSON.stringify({ event: 'payment_local_entity_configuration_invalid', error: error.message }));
    return null;
  }
}

function persistPaymentPushReceipt_(pushPayload, configuration, status, deployment) {
  const receipt = {
    request_id: pushPayload.request_id,
    report_key: PAYMENT_ENTITY_CONTROL.reportKey,
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
    PAYMENT_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );
  return receipt;
}

function getPaymentEntityPushEndpointUrl_() {
  const endpointUrl = String(PropertiesService.getScriptProperties()
    .getProperty(PAYMENT_ENTITY_CONTROL.pushEndpointUrlProperty) || '').trim();

  if (!endpointUrl) throw new Error('Missing Script Property: ' + PAYMENT_ENTITY_CONTROL.pushEndpointUrlProperty);
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(endpointUrl)) {
    throw new Error(
      'Payments push endpoint must be the deployed Web App URL ending in /exec. CurrentValue=' + endpointUrl
    );
  }
  return endpointUrl;
}

function getPaymentEntityPushSecret_() {
  const secret = String(PropertiesService.getScriptProperties()
    .getProperty(PAYMENT_ENTITY_CONTROL.pushSecretProperty) || '').trim();

  if (!secret) throw new Error('Missing Script Property: ' + PAYMENT_ENTITY_CONTROL.pushSecretProperty);
  if (secret.length < 32) throw new Error('Payments entity push secret must contain at least 32 characters.');
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

function createPaymentJsonResponse_(payload) {
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
      'Unable to calculate the payment week range. Invalid reference date: ' + referenceIsoDate
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
 * HTTP and Payment Fetching
 ***********************/

function fetchJsonOrThrow_(url, contextLabel) {
  const apiKey = String(PropertiesService.getScriptProperties().getProperty(PAYMENT_CONFIG.apiKeyProperty) || '').trim();
  if (!apiKey) throw new Error('Missing Script Property: ' + PAYMENT_CONFIG.apiKeyProperty);
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
  try { return JSON.parse(body); }
  catch (error) { throw new Error('Invalid JSON returned by ' + contextLabel + ': ' + String(error)); }
}

function buildPaymentsUrl_(clientId, updatedSince, startPosition) {
  const query = [
    'environment=' + encodeURIComponent(PAYMENT_CONFIG.environment),
    'updated_since=' + encodeURIComponent(updatedSince),
    'startposition=' + encodeURIComponent(startPosition),
    'maxresults=' + encodeURIComponent(PAYMENT_CONFIG.pageSize)
  ].join('&');
  return PAYMENT_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(clientId) + '/payments?' + query;
}

function fetchPayments_(clientId, updatedSince) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedUpdatedSince = normalizeTimestampForOutput_(updatedSince);
  if (!normalizedClientId) throw new Error('Client ID is required to fetch payments.');
  if (!normalizedUpdatedSince) throw new Error('A valid updated_since timestamp is required to fetch payments.');

  const items = [];
  const pages = [];
  const seenStartPositions = {};
  let startPosition = PAYMENT_CONFIG.firstStartPosition;
  let pageNumber = 0;

  while (startPosition !== null) {
    pageNumber++;
    if (pageNumber > PAYMENT_CONFIG.maxPages) {
      throw new Error('Payments pagination exceeded maxPages for client ' + normalizedClientId + '.');
    }
    if (seenStartPositions[startPosition]) {
      throw new Error('Payments pagination repeated startposition=' + startPosition + ' for client ' + normalizedClientId + '.');
    }
    seenStartPositions[startPosition] = true;

    const payload = fetchJsonOrThrow_(
      buildPaymentsUrl_(normalizedClientId, normalizedUpdatedSince, startPosition),
      '/qbo/' + normalizedClientId + '/payments page ' + pageNumber
    );
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.items)) {
      throw new Error('Invalid payments response for client ' + normalizedClientId + ' at page ' + pageNumber + '.');
    }
    payload.items.forEach(item => items.push(item));
    const next = payload.next_startposition;
    const nextStartPosition = next === null || next === undefined || String(next).trim() === '' ? null : Number(next);
    if (nextStartPosition !== null && (!Number.isInteger(nextStartPosition) || nextStartPosition < 1)) {
      throw new Error('Invalid next_startposition for client ' + normalizedClientId + ': ' + next);
    }
    pages.push({
      pageNumber,
      startPosition,
      itemCount: payload.items.length,
      nextStartPosition,
      latencyMs: numberOrNull_(payload.latency_ms),
      refreshed: payload.refreshed === true
    });
    startPosition = nextStartPosition;
    if (startPosition !== null && PAYMENT_CONFIG.pageDelayMs > 0) Utilities.sleep(PAYMENT_CONFIG.pageDelayMs);
  }

  return { clientId: normalizedClientId, updatedSince: normalizedUpdatedSince, paymentCount: items.length, pageCount: pages.length, pages, items };
}

/***********************
 * Client Selection
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
  const loaded = loadedEntityConfiguration || loadPaymentEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildPaymentEntityAuthorizationMaps_(configuration);
  const payload = fetchJsonOrThrow_(PAYMENT_CONFIG.baseUrl + '/clients', '/clients');
  const clients = extractClientsArray_(payload);
  if (!clients.length) throw new Error('The QBO /clients endpoint returned no clients. Payments processing was stopped before BigQuery.');

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
    if (authorizationMatchType === 'client_id') clientIdMatchCount++; else firstWordMatchCount++;
    clientsById[id] = {
      id,
      name,
      entity: String(client.entity || client.slug || entityAlias).trim(),
      entityAlias,
      firstWord,
      authorizationMatchType,
      authorizationMatchValue: clientIdAlias ? id : firstWord
    };
  });

  const filteredClientCount = Object.keys(clientsById).length;
  if (!filteredClientCount) {
    throw new Error('No QBO clients matched the published Payments entity configuration. ConfigurationVersion=' + configuration.configuration_version + '.');
  }
  Logger.log(JSON.stringify({
    event: 'payment_clients_filtered',
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

/***********************
 * Source Schema Monitoring
 ***********************/

function getPaymentSchemaBaselineKey_(clientId) {
  return PAYMENT_SCHEMA_BASELINE_PREFIX + String(clientId || '').trim();
}

function getPaymentSourceType_(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Object.prototype.toString.call(value) === '[object Date]') return 'date';
  return typeof value;
}

function collectPaymentSourceSchema_(value, path, fields, depth) {
  if (depth > 12) return;
  const type = getPaymentSourceType_(value);
  if (path) {
    if (!fields[path]) fields[path] = { types: {}, observations: 0 };
    fields[path].types[type] = true;
    fields[path].observations++;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPaymentSourceSchema_(item, path ? path + '[]' : '[]', fields, depth + 1));
  } else if (value && typeof value === 'object') {
    Object.keys(value).sort().forEach(key => {
      collectPaymentSourceSchema_(value[key], path ? path + '.' + key : key, fields, depth + 1);
    });
  }
}

function buildPaymentSchemaProfile_(client, range, payments) {
  const fields = {};
  payments.forEach(payment => collectPaymentSourceSchema_(payment, 'payment', fields, 0));
  const compactFields = {};
  Object.keys(fields).sort().forEach(path => {
    compactFields[path] = { t: Object.keys(fields[path].types).sort(), o: fields[path].observations };
  });
  return {
    version: PAYMENT_SCHEMA_BASELINE_VERSION,
    clientId: client.id,
    clientName: client.name,
    snapshotWeek: range.snapshotWeek,
    capturedAt: new Date().toISOString(),
    paymentCount: payments.length,
    fields: compactFields
  };
}

function comparePaymentSchemaProfiles_(previous, current) {
  if (!previous) return { status: 'baseline_missing', newPaths: Object.keys(current.fields), missingPaths: [], typeChanges: [] };
  const previousFields = previous.fields || {};
  const currentFields = current.fields || {};
  const newPaths = Object.keys(currentFields).filter(path => !previousFields[path]).sort();
  const missingPaths = Object.keys(previousFields).filter(path => !currentFields[path]).sort();
  const typeChanges = Object.keys(currentFields).filter(path => previousFields[path]).map(path => {
    const before = (previousFields[path].t || []).slice().sort();
    const after = (currentFields[path].t || []).slice().sort();
    return JSON.stringify(before) === JSON.stringify(after) ? null : { path, before, after };
  }).filter(Boolean);
  let status = 'unchanged';
  if (newPaths.length || typeChanges.length) status = 'changed';
  else if (missingPaths.length) status = 'observed_variation';
  return { status, newPaths, missingPaths, typeChanges };
}

function loadPaymentSchemaProfile_(clientId) {
  const serialized = PropertiesService.getScriptProperties().getProperty(getPaymentSchemaBaselineKey_(clientId));
  if (!serialized) return null;
  try { return JSON.parse(serialized); }
  catch (error) { throw new Error('Invalid Payment schema baseline for client ' + clientId + ': ' + error.message); }
}

function persistPaymentSchemaProfile_(profile) {
  const key = getPaymentSchemaBaselineKey_(profile.clientId);
  const serialized = JSON.stringify(profile);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PAYMENT_SCHEMA_SAFE_PROPERTY_BYTES) {
    throw new Error('Payment schema baseline exceeds safe Script Property size. clientId=' + profile.clientId + ', bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(key, serialized);
  return { propertyKey: key, clientId: profile.clientId, clientName: profile.clientName, byteCount, status: 'saved' };
}

/***********************
 * Payment Normalization
 ***********************/

function normalizeTimestampForOutput_(value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function stringOrNull_(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function booleanOrNull_(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return null;
}


function arrayOrSingle_(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  return [];
}

function refValue_(reference) {
  return reference && typeof reference === 'object' ? stringOrNull_(reference.value || reference.Value || reference.id || reference.Id) : null;
}

function refName_(reference) {
  return reference && typeof reference === 'object' ? stringOrNull_(reference.name || reference.Name) : null;
}

function paymentIsVoided_(payment) {
  return String(payment && payment.PrivateNote || '').trim().toLowerCase() === 'voided';
}

function parsePaymentLineEx_(lineEx) {
  const result = {};
  const any = lineEx ? arrayOrSingle_(lineEx.any) : [];
  any.forEach(wrapper => {
    const candidate = wrapper && wrapper.value && typeof wrapper.value === 'object' ? wrapper.value : wrapper;
    const name = stringOrNull_(candidate && (candidate.Name || candidate.name));
    const value = stringOrNull_(candidate && (candidate.Value || candidate.value));
    if (name) result[name] = value;
  });
  return result;
}

function getPaymentLineSign_(linkedTxnType, context) {
  const normalizedType = String(linkedTxnType || '').trim();

  const isSupported =
    Object.prototype.hasOwnProperty.call(
      PAYMENT_LINE_SIGN_BY_TXN_TYPE,
      normalizedType
    );

  if (!isSupported) {
    throw new Error(
      'Unsupported Payment LINE LinkedTxn type: ' +
      (normalizedType || '(empty)') +
      '. Supported=' +
      Object.keys(PAYMENT_LINE_SIGN_BY_TXN_TYPE).join(', ') +
      (context
        ? '. Context=' + JSON.stringify(context)
        : '')
    );
  }

  return PAYMENT_LINE_SIGN_BY_TXN_TYPE[normalizedType];
}

function buildPaymentIdempotencyKey_(row) {
  const parts = [
    'payment', row.SnapshotWeek, row.ClientId, row.PaymentId, row.RecordType,
    row.RecordOrder, row.LinkedTxnId || ''
  ].map(value => String(value === null || value === undefined ? '' : value).trim());
  if (parts.slice(1, 6).some(value => !value)) {
    throw new Error('Unable to build Payment idempotency key: ' + JSON.stringify(parts));
  }
  return sha256Hex_(parts.join('|'));
}

function buildPaymentHeaderContext_(client, range, payment, loadedAt) {
  const paymentId = stringOrNull_(payment.Id || payment.PaymentId || payment.payment_id);
  if (!paymentId) throw new Error('Payment is missing Id for client ' + client.id + '.');
  const metadata = payment.MetaData && typeof payment.MetaData === 'object' ? payment.MetaData : {};
  const updatedAt = normalizeTimestampForOutput_(metadata.LastUpdatedTime || metadata.UpdatedAt || metadata.last_updated_time);
  if (!updatedAt) throw new Error('Payment ' + paymentId + ' is missing a valid MetaData.LastUpdatedTime.');
  const lines = arrayOrSingle_(payment.Line);
  const paymentLinkedTxn = arrayOrSingle_(payment.LinkedTxn);
  return {
    ReportType: PAYMENT_CONFIG.reportType,
    Entity: client.entityAlias,
    ClientName: client.name,
    ClientId: client.id,
    SnapshotDate: range.snapshotDate,
    SnapshotWeek: range.snapshotWeek,
    DateFrom: range.dateFrom,
    DateTo: range.dateTo,
    UpdatedSince: range.updatedSince,
    LoadedAt: loadedAt,
    PaymentId: paymentId,
    SyncToken: stringOrNull_(payment.SyncToken),
    TxnDate: normalizeDateForOutput_(payment.TxnDate) || null,
    CustomerId: refValue_(payment.CustomerRef),
    CustomerName: refName_(payment.CustomerRef),
    DepositToAccountId: refValue_(payment.DepositToAccountRef),
    PaymentMethodId: refValue_(payment.PaymentMethodRef),
    PaymentRefNum: stringOrNull_(payment.PaymentRefNum),
    PrivateNote: stringOrNull_(payment.PrivateNote),
    TotalAmount: numberOrNull_(payment.TotalAmt),
    UnappliedAmount: numberOrNull_(payment.UnappliedAmt),
    ProcessPayment: booleanOrNull_(payment.ProcessPayment),
    IsVoided: paymentIsVoided_(payment),
    CurrencyCode: refValue_(payment.CurrencyRef) || PAYMENT_CONFIG.currencyDefault,
    CurrencyName: refName_(payment.CurrencyRef),
    PaymentLinkedTxnIds: paymentLinkedTxn.map(item => stringOrNull_(item && item.TxnId)).filter(Boolean).join(',') || null,
    PaymentLinkedTxnTypes: paymentLinkedTxn.map(item => stringOrNull_(item && item.TxnType)).filter(Boolean).join(',') || null,
    LineCount: lines.length,
    CreatedAt: normalizeTimestampForOutput_(metadata.CreateTime || metadata.CreatedAt || metadata.create_time) || null,
    UpdatedAt: updatedAt,
    Domain: stringOrNull_(payment.domain || payment.Domain),
    Sparse: booleanOrNull_(payment.sparse === undefined ? payment.Sparse : payment.sparse),
    Source: PAYMENT_CONFIG.sourceDefault,
    lines
  };
}

function buildPaymentBaseRow_(header, recordType, recordOrder) {
  return {
    idempotency_key: null,
    RecordType: recordType,
    RecordOrder: recordOrder,
    ReportType: header.ReportType,
    Entity: header.Entity,
    ClientName: header.ClientName,
    ClientId: header.ClientId,
    SnapshotDate: header.SnapshotDate,
    SnapshotWeek: header.SnapshotWeek,
    DateFrom: header.DateFrom,
    DateTo: header.DateTo,
    UpdatedSince: header.UpdatedSince,
    LoadedAt: header.LoadedAt,
    PaymentId: header.PaymentId,
    SyncToken: header.SyncToken,
    TxnDate: header.TxnDate,
    CustomerId: header.CustomerId,
    CustomerName: header.CustomerName,
    DepositToAccountId: header.DepositToAccountId,
    PaymentMethodId: header.PaymentMethodId,
    PaymentRefNum: header.PaymentRefNum,
    PrivateNote: header.PrivateNote,
    TotalAmount: header.TotalAmount,
    UnappliedAmount: header.UnappliedAmount,
    ProcessPayment: header.ProcessPayment,
    IsVoided: header.IsVoided,
    CurrencyCode: header.CurrencyCode,
    CurrencyName: header.CurrencyName,
    PaymentLinkedTxnIds: header.PaymentLinkedTxnIds,
    PaymentLinkedTxnTypes: header.PaymentLinkedTxnTypes,
    LineCount: header.LineCount,
    LineAmountRaw: null,
    LineAmountSigned: null,
    LinkedTxnId: null,
    LinkedTxnType: null,
    LinkedTxnOpenBalance: null,
    LinkedTxnReferenceNumber: null,
    CreatedAt: header.CreatedAt,
    UpdatedAt: header.UpdatedAt,
    Domain: header.Domain,
    Sparse: header.Sparse,
    Source: header.Source
  };
}

function buildPaymentHeaderRow_(header) {
  const row = buildPaymentBaseRow_(header, PAYMENT_RECORD_TYPES.header, 0);
  row.idempotency_key = buildPaymentIdempotencyKey_(row);
  return row;
}

function buildPaymentLineRow_(header, line, recordOrder) {
  if (!line || typeof line !== 'object' || Array.isArray(line)) {
    throw new Error('Payment ' + header.PaymentId + ' contains an invalid line at order ' + recordOrder + '.');
  }
  const linkedTransactions = arrayOrSingle_(line.LinkedTxn);
  if (linkedTransactions.length !== 1) {
    throw new Error('Payment ' + header.PaymentId + ' line ' + recordOrder + ' must contain exactly one LinkedTxn. Actual=' + linkedTransactions.length);
  }
  const linkedTxn = linkedTransactions[0] || {};
  const linkedTxnId = stringOrNull_(linkedTxn.TxnId);
  const linkedTxnType = stringOrNull_(linkedTxn.TxnType);
  if (!linkedTxnId || !linkedTxnType) {
    throw new Error('Payment ' + header.PaymentId + ' line ' + recordOrder + ' contains an invalid LinkedTxn.');
  }
  const rawAmount = numberOrNull_(line.Amount);
  if (rawAmount === null) throw new Error('Payment ' + header.PaymentId + ' line ' + recordOrder + ' is missing Amount.');
  const lineEx = parsePaymentLineEx_(line.LineEx);
  if (lineEx.txnId && String(lineEx.txnId) !== linkedTxnId) {
    throw new Error('Payment ' + header.PaymentId + ' line ' + recordOrder + ' contains inconsistent txnId metadata. LinkedTxn=' + linkedTxnId + ', LineEx=' + lineEx.txnId);
  }
  const row = buildPaymentBaseRow_(header, PAYMENT_RECORD_TYPES.line, recordOrder);
  row.LineAmountRaw = rawAmount;
  row.LineAmountSigned =
  rawAmount * getPaymentLineSign_(
    linkedTxnType,
    {
      paymentId: header.PaymentId,
      recordOrder: recordOrder,
      linkedTxnId: linkedTxnId,
      rawAmount: rawAmount
    }
  );
  row.LinkedTxnId = linkedTxnId;
  row.LinkedTxnType = linkedTxnType;
  row.LinkedTxnOpenBalance = numberOrNull_(lineEx.txnOpenBalance);
  row.LinkedTxnReferenceNumber = stringOrNull_(lineEx.txnReferenceNumber);
  row.idempotency_key = buildPaymentIdempotencyKey_(row);
  return row;
}

function normalizePayment_(client, range, payment, loadedAt) {
  const header = buildPaymentHeaderContext_(client, range, payment, loadedAt);
  const rows = [buildPaymentHeaderRow_(header)];
  header.lines.forEach((line, index) => rows.push(buildPaymentLineRow_(header, line, index + 1)));
  validatePaymentReconciliation_(header, rows);
  return { paymentId: header.PaymentId, rows };
}

function validatePaymentReconciliation_(header, rows) {
  const totalCents = Math.round(Number(header.TotalAmount || 0) * 100);
  const unappliedCents = Math.round(Number(header.UnappliedAmount || 0) * 100);
  const signedLineCents = rows.filter(row => row.RecordType === PAYMENT_RECORD_TYPES.line)
    .reduce((sum, row) => sum + Math.round(Number(row.LineAmountSigned || 0) * 100), 0);
  const difference = totalCents - (signedLineCents + unappliedCents);
  if (Math.abs(difference) > PAYMENT_RECONCILIATION_TOLERANCE_CENTS) {
    throw new Error('Payment reconciliation failed. PaymentId=' + header.PaymentId + ', TotalAmount=' + header.TotalAmount +
      ', SignedLineAmount=' + signedLineCents / 100 + ', UnappliedAmount=' + header.UnappliedAmount + ', Difference=' + difference / 100);
  }
  return { totalAmount: totalCents / 100, signedLineAmount: signedLineCents / 100, unappliedAmount: unappliedCents / 100 };
}

function paymentUpdatedInRange_(payment, range) {
  const metadata = payment && payment.MetaData && typeof payment.MetaData === 'object' ? payment.MetaData : {};
  const updatedAt = new Date(metadata.LastUpdatedTime || metadata.UpdatedAt || metadata.last_updated_time || '');
  if (isNaN(updatedAt.getTime())) return false;
  return updatedAt.getTime() >= Date.parse(range.updatedSince) && updatedAt.getTime() < Date.parse(range.updatedThroughExclusive);
}

function sortPaymentRows_(rows) {
  rows.sort((a, b) => {
    return String(a.Entity || '').localeCompare(String(b.Entity || '')) ||
      String(a.ClientName || '').localeCompare(String(b.ClientName || '')) ||
      String(a.TxnDate || '').localeCompare(String(b.TxnDate || '')) ||
      String(a.PaymentId || '').localeCompare(String(b.PaymentId || '')) ||
      Number(a.RecordOrder || 0) - Number(b.RecordOrder || 0);
  });
}

function validatePaymentSnapshotHierarchy_(rows) {
  const keys = {};
  const payments = {};
  let headerCount = 0;
  let lineCount = 0;
  rows.forEach((row, index) => {
    if (keys[row.idempotency_key]) throw new Error('Duplicate Payment idempotency_key at row ' + index + ': ' + row.idempotency_key);
    keys[row.idempotency_key] = true;
    const paymentKey = row.ClientId + '|' + row.PaymentId;
    if (!payments[paymentKey]) payments[paymentKey] = { headerCount: 0, lineCount: 0, orders: {} };
    if (payments[paymentKey].orders[row.RecordOrder]) throw new Error('Duplicate Payment RecordOrder for ' + paymentKey + ': ' + row.RecordOrder);
    payments[paymentKey].orders[row.RecordOrder] = true;
    if (row.RecordType === PAYMENT_RECORD_TYPES.header) { payments[paymentKey].headerCount++; headerCount++; }
    else if (row.RecordType === PAYMENT_RECORD_TYPES.line) { payments[paymentKey].lineCount++; lineCount++; }
    else throw new Error('Unsupported Payment RecordType at row ' + index + ': ' + row.RecordType);
  });
  Object.keys(payments).forEach(paymentKey => {
    if (payments[paymentKey].headerCount !== 1) throw new Error('Payment must contain exactly one HEADER: ' + paymentKey);
  });
  return {
    status: 'passed',
    rowCount: rows.length,
    paymentCount: Object.keys(payments).length,
    headerRowCount: headerCount,
    lineRowCount: lineCount,
    uniqueIdempotencyKeyCount: Object.keys(keys).length
  };
}

/***********************
 * Snapshot Assembly
 ***********************/

function buildPaymentSnapshot_(loadedEntityConfigurationOverride, options) {
  const settings = options || {};
  const range = getPreviousCompletedWeekRange_();
  range.updatedSince = range.dateFrom + 'T00:00:00.000Z';
  const dayAfter = safeParseDate_(range.dateTo);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  range.updatedThroughExclusive = formatUtcDate_(dayAfter) + 'T00:00:00.000Z';
  const loadedAt = new Date().toISOString();
  const loadedEntityConfiguration = loadedEntityConfigurationOverride
    ? { source: String(loadedEntityConfigurationOverride.source || 'configuration_deployment'), configuration: validatePaymentEntityConfiguration_(loadedEntityConfigurationOverride.configuration) }
    : loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loadedEntityConfiguration);
  const clients = Object.keys(clientsById).map(clientId => clientsById[clientId]).sort((a, b) => a.entityAlias.localeCompare(b.entityAlias) || a.name.localeCompare(b.name));

  const rows = [];
  const clientChecks = [];
  const baselineUpdates = [];
  let sourcePaymentCount = 0;
  let filteredPaymentCount = 0;
  let pageCount = 0;

  Logger.log('Filtered payment clients: ' + clients.length);
  clients.forEach(client => {
    Logger.log('Fetching payments for ' + client.name + ' [' + client.id + ']');
    const response = fetchPayments_(client.id, range.updatedSince);
    pageCount += response.pageCount;
    sourcePaymentCount += response.items.length;
    const currentPayments = response.items.filter(payment => paymentUpdatedInRange_(payment, range));
    filteredPaymentCount += currentPayments.length;

    const profile = buildPaymentSchemaProfile_(client, range, response.items);
    const previous = loadPaymentSchemaProfile_(client.id);
    const comparison = comparePaymentSchemaProfiles_(previous, profile);
    clientChecks.push({
      clientId: client.id,
      clientName: client.name,
      sourcePaymentCount: response.items.length,
      includedPaymentCount: currentPayments.length,
      pageCount: response.pageCount,
      status: response.items.length ? comparison.status : 'skipped_no_payments',
      newPathCount: comparison.newPaths.length,
      missingPathCount: comparison.missingPaths.length,
      typeChangeCount: comparison.typeChanges.length,
      newPaths: comparison.newPaths,
      typeChanges: comparison.typeChanges
    });
    if (response.items.length) baselineUpdates.push(profile);

    currentPayments.forEach(payment => {
      const normalized = normalizePayment_(client, range, payment, loadedAt);
      normalized.rows.forEach(row => rows.push(row));
    });
    Logger.log(client.name + ': sourcePayments=' + response.items.length + ', includedPayments=' + currentPayments.length + ', snapshotRows=' + rows.length + ', pages=' + response.pageCount + ', schemaStatus=' + comparison.status);
  });

  sortPaymentRows_(rows);
  const hierarchyValidation = validatePaymentSnapshotHierarchy_(rows);
  const baselinePersistence = settings.persistSchemaBaselines === false
    ? { status: 'skipped_debug', attemptedCount: baselineUpdates.length, savedCount: 0, results: [] }
    : { status: 'completed', attemptedCount: baselineUpdates.length, savedCount: baselineUpdates.length, results: baselineUpdates.map(persistPaymentSchemaProfile_) };

  return {
    entityConfiguration: {
      source: loadedEntityConfiguration.source,
      reportKey: loadedEntityConfiguration.configuration.report_key,
      configurationVersion: loadedEntityConfiguration.configuration.configuration_version,
      configurationHash: loadedEntityConfiguration.configuration.configuration_hash,
      publishedAt: loadedEntityConfiguration.configuration.published_at,
      authorizedEntityCount: loadedEntityConfiguration.configuration.entities.length
    },
    range,
    clientCount: clients.length,
    sourcePaymentCount,
    paymentCount: filteredPaymentCount,
    pageCount,
    rows,
    hierarchyValidation,
    schemaMonitoring: {
      clientCount: clientChecks.length,
      changedCount: clientChecks.filter(c => c.status === 'changed').length,
      observedVariationCount: clientChecks.filter(c => c.status === 'observed_variation').length,
      unchangedCount: clientChecks.filter(c => c.status === 'unchanged').length,
      baselineMissingCount: clientChecks.filter(c => c.status === 'baseline_missing').length,
      skippedNoPaymentsCount: clientChecks.filter(c => c.status === 'skipped_no_payments').length,
      clientChecks
    },
    baselinePersistence
  };
}

/***********************
 * BigQuery Schema Validation
 ***********************/

function validatePaymentBigQuerySchema_() {
  const duplicateNames = PAYMENT_EXPORT_COLUMNS.filter((name, index) => PAYMENT_EXPORT_COLUMNS.indexOf(name) !== index);
  if (duplicateNames.length) throw new Error('Duplicate Payments schema columns detected: ' + duplicateNames.join(', '));
  let table;
  try { table = BigQuery.Tables.get(BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId); }
  catch (error) { throw new Error('Unable to read Payments BigQuery table ' + PAYMENT_BIGQUERY_TABLE + ': ' + String(error)); }
  const actualFields = table.schema && Array.isArray(table.schema.fields) ? table.schema.fields : [];
  const actualNames = actualFields.map(field => String(field.name || ''));
  const missingColumns = PAYMENT_EXPORT_COLUMNS.filter(name => !actualNames.includes(name));
  const unexpectedColumns = actualNames.filter(name => !PAYMENT_EXPORT_COLUMNS.includes(name));
  const fieldMismatches = [];
  PAYMENT_BIGQUERY_SCHEMA.forEach((expected, index) => {
    const actual = actualFields[index];
    const definition = actual ? { name: String(actual.name || ''), type: String(actual.type || '').toUpperCase(), mode: String(actual.mode || 'NULLABLE').toUpperCase() } : null;
    if (!definition || definition.name !== expected.name || definition.type !== expected.type || definition.mode !== expected.mode) {
      fieldMismatches.push({ index, expected, actual: definition });
    }
  });
  for (let index = PAYMENT_BIGQUERY_SCHEMA.length; index < actualFields.length; index++) {
    const actual = actualFields[index];
    fieldMismatches.push({ index, expected: null, actual: { name: String(actual.name || ''), type: String(actual.type || '').toUpperCase(), mode: String(actual.mode || 'NULLABLE').toUpperCase() } });
  }
  const actualPartitionField = String(table.timePartitioning && table.timePartitioning.field || '').trim();
  const actualPartitionType = String(table.timePartitioning && table.timePartitioning.type || '').toUpperCase();
  const partitionMatches = actualPartitionField === PAYMENT_BIGQUERY_PARTITION_FIELD && actualPartitionType === 'DAY';
  const actualClusterFields = table.clustering && Array.isArray(table.clustering.fields) ? table.clustering.fields.map(String) : [];
  const clusterMatches = PAYMENT_BIGQUERY_CLUSTER_FIELDS.length === actualClusterFields.length && PAYMENT_BIGQUERY_CLUSTER_FIELDS.every((field, index) => actualClusterFields[index] === field);
  if (missingColumns.length || unexpectedColumns.length || fieldMismatches.length || !partitionMatches || !clusterMatches) {
    throw new Error('Payments BigQuery schema mismatch. ' + JSON.stringify({ table: PAYMENT_BIGQUERY_TABLE, missingColumns, unexpectedColumns, fieldMismatches, partition: { expectedField: PAYMENT_BIGQUERY_PARTITION_FIELD, expectedType: 'DAY', actualField: actualPartitionField, actualType: actualPartitionType, matches: partitionMatches }, clustering: { expected: PAYMENT_BIGQUERY_CLUSTER_FIELDS, actual: actualClusterFields, matches: clusterMatches } }));
  }
  return { status: 'passed', table: PAYMENT_BIGQUERY_TABLE, expectedColumnCount: PAYMENT_BIGQUERY_SCHEMA.length, actualColumnCount: actualFields.length, namesMatch: true, typesMatch: true, modesMatch: true, orderMatches: true, partition: { field: actualPartitionField, type: actualPartitionType }, clustering: actualClusterFields };
}

function validatePaymentBigQueryRow_(row, index) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Payment row ' + index + ' is not a valid object.');
  const missingRequired = PAYMENT_REQUIRED_EXPORT_COLUMNS.filter(column => row[column] === null || row[column] === undefined || String(row[column]).trim() === '');
  if (missingRequired.length) throw new Error('Payment row ' + index + ' is missing required fields: ' + missingRequired.join(', '));
  PAYMENT_DATE_COLUMNS.forEach(column => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new Error('Payment row ' + index + ' contains an invalid date in ' + column + ': ' + value);
  });
  PAYMENT_TIMESTAMP_COLUMNS.forEach(column => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && isNaN(new Date(value).getTime())) throw new Error('Payment row ' + index + ' contains an invalid timestamp in ' + column + ': ' + value);
  });
  PAYMENT_NUMERIC_COLUMNS.forEach(column => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && !Number.isFinite(Number(value))) throw new Error('Payment row ' + index + ' contains an invalid number in ' + column + ': ' + value);
  });
  PAYMENT_INTEGER_COLUMNS.forEach(column => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && !Number.isInteger(Number(value))) throw new Error('Payment row ' + index + ' contains an invalid integer in ' + column + ': ' + value);
  });
  PAYMENT_BOOLEAN_COLUMNS.forEach(column => {
    const value = row[column];
    if (value !== null && value !== undefined && value !== '' && value !== true && value !== false) throw new Error('Payment row ' + index + ' contains an invalid boolean in ' + column + ': ' + value);
  });
  if (![PAYMENT_RECORD_TYPES.header, PAYMENT_RECORD_TYPES.line].includes(row.RecordType)) throw new Error('Payment row ' + index + ' contains unsupported RecordType: ' + row.RecordType);
  if (row.RecordType === PAYMENT_RECORD_TYPES.header && Number(row.RecordOrder) !== 0) throw new Error('Payment HEADER row must have RecordOrder=0.');
  if (row.RecordType === PAYMENT_RECORD_TYPES.line) {
    if (Number(row.RecordOrder) < 1) throw new Error('Payment LINE row must have RecordOrder>=1.');
    if (!row.LinkedTxnId || !row.LinkedTxnType) throw new Error('Payment LINE row is missing LinkedTxn identity.');
    const expectedSigned = Number(row.LineAmountRaw) * getPaymentLineSign_(row.LinkedTxnType);
    if (Math.abs(Math.round(expectedSigned * 100) - Math.round(Number(row.LineAmountSigned) * 100)) > PAYMENT_RECONCILIATION_TOLERANCE_CENTS) {
      throw new Error('Payment row ' + index + ' contains inconsistent LineAmountSigned.');
    }
  }
  const expectedKey = buildPaymentIdempotencyKey_(row);
  if (String(row.idempotency_key || '').trim() !== expectedKey) throw new Error('Payment row ' + index + ' contains inconsistent idempotency_key.');
}

function replacePaymentSnapshotPartition_(range, rows) {
  const snapshotWeek = String(range && range.snapshotWeek || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotWeek)) throw new Error('Invalid SnapshotWeek for Payments partition replacement: ' + snapshotWeek);
  if (!Array.isArray(rows)) throw new Error('Payment snapshot rows must be an array.');
  rows.forEach((row, index) => {
    if (String(row.SnapshotWeek || '') !== snapshotWeek) throw new Error('Payment row ' + index + ' belongs to a different partition.');
  });
  if (!rows.length) return clearEmptyPaymentPartition_(snapshotWeek);
  const preparedRows = rows.map((row, index) => {
    validatePaymentBigQueryRow_(row, index);
    return PAYMENT_EXPORT_COLUMNS.reduce((json, column) => { json[column] = row[column] === undefined ? null : row[column]; return json; }, {});
  });
  const ndjson = preparedRows.map(JSON.stringify).join('\n');
  const partitionId = snapshotWeek.replace(/-/g, '');
  const destinationTableId = BQ_CONFIG.snapshotsTableId + '$' + partitionId;
  const jobId = ['payment_snapshot', partitionId, Date.now(), Utilities.getUuid().replace(/-/g, '')].join('_');
  const blob = Utilities.newBlob(ndjson, 'application/octet-stream', 'payment_snapshot_' + partitionId + '.ndjson');
  const insertedJob = BigQuery.Jobs.insert({
    jobReference: { projectId: BQ_CONFIG.projectId, jobId },
    configuration: { load: {
      destinationTable: { projectId: BQ_CONFIG.projectId, datasetId: BQ_CONFIG.rawDatasetId, tableId: destinationTableId },
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      createDisposition: 'CREATE_NEVER',
      writeDisposition: 'WRITE_TRUNCATE_DATA',
      autodetect: false,
      ignoreUnknownValues: false,
      maxBadRecords: 0
    }}
  }, BQ_CONFIG.projectId, blob);
  if (!insertedJob || !insertedJob.jobReference) throw new Error('BigQuery did not return a job reference for the Payments load.');
  const completedJob = waitForBigQueryJob_(insertedJob.jobReference, 120000);
  const outputRows = completedJob.statistics && completedJob.statistics.load && completedJob.statistics.load.outputRows !== undefined ? Number(completedJob.statistics.load.outputRows) : null;
  return { mode: 'partition_replace', jobId: completedJob.jobReference.jobId, destinationTable: [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, destinationTableId].join('.'), snapshotWeek, partitionId, rowCount: rows.length, outputRows, payloadBytes: blob.getBytes().length, state: completedJob.status.state };
}

function waitForBigQueryJob_(jobReference, timeoutMs) {
  if (!jobReference || !jobReference.jobId) throw new Error('A valid BigQuery job reference is required.');
  const projectId = jobReference.projectId || BQ_CONFIG.projectId;
  const jobId = jobReference.jobId;
  const startedAt = Date.now();
  let job;
  while (true) {
    job = BigQuery.Jobs.get(projectId, jobId);
    if (job.status && job.status.state === 'DONE') break;
    if (Date.now() - startedAt > Number(timeoutMs || 120000)) throw new Error('BigQuery job timed out: ' + jobId);
    Utilities.sleep(1000);
  }
  if (job.status && job.status.errorResult) throw new Error('BigQuery job failed: ' + JSON.stringify({ jobId, errorResult: job.status.errorResult, errors: job.status.errors || [] }));
  return job;
}

function verifyPaymentSnapshotPartition_(snapshotWeek, expectedHierarchy) {
  const normalizedSnapshotWeek = String(snapshotWeek || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedSnapshotWeek)) throw new Error('Invalid SnapshotWeek for Payments verification: ' + normalizedSnapshotWeek);
  const result = runBigQueryQuery_([
    'SELECT',
    '  COUNT(*) AS row_count,',
    "  COUNTIF(idempotency_key IS NULL OR TRIM(idempotency_key) = '') AS missing_key_count,",
    '  COUNT(DISTINCT idempotency_key) AS unique_key_count,',
    "  COUNTIF(RecordType = 'HEADER') AS header_count,",
    "  COUNTIF(RecordType = 'LINE') AS line_count,",
    "  COUNT(DISTINCT IF(RecordType = 'HEADER', CONCAT(ClientId, '|', PaymentId), NULL)) AS payment_count",
    'FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
    "WHERE SnapshotWeek = DATE '" + normalizedSnapshotWeek + "'"
  ].join('\n'));
  const values = result.rows && result.rows.length ? result.rows[0].f : [];
  const actual = {
    rowCount: Number(values[0] ? values[0].v : 0),
    missingKeyCount: Number(values[1] ? values[1].v : 0),
    uniqueKeyCount: Number(values[2] ? values[2].v : 0),
    headerCount: Number(values[3] ? values[3].v : 0),
    lineCount: Number(values[4] ? values[4].v : 0),
    paymentCount: Number(values[5] ? values[5].v : 0)
  };
  const expected = expectedHierarchy || { rowCount: 0, headerRowCount: 0, lineRowCount: 0, paymentCount: 0 };
  if (actual.rowCount !== Number(expected.rowCount) || actual.headerCount !== Number(expected.headerRowCount) || actual.lineCount !== Number(expected.lineRowCount) || actual.paymentCount !== Number(expected.paymentCount)) {
    throw new Error('Payments partition hierarchy mismatch. Expected=' + JSON.stringify(expected) + ', actual=' + JSON.stringify(actual));
  }
  if (actual.missingKeyCount !== 0 || actual.uniqueKeyCount !== actual.rowCount) throw new Error('Payments partition idempotency verification failed: ' + JSON.stringify(actual));
  return { status: 'passed', snapshotWeek: normalizedSnapshotWeek, partitionId: normalizedSnapshotWeek.replace(/-/g, ''), expectedRowCount: Number(expected.rowCount), actualRowCount: actual.rowCount, paymentCount: actual.paymentCount, headerRowCount: actual.headerCount, lineRowCount: actual.lineCount, missingKeyCount: actual.missingKeyCount, uniqueKeyCount: actual.uniqueKeyCount };
}

function runBigQueryQuery_(query) {
  let result = BigQuery.Jobs.query({ query, useLegacySql: false, timeoutMs: 120000 }, BQ_CONFIG.projectId);
  if (!result || !result.jobReference) throw new Error('BigQuery did not return a query job reference.');
  const jobReference = result.jobReference;
  while (!result.jobComplete) { Utilities.sleep(500); result = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, jobReference.jobId); }
  if (result.errors && result.errors.length) throw new Error('BigQuery query failed: ' + JSON.stringify(result.errors));
  if (!result.jobReference) result.jobReference = jobReference;
  return result;
}

function clearEmptyPaymentPartition_(snapshotWeek) {
  const normalizedSnapshotWeek = String(snapshotWeek || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedSnapshotWeek)) throw new Error('Invalid SnapshotWeek for empty Payments partition: ' + normalizedSnapshotWeek);
  const result = runBigQueryQuery_(['DELETE FROM `' + PAYMENT_BIGQUERY_TABLE + '`', "WHERE SnapshotWeek = DATE '" + normalizedSnapshotWeek + "'"].join('\n'));
  return { mode: 'empty_partition_clear', jobId: result.jobReference.jobId, destinationTable: PAYMENT_BIGQUERY_TABLE, snapshotWeek: normalizedSnapshotWeek, rowCount: 0, state: 'DONE' };
}
