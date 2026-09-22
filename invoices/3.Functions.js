/***********************
 * QBO Invoices - Functions
 ***********************/

/***********************
 * Central Entity Configuration
 ***********************/

function loadInvoiceEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cachedValue = cache.get(
    INVOICE_ENTITY_CONTROL.cacheKey
  );

  if (cachedValue) {
    try {
      const configuration =
        validateInvoiceEntityConfiguration_(
          JSON.parse(cachedValue)
        );

      return {
        source: 'script_cache',
        configuration
      };
    } catch (error) {
      Logger.log(JSON.stringify({
        event: 'invoice_entity_configuration_cache_invalid',
        error: error.message
      }));

      cache.remove(
        INVOICE_ENTITY_CONTROL.cacheKey
      );
    }
  }

  const localConfiguration =
    readLocalInvoiceEntityConfiguration_();

  if (!localConfiguration) {
    throw new Error(
      'No valid local Invoice entity configuration is available. ' +
      'Publish the centralized configuration again or run ' +
      'debugRefreshInvoiceEntityConfigurationFromCentral().'
    );
  }

  cacheInvoiceEntityConfiguration_(
    localConfiguration
  );

  return {
    source: 'script_properties',
    configuration: localConfiguration
  };
}

function readInvoiceCentralMetadata_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(
    INVOICE_ENTITY_CONTROL.metadataSheetName
  );

  if (!sheet) {
    throw new Error(
      'Central metadata sheet not found: ' +
      INVOICE_ENTITY_CONTROL.metadataSheetName
    );
  }

  assertInvoiceControlHeaders_(
    sheet,
    ['Key', 'Value', 'Updated At']
  );

  if (sheet.getLastRow() < 2) {
    throw new Error('Central configuration metadata is empty.');
  }

  const values = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 2)
    .getValues();

  const metadata = {};

  values.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) metadata[key] = row[1];
  });

  const currentVersion = Number(metadata.current_version || 0);
  const status = String(metadata.status || '').trim().toLowerCase();
  const currentHash = String(metadata.current_hash || '').trim();
  const publishedAt = String(metadata.published_at || '').trim();

  if (!Number.isInteger(currentVersion) || currentVersion < 1) {
    throw new Error(
      'Invalid central configuration version: ' +
      metadata.current_version
    );
  }

  if (status !== 'published') {
    throw new Error(
      'Central configuration is not published. Status=' +
      status
    );
  }

  if (!currentHash) {
    throw new Error(
      'Central configuration metadata is missing current_hash.'
    );
  }

  if (!publishedAt) {
    throw new Error(
      'Central configuration metadata is missing published_at.'
    );
  }

  return {
    currentVersion: currentVersion,
    currentHash: currentHash,
    publishedAt: publishedAt,
    status: status
  };
}

function readPublishedInvoiceConfiguration_(spreadsheet, expectedVersion) {
  const sheet = spreadsheet.getSheetByName(
    INVOICE_ENTITY_CONTROL.publishedSheetName
  );

  if (!sheet) {
    throw new Error(
      'Published configuration sheet not found: ' +
      INVOICE_ENTITY_CONTROL.publishedSheetName
    );
  }

  assertInvoiceControlHeaders_(
    sheet,
    [
      'Report Key',
      'Report Name',
      'Configuration Version',
      'Configuration Hash',
      'Published At',
      'Entity Count',
      'Configuration JSON'
    ]
  );

  if (sheet.getLastRow() < 2) {
    throw new Error('Published configuration sheet is empty.');
  }

  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, 7)
    .getValues();

  const reportRow = rows.find(row =>
    String(row[0] || '').trim() ===
    INVOICE_ENTITY_CONTROL.reportKey
  );

  if (!reportRow) {
    throw new Error(
      'No published configuration was found for report_key=' +
      INVOICE_ENTITY_CONTROL.reportKey
    );
  }

  const rowVersion = Number(reportRow[2] || 0);
  const rowHash = String(reportRow[3] || '').trim();
  const entityCount = Number(reportRow[5] || 0);
  const configurationJson = String(reportRow[6] || '').trim();

  if (rowVersion !== expectedVersion) {
    throw new Error(
      'Published invoice configuration version mismatch. ' +
      'Expected=' +
      expectedVersion +
      ', actual=' +
      rowVersion
    );
  }

  if (!configurationJson) {
    throw new Error(
      'Published invoice configuration JSON is empty.'
    );
  }

  let configuration;

  try {
    configuration = JSON.parse(configurationJson);
  } catch (error) {
    throw new Error(
      'Published invoice configuration contains invalid JSON: ' +
      error.message
    );
  }

  const validated = validateInvoiceEntityConfiguration_(
    configuration,
    expectedVersion
  );

  if (validated.configuration_hash !== rowHash) {
    throw new Error(
      'Published invoice configuration hash does not match its row hash.'
    );
  }

  if (validated.entities.length !== entityCount) {
    throw new Error(
      'Published invoice entity count mismatch. ' +
      'Expected=' +
      entityCount +
      ', actual=' +
      validated.entities.length
    );
  }

  return validated;
}

function refreshInvoiceEntityConfigurationFromCentral_() {
  const spreadsheet = getInvoiceControlSpreadsheet_();
  const metadata = readInvoiceCentralMetadata_(spreadsheet);

  const configuration = readPublishedInvoiceConfiguration_(
    spreadsheet,
    metadata.currentVersion
  );

  const persistence = persistInvoiceEntityConfiguration_(
    configuration
  );

  cacheInvoiceEntityConfiguration_(
    configuration
  );

  Logger.log(JSON.stringify({
    event: 'invoice_entity_configuration_refreshed_manually',
    configurationVersion:
      configuration.configuration_version,
    configurationHash:
      configuration.configuration_hash,
    entityCount:
      configuration.entities.length,
    byteCount: persistence.byteCount
  }));

  return {
    source: 'central_sheet_manual',
    configuration,
    persistence
  };
}

function validateInvoiceEntityConfiguration_(configuration, expectedVersion) {
  if (
    !configuration ||
    typeof configuration !== 'object' ||
    Array.isArray(configuration)
  ) {
    throw new Error(
      'Invoice entity configuration must be a JSON object.'
    );
  }

  const contractType = String(
    configuration.contract_type || ''
  ).trim();

  const contractVersion = String(
    configuration.contract_version || ''
  ).trim();

  const schemaVersion = String(
    configuration.schema_version || ''
  ).trim();

  const reportKey = String(
    configuration.report_key || ''
  ).trim();

  const configurationVersion = Number(
    configuration.configuration_version || 0
  );

  const configurationHash = String(
    configuration.configuration_hash || ''
  ).trim();

  if (contractType !== INVOICE_ENTITY_CONTROL.contractType) {
    throw new Error(
      'Unexpected entity configuration contract_type: ' +
      contractType
    );
  }

  if (contractVersion !== INVOICE_ENTITY_CONTROL.contractVersion) {
    throw new Error(
      'Unexpected entity configuration contract_version: ' +
      contractVersion
    );
  }

  if (schemaVersion !== INVOICE_ENTITY_CONTROL.schemaVersion) {
    throw new Error(
      'Unexpected entity configuration schema_version: ' +
      schemaVersion
    );
  }

  if (reportKey !== INVOICE_ENTITY_CONTROL.reportKey) {
    throw new Error(
      'Unexpected entity configuration report_key: ' +
      reportKey
    );
  }

  if (
    !Number.isInteger(configurationVersion) ||
    configurationVersion < 1
  ) {
    throw new Error(
      'Invalid entity configuration version: ' +
      configuration.configuration_version
    );
  }

  if (
    expectedVersion !== undefined &&
    configurationVersion !== Number(expectedVersion)
  ) {
    throw new Error(
      'Entity configuration version is stale. ' +
      'Expected=' +
      expectedVersion +
      ', actual=' +
      configurationVersion
    );
  }

  if (!Array.isArray(configuration.entities)) {
    throw new Error(
      'Entity configuration must contain an entities array.'
    );
  }

  if (!configuration.entities.length) {
    throw new Error(
      'Invoice entity configuration contains no authorized entities.'
    );
  }

  const duplicateKeys = {};
  const normalizedEntities = configuration.entities.map(
    (entity, index) => {
      const matchType = String(
        entity && entity.match_type || ''
      ).trim().toLowerCase();

      const rawMatchValue = String(
        entity && entity.match_value || ''
      ).trim();

      const matchValue = matchType === 'first_word'
        ? getFirstWordNormalized_(rawMatchValue)
        : rawMatchValue;

      const entityAlias = String(
        entity && entity.entity_alias || ''
      ).trim().toLowerCase();

      if (!['first_word', 'client_id'].includes(matchType)) {
        throw new Error(
          'Unsupported match_type at entity index ' +
          index +
          ': ' +
          matchType
        );
      }

      if (!matchValue) {
        throw new Error(
          'Missing match_value at entity index ' +
          index +
          '.'
        );
      }

      if (!entityAlias) {
        throw new Error(
          'Missing entity_alias at entity index ' +
          index +
          '.'
        );
      }

      if (!/^[a-z0-9_]+$/.test(entityAlias)) {
        throw new Error(
          'Invalid entity_alias at entity index ' +
          index +
          ': ' +
          entityAlias
        );
      }

      const duplicateKey = matchType + '|' + matchValue;

      if (duplicateKeys[duplicateKey]) {
        throw new Error(
          'Duplicate entity authorization: ' +
          duplicateKey
        );
      }

      duplicateKeys[duplicateKey] = true;

      return {
        match_type: matchType,
        match_value: matchValue,
        entity_alias: entityAlias
      };
    }
  );

  const calculatedHash = sha256Hex_(
    JSON.stringify({
      schema_version: schemaVersion,
      report_key: reportKey,
      entities: normalizedEntities
    })
  );

  if (!configurationHash) {
    throw new Error(
      'Entity configuration is missing configuration_hash.'
    );
  }

  if (calculatedHash !== configurationHash) {
    throw new Error(
      'Entity configuration hash validation failed. ' +
      'Expected=' +
      configurationHash +
      ', calculated=' +
      calculatedHash
    );
  }

  return {
    contract_type: contractType,
    contract_version: contractVersion,
    schema_version: schemaVersion,
    report_key: reportKey,
    configuration_version: configurationVersion,
    configuration_hash: configurationHash,
    published_at: String(
      configuration.published_at || ''
    ).trim(),
    entities: normalizedEntities
  };
}

