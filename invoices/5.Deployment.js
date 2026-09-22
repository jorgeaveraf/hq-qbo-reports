/***********************
 * Invoice Configuration Operational Deployment
 *
 * A centralized configuration is received synchronously, persisted, and queued.
 * Operational work runs in three separate one-time-trigger stages:
 * 1. BigQuery snapshot
 * 2. Connected Sheets data-source sheets
 * 3. Connected Sheets extracts
 ***********************/

function queueInvoiceConfigurationDeployment_(pushPayload, configuration, options) {
  const settings = options || {};
  const validatedConfiguration = validateInvoiceEntityConfiguration_(configuration);
  const current = readInvoiceDeploymentState_();
  const sameConfiguration = current &&
    Number(current.configurationVersion) === Number(validatedConfiguration.configuration_version) &&
    String(current.configurationHash || '') === String(validatedConfiguration.configuration_hash || '');

  if (sameConfiguration && !(current.status === 'failed' && settings.forceRequeueFailed === true)) {
    return summarizeInvoiceDeploymentState_(current, false);
  }

  if (settings.forceRequeueFailed === true && (!sameConfiguration || !current || current.status !== 'failed')) {
    throw new Error('Explicit Invoice deployment requeue is allowed only for the current failed operation.');
  }

  const now = new Date().toISOString();
  const operationId = Utilities.getUuid();
  const state = {
    schemaVersion: '1.0',
    operationId: operationId,
    operationKey: [
      INVOICE_ENTITY_CONTROL.reportKey,
      validatedConfiguration.configuration_version,
      validatedConfiguration.configuration_hash
    ].join('|'),
    requestId: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
    reportKey: INVOICE_ENTITY_CONTROL.reportKey,
    configurationVersion: validatedConfiguration.configuration_version,
    configurationHash: validatedConfiguration.configuration_hash,
    configuration: validatedConfiguration,
    status: 'pending',
    currentStage: 'bigquery',
    attempts: {
      bigquery: 0,
      data_source_sheets: 0,
      extracts: 0
    },
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastError: null,
    lastAttempt: null,
    trigger: null,
    stages: {
      configuration: {
        status: 'completed',
        attempts: 1,
        startedAt: now,
        completedAt: now,
        error: null,
        result: null
      },
      bigquery: createInvoiceDeploymentStageState_(),
      data_source_sheets: createInvoiceDeploymentStageState_(),
      extracts: createInvoiceDeploymentStageState_()
    }
  };

  persistInvoiceDeploymentState_(state);
  scheduleInvoiceDeploymentWorker_(
    INVOICE_OPERATIONAL_DEPLOYMENT.initialDelayMs,
    state.currentStage,
    state.operationId
  );
  const queuedState = readInvoiceDeploymentState_() || state;
  return summarizeInvoiceDeploymentState_(queuedState, true);
}

function createInvoiceDeploymentStageState_() {
  return {
    status: 'pending',
    attempts: 0,
    startedAt: null,
    completedAt: null,
    error: null,
    lastAttempt: null,
    result: null
  };
}