function persistInvoiceEntityConfiguration_(configuration) {
  const serialized = JSON.stringify(configuration);
  const byteCount = Utilities
    .newBlob(serialized)
    .getBytes()
    .length;

  if (byteCount > INVOICE_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error(
      'Invoice entity configuration exceeds the safe Script Property size. ' +
      'bytes=' +
      byteCount +
      ', maximum=' +
      INVOICE_ENTITY_CONTROL.maxPropertyBytes
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(
      INVOICE_ENTITY_CONTROL.localPropertyKey,
      serialized
    );

  return {
    propertyKey: INVOICE_ENTITY_CONTROL.localPropertyKey,
    byteCount: byteCount
  };
}

function cacheInvoiceEntityConfiguration_(configuration) {
  CacheService
    .getScriptCache()
    .put(
      INVOICE_ENTITY_CONTROL.cacheKey,
      JSON.stringify(configuration),
      INVOICE_ENTITY_CONTROL.cacheTtlSeconds
    );
}

function buildInvoiceEntityAuthorizationMaps_(configuration) {
  const firstWordAliases = {};
  const clientIdAliases = {};

  configuration.entities.forEach(entity => {
    if (entity.match_type === 'first_word') {
      firstWordAliases[entity.match_value] =
        entity.entity_alias;
    } else if (entity.match_type === 'client_id') {
      clientIdAliases[entity.match_value] =
        entity.entity_alias;
    }
  });

  return {
    firstWordAliases: firstWordAliases,
    clientIdAliases: clientIdAliases
  };
}

function assertInvoiceControlHeaders_(sheet, expectedHeaders) {
  const actualHeaders = sheet
    .getRange(1, 1, 1, expectedHeaders.length)
    .getDisplayValues()[0]
    .map(value => String(value || '').trim());

  const mismatches = expectedHeaders
    .map((expected, index) => ({
      position: index + 1,
      expected: expected,
      actual: actualHeaders[index]
    }))
    .filter(header => header.expected !== header.actual);

  if (mismatches.length) {
    throw new Error(
      'Unexpected headers in central sheet "' +
      sheet.getName() +
      '": ' +
      JSON.stringify(mismatches)
    );
  }
}

/***********************
 * Entity Configuration Push Endpoint
 ***********************/

function doPost(e) {
  let response;

  try {
    response = handleInvoiceEntityConfigurationPush_(e);
  } catch (error) {
    response = {
      success: false,
      status: 'rejected',
      reportKey: INVOICE_ENTITY_CONTROL.reportKey,
      error: error.message
    };

    Logger.log(JSON.stringify({
      event: 'invoice_entity_configuration_push_rejected',
      error: error.message
    }));
  }

  return createInvoiceJsonResponse_(response);
}

function handleInvoiceEntityConfigurationPush_(e) {
  const rawBody = String(
    e &&
    e.postData &&
    e.postData.contents || ''
  ).trim();

  if (!rawBody) {
    throw new Error('Push request body is empty.');
  }

  let envelope;

  try {
    envelope = JSON.parse(rawBody);
  } catch (error) {
    throw new Error(
      'Push request contains invalid envelope JSON: ' +
      error.message
    );
  }

  validateInvoicePushEnvelope_(envelope);

  const secret = getInvoiceEntityPushSecret_();
  const calculatedSignature = hmacSha256Hex_(
    envelope.payload,
    secret
  );

  if (!secureHexEquals_(
    calculatedSignature,
    envelope.signature
  )) {
    throw new Error('Push request signature is invalid.');
  }

  let pushPayload;

  try {
    pushPayload = JSON.parse(envelope.payload);
  } catch (error) {
    throw new Error(
      'Push envelope contains invalid payload JSON: ' +
      error.message
    );
  }

  validateInvoicePushPayload_(pushPayload);

  const configuration = validateInvoiceEntityConfiguration_(
    pushPayload.configuration,
    Number(pushPayload.configuration_version)
  );

  if (
    configuration.configuration_hash !==
    String(pushPayload.configuration_hash || '').trim()
  ) {
    throw new Error(
      'Push payload configuration hash does not match ' +
      'the embedded configuration.'
    );
  }

  const lock = LockService.getUserLock();

  if (!lock.tryLock(30000)) {
    throw new Error(
      'Unable to acquire the Invoice configuration request lock.'
    );
  }

  try {
    return applyInvoicePushedConfiguration_(
      pushPayload,
      configuration
    );
  } finally {
    lock.releaseLock();
  }
}

function validateInvoicePushEnvelope_(envelope) {
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope)
  ) {
    throw new Error('Push envelope must be a JSON object.');
  }

  const contractType = String(
    envelope.contract_type || ''
  ).trim();

  const contractVersion = String(
    envelope.contract_version || ''
  ).trim();

  const payload = String(envelope.payload || '').trim();
  const signature = String(
    envelope.signature || ''
  ).trim().toLowerCase();

  if (
    contractType !==
    INVOICE_ENTITY_CONTROL.pushEnvelopeContractType
  ) {
    throw new Error(
      'Unexpected push envelope contract_type: ' +
      contractType
    );
  }

  if (
    contractVersion !==
    INVOICE_ENTITY_CONTROL.pushEnvelopeContractVersion
  ) {
    throw new Error(
      'Unexpected push envelope contract_version: ' +
      contractVersion
    );
  }

  if (!payload) {
    throw new Error('Push envelope payload is empty.');
  }

  if (!/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error(
      'Push envelope signature must be a SHA-256 hex value.'
    );
  }
}

function validateInvoicePushPayload_(payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  ) {
    throw new Error('Push payload must be a JSON object.');
  }

  const contractType = String(
    payload.contract_type || ''
  ).trim();

  const contractVersion = String(
    payload.contract_version || ''
  ).trim();

  const requestId = String(
    payload.request_id || ''
  ).trim();

  const reportKey = String(
    payload.report_key || ''
  ).trim();

  const configurationVersion = Number(
    payload.configuration_version || 0
  );

  const configurationHash = String(
    payload.configuration_hash || ''
  ).trim();

  const sentAt = String(payload.sent_at || '').trim();
  const sentAtMilliseconds = Date.parse(sentAt);

  if (
    contractType !==
    INVOICE_ENTITY_CONTROL.pushContractType
  ) {
    throw new Error(
      'Unexpected push payload contract_type: ' +
      contractType
    );
  }

  if (
    contractVersion !==
    INVOICE_ENTITY_CONTROL.pushContractVersion
  ) {
    throw new Error(
      'Unexpected push payload contract_version: ' +
      contractVersion
    );
  }

  if (!requestId) {
    throw new Error('Push payload is missing request_id.');
  }

  if (reportKey !== INVOICE_ENTITY_CONTROL.reportKey) {
    throw new Error(
      'Push payload was sent to the wrong report. ' +
      'Expected=' +
      INVOICE_ENTITY_CONTROL.reportKey +
      ', actual=' +
      reportKey
    );
  }

  if (
    !Number.isInteger(configurationVersion) ||
    configurationVersion < 1
  ) {
    throw new Error(
      'Push payload contains an invalid configuration version.'
    );
  }

  if (!/^[a-f0-9]{64}$/.test(configurationHash)) {
    throw new Error(
      'Push payload contains an invalid configuration hash.'
    );
  }

  if (!Number.isFinite(sentAtMilliseconds)) {
    throw new Error(
      'Push payload contains an invalid sent_at value.'
    );
  }

  const ageSeconds =
    (Date.now() - sentAtMilliseconds) / 1000;

  if (
    ageSeconds >
    INVOICE_ENTITY_CONTROL.pushMaxAgeSeconds
  ) {
    throw new Error(
      'Push payload has expired. AgeSeconds=' +
      Math.floor(ageSeconds)
    );
  }

  if (
    ageSeconds <
    -INVOICE_ENTITY_CONTROL.pushFutureToleranceSeconds
  ) {
    throw new Error(
      'Push payload sent_at is too far in the future.'
    );
  }

  if (
    !payload.configuration ||
    typeof payload.configuration !== 'object'
  ) {
    throw new Error(
      'Push payload is missing the configuration object.'
    );
  }
}

function applyInvoicePushedConfiguration_(pushPayload, incomingConfiguration) {
  const localConfiguration = readLocalInvoiceEntityConfiguration_();

  if (localConfiguration) {
    const localVersion = localConfiguration.configuration_version;
    const incomingVersion = incomingConfiguration.configuration_version;

    if (incomingVersion < localVersion) {
      throw new Error(
        'Incoming Invoice configuration is stale. IncomingVersion=' + incomingVersion +
        ', currentVersion=' + localVersion
      );
    }

    if (incomingVersion === localVersion) {
      if (incomingConfiguration.configuration_hash !== localConfiguration.configuration_hash) {
        throw new Error(
          'Configuration version conflict. Version=' + incomingVersion +
          ' has a different local hash.'
        );
      }

      cacheInvoiceEntityConfiguration_(incomingConfiguration);
      const deployment = queueInvoiceConfigurationDeployment_(pushPayload, incomingConfiguration);
      const responseStatus = deployment.queued ? 'queued' : 'idempotent';
      persistInvoicePushReceipt_(pushPayload, incomingConfiguration, responseStatus, deployment);

      if (responseStatus === 'idempotent') {
        return {
          success: true,
          status: 'idempotent',
          reportKey: INVOICE_ENTITY_CONTROL.reportKey,
          configurationVersion: incomingVersion,
          configurationHash: incomingConfiguration.configuration_hash
        };
      }

      return {
        success: true,
        status: 'queued',
        reportKey: INVOICE_ENTITY_CONTROL.reportKey,
        configurationVersion: incomingVersion,
        configurationHash: incomingConfiguration.configuration_hash,
        operationId: deployment.operationId,
        deploymentStatus: deployment.status,
        currentStage: deployment.currentStage
      };
    }
  }

  const persistence = persistInvoiceEntityConfiguration_(incomingConfiguration);
  cacheInvoiceEntityConfiguration_(incomingConfiguration);
  const deployment = queueInvoiceConfigurationDeployment_(pushPayload, incomingConfiguration);
  persistInvoicePushReceipt_(pushPayload, incomingConfiguration, 'queued', deployment);

  Logger.log(JSON.stringify({
    event: 'invoice_entity_configuration_push_queued',
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
    reportKey: INVOICE_ENTITY_CONTROL.reportKey,
    configurationVersion: incomingConfiguration.configuration_version,
    configurationHash: incomingConfiguration.configuration_hash,
    operationId: deployment.operationId,
    deploymentStatus: deployment.status,
    currentStage: deployment.currentStage
  };
}

function readLocalInvoiceEntityConfiguration_() {
  const serialized = PropertiesService
    .getScriptProperties()
    .getProperty(
      INVOICE_ENTITY_CONTROL.localPropertyKey
    );

  if (!serialized) return null;

  try {
    return validateInvoiceEntityConfiguration_(
      JSON.parse(serialized)
    );
  } catch (error) {
    Logger.log(JSON.stringify({
      event: 'invoice_local_entity_configuration_invalid',
      error: error.message
    }));

    return null;
  }
}

function persistInvoicePushReceipt_(pushPayload, configuration, status, deployment) {
  const receipt = {
    request_id: pushPayload.request_id,
    report_key: INVOICE_ENTITY_CONTROL.reportKey,
    status: status,
    configuration_version: configuration.configuration_version,
    configuration_hash: configuration.configuration_hash,
    sent_at: pushPayload.sent_at,
    received_at: new Date().toISOString(),
    operation_id: deployment && deployment.operationId || null,
    deployment_status: deployment && deployment.status || null,
    current_stage: deployment && deployment.currentStage || null
  };

  PropertiesService.getScriptProperties().setProperty(
    INVOICE_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );
  return receipt;
}

function hmacSha256Hex_(value, secret) {
  const bytes =
    Utilities.computeHmacSha256Signature(
      String(value),
      String(secret),
      Utilities.Charset.UTF_8
    );

  return bytes.map(byte => {
    const unsignedByte = byte < 0 ? byte + 256 : byte;

    return unsignedByte
      .toString(16)
      .padStart(2, '0');
  }).join('');
}

function secureHexEquals_(left, right) {
  const leftValue = String(left || '');
  const rightValue = String(right || '');

  if (leftValue.length !== rightValue.length) {
    return false;
  }

  let difference = 0;

  for (
    let index = 0;
    index < leftValue.length;
    index++
  ) {
    difference |=
      leftValue.charCodeAt(index) ^
      rightValue.charCodeAt(index);
  }

  return difference === 0;
}

function createInvoiceJsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/***********************
 * Source Diagnostics and Schema Monitoring
 ***********************/

function createInvoiceSourceDiagnostics_() {
  return {
    resolvedFields: {}, aliasesUsed: {}, normalizedKeyMatches: {}, missingOptionalFields: {}, observedSourcePaths: {},
    observedSourceTypes: {}
  };
}

function resolveInvoiceSourceField_(scope, source, fieldName, diagnostics, contextLabel) {
  const scopeMap = INVOICE_SOURCE_FIELDS[scope];
  const config = scopeMap && scopeMap[fieldName];
  if (!config) {
    throw new Error('Invoice source field mapping not found. Scope=' + scope + ', field=' + fieldName);
  }
  for (let index = 0; index < config.paths.length; index++) {
    const configuredPath = config.paths[index];
    const result = getSourceValueByPath_(source, configuredPath);
    if (!result.found || !isSourceValuePresent_(result.value)) continue;
    incrementDiagnosticCounter_(diagnostics.resolvedFields, scope + '.' + fieldName);
    if (index > 0) {
      incrementDiagnosticCounter_(diagnostics.aliasesUsed, scope + '.' + fieldName + ' <- ' + configuredPath);
    }
    if (result.resolvedPath !== configuredPath) {
      incrementDiagnosticCounter_(diagnostics.normalizedKeyMatches, configuredPath + ' <- ' + result.resolvedPath);
    }
    return result.value;
  }
  const fieldReference = scope + '.' + fieldName;
  const context = contextLabel ? ', context=' + contextLabel : '';
  if (config.required) {
    throw new Error('Required invoice source field not found. Field=' + fieldReference + ', acceptedPaths=' +
        JSON.stringify(config.paths) + context);
  }
  incrementDiagnosticCounter_(diagnostics.missingOptionalFields, fieldReference);
  return null;
}

function getSourceValueByPath_(source, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  const resolvedParts = [];
  let current = source;
  for (const expectedKey of parts) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: null, resolvedPath: null };
    }
    const actualKey = Object.prototype.hasOwnProperty.call(current, expectedKey) ? expectedKey
      : findNormalizedSourceKey_(current, expectedKey);
    if (!actualKey) {
      return { found: false, value: null, resolvedPath: null };
    }
    resolvedParts.push(actualKey);
    current = current[actualKey];
  }
  return {
    found: true, value: current, resolvedPath: resolvedParts.join('.')
  };
}

function findNormalizedSourceKey_(source, expectedKey) {
  const normalizedExpected = normalizeSourceKey_(expectedKey);
  return Object.keys(source).find((actualKey) => normalizeSourceKey_(actualKey) === normalizedExpected) || null;
}

function normalizeSourceKey_(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSourceValuePresent_(value) {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function incrementDiagnosticCounter_(container, key) {
  container[key] = (container[key] || 0) + 1;
}

function inspectInvoiceSourceSchema_(invoice, diagnostics) {
  collectInvoiceSourceSchema_(invoice, 'invoice', diagnostics, 0);
}

function collectInvoiceSourceSchema_(value, currentPath, diagnostics, depth) {
  if (value === null || value === undefined || depth > 8) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (item !== null && item !== undefined && typeof item === 'object') {
        collectInvoiceSourceSchema_(item, currentPath + '[]', diagnostics, depth + 1);
      }
    });
    return;
  }
  if (typeof value !== 'object') return;
  Object.keys(value).forEach((key) => {
    const childValue = value[key];
    const childPath = currentPath + '.' + key;
    incrementDiagnosticCounter_(diagnostics.observedSourcePaths, childPath);
    if (childValue !== null && childValue !== undefined) {
      const valueType = getInvoiceSourceValueType_(childValue);
      incrementDiagnosticCounter_(diagnostics.observedSourceTypes, childPath + '<' + valueType + '>');
    }
    if (Array.isArray(childValue)) {
      childValue.forEach((item) => {
        if (item !== null && item !== undefined && typeof item === 'object') {
          collectInvoiceSourceSchema_(item, childPath + '[]', diagnostics, depth + 1);
        }
      });
      return;
    }
    if (childValue !== null && typeof childValue === 'object') {
      collectInvoiceSourceSchema_(childValue, childPath, diagnostics, depth + 1);
    }
  });
}

function getInvoiceSourceValueType_(value) {
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function mergeInvoiceSourceDiagnostics_(target, source) {
  const sections = ['resolvedFields', 'aliasesUsed', 'normalizedKeyMatches', 'missingOptionalFields',
    'observedSourcePaths', 'observedSourceTypes'];
  sections.forEach((section) => {
    const sourceValues = source && source[section] ? source[section] : {};
    Object.keys(sourceValues).forEach((key) => {
      target[section][key] = (target[section][key] || 0) + Number(sourceValues[key] || 0);
    });
  });
  return target;
}

function sumInvoiceDiagnosticCounters_(container) {
  return Object.keys(container || {}).reduce((total, key) => total + Number(container[key] || 0), 0);
}

function summarizeInvoiceSourceDiagnostics_(diagnostics) {
  const safeDiagnostics = diagnostics || createInvoiceSourceDiagnostics_();
  return {
    resolvedValueCount: sumInvoiceDiagnosticCounters_(safeDiagnostics.resolvedFields),
    aliasResolutionCount: sumInvoiceDiagnosticCounters_(safeDiagnostics.aliasesUsed),
    normalizedKeyMatchCount: sumInvoiceDiagnosticCounters_(safeDiagnostics.normalizedKeyMatches),
    missingOptionalValueCount: sumInvoiceDiagnosticCounters_(safeDiagnostics.missingOptionalFields),
    observedSourcePathCount: Object.keys(safeDiagnostics.observedSourcePaths).length,
    observedSourceTypeCount: Object.keys(safeDiagnostics.observedSourceTypes).length,
    aliasesUsed: safeDiagnostics.aliasesUsed, normalizedKeyMatches: safeDiagnostics.normalizedKeyMatches,
    missingOptionalFields: safeDiagnostics.missingOptionalFields
  };
}

function buildInvoiceSchemaProfile_(client, range, invoiceCount, diagnostics) {
  const observedPaths = diagnostics && diagnostics.observedSourcePaths ? diagnostics.observedSourcePaths : {};
  const observedTypes = diagnostics && diagnostics.observedSourceTypes ? diagnostics.observedSourceTypes : {};
  const fields = {};
  Object.keys(observedPaths).sort().forEach((path) => {
    fields[path] = {
      t: [], o: Number(observedPaths[path] || 0)
    };
  });
  Object.keys(observedTypes).forEach((signature) => {
    const parsed = parseInvoiceTypeSignature_(signature);
    if (!parsed) return;
    if (!fields[parsed.path]) {
      fields[parsed.path] = {
        t: [], o: 0
      };
    }
    if (!fields[parsed.path].t.includes(parsed.type)) {
      fields[parsed.path].t.push(parsed.type);
    }
  });
  Object.keys(fields).forEach((path) => {
    fields[path].t.sort();
  });
  return {
    version: INVOICE_SCHEMA_BASELINE_VERSION, clientId: String(client.id || '').trim(),
    clientName: String(client.name || '').trim(), snapshotWeek: range.snapshotWeek, periodKey: range.periodKey,
    invoiceCount: Number(invoiceCount || 0), capturedAt: new Date().toISOString(), fields: fields
  };
}

function parseInvoiceTypeSignature_(signature) {
  const match = String(signature || '').match(/^(.*)<([^<>]+)>$/);
  if (!match) return null;
  return {
    path: match[1], type: match[2]
  };
}

function compareInvoiceSchemaProfiles_(previousProfile, currentProfile) {
  if (!previousProfile) {
    return {
      status: 'baseline_missing', hasChanges: false, previousSnapshotWeek: null,
      currentSnapshotWeek: currentProfile.snapshotWeek, newPaths: [], notObservedPaths: [], suspectedRemovedPaths: [],
      typeChanges: []
    };
  }
  const previousFields = previousProfile.fields || {};
  const currentFields = currentProfile.fields || {};
  const previousPaths = Object.keys(previousFields).sort();
  const currentPaths = Object.keys(currentFields).sort();
  const newPaths = currentPaths.filter(path => !Object.prototype.hasOwnProperty.call(previousFields, path));
  const notObservedPaths = previousPaths.filter(path => !Object.prototype.hasOwnProperty.call(currentFields, path));
  const snapshotWeekAdvanced = String(currentProfile.snapshotWeek || '') >
    String(previousProfile.snapshotWeek || '');
  const suspectedRemovedPaths = notObservedPaths.filter(path => {
    const previousMissingWeeks = Number(previousFields[path].m || 0);
    const nextMissingWeeks = previousMissingWeeks + (snapshotWeekAdvanced ? 1 : 0);
    return nextMissingWeeks >= INVOICE_SCHEMA_MISSING_WEEK_THRESHOLD;
  });
  const typeChanges = currentPaths.filter(path => Object.prototype.hasOwnProperty.call(previousFields, path))
    .map(path => {
      const previousTypes = Array.from(new Set(previousFields[path].t || [])).sort();
      const currentTypes = Array.from(new Set(currentFields[path].t || [])).sort();
      const addedTypes = currentTypes.filter(type => !previousTypes.includes(type));
      return {
        path: path, previousTypes: previousTypes, currentTypes: currentTypes, addedTypes: addedTypes
      };
    }).filter(change => change.addedTypes.length > 0);
  const hasChanges = newPaths.length > 0 || suspectedRemovedPaths.length > 0 || typeChanges.length > 0;
  let status = 'unchanged';
  if (hasChanges) {
    status = 'changed';
  } else if (notObservedPaths.length > 0) {
    status = 'observed_variation';
  }
  return {
    status: status, hasChanges: hasChanges, previousSnapshotWeek: previousProfile.snapshotWeek || null,
    currentSnapshotWeek: currentProfile.snapshotWeek, newPaths: newPaths, notObservedPaths: notObservedPaths,
    suspectedRemovedPaths: suspectedRemovedPaths, typeChanges: typeChanges
  };
}

function getInvoiceSchemaBaselineKey_(clientId) {
  const normalizedClientId = String(clientId || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!normalizedClientId) {
    throw new Error('A client ID is required for the schema baseline.');
  }
  return (INVOICE_SCHEMA_BASELINE_PREFIX + normalizedClientId);
}

function compactInvoiceSchemaProfile_(profile) {
  const compactFields = {};
  Object.keys(profile.fields || {}).sort().forEach((path) => {
    const field = profile.fields[path] || {};
    compactFields[path] = [Array.from(new Set(field.t || [])).sort(), field.l || profile.snapshotWeek || null,
      Number(field.m || 0)];
  });
  return {
    v: INVOICE_SCHEMA_BASELINE_VERSION, i: String(profile.clientId || '').trim(), w: profile.snapshotWeek || null,
    f: compactFields
  };
}

function expandInvoiceSchemaProfile_(storedProfile, propertyKey) {
  if (storedProfile && storedProfile.version === INVOICE_SCHEMA_BASELINE_VERSION && storedProfile.fields &&
    typeof storedProfile.fields === 'object') {
    return storedProfile;
  }
  if (!storedProfile || storedProfile.v !== INVOICE_SCHEMA_BASELINE_VERSION || !storedProfile.f ||
    typeof storedProfile.f !== 'object') {
    throw new Error('Invalid invoice schema baseline structure. Key=' + propertyKey);
  }
  const fields = {};
  Object.keys(storedProfile.f).forEach((path) => {
    const compactField = storedProfile.f[path];
    if (!Array.isArray(compactField)) {
      throw new Error('Invalid compact invoice schema field. Key=' + propertyKey + ', path=' + path);
    }
    fields[path] = {
      t: Array.from(new Set(Array.isArray(compactField[0]) ? compactField[0] : [])).sort(), o: 0, l: compactField[1] ||
        storedProfile.w || null, m: Number(compactField[2] || 0)
    };
  });
  return {
    version: storedProfile.v, clientId: String(storedProfile.i || '').trim(), clientName: '',
    snapshotWeek: storedProfile.w || null, periodKey: null, invoiceCount: 0, capturedAt: null, fields: fields
  };
}

function loadInvoiceSchemaProfileByKey_(propertyKey) {
  const raw = PropertiesService.getScriptProperties().getProperty(propertyKey);
  if (!raw) return null;
  let storedProfile;
  try {
    storedProfile = JSON.parse(raw);
  } catch (error) {
    throw new Error('Invalid invoice schema baseline JSON. Key=' + propertyKey + ', error=' + error.message);
  }
  return expandInvoiceSchemaProfile_(storedProfile, propertyKey);
}

function saveInvoiceSchemaProfileByKey_(propertyKey, profile) {
  const compactProfile = compactInvoiceSchemaProfile_(profile);
  const serialized = JSON.stringify(compactProfile);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount >
    INVOICE_SCHEMA_SAFE_PROPERTY_BYTES) {
    throw new Error('Invoice schema profile exceeds the safe property size. ' + 'Key=' + propertyKey + ', bytes=' +
      byteCount + ', limit=' + INVOICE_SCHEMA_SAFE_PROPERTY_BYTES);
  }
  PropertiesService.getScriptProperties().setProperty(propertyKey, serialized);
  return {
    propertyKey: propertyKey, byteCount: byteCount, storageFormat: 'compact_v2'
  };
}