function processInvoiceConfigurationDeployment() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    scheduleInvoiceDeploymentWorker_(
      INVOICE_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs,
      null,
      null
    );
    const deferred = { status: 'deferred_lock_busy', retryScheduled: true };
    Logger.log(JSON.stringify({ event: 'invoice_configuration_deployment_deferred', ...deferred }));
    return deferred;
  }

  let claimedState = null;
  let claimedStage = null;

  try {
    deleteInvoiceDeploymentWorkerTriggers_();
    let state = readInvoiceDeploymentState_();
    if (!state) return { status: 'no_pending_deployment' };
    if (state.status === 'completed' || state.status === 'failed') {
      return summarizeInvoiceDeploymentState_(state, false);
    }

    if (state.status === 'processing') {
      const stageState = state.stages && state.stages[state.currentStage];
      const startedAt = stageState && Date.parse(stageState.startedAt || '');
      const ageSeconds = Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : Infinity;

      if (ageSeconds < INVOICE_OPERATIONAL_DEPLOYMENT.staleProcessingSeconds) {
        scheduleInvoiceDeploymentWorker_(
          INVOICE_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs,
          state.currentStage,
          state.operationId
        );
        return {
          status: 'deferred_stage_processing',
          operationId: state.operationId,
          currentStage: state.currentStage
        };
      }

      if (stageState) {
        stageState.status = 'pending';
        stageState.error = 'Recovered after a stale processing state.';
      }
      state.status = 'pending';
      state.updatedAt = new Date().toISOString();
      state.lastError = null;
      persistInvoiceDeploymentState_(state);
    }

    claimedStage = getNextInvoiceDeploymentStage_(state);
    if (!claimedStage) {
      state.status = 'completed';
      state.currentStage = 'completed';
      state.completedAt = state.completedAt || new Date().toISOString();
      state.updatedAt = state.completedAt;
      state.lastError = null;
      state.trigger = null;
      persistInvoiceDeploymentState_(state);
      updateInvoiceDeploymentReceipt_(state);
      return summarizeInvoiceDeploymentState_(state, false);
    }

    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];
    stageState.status = 'processing';
    stageState.attempts = Number(stageState.attempts || 0) + 1;
    stageState.startedAt = now;
    stageState.completedAt = null;
    stageState.error = null;
    stageState.lastAttempt = null;
    state.attempts[claimedStage] = stageState.attempts;
    state.status = 'processing';
    state.currentStage = claimedStage;
    state.updatedAt = now;
    state.lastError = null;
    state.trigger = null;
    persistInvoiceDeploymentState_(state);
    claimedState = JSON.parse(JSON.stringify(state));

    Logger.log(JSON.stringify({
      event: 'invoice_configuration_deployment_stage_started',
      operationId: state.operationId,
      stage: claimedStage,
      attempt: stageState.attempts,
      configurationVersion: state.configurationVersion,
      configurationHash: state.configurationHash
    }));

    const stageResult = executeInvoiceDeploymentStage_(claimedStage, claimedState);
    const current = readInvoiceDeploymentState_();

    if (!current || current.operationId !== claimedState.operationId) {
      if (current && current.status === 'pending') {
        scheduleInvoiceDeploymentWorker_(
          INVOICE_OPERATIONAL_DEPLOYMENT.nextStageDelayMs,
          current.currentStage,
          current.operationId
        );
      }
      const superseded = {
        status: 'superseded',
        operationId: claimedState.operationId,
        stage: claimedStage,
        currentOperationId: current && current.operationId || null
      };
      Logger.log(JSON.stringify({ event: 'invoice_configuration_deployment_stage_superseded', ...superseded }));
      return superseded;
    }

    const completedAt = new Date().toISOString();
    const completedStage = current.stages[claimedStage];
    completedStage.status = 'completed';
    completedStage.completedAt = completedAt;
    completedStage.error = null;
    completedStage.lastAttempt = {
      stage: claimedStage,
      attempt: completedStage.attempts,
      retryScheduled: false,
      error: null,
      completedAt: completedAt
    };
    completedStage.result = compactInvoiceDeploymentStageResult_(claimedStage, stageResult);
    current.lastAttempt = completedStage.lastAttempt;
    current.updatedAt = completedAt;
    current.lastError = null;

    const nextStage = getNextInvoiceDeploymentStage_(current);
    if (nextStage) {
      current.status = 'pending';
      current.currentStage = nextStage;
      persistInvoiceDeploymentState_(current);
      updateInvoiceDeploymentReceipt_(current);
      scheduleInvoiceDeploymentWorker_(
        INVOICE_OPERATIONAL_DEPLOYMENT.nextStageDelayMs,
        nextStage,
        current.operationId
      );
    } else {
      current.status = 'completed';
      current.currentStage = 'completed';
      current.completedAt = completedAt;
      current.trigger = null;
      persistInvoiceDeploymentState_(current);
      updateInvoiceDeploymentReceipt_(current);
      deleteInvoiceDeploymentWorkerTriggers_();
    }

    const result = summarizeInvoiceDeploymentState_(current, false);
    Logger.log(JSON.stringify({
      event: 'invoice_configuration_deployment_stage_completed',
      operationId: current.operationId,
      stage: claimedStage,
      attempt: completedStage.attempts,
      configurationVersion: current.configurationVersion,
      configurationHash: current.configurationHash,
      ...result
    }));
    return result;
  } catch (error) {
    const current = readInvoiceDeploymentState_();
    let retryScheduled = false;

    if (claimedState && current && current.operationId === claimedState.operationId && claimedStage) {
      const failedAt = new Date().toISOString();
      const stageState = current.stages[claimedStage];
      const errorMessage = String(error && error.message || error);
      retryScheduled = Number(stageState.attempts || 0) < INVOICE_OPERATIONAL_DEPLOYMENT.maxStageAttempts;

      stageState.error = errorMessage;
      stageState.completedAt = failedAt;
      stageState.lastAttempt = {
        stage: claimedStage,
        attempt: Number(stageState.attempts || 0),
        retryScheduled: retryScheduled,
        error: errorMessage,
        completedAt: failedAt
      };
      current.lastAttempt = stageState.lastAttempt;
      current.updatedAt = failedAt;
      current.lastError = errorMessage;
      current.trigger = null;

      if (retryScheduled) {
        stageState.status = 'pending';
        current.status = 'pending';
        current.currentStage = claimedStage;
      } else {
        stageState.status = 'failed';
        current.status = 'failed';
        current.currentStage = claimedStage;
      }

      persistInvoiceDeploymentState_(current);
      updateInvoiceDeploymentReceipt_(current);
      if (retryScheduled) {
        scheduleInvoiceDeploymentWorker_(
          INVOICE_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs,
          claimedStage,
          current.operationId
        );
      } else {
        deleteInvoiceDeploymentWorkerTriggers_();
      }
    }

    Logger.log(JSON.stringify({
      event: 'invoice_configuration_deployment_stage_failed',
      operationId: claimedState && claimedState.operationId || null,
      stage: claimedStage,
      attempt: claimedState && claimedStage && claimedState.stages[claimedStage]
        ? claimedState.stages[claimedStage].attempts
        : null,
      retryScheduled: retryScheduled,
      error: String(error && error.message || error)
    }));

    if (retryScheduled) {
      return {
        status: 'retry_scheduled',
        operationId: claimedState.operationId,
        stage: claimedStage,
        attempt: claimedState.stages[claimedStage].attempts,
        retryScheduled: true,
        error: String(error && error.message || error)
      };
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function executeInvoiceDeploymentStage_(stage, state) {
  if (stage === 'bigquery') {
    const configuration = validateInvoiceEntityConfiguration_(
      state.configuration,
      state.configurationVersion
    );
    if (configuration.configuration_hash !== state.configurationHash) {
      throw new Error('Deployment configuration hash no longer matches the queued operation.');
    }

    const result = executeInvoiceBigQuerySnapshot_({
      source: 'configuration_push_operation',
      configuration: configuration
    });
    validateInvoiceBigQueryDeploymentResult_(result);
    return result;
  }

  if (stage === 'data_source_sheets') {
    return refreshInvoiceConnectedSheetsStage_('data_source_sheets');
  }
  if (stage === 'extracts') {
    return refreshInvoiceConnectedSheetsStage_('extracts');
  }
  throw new Error('Unsupported Invoice deployment stage: ' + stage);
}

function validateInvoiceBigQueryDeploymentResult_(result) {
  const expectedRowCount = Number(result && result.hierarchyValidation && result.hierarchyValidation.rowCount || 0);
  const actualRowCount = Number(result && result.verification && result.verification.rowCount || 0);
  const missingKeyCount = Number(result && result.verification && (
    result.verification.missingKeyCount !== undefined
      ? result.verification.missingKeyCount
      : result.verification.invalidKeyCount
  ) || 0);
  const distinctKeyCount = Number(result && result.verification && result.verification.distinctIdempotencyKeyCount || 0);

  const failures = [];
  if (!result || !result.schemaValidation || result.schemaValidation.status !== 'passed') {
    failures.push('schemaValidation.status must be passed.');
  }
  if (!result || !result.loadResult || result.loadResult.state !== 'DONE') {
    failures.push('loadResult.state must be DONE.');
  }
  if (!result || !result.verification || result.verification.status !== 'passed') {
    failures.push('verification.status must be passed.');
  }
  if (expectedRowCount !== actualRowCount) {
    failures.push('Expected and actual row counts do not match.');
  }
  if (missingKeyCount !== 0) failures.push('missingKeyCount must be 0.');
  if (distinctKeyCount !== expectedRowCount) {
    failures.push('Distinct idempotency key count must equal expected row count.');
  }

  if (failures.length) {
    throw new Error('Invoice BigQuery deployment validation failed: ' + JSON.stringify({
      failures: failures,
      expectedRowCount: expectedRowCount,
      actualRowCount: actualRowCount,
      missingKeyCount: missingKeyCount,
      distinctKeyCount: distinctKeyCount
    }));
  }

  return {
    status: 'passed',
    expectedRowCount: expectedRowCount,
    actualRowCount: actualRowCount,
    missingKeyCount: missingKeyCount,
    distinctKeyCount: distinctKeyCount
  };
}

function refreshInvoiceConnectedSheetsPipeline_(spreadsheet) {
  const sourceSheets = refreshInvoiceConnectedSheetsStage_('data_source_sheets', spreadsheet);
  const extracts = refreshInvoiceConnectedSheetsStage_('extracts', spreadsheet);
  return {
    status: 'passed',
    refreshedObjectCount: sourceSheets.refreshedObjectCount + extracts.refreshedObjectCount,
    stages: { dataSourceSheets: sourceSheets, extracts: extracts }
  };
}

function refreshInvoiceConnectedSheetsStage_(stage, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getInvoiceReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getInvoiceConnectedSheetTargets_(spreadsheet, stage);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(INVOICE_CONNECTED_SHEETS_CONFIG.timeoutSeconds);

  const executions = targets.map(target => {
    const status = target.getStatus();
    const lastRefreshedTime = status.getLastRefreshedTime();
    const lastExecutionTime = status.getLastExecutionTime();
    return {
      name: target.name,
      type: target.type,
      state: String(status.getExecutionState()),
      errorCode: String(status.getErrorCode()),
      errorMessage: String(status.getErrorMessage() || '').trim() || null,
      lastExecutionAt: lastExecutionTime ? lastExecutionTime.toISOString() : null,
      lastRefreshedAt: lastRefreshedTime ? lastRefreshedTime.toISOString() : null,
      truncated: status.isTruncated() === true
    };
  });

  const failures = executions.filter(execution =>
    execution.state !== 'SUCCESS' ||
    execution.errorCode !== 'NONE' ||
    execution.truncated === true
  );
  if (failures.length) {
    throw new Error('Invoice Connected Sheets stage failed: ' + JSON.stringify({ stage: stage, failures: failures }));
  }

  const result = {
    status: 'passed',
    stage: stage,
    refreshedObjectCount: executions.length,
    executions: executions
  };
  Logger.log(JSON.stringify({ event: 'invoice_connected_sheets_stage_completed', ...result }));
  return result;
}

function getInvoiceConnectedSheetTargets_(spreadsheet, stage) {
  let targets;
  let configuredNames;

  if (stage === 'data_source_sheets') {
    configuredNames = INVOICE_CONNECTED_SHEETS_CONFIG.sourceSheets || [];
    targets = spreadsheet.getDataSourceSheets().map(source => ({
      name: source.asSheet().getName(),
      type: 'data_source_sheet',
      refresh: () => source.refreshData(),
      getStatus: () => source.getStatus()
    }));
  } else if (stage === 'extracts') {
    configuredNames = INVOICE_CONNECTED_SHEETS_CONFIG.extractSheets || [];
    targets = spreadsheet.getDataSourceTables().map(extract => ({
      name: extract.getRange().getSheet().getName(),
      type: 'extract',
      refresh: () => extract.refreshData(),
      getStatus: () => extract.getStatus()
    }));
  } else {
    throw new Error('Unsupported Connected Sheets stage: ' + stage);
  }

  if (configuredNames.length) {
    targets = targets.filter(target => configuredNames.includes(target.name));
    const counts = {};
    targets.forEach(target => counts[target.name] = (counts[target.name] || 0) + 1);
    const missing = configuredNames.filter(name => !counts[name]);
    const duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
    if (missing.length || duplicates.length) {
      throw new Error('Invoice data source object validation failed: ' + JSON.stringify({
        stage: stage,
        missing: missing,
        duplicates: duplicates,
        counts: counts
      }));
    }
  }

  if (!targets.length) {
    throw new Error('No Invoice Connected Sheets objects were found for stage=' + stage + '.');
  }
  return targets;
}

function getInvoiceReportSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const configuredId = String(
    properties.getProperty(INVOICE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty) || ''
  ).trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('Missing Script Property: ' + INVOICE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty);
  }
  properties.setProperty(INVOICE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty, active.getId());
  return active;
}