/***********************
 * Schema Baseline Monitoring
 ***********************/

function prepareInvoiceSchemaBaseline_(client, range, invoiceCount, diagnostics) {
  const baseCheck = {
    clientId: client.id, clientName: client.name, invoiceCount: Number(invoiceCount || 0),
    currentSnapshotWeek: range.snapshotWeek
  };
  if (!invoiceCount) {
    return {
      check: {
...baseCheck, status: 'skipped_no_invoices', hasChanges: false, fieldCount: 0, previousSnapshotWeek: null, newPaths: [],
        notObservedPathCount: 0, suspectedRemovedPaths: [], typeChanges: []
      }, update: null
    };
  }
  const propertyKey = getInvoiceSchemaBaselineKey_(client.id);
  try {
    const currentProfile = buildInvoiceSchemaProfile_(client, range, invoiceCount, diagnostics);
    const previousProfile = loadInvoiceSchemaProfileByKey_(propertyKey);
    if (previousProfile && String(currentProfile.snapshotWeek || '') <
        String(previousProfile.snapshotWeek || '')) {
      return {
        check: {
...baseCheck, status: 'skipped_older_snapshot', hasChanges: false,
          fieldCount: Object.keys(currentProfile.fields).length, previousSnapshotWeek: previousProfile.snapshotWeek,
          newPaths: [], notObservedPathCount: 0, suspectedRemovedPaths: [], typeChanges: []
        }, update: null
      };
    }
    const comparison = compareInvoiceSchemaProfiles_(previousProfile, currentProfile);
    const mergedProfile = mergeInvoiceSchemaProfiles_(previousProfile, currentProfile);
    return {
      check: {
...baseCheck, status: comparison.status, hasChanges: comparison.hasChanges,
        fieldCount: Object.keys(currentProfile.fields).length, previousSnapshotWeek: comparison.previousSnapshotWeek,
        newPaths: comparison.newPaths, notObservedPathCount: comparison.notObservedPaths.length, suspectedRemovedPaths:
          comparison.suspectedRemovedPaths, typeChanges: comparison.typeChanges
      }, update: {
        propertyKey: propertyKey, profile: mergedProfile
      }
    };
  } catch (error) {
    return {
      check: {
...baseCheck, status: 'baseline_error', hasChanges: false, fieldCount: 0, previousSnapshotWeek: null, newPaths: [],
        notObservedPathCount: 0, suspectedRemovedPaths: [], typeChanges: [], error: error.message
      }, update: null
    };
  }
}

function persistInvoiceSchemaBaselineUpdates_(updates) {
  const results = (updates || []).map(update => {
    try {
      const saved = saveInvoiceSchemaProfileByKey_(update.propertyKey, update.profile);
      return {
        propertyKey: update.propertyKey, clientId: update.profile.clientId, clientName: update.profile.clientName,
        status: 'saved', byteCount: saved.byteCount, error: null
      };
    } catch (error) {
      return {
        propertyKey: update.propertyKey, clientId: update.profile.clientId, clientName: update.profile.clientName,
        status: 'failed', byteCount: null, error: error.message
      };
    }
  });
  const failures = results.filter(result => result.status === 'failed');
  return {
    status: failures.length ? 'completed_with_failures' : 'completed', attemptedCount: results.length,
    savedCount: results.length - failures.length, failureCount: failures.length, results: results
  };
}

function summarizeInvoiceSchemaMonitoring_(checks) {
  const safeChecks = checks || [];
  const countStatus = status => safeChecks.filter(check => check.status === status).length;
  const changes = safeChecks.filter(check => check.hasChanges || check.status === 'baseline_error').map(check => ({
      clientId: check.clientId, clientName: check.clientName, status: check.status, previousSnapshotWeek:
        check.previousSnapshotWeek, currentSnapshotWeek: check.currentSnapshotWeek, newPaths: check.newPaths,
      suspectedRemovedPaths: check.suspectedRemovedPaths, typeChanges: check.typeChanges, error: check.error || null
    }));
  return {
    clientCount: safeChecks.length, baselineMissingCount: countStatus('baseline_missing'), unchangedCount:
      countStatus('unchanged'), observedVariationCount: countStatus('observed_variation'), changedCount:
      countStatus('changed'), skippedNoInvoicesCount: countStatus('skipped_no_invoices'), skippedOlderSnapshotCount:
      countStatus('skipped_older_snapshot'), errorCount: countStatus('baseline_error'), changes: changes,
    clientChecks: safeChecks.map(check => ({
      clientId: check.clientId, clientName: check.clientName, invoiceCount: check.invoiceCount, status: check.status,
      fieldCount: check.fieldCount, previousSnapshotWeek: check.previousSnapshotWeek, currentSnapshotWeek:
        check.currentSnapshotWeek, newPathCount: check.newPaths.length, notObservedPathCount:
        check.notObservedPathCount, suspectedRemovedPathCount: check.suspectedRemovedPaths.length, typeChangeCount:
        check.typeChanges.length
    }))
  };
}

/***********************
 * Dates
 ***********************/

function todayIsoDate_() {
  return Utilities.formatDate(new Date(), getSpreadsheetTimeZone_(), 'yyyy-MM-dd');
}

function getPreviousCompletedWeekRange_(referenceIsoDate) {
  const referenceDateText = normalizeDateForOutput_(referenceIsoDate || todayIsoDate_());
  const referenceDate = safeParseDate_(referenceDateText);
  if (!referenceDate) {
    throw new Error('Unable to calculate the invoice week range. Invalid reference date: ' + referenceIsoDate);
  }
  const daysSinceMonday = (referenceDate.getUTCDay() + 6) % 7;
  const currentWeekMonday = new Date(referenceDate.getTime());
  currentWeekMonday.setUTCDate(currentWeekMonday.getUTCDate() - daysSinceMonday);
  const dateFrom = new Date(currentWeekMonday.getTime());
  dateFrom.setUTCDate(dateFrom.getUTCDate() - 7);
  const dateTo = new Date(currentWeekMonday.getTime());
  dateTo.setUTCDate(dateTo.getUTCDate() - 1);
  const snapshotDateIso = formatUtcDate_(currentWeekMonday);
  const dateFromIso = formatUtcDate_(dateFrom);
  const dateToIso = formatUtcDate_(dateTo);
  return {
    snapshotDate: snapshotDateIso, snapshotWeek: dateFromIso, dateFrom: dateFromIso, dateTo: dateToIso,
    periodKey: [dateFromIso, dateToIso].join('|')
  };
}

function formatUtcDate_(date) {
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}

function normalizeDateForOutput_(value) {
  const date = safeParseDate_(value);
  if (!date) return '';
  return formatUtcDate_(date);
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
    const spreadsheetTimeZone = ss ? ss.getSpreadsheetTimeZone() : '';
    return spreadsheetTimeZone || Session.getScriptTimeZone() || 'Etc/UTC';
  } catch (error) {
    return Session.getScriptTimeZone() || 'Etc/UTC';
  }
}

/***********************
 * QBO Clients and Requests
 ***********************/

function fetchClients_(loadedEntityConfiguration) {
  const loaded = loadedEntityConfiguration || loadInvoiceEntityConfiguration_();
  const configuration = loaded.configuration;
  const authorizationMaps = buildInvoiceEntityAuthorizationMaps_(configuration);

  const url = INVOICE_CONFIG.baseUrl + '/clients';
  const payload = fetchJsonOrThrow_(url, '/clients');
  const clients = extractClientsArray_(payload);

  if (!clients.length) {
    throw new Error(
      'The QBO /clients endpoint returned no clients. ' +
      'Invoice processing was stopped before BigQuery.'
    );
  }

  const clientsById = {};
  let clientIdMatchCount = 0;
  let firstWordMatchCount = 0;

  clients.forEach(client => {
    const id = String(
      client.id ||
      client.clientId ||
      client.client_id ||
      ''
    ).trim();

    const name = String(
      client.name ||
      client.clientName ||
      client.displayName ||
      client.companyName ||
      ''
    ).trim();

    if (!id || !name) return;

    const firstWord = getFirstWordNormalized_(name);
    const clientIdAlias = authorizationMaps.clientIdAliases[id] || '';
    const firstWordAlias = authorizationMaps.firstWordAliases[firstWord] || '';

    // Client ID is more specific and therefore has precedence.
    const entityAlias = clientIdAlias || firstWordAlias;

    if (!entityAlias) return;

    const authorizationMatchType = clientIdAlias
      ? 'client_id'
      : 'first_word';

    const authorizationMatchValue = clientIdAlias
      ? id
      : firstWord;

    if (authorizationMatchType === 'client_id') {
      clientIdMatchCount++;
    } else {
      firstWordMatchCount++;
    }

    clientsById[id] = {
      id: id,
      name: name,
      entity: String(
        client.entity ||
        client.slug ||
        entityAlias
      ).trim(),
      entityAlias: entityAlias,
      firstWord: firstWord,
      authorizationMatchType: authorizationMatchType,
      authorizationMatchValue: authorizationMatchValue
    };
  });

  const filteredClientCount = Object.keys(clientsById).length;

  if (!filteredClientCount) {
    throw new Error(
      'No QBO clients matched the published invoice entity configuration. ' +
      'ConfigurationVersion=' +
      configuration.configuration_version +
      '. Invoice processing was stopped before BigQuery.'
    );
  }

  Logger.log(JSON.stringify({
    event: 'invoice_clients_filtered',
    configurationSource: loaded.source,
    configurationVersion: configuration.configuration_version,
    configurationHash: configuration.configuration_hash,
    authorizationEntityCount: configuration.entities.length,
    sourceClientCount: clients.length,
    filteredClientCount: filteredClientCount,
    clientIdMatchCount: clientIdMatchCount,
    firstWordMatchCount: firstWordMatchCount
  }));

  return clientsById;
}

function fetchJsonOrThrow_(url, contextLabel) {
  const response = fetchJsonResponse_(url);
  if (response.error) {
    throw new Error('Network error for ' + contextLabel + ': ' + response.error);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(contextLabel + ' returned HTTP ' + response.status + ': ' + response.body.slice(0, 500));
  }
  if (response.parseError) {
    throw new Error('Invalid JSON returned by ' + contextLabel + ': ' + response.parseError);
  }
  return response.json;
}

function fetchJsonResponse_(url) {
  const options = {
    method: 'get', headers: { 'X-API-Key': getQboApiKey_() }, muteHttpExceptions: true
  };
  try {
    const response = UrlFetchApp.fetch(url, options);
    const body = response.getContentText();
    let json = null;
    let parseError = null;
    try {
      json = JSON.parse(body);
    } catch (error) {
      parseError = String(error);
    }
    return {
      status: response.getResponseCode(), body: body, json: json, parseError: parseError
    };
  } catch (error) {
    return {
      status: 0, body: '', json: null, parseError: null, error: String(error)
    };
  }
}

function mergeInvoiceSchemaProfiles_(previousProfile, currentProfile) {
  if (!previousProfile) {
    const initialFields = {};
    Object.keys(currentProfile.fields || {}).forEach(path => {
      const currentField = currentProfile.fields[path];
      initialFields[path] = {
        t: Array.from(new Set(currentField.t || [])).sort(), o: Number(currentField.o || 0),
        l: currentProfile.snapshotWeek, m: 0
      };
    });
    return {
      version: INVOICE_SCHEMA_BASELINE_VERSION, clientId: currentProfile.clientId,
      clientName: currentProfile.clientName, snapshotWeek: currentProfile.snapshotWeek,
      periodKey: currentProfile.periodKey, invoiceCount: currentProfile.invoiceCount,
      capturedAt: currentProfile.capturedAt, fields: initialFields
    };
  }
  const previousFields = previousProfile.fields || {};
  const currentFields = currentProfile.fields || {};
  const mergedFields = {};
  const snapshotWeekAdvanced = String(currentProfile.snapshotWeek || '') >
    String(previousProfile.snapshotWeek || '');
  const paths = Array.from(new Set([...Object.keys(previousFields),...Object.keys(currentFields)])).sort();
  paths.forEach(path => {
    const previousField = previousFields[path] || null;
    const currentField = currentFields[path] || null;
    if (currentField) {
      mergedFields[path] = {
        t: Array.from(new Set([...(previousField && Array.isArray(previousField.t) ? previousField.t : []),
...(currentField.t || [])])).sort(), o: Number(currentField.o || 0), l: currentProfile.snapshotWeek, m: 0
      };
      return;
    }
    mergedFields[path] = {
      t: Array.from(new Set(previousField.t || [])).sort(), o: 0, l: previousField.l || previousProfile.snapshotWeek ||
        null, m: Number(previousField.m || 0) + (snapshotWeekAdvanced ? 1 : 0)
    };
  });
  return {
    version: INVOICE_SCHEMA_BASELINE_VERSION, clientId: currentProfile.clientId, clientName: currentProfile.clientName,
    snapshotWeek: currentProfile.snapshotWeek, periodKey: currentProfile.periodKey,
    invoiceCount: currentProfile.invoiceCount, capturedAt: currentProfile.capturedAt, fields: mergedFields
  };
}

/***********************
 * Invoice Fetching
 ***********************/

function fetchInvoices_(clientId, dateFrom, dateTo) {
  const normalizedClientId = String(clientId || '').trim();
  const normalizedDateFrom = normalizeDateForOutput_(dateFrom);
  const normalizedDateTo = normalizeDateForOutput_(dateTo);
  if (!normalizedClientId) {
    throw new Error('Client ID is required to fetch invoices.');
  }
  if (!normalizedDateFrom || !normalizedDateTo) {
    throw new Error('A valid invoice date range is required. ' + 'dateFrom=' + dateFrom + ', dateTo=' + dateTo);
  }
  const parsedDateFrom = safeParseDate_(normalizedDateFrom);
  const parsedDateTo = safeParseDate_(normalizedDateTo);
  if (parsedDateFrom.getTime() > parsedDateTo.getTime()) {
    throw new Error('Invoice dateFrom cannot be later than dateTo. ' + normalizedDateFrom + ' > ' + normalizedDateTo);
  }
  const url = buildInvoicesUrl_(normalizedClientId, normalizedDateFrom, normalizedDateTo);
  const payload = fetchJsonOrThrow_(url, '/qbo/' + normalizedClientId + '/invoices');
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid invoice response for client ' + normalizedClientId + '. Expected a JSON object.');
  }
  if (!Array.isArray(payload.items)) {
    throw new Error('Invalid invoice response for client ' + normalizedClientId + '. Expected payload.items to be an array.');
  }
  const items = payload.items;
  const nextStartPosition =
    payload.next_startposition === undefined || payload.next_startposition === null || payload.next_startposition === ''
      ? null : payload.next_startposition;
  if (items.length >= INVOICE_CONFIG.maxResults || nextStartPosition !== null) {
    throw new Error('Invoice query may be incomplete for client ' + normalizedClientId + '. items=' + items.length +
        ', maxResults=' + INVOICE_CONFIG.maxResults + ', nextStartPosition=' + nextStartPosition + ', dateFrom=' +
        normalizedDateFrom + ', dateTo=' + normalizedDateTo);
  }
  return {
    clientId: normalizedClientId, dateFrom: normalizedDateFrom, dateTo: normalizedDateTo, invoiceCount: items.length,
    nextStartPosition: nextStartPosition, latencyMs: numberOrNull_(payload.latency_ms),
    refreshed: payload.refreshed === true, items: items
  };
}

function buildInvoicesUrl_(clientId, dateFrom, dateTo) {
  const query = ['environment=' + encodeURIComponent(INVOICE_CONFIG.environment),
    'date_from=' + encodeURIComponent(dateFrom), 'date_to=' + encodeURIComponent(dateTo),
    'maxresults=' + encodeURIComponent(INVOICE_CONFIG.maxResults)].join('&');
  return INVOICE_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(clientId) + '/invoices?' + query;
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sha256Hex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );

  return bytes.map(byte => {
    const unsignedByte = (byte + 256) % 256;
    return ('0' + unsignedByte.toString(16)).slice(-2);
  }).join('');
}

function buildInvoiceIdempotencyKey_(row) {
  const canonicalIdentity = JSON.stringify([
    'invoice_snapshot',
    'v1',
    INVOICE_CONFIG.environment,
    row.ClientId,
    row.SnapshotWeek,
    row.InvoiceId,
    row.RecordType,
    Number(row.RecordOrder),
    stringOrNull_(row.LineId) || '',
    stringOrNull_(row.LineType) || ''
  ]);

  return sha256Hex_(canonicalIdentity);
}

/***********************
 * Invoice Normalization
 ***********************/

function normalizeInvoices_(client, range, invoiceResult, loadedAt) {
  if (!client || !client.id) throw new Error('A valid client is required to normalize invoices.');
  if (!range || !range.dateFrom || !range.dateTo) {
    throw new Error('A valid weekly range is required to normalize invoices.');
  }

  const invoices = invoiceResult && Array.isArray(invoiceResult.items) ? invoiceResult.items : [];
  const normalizedLoadedAt = loadedAt || new Date().toISOString();
  const diagnostics = createInvoiceSourceDiagnostics_();
  const rows = [];
  const stats = {
    invoiceCount: invoices.length,
    sourceLineCount: 0,
    snapshotRowCount: 0,
    headerRowCount: 0,
    lineRowCount: 0,
    salesLineCount: 0,
    discountLineCount: 0,
    descriptionLineCount: 0,
    ignoredSubtotalCount: 0,
    unsupportedLineCount: 0
  };

  invoices.forEach((invoice, invoiceIndex) => {
    const invoiceContext = client.name + ' invoice[' + invoiceIndex + ']';
    inspectInvoiceSourceSchema_(invoice, diagnostics);

    const header = buildInvoiceHeaderContext_(
      client, range, invoice, normalizedLoadedAt, diagnostics, invoiceContext
    );

    const mappedLines = resolveInvoiceSourceField_(
      'invoice', invoice, 'lines', diagnostics,
      invoiceContext + ', invoiceId=' + header.InvoiceId
    );

    if (mappedLines !== null && !Array.isArray(mappedLines)) {
      throw new Error(
        'Invalid invoice lines type. Expected an array. Context=' + invoiceContext +
        ', invoiceId=' + header.InvoiceId + ', actualType=' + typeof mappedLines
      );
    }

    const lines = Array.isArray(mappedLines) ? mappedLines : [];
    rows.push(buildInvoiceHeaderRow_(header));
    stats.headerRowCount++;

    let recordOrder = 0;

    lines.forEach((line, lineIndex) => {
      const lineContext = [
        invoiceContext,
        'invoiceId=' + header.InvoiceId,
        'line[' + lineIndex + ']'
      ].join(', ');

      stats.sourceLineCount++;

      const lineTypeValue = resolveInvoiceSourceField_(
        'line', line, 'lineType', diagnostics, lineContext
      );

      const lineType = String(lineTypeValue || 'Unknown').trim() || 'Unknown';

      if (lineType === 'SubTotalLineDetail') {
        stats.ignoredSubtotalCount++;
        return;
      }

      recordOrder++;
      if (lineType === 'SalesItemLineDetail') stats.salesLineCount++;
      else if (lineType === 'DiscountLineDetail') stats.discountLineCount++;
      else if (lineType === 'DescriptionOnly') stats.descriptionLineCount++;
      else stats.unsupportedLineCount++;

      rows.push(normalizeInvoiceLine_(
        header, line, lineType, recordOrder, diagnostics,
        lineContext + ', recordOrder=' + recordOrder
      ));

      stats.lineRowCount++;
    });
  });

  stats.snapshotRowCount = rows.length;
  return { rows, stats, diagnostics };
}

function buildInvoiceHeaderContext_(client, range, invoice, loadedAt, diagnostics, contextLabel) {
  const invoiceId = resolveInvoiceSourceField_('invoice', invoice, 'invoiceId', diagnostics, contextLabel);
  const resolvedContext = contextLabel + ', invoiceId=' + invoiceId;
  const resolveInvoiceField = (fieldName) => resolveInvoiceSourceField_('invoice', invoice, fieldName, diagnostics,
      resolvedContext);
  const currencyRef = resolveInvoiceField('currencyRef') || {};
  const customerRef = resolveInvoiceField('customerRef') || {};
  const salesTermRef = resolveInvoiceField('salesTermRef') || {};
  const departmentRef = resolveInvoiceField('departmentRef') || {};
  const metadata = resolveInvoiceField('metadata') || {};
  const linkedTransactionsValue = resolveInvoiceField('linkedTransactions');
  if (linkedTransactionsValue !== null && !Array.isArray(linkedTransactionsValue)) {
    throw new Error('Invalid linked transactions type. Expected an array. ' + 'Context=' + resolvedContext +
      ', actualType=' + typeof linkedTransactionsValue);
  }
  const linkedTransactions = Array.isArray(linkedTransactionsValue) ? linkedTransactionsValue : [];
  const resolveMetadataField = (fieldName) => metadata && typeof metadata === 'object' ? resolveInvoiceSourceField_(
          'metadata', metadata, fieldName, diagnostics, resolvedContext) : null;
  const createdAt = resolveMetadataField('createdAt');
  const updatedAt = resolveMetadataField('updatedAt');
  const lastModifiedByRef = resolveMetadataField('lastModifiedByRef') || {};
  const linkedTxnIds = linkedTransactions.map((linkedTransaction, index) => {
      const value = resolveInvoiceSourceField_('linkedTransaction', linkedTransaction, 'transactionId', diagnostics,
        resolvedContext + ', linkedTransaction[' + index + ']');
      return stringOrNull_(value);
    }).filter(Boolean).join('|') || null;
  const linkedTxnTypes = linkedTransactions.map((linkedTransaction, index) => {
      const value = resolveInvoiceSourceField_('linkedTransaction', linkedTransaction, 'transactionType', diagnostics,
        resolvedContext + ', linkedTransaction[' + index + ']');
      return stringOrNull_(value);
    }).filter(Boolean).join('|') || null;
  const syncToken = resolveInvoiceField('syncToken');
  const docNumber = resolveInvoiceField('docNumber');
  const txnDate = resolveInvoiceField('txnDate');
  const dueDate = resolveInvoiceField('dueDate');
  const shipDate = resolveInvoiceField('shipDate');
  const billEmail = resolveInvoiceField('billEmail');
  const printStatus = resolveInvoiceField('printStatus');
  const emailStatus = resolveInvoiceField('emailStatus');
  const eInvoiceStatus = resolveInvoiceField('eInvoiceStatus');
  const totalAmount = resolveInvoiceField('totalAmount');
  const balance = resolveInvoiceField('balance');
  const billAddress = resolveInvoiceField('billAddress');
  const shipAddress = resolveInvoiceField('shipAddress');
  const shipFromAddress = resolveInvoiceField('shipFromAddress');
  return {
    ReportType: INVOICE_CONFIG.reportType, Entity: client.entityAlias || client.entity || slugifyEntity_(client.name),
    ClientName: String(client.name || '').trim(), ClientId: String(client.id || '').trim(),
    SnapshotDate: range.snapshotDate, SnapshotWeek: range.snapshotWeek, DateFrom: range.dateFrom, DateTo: range.dateTo,
    LoadedAt: loadedAt, InvoiceId: stringOrNull_(invoiceId), SyncToken: stringOrNull_(syncToken),
    DocNumber: stringOrNull_(docNumber), TxnDate: optionalIsoDate_(txnDate), DueDate: optionalIsoDate_(dueDate),
    ShipDate: optionalIsoDate_(shipDate), CustomerId: refValue_(customerRef), CustomerName: refName_(customerRef),
    CurrencyCode: refValue_(currencyRef) || INVOICE_CONFIG.currencyDefault, CurrencyName: refName_(currencyRef),
    SalesTermId: refValue_(salesTermRef), SalesTermName: refName_(salesTermRef), DepartmentId: refValue_(departmentRef),
    DepartmentName: refName_(departmentRef), BillEmail: extractEmailAddress_(billEmail),
    PrintStatus: stringOrNull_(printStatus), EmailStatus: stringOrNull_(emailStatus),
    EInvoiceStatus: stringOrNull_(eInvoiceStatus), TotalAmount: numberOrZero_(totalAmount),
    Balance: numberOrZero_(balance), PaymentStatus: getInvoicePaymentStatus_(totalAmount, balance),
    LinkedTxnIds: linkedTxnIds, LinkedTxnTypes: linkedTxnTypes, BillAddress: formatInvoiceAddress_(billAddress),
    ShipAddress: formatInvoiceAddress_(shipAddress), ShipFromAddress: formatInvoiceAddress_(shipFromAddress),
    CreatedAt: stringOrNull_(createdAt), UpdatedAt: stringOrNull_(updatedAt),
    LastModifiedBy: refValue_(lastModifiedByRef), Source: INVOICE_CONFIG.sourceDefault
  };
}