function getNextInvoiceDeploymentStage_(state) {
  const sequence = ['bigquery', 'data_source_sheets', 'extracts'];
  for (let index = 0; index < sequence.length; index++) {
    const stage = sequence[index];
    const status = state && state.stages && state.stages[stage] && state.stages[stage].status;
    if (status === 'pending' || status === 'processing') return stage;
  }
  return null;
}

function readInvoiceDeploymentState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    INVOICE_OPERATIONAL_DEPLOYMENT.statePropertyKey
  );
  if (!serialized) return null;

  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('State is not an object.');
    }
    if (String(state.reportKey || '') !== INVOICE_ENTITY_CONTROL.reportKey) {
      throw new Error('Unexpected reportKey.');
    }
    if (!String(state.operationId || '').trim()) throw new Error('Missing operationId.');
    return state;
  } catch (error) {
    throw new Error('Invalid Invoice deployment state: ' + error.message);
  }
}

function persistInvoiceDeploymentState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > INVOICE_OPERATIONAL_DEPLOYMENT.maxStateBytes) {
    throw new Error('Invoice deployment state exceeds the Script Property limit. Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(
    INVOICE_OPERATIONAL_DEPLOYMENT.statePropertyKey,
    serialized
  );
  return { byteCount: byteCount };
}

function scheduleInvoiceDeploymentWorker_(delayMs, stage, operationId) {
  const deletedTriggerCount = deleteInvoiceDeploymentWorkerTriggers_();
  const normalizedDelayMs = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(INVOICE_OPERATIONAL_DEPLOYMENT.workerHandler)
    .timeBased()
    .after(normalizedDelayMs)
    .create();

  const current = readInvoiceDeploymentState_();
  if (current && (!operationId || current.operationId === operationId) &&
      current.status !== 'completed' && current.status !== 'failed') {
    current.trigger = {
      triggerId: trigger.getUniqueId(),
      stage: stage || current.currentStage,
      scheduledAt: new Date().toISOString(),
      delayMs: normalizedDelayMs
    };
    current.updatedAt = new Date().toISOString();
    persistInvoiceDeploymentState_(current);
  }

  return {
    triggerId: trigger.getUniqueId(),
    delayMs: normalizedDelayMs,
    deletedTriggerCount: deletedTriggerCount
  };
}

function deleteInvoiceDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger =>
    trigger.getHandlerFunction() === INVOICE_OPERATIONAL_DEPLOYMENT.workerHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function updateInvoiceDeploymentReceipt_(state) {
  const properties = PropertiesService.getScriptProperties();
  const serialized = properties.getProperty(INVOICE_ENTITY_CONTROL.pushReceiptProperty);
  if (!serialized) return null;

  let receipt;
  try {
    receipt = JSON.parse(serialized);
  } catch (error) {
    return null;
  }

  if (Number(receipt.configuration_version || 0) !== Number(state.configurationVersion || 0) ||
      String(receipt.configuration_hash || '') !== String(state.configurationHash || '')) {
    return null;
  }

  receipt.operation_id = state.operationId;
  receipt.deployment_status = state.status;
  receipt.current_stage = state.currentStage;
  receipt.deployment_updated_at = state.updatedAt;
  receipt.deployment_completed_at = state.completedAt || null;
  receipt.deployment_error = state.lastError || null;
  properties.setProperty(INVOICE_ENTITY_CONTROL.pushReceiptProperty, JSON.stringify(receipt));
  return receipt;
}

function compactInvoiceDeploymentStageResult_(stage, result) {
  if (stage === 'bigquery') {
    return {
      period: result.period,
      clientCount: result.clientCount,
      invoiceCount: result.hierarchyValidation && result.hierarchyValidation.invoiceCount || 0,
      expectedRowCount: result.hierarchyValidation && result.hierarchyValidation.rowCount || 0,
      actualRowCount: result.verification && result.verification.rowCount || 0,
      missingKeyCount: result.verification && (
        result.verification.missingKeyCount !== undefined
          ? result.verification.missingKeyCount
          : result.verification.invalidKeyCount
      ) || 0,
      distinctIdempotencyKeyCount: result.verification && result.verification.distinctIdempotencyKeyCount || 0,
      jobId: result.loadResult && result.loadResult.jobId || null,
      schemaValidationStatus: result.schemaValidation && result.schemaValidation.status || null,
      loadState: result.loadResult && result.loadResult.state || null,
      verificationStatus: result.verification && result.verification.status || null
    };
  }
  return {
    status: result.status,
    refreshedObjectCount: result.refreshedObjectCount,
    executions: result.executions
  };
}

function summarizeInvoiceDeploymentState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operationId,
    status: state.status,
    currentStage: state.currentStage,
    configurationVersion: state.configurationVersion,
    configurationHash: state.configurationHash,
    attempts: state.attempts,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt || null,
    lastError: state.lastError || null
  };
}