function buildInvoiceBaseRow_(header, recordType, recordOrder) {
  return {
    idempotency_key: null,
    RecordType: recordType,
    RecordOrder: Number(recordOrder),

    ReportType: header.ReportType,
    Entity: header.Entity,
    ClientName: header.ClientName,
    ClientId: header.ClientId,

    SnapshotDate: header.SnapshotDate,
    SnapshotWeek: header.SnapshotWeek,
    DateFrom: header.DateFrom,
    DateTo: header.DateTo,
    LoadedAt: header.LoadedAt,

    InvoiceId: header.InvoiceId,
    Source: header.Source,

    _sortTxnDate: header.TxnDate || '',
    _sortDocNumber: header.DocNumber || '',
    _sortInvoiceId: header.InvoiceId || ''
  };
}

function buildInvoiceHeaderRow_(header) {
  const row = {
    ...buildInvoiceBaseRow_(header, 'HEADER', 0),

    SyncToken: header.SyncToken,
    DocNumber: header.DocNumber,
    TxnDate: header.TxnDate,
    DueDate: header.DueDate,
    ShipDate: header.ShipDate,

    CustomerId: header.CustomerId,
    CustomerName: header.CustomerName,
    CurrencyCode: header.CurrencyCode,
    CurrencyName: header.CurrencyName,
    SalesTermId: header.SalesTermId,
    SalesTermName: header.SalesTermName,
    DepartmentId: header.DepartmentId,
    DepartmentName: header.DepartmentName,

    BillEmail: header.BillEmail,
    PrintStatus: header.PrintStatus,
    EmailStatus: header.EmailStatus,
    EInvoiceStatus: header.EInvoiceStatus,

    TotalAmount: header.TotalAmount,
    Balance: header.Balance,
    PaymentStatus: header.PaymentStatus,

    LinkedTxnIds: header.LinkedTxnIds,
    LinkedTxnTypes: header.LinkedTxnTypes,
    BillAddress: header.BillAddress,
    ShipAddress: header.ShipAddress,
    ShipFromAddress: header.ShipFromAddress,

    CreatedAt: header.CreatedAt,
    UpdatedAt: header.UpdatedAt,
    LastModifiedBy: header.LastModifiedBy
  };

  row.idempotency_key = buildInvoiceIdempotencyKey_(row);
  return row;
}

function normalizeInvoiceLine_(header, line, lineType, recordOrder, diagnostics, contextLabel) {
  const resolveLineField = fieldName =>
    resolveInvoiceSourceField_('line', line, fieldName, diagnostics, contextLabel);

  const lineId = resolveLineField('lineId');
  const lineNumber = resolveLineField('lineNumber');
  const description = resolveLineField('description');
  const amountValue = resolveLineField('amount');
  const requiresAmount = lineType === 'SalesItemLineDetail' || lineType === 'DiscountLineDetail';

  if (requiresAmount && !isSourceValuePresent_(amountValue)) {
    throw new Error(
      'Required invoice line amount not found. Context=' + contextLabel +
      ', lineType=' + lineType
    );
  }

  let salesDetail = null;
  let discountDetail = null;

  if (lineType === 'SalesItemLineDetail') {
    salesDetail = resolveLineField('salesDetail');
    if (!salesDetail || typeof salesDetail !== 'object' || Array.isArray(salesDetail)) {
      throw new Error('SalesItemLineDetail object not found or invalid. Context=' + contextLabel);
    }
  }

  if (lineType === 'DiscountLineDetail') {
    discountDetail = resolveLineField('discountDetail');
    if (!discountDetail || typeof discountDetail !== 'object' || Array.isArray(discountDetail)) {
      throw new Error('DiscountLineDetail object not found or invalid. Context=' + contextLabel);
    }
  }

  const resolveSalesField = fieldName => salesDetail
    ? resolveInvoiceSourceField_('salesDetail', salesDetail, fieldName, diagnostics, contextLabel)
    : null;

  const resolveDiscountField = fieldName => discountDetail
    ? resolveInvoiceSourceField_('discountDetail', discountDetail, fieldName, diagnostics, contextLabel)
    : null;

  const itemRef = resolveSalesField('itemRef') || {};
  const accountRef = resolveSalesField('accountRef') || {};
  const taxCodeRef = resolveSalesField('taxCodeRef') || {};
  const classRef = resolveSalesField('classRef') || {};
  const serviceDate = resolveSalesField('serviceDate');
  const unitPrice = resolveSalesField('unitPrice');
  const quantity = resolveSalesField('quantity');
  const discountPercent = resolveDiscountField('discountPercent');
  const discountAccountRef = resolveDiscountField('discountAccountRef') || {};

  const rawAmount = lineType === 'DescriptionOnly' ? 0 : numberOrZero_(amountValue);
  const signedAmount = lineType === 'DiscountLineDetail' ? -Math.abs(rawAmount) : rawAmount;

  const row = {
    ...buildInvoiceBaseRow_(header, 'LINE', recordOrder),

    LineId: stringOrNull_(lineId),
    LineNumber: numberOrNull_(lineNumber),
    LineType: lineType,
    Description: stringOrNull_(description),
    ServiceDate: optionalIsoDate_(serviceDate),

    LineAmountRaw: rawAmount,
    LineAmountSigned: signedAmount,

    ItemId: refValue_(itemRef),
    ItemName: refName_(itemRef),
    UnitPrice: numberOrNull_(unitPrice),
    Quantity: numberOrNull_(quantity),

    AccountId: refValue_(accountRef),
    AccountName: refName_(accountRef),
    TaxCode: refValue_(taxCodeRef) || refName_(taxCodeRef),
    ClassId: refValue_(classRef),
    ClassName: refName_(classRef),

    DiscountPercent: numberOrNull_(discountPercent),
    DiscountAccountId: refValue_(discountAccountRef),
    DiscountAccountName: refName_(discountAccountRef)
  };

  row.idempotency_key = buildInvoiceIdempotencyKey_(row);
  return row;
}

/***********************
 * Normalization Helpers
 ***********************/

function extractClientsArray_(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.clients)) return payload.clients;
  if (payload.data && Array.isArray(payload.data.clients)) {
    return payload.data.clients;
  }
  if (payload.data && Array.isArray(payload.data.items)) {
    return payload.data.items;
  }
  if (Array.isArray(payload.items)) return payload.items;
  return [];
}

function getFirstWordNormalized_(name) {
  const tokens = String(name || '').trim().toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return tokens.length ? tokens[0] : '';
}

function slugifyEntity_(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

function getInvoicePaymentStatus_(totalAmount, balance) {
  const total = numberOrZero_(totalAmount);
  const openBalance = numberOrZero_(balance);
  if (openBalance <= 0) return 'paid';
  if (total > 0 && openBalance < total) {
    return 'partially_paid';
  }
  return 'open';
}

function formatInvoiceAddress_(address) {
  if (!address || typeof address !== 'object') {
    return null;
  }
  const values = [address.Line1, address.Line2, address.Line3, address.Line4, address.Line5, address.City,
    address.CountrySubDivisionCode, address.PostalCode, address.Country];
  const parts = values.map((value) => String(value || '').trim()).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function extractEmailAddress_(emailObject) {
  if (!emailObject) return null;
  if (typeof emailObject === 'string') {
    return stringOrNull_(emailObject);
  }
  return stringOrNull_(emailObject.Address || emailObject.address);
}

function refValue_(reference) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }
  return stringOrNull_(reference.value !== undefined ? reference.value : reference.id);
}

function refName_(reference) {
  if (!reference || typeof reference !== 'object') {
    return null;
  }
  return stringOrNull_(reference.name !== undefined ? reference.name : reference.label);
}

function stringOrNull_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}

function numberOrZero_(value) {
  const number = numberOrNull_(value);
  return number === null ? 0 : number;
}

function optionalIsoDate_(value) {
  const normalized = normalizeDateForOutput_(value);
  return normalized || null;
}

/***********************
 * Snapshot Assembly
 ***********************/

function buildInvoiceSnapshot_(loadedEntityConfigurationOverride) {
  const range = getPreviousCompletedWeekRange_();
  const loadedAt = new Date().toISOString();
  const loadedEntityConfiguration = loadedEntityConfigurationOverride || loadInvoiceEntityConfiguration_();

  if (!loadedEntityConfiguration || !loadedEntityConfiguration.configuration) {
    throw new Error('A valid loaded Invoice entity configuration is required.');
  }

  const validatedConfiguration = validateInvoiceEntityConfiguration_(
    loadedEntityConfiguration.configuration
  );
  const effectiveConfiguration = {
    source: String(loadedEntityConfiguration.source || 'configuration_override'),
    configuration: validatedConfiguration
  };
  const clientsById = fetchClients_(effectiveConfiguration);
  const clients = Object.keys(clientsById).map(clientId => clientsById[clientId]).sort((a, b) => {
    const entityDiff = String(a.entityAlias).localeCompare(String(b.entityAlias));
    return entityDiff || String(a.name).localeCompare(String(b.name));
  });
  const lineRows = [];
  const diagnostics = createInvoiceSourceDiagnostics_();
  const mappingWarnings = [];
  const schemaChecks = [];
  const schemaBaselineUpdates = [];

  Logger.log('Filtered invoice clients: ' + clients.length);
  clients.forEach(client => {
    Logger.log('Fetching invoices for ' + client.name + ' [' + client.id + ']');
    const invoiceResult = fetchInvoices_(client.id, range.dateFrom, range.dateTo);
    const normalized = normalizeInvoices_(client, range, invoiceResult, loadedAt);
    normalized.rows.forEach(row => lineRows.push(row));
    mergeInvoiceSourceDiagnostics_(diagnostics, normalized.diagnostics);
    const clientDiagnostics = summarizeInvoiceSourceDiagnostics_(normalized.diagnostics);

    if (clientDiagnostics.aliasResolutionCount > 0 || clientDiagnostics.normalizedKeyMatchCount > 0) {
      mappingWarnings.push({
        clientId: client.id,
        clientName: client.name,
        aliasResolutionCount: clientDiagnostics.aliasResolutionCount,
        normalizedKeyMatchCount: clientDiagnostics.normalizedKeyMatchCount,
        aliasesUsed: clientDiagnostics.aliasesUsed,
        normalizedKeyMatches: clientDiagnostics.normalizedKeyMatches
      });
    }

    const schemaBaseline = prepareInvoiceSchemaBaseline_(
      client,
      range,
      normalized.stats.invoiceCount,
      normalized.diagnostics
    );
    schemaChecks.push(schemaBaseline.check);
    if (schemaBaseline.update) schemaBaselineUpdates.push(schemaBaseline.update);

    Logger.log(
      client.name + ': invoices=' + normalized.stats.invoiceCount +
      ', snapshotRows=' + normalized.stats.snapshotRowCount +
      ', aliases=' + clientDiagnostics.aliasResolutionCount +
      ', normalizedKeys=' + clientDiagnostics.normalizedKeyMatchCount +
      ', schemaStatus=' + schemaBaseline.check.status
    );
  });

  sortInvoiceRows_(lineRows);
  const entityConfigurationSummary = {
    source: effectiveConfiguration.source,
    reportKey: validatedConfiguration.report_key,
    configurationVersion: validatedConfiguration.configuration_version,
    configurationHash: validatedConfiguration.configuration_hash,
    publishedAt: validatedConfiguration.published_at,
    authorizedEntityCount: validatedConfiguration.entities.length
  };

  return {
    range: range,
    loadedAt: loadedAt,
    clientCount: clients.length,
    lineRows: lineRows,
    entityConfiguration: entityConfigurationSummary,
    sourceDiagnostics: summarizeInvoiceSourceDiagnostics_(diagnostics),
    mappingWarnings: mappingWarnings,
    schemaMonitoring: summarizeInvoiceSchemaMonitoring_(schemaChecks),
    schemaBaselineUpdates: schemaBaselineUpdates
  };
}

function sortInvoiceRows_(rows) {
  rows.sort((a, b) => {
    const entityDiff = String(a.Entity || '').localeCompare(String(b.Entity || ''));
    if (entityDiff) return entityDiff;

    const clientDiff = String(a.ClientName || '').localeCompare(String(b.ClientName || ''));
    if (clientDiff) return clientDiff;

    const dateDiff = String(b._sortTxnDate || '').localeCompare(String(a._sortTxnDate || ''));
    if (dateDiff) return dateDiff;

    const documentDiff = String(a._sortDocNumber || '').localeCompare(String(b._sortDocNumber || ''));
    if (documentDiff) return documentDiff;

    const invoiceDiff = String(a._sortInvoiceId || '').localeCompare(String(b._sortInvoiceId || ''));
    if (invoiceDiff) return invoiceDiff;

    return Number(a.RecordOrder) - Number(b.RecordOrder);
  });

  return rows;
}

/***********************
 * BigQuery Validation
 ***********************/

function buildInvoiceBigQueryRows_(rows) {
  return rows.map((row, index) => {
    validateInvoiceBigQueryRow_(row, index);
    const json = {};
    INVOICE_EXPORT_COLUMNS.forEach((column) => {
      json[column] = row[column] === undefined ? null : row[column];
    });
    return json;
  });
}

function validateInvoiceBigQuerySchema_() {
  const table = BigQuery.Tables.get(
    BQ_CONFIG.projectId,
    BQ_CONFIG.rawDatasetId,
    BQ_CONFIG.snapshotsTableId
  );

  const actualFields = table.schema && Array.isArray(table.schema.fields)
    ? table.schema.fields
    : [];

  const expectedFields = INVOICE_BIGQUERY_SCHEMA;
  const fieldMismatches = [];

  const maxLength = Math.max(expectedFields.length, actualFields.length);

  for (let index = 0; index < maxLength; index++) {
    const expected = expectedFields[index] || null;
    const actual = actualFields[index] || null;

    if (!expected || !actual) {
      fieldMismatches.push({
        position: index + 1,
        expected: expected,
        actual: actual
      });
      continue;
    }

    const actualType = String(actual.type || '').toUpperCase();
    const actualMode = String(actual.mode || 'NULLABLE').toUpperCase();

    if (
      actual.name !== expected.name ||
      actualType !== expected.type ||
      actualMode !== expected.mode
    ) {
      fieldMismatches.push({
        position: index + 1,
        expected: expected,
        actual: {
          name: actual.name,
          type: actualType,
          mode: actualMode
        }
      });
    }
  }

  if (fieldMismatches.length) {
    throw new Error(
      'Invoice BigQuery schema mismatch. ' +
      JSON.stringify({
        expectedColumnCount: expectedFields.length,
        actualColumnCount: actualFields.length,
        fieldMismatches: fieldMismatches
      })
    );
  }

  return {
    status: 'passed',
    expectedColumnCount: expectedFields.length,
    actualColumnCount: actualFields.length,
    namesMatch: true,
    typesMatch: true,
    modesMatch: true,
    orderMatches: true
  };
}

function validateInvoiceBigQueryRow_(row, index) {
  const requiredColumns = [
    'idempotency_key', 'RecordType', 'RecordOrder',
    'ReportType', 'Entity', 'ClientName', 'ClientId',
    'SnapshotDate', 'SnapshotWeek', 'DateFrom', 'DateTo',
    'LoadedAt', 'InvoiceId', 'Source'
  ];

  const missingRequired = requiredColumns.filter(column => {
    const value = row[column];
    return value === null || value === undefined || String(value).trim() === '';
  });

  if (missingRequired.length) {
    throw new Error(
      'Invoice row ' + index + ' is missing required fields: ' +
      missingRequired.join(', ')
    );
  }

  if (!/^[a-f0-9]{64}$/.test(String(row.idempotency_key))) {
    throw new Error('Invoice row ' + index + ' contains an invalid SHA-256 idempotency key.');
  }

  if (row.RecordType !== 'HEADER' && row.RecordType !== 'LINE') {
    throw new Error('Invoice row ' + index + ' contains an invalid RecordType: ' + row.RecordType);
  }

  if (!Number.isInteger(Number(row.RecordOrder)) || Number(row.RecordOrder) < 0) {
    throw new Error('Invoice row ' + index + ' contains an invalid RecordOrder: ' + row.RecordOrder);
  }

  if (row.RecordType === 'HEADER') {
    if (Number(row.RecordOrder) !== 0) {
      throw new Error('Invoice HEADER row ' + index + ' must have RecordOrder=0.');
    }

    const lineFields = [
      'LineId', 'LineNumber', 'LineType', 'Description', 'ServiceDate',
      'LineAmountRaw', 'LineAmountSigned', 'ItemId', 'ItemName',
      'UnitPrice', 'Quantity', 'AccountId', 'AccountName', 'TaxCode',
      'ClassId', 'ClassName', 'DiscountPercent',
      'DiscountAccountId', 'DiscountAccountName'
    ];

    const populatedLineFields = lineFields.filter(column =>
      row[column] !== null && row[column] !== undefined && row[column] !== ''
    );

    if (populatedLineFields.length) {
      throw new Error(
        'Invoice HEADER row ' + index + ' contains line fields: ' +
        populatedLineFields.join(', ')
      );
    }
  }

  if (row.RecordType === 'LINE') {
    if (Number(row.RecordOrder) < 1) {
      throw new Error('Invoice LINE row ' + index + ' must have RecordOrder >= 1.');
    }

    ['LineType', 'LineAmountRaw', 'LineAmountSigned'].forEach(column => {
      if (row[column] === null || row[column] === undefined || row[column] === '') {
        throw new Error('Invoice LINE row ' + index + ' is missing ' + column + '.');
      }
    });

    const headerFields = [
      'SyncToken', 'DocNumber', 'TxnDate', 'DueDate', 'ShipDate',
      'CustomerId', 'CustomerName', 'CurrencyCode', 'CurrencyName',
      'SalesTermId', 'SalesTermName', 'DepartmentId', 'DepartmentName',
      'BillEmail', 'PrintStatus', 'EmailStatus', 'EInvoiceStatus',
      'TotalAmount', 'Balance', 'PaymentStatus', 'LinkedTxnIds',
      'LinkedTxnTypes', 'BillAddress', 'ShipAddress', 'ShipFromAddress',
      'CreatedAt', 'UpdatedAt', 'LastModifiedBy'
    ];

    const populatedHeaderFields = headerFields.filter(column =>
      row[column] !== null && row[column] !== undefined && row[column] !== ''
    );

    if (populatedHeaderFields.length) {
      throw new Error(
        'Invoice LINE row ' + index + ' contains header fields: ' +
        populatedHeaderFields.join(', ')
      );
    }
  }

  const dateColumns = [
    'SnapshotDate', 'SnapshotWeek', 'DateFrom', 'DateTo',
    'TxnDate', 'DueDate', 'ShipDate', 'ServiceDate'
  ];

  dateColumns.forEach(column => {
    const value = row[column];

    if (
      value !== null && value !== undefined && value !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ) {
      throw new Error(
        'Invoice row ' + index + ' contains an invalid date in ' +
        column + ': ' + value
      );
    }
  });

  ['LoadedAt', 'CreatedAt', 'UpdatedAt'].forEach(column => {
    const value = row[column];

    if (
      value !== null && value !== undefined && value !== '' &&
      isNaN(new Date(value).getTime())
    ) {
      throw new Error(
        'Invoice row ' + index + ' contains an invalid timestamp in ' +
        column + ': ' + value
      );
    }
  });

  const numericColumns = [
    'TotalAmount', 'Balance', 'LineAmountRaw', 'LineAmountSigned',
    'UnitPrice', 'Quantity', 'DiscountPercent'
  ];

  numericColumns.forEach(column => {
    const value = row[column];

    if (
      value !== null && value !== undefined && value !== '' &&
      !Number.isFinite(Number(value))
    ) {
      throw new Error(
        'Invoice row ' + index + ' contains an invalid number in ' +
        column + ': ' + value
      );
    }
  });

  if (
    row.LineNumber !== null && row.LineNumber !== undefined &&
    row.LineNumber !== '' && !Number.isInteger(Number(row.LineNumber))
  ) {
    throw new Error(
      'Invoice row ' + index + ' contains an invalid LineNumber: ' +
      row.LineNumber
    );
  }
}

function validateInvoiceSnapshotHierarchy_(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const idempotencyKeys = new Set();
  const closedInvoices = new Set();

  let activeInvoiceKey = null;
  let expectedRecordOrder = 0;
  let headerRowCount = 0;
  let lineRowCount = 0;

  safeRows.forEach((row, index) => {
    const clientId = String(row && row.ClientId || '').trim();
    const snapshotWeek = String(row && row.SnapshotWeek || '').trim();
    const invoiceId = String(row && row.InvoiceId || '').trim();
    const idempotencyKey = String(row && row.idempotency_key || '').trim();
    const recordType = String(row && row.RecordType || '').trim();
    const recordOrder = Number(row && row.RecordOrder);
    const invoiceKey = [clientId, snapshotWeek, invoiceId].join('|');

    if (!clientId || !snapshotWeek || !invoiceId) {
      throw new Error('Invoice hierarchy row ' + index + ' is missing its invoice identity.');
    }

    if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) {
      throw new Error('Invoice hierarchy row ' + index + ' has an invalid SHA-256 idempotency key.');
    }

    if (idempotencyKeys.has(idempotencyKey)) {
      throw new Error('Duplicate invoice idempotency key detected: ' + idempotencyKey);
    }

    idempotencyKeys.add(idempotencyKey);

    if (recordType !== 'HEADER' && recordType !== 'LINE') {
      throw new Error('Invoice hierarchy row ' + index + ' has an invalid RecordType: ' + recordType);
    }

    if (invoiceKey !== activeInvoiceKey) {
      if (activeInvoiceKey) closedInvoices.add(activeInvoiceKey);

      if (closedInvoices.has(invoiceKey)) {
        throw new Error('Invoice rows are not contiguous. Invoice=' + invoiceKey);
      }

      if (recordType !== 'HEADER' || recordOrder !== 0) {
        throw new Error(
          'Each invoice group must begin with HEADER RecordOrder=0. ' +
          'Invoice=' + invoiceKey + ', row=' + index
        );
      }

      activeInvoiceKey = invoiceKey;
      expectedRecordOrder = 0;
      headerRowCount++;
      return;
    }

    expectedRecordOrder++;

    if (recordType !== 'LINE' || recordOrder !== expectedRecordOrder) {
      throw new Error(
        'Invalid invoice line sequence. Invoice=' + invoiceKey +
        ', expectedRecordOrder=' + expectedRecordOrder +
        ', actualRecordType=' + recordType +
        ', actualRecordOrder=' + recordOrder
      );
    }

    lineRowCount++;
  });

  if (headerRowCount + lineRowCount !== safeRows.length) {
    throw new Error('Invoice hierarchy row totals do not reconcile.');
  }

  return {
    status: 'passed',
    rowCount: safeRows.length,
    invoiceCount: headerRowCount,
    headerRowCount: headerRowCount,
    lineRowCount: lineRowCount,
    uniqueIdempotencyKeyCount: idempotencyKeys.size
  };
}

/***********************
 * BigQuery Snapshot Load
 ***********************/

function snapshotInvoicesToBigQuery() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another Invoice snapshot or deployment execution is already running.');
  }

  try {
    return executeInvoiceBigQuerySnapshot_();
  } finally {
    lock.releaseLock();
  }
}

function executeInvoiceBigQuerySnapshot_(loadedEntityConfiguration) {
  Logger.log('--- INVOICE BIGQUERY SNAPSHOT START ---');

  const schemaValidation = validateInvoiceBigQuerySchema_();
  const result = buildInvoiceSnapshot_(loadedEntityConfiguration);
  const hierarchyValidation = validateInvoiceSnapshotHierarchy_(result.lineRows);
  const loadResult = replaceInvoiceSnapshotPartition_(result.range, result.lineRows);
  const verification = verifyInvoiceSnapshotPartition_(
    result.range.snapshotWeek,
    hierarchyValidation
  );
  const baselinePersistence = persistInvoiceSchemaBaselineUpdates_(
    result.schemaBaselineUpdates
  );

  const executionResult = {
    entityConfiguration: result.entityConfiguration,
    schemaValidation: schemaValidation,
    period: result.range,
    clientCount: result.clientCount,
    sourceRowCount: result.lineRows.length,
    hierarchyValidation: hierarchyValidation,
    sourceDiagnostics: result.sourceDiagnostics,
    mappingWarnings: result.mappingWarnings,
    schemaMonitoring: result.schemaMonitoring,
    baselinePersistence: baselinePersistence,
    loadResult: loadResult,
    verification: verification
  };

  Logger.log(JSON.stringify(executionResult, null, 2));
  Logger.log('--- INVOICE BIGQUERY SNAPSHOT END ---');
  return executionResult;
}

function replaceInvoiceSnapshotPartition_(range, rows) {
  const snapshotWeek = String((range && range.snapshotWeek) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotWeek)) {
    throw new Error('Invalid SnapshotWeek for partition replacement: ' + snapshotWeek);
  }
  rows.forEach((row, index) => {
    if (row.SnapshotWeek !== snapshotWeek) {
      throw new Error(
        'Invoice row ' + index + ' belongs to a different partition. Expected=' + snapshotWeek + ', actual=' + row.SnapshotWeek
      );
    }
  });
  if (!rows.length) return clearEmptyInvoicePartition_(snapshotWeek);
  const ndjson = buildInvoiceBigQueryRows_(rows).map((row) => JSON.stringify(row)).join('\n');
  const partitionId = snapshotWeek.replace(/-/g, '');
  const destinationTableId = BQ_CONFIG.snapshotsTableId + '$' + partitionId;
  const jobId = ['invoice_snapshot', partitionId, Date.now(), Utilities.getUuid().replace(/-/g, '')].join('_');
  const blob = Utilities.newBlob(ndjson, 'application/octet-stream', 'invoice_snapshot_' + partitionId + '.ndjson');
  const job = {
    jobReference: { projectId: BQ_CONFIG.projectId, jobId: jobId }, configuration: {
      load: {
        destinationTable: {
          projectId: BQ_CONFIG.projectId, datasetId: BQ_CONFIG.rawDatasetId, tableId: destinationTableId
        }, sourceFormat: 'NEWLINE_DELIMITED_JSON', createDisposition: 'CREATE_NEVER',
        writeDisposition: 'WRITE_TRUNCATE_DATA', autodetect: false, ignoreUnknownValues: false, maxBadRecords: 0
      }
    }
  };
  const insertedJob = BigQuery.Jobs.insert(job, BQ_CONFIG.projectId, blob);
  const completedJob = waitForBigQueryJob_(insertedJob.jobReference, 120000);
  return {
    mode: 'partition_replace', jobId: completedJob.jobReference.jobId,
    destinationTable: [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, destinationTableId].join('.'),
    snapshotWeek: snapshotWeek, rowCount: rows.length, payloadBytes: blob.getBytes().length,
    state: completedJob.status.state
  };
}

function waitForBigQueryJob_(jobReference, timeoutMs) {
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
    throw new Error('BigQuery job failed: ' + JSON.stringify({
          jobId: jobId, errorResult: job.status.errorResult, errors: job.status.errors || []
        }));
  }
  return job;
}

function verifyInvoiceSnapshotPartition_(snapshotWeek, expectedHierarchy) {
  const normalizedSnapshotWeek = String(snapshotWeek || '').trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedSnapshotWeek)) {
    throw new Error(
      'Invalid SnapshotWeek for partition verification: ' +
      normalizedSnapshotWeek
    );
  }

  const tableReference = [
    BQ_CONFIG.projectId,
    BQ_CONFIG.rawDatasetId,
    BQ_CONFIG.snapshotsTableId
  ].join('.');

  const query = [
    'WITH partition_rows AS (',
    '  SELECT idempotency_key, RecordType, RecordOrder, ClientId, InvoiceId',
    '  FROM `' + tableReference + '`',
    "  WHERE SnapshotWeek = DATE '" + normalizedSnapshotWeek + "'",
    '),',
    'invoice_groups AS (',
    '  SELECT ClientId, InvoiceId, COUNTIF(RecordType = "HEADER") AS header_count',
    '  FROM partition_rows',
    '  GROUP BY ClientId, InvoiceId',
    '),',
    'order_groups AS (',
    '  SELECT ClientId, InvoiceId, RecordOrder, COUNT(*) AS row_count',
    '  FROM partition_rows',
    '  GROUP BY ClientId, InvoiceId, RecordOrder',
    ')',
    'SELECT',
    '  COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS distinct_key_count,',
    '  COUNTIF(',
    '    idempotency_key IS NULL OR',
    '    NOT REGEXP_CONTAINS(idempotency_key, r"^[a-f0-9]{64}$")',
    '  ) AS invalid_key_count,',
    '  COUNTIF(RecordType = "HEADER") AS header_count,',
    '  COUNTIF(RecordType = "LINE") AS line_count,',
    '  COUNTIF(RecordType IS NULL OR RecordType NOT IN ("HEADER", "LINE"))',
    '    AS invalid_record_type_count,',
    '  COUNTIF(',
    '    RecordOrder IS NULL OR',
    '    (RecordType = "HEADER" AND RecordOrder != 0) OR',
    '    (RecordType = "LINE" AND RecordOrder < 1)',
    '  ) AS invalid_record_order_count,',
    '  (SELECT COUNT(*) FROM invoice_groups WHERE header_count != 1)',
    '    AS invalid_invoice_header_count,',
    '  (SELECT COUNT(*) FROM order_groups WHERE row_count != 1)',
    '    AS duplicate_record_order_count',
    'FROM partition_rows'
  ].join('\n');

  const result = runBigQuerySingleRowQuery_(query);
  const metrics = {};

  Object.keys(result).forEach(key => {
    metrics[key] = Number(result[key] || 0);
  });

  const expected = {
    row_count: Number(expectedHierarchy.rowCount),
    distinct_key_count: Number(expectedHierarchy.uniqueIdempotencyKeyCount),
    header_count: Number(expectedHierarchy.headerRowCount),
    line_count: Number(expectedHierarchy.lineRowCount)
  };

  const failures = [];

  Object.keys(expected).forEach(key => {
    if (metrics[key] !== expected[key]) {
      failures.push({
        metric: key,
        expected: expected[key],
        actual: metrics[key]
      });
    }
  });

  [
    'invalid_key_count',
    'invalid_record_type_count',
    'invalid_record_order_count',
    'invalid_invoice_header_count',
    'duplicate_record_order_count'
  ].forEach(key => {
    if (metrics[key] !== 0) {
      failures.push({
        metric: key,
        expected: 0,
        actual: metrics[key]
      });
    }
  });

  if (failures.length) {
    throw new Error(
      'Invoice partition verification failed. ' +
      JSON.stringify({
        snapshotWeek: normalizedSnapshotWeek,
        failures: failures,
        metrics: metrics
      })
    );
  }

  return {
    status: 'passed',
    snapshotWeek: normalizedSnapshotWeek,
    partitionId: normalizedSnapshotWeek.replace(/-/g, ''),
    rowCount: metrics.row_count,
    invoiceCount: metrics.header_count,
    headerRowCount: metrics.header_count,
    lineRowCount: metrics.line_count,
    distinctIdempotencyKeyCount: metrics.distinct_key_count,
    invalidKeyCount: metrics.invalid_key_count,
    missingKeyCount: metrics.invalid_key_count,
    invalidRecordTypeCount: metrics.invalid_record_type_count,
    invalidRecordOrderCount: metrics.invalid_record_order_count,
    invalidInvoiceHeaderCount: metrics.invalid_invoice_header_count,
    duplicateRecordOrderCount: metrics.duplicate_record_order_count
  };
}

function runBigQuerySingleRowQuery_(query) {
  const request = { query: query, useLegacySql: false, timeoutMs: 120000 };
  let result = BigQuery.Jobs.query(request, BQ_CONFIG.projectId);

  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(
      BQ_CONFIG.projectId,
      result.jobReference.jobId
    );
  }

  if (!result.rows || !result.rows.length) return {};

  const fields = result.schema && Array.isArray(result.schema.fields)
    ? result.schema.fields
    : [];

  const values = result.rows[0].f || [];
  const row = {};

  fields.forEach((field, index) => {
    row[field.name] = values[index] ? values[index].v : null;
  });

  return row;
}

function clearEmptyInvoicePartition_(snapshotWeek) {
  const tableReference = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const query = ['DELETE FROM `' + tableReference + '`', "WHERE SnapshotWeek = DATE '" + snapshotWeek + "'"].join('\n');
  const request = {
    query: query, useLegacySql: false, timeoutMs: 120000
  };
  let result = BigQuery.Jobs.query(request, BQ_CONFIG.projectId);
  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(BQ_CONFIG.projectId, result.jobReference.jobId);
  }
  return {
    mode: 'empty_partition_clear', jobId: result.jobReference.jobId, destinationTable: tableReference,
    snapshotWeek: snapshotWeek, rowCount: 0, state: 'DONE'
  };
}