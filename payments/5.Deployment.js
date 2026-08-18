/***********************
 * Configuration Publication Deployment
 *
 * A new centralized configuration is received synchronously, persisted, and queued.
 * The operational work runs in three separate time-triggered stages:
 * 1. BigQuery snapshot
 * 2. Connected Sheets data-source views
 * 3. Connected Sheets extracts
 ***********************/

function queuePaymentConfigurationDeployment_(pushPayload, configuration) {
  const validatedConfiguration = validatePaymentEntityConfiguration_(configuration);
  const current = readPaymentDeploymentState_();
  const sameConfiguration = current &&
    current.configuration_version === validatedConfiguration.configuration_version &&
    current.configuration_hash === validatedConfiguration.configuration_hash;

  if (sameConfiguration && ['pending', 'running', 'completed'].includes(current.status)) {
    if (current.status !== 'completed') schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
    return summarizePaymentDeploymentState_(current, false);
  }

  if (sameConfiguration && current.status === 'failed') {
    return summarizePaymentDeploymentState_(current, false);
  }

  const now = new Date().toISOString();
  const state = {
    schema_version: '1.0',
    operation_id: Utilities.getUuid(),
    request_id: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
    report_key: PAYMENT_ENTITY_CONTROL.reportKey,
    configuration_version: validatedConfiguration.configuration_version,
    configuration_hash: validatedConfiguration.configuration_hash,
    configuration: validatedConfiguration,
    status: 'pending',
    current_stage: 'bigquery',
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    stages: {
      configuration: { status: 'completed', attempts: 1, completed_at: now },
      bigquery: { status: 'pending', attempts: 0, started_at: null, completed_at: null, error: null, result: null },
      data_source_sheets: { status: 'pending', attempts: 0, started_at: null, completed_at: null, error: null, result: null },
      extracts: { status: 'pending', attempts: 0, started_at: null, completed_at: null, error: null, result: null }
    }
  };

  persistPaymentDeploymentState_(state);
  schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.initialDelayMs);
  return summarizePaymentDeploymentState_(state, true);
}

function processPaymentConfigurationDeployment() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
    const deferred = { status: 'deferred_lock_busy', retryScheduled: true };
    Logger.log(JSON.stringify({ event: 'payment_configuration_deployment_deferred', ...deferred }));
    return deferred;
  }

  let claimedState = null;
  let claimedStage = null;

  try {
    let state = readPaymentDeploymentState_();
    if (!state) return { status: 'no_pending_deployment' };
    if (state.status === 'completed') {
      deletePaymentDeploymentWorkerTriggers_();
      return summarizePaymentDeploymentState_(state, false);
    }

    if (state.status === 'running') {
      const stageState = state.stages && state.stages[state.current_stage];
      const startedAt = stageState && Date.parse(stageState.started_at || '');
      const ageSeconds = Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : Infinity;
      if (ageSeconds < PAYMENT_OPERATIONAL_DEPLOYMENT.staleRunningSeconds) {
        schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
        return { status: 'deferred_stage_running', operationId: state.operation_id, currentStage: state.current_stage };
      }
      if (stageState) {
        stageState.status = 'pending';
        stageState.error = 'Recovered after a stale running state.';
      }
      state.status = 'pending';
      state.updated_at = new Date().toISOString();
      persistPaymentDeploymentState_(state);
    }

    claimedStage = getNextPaymentDeploymentStage_(state, false);
    if (!claimedStage) {
      state.status = 'completed';
      state.current_stage = 'completed';
      state.completed_at = state.completed_at || new Date().toISOString();
      state.updated_at = new Date().toISOString();
      persistPaymentDeploymentState_(state);
      updatePaymentDeploymentReceipt_(state);
      deletePaymentDeploymentWorkerTriggers_();
      return summarizePaymentDeploymentState_(state, false);
    }

    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];
    stageState.status = 'running';
    stageState.attempts = Number(stageState.attempts || 0) + 1;
    stageState.started_at = now;
    stageState.error = null;
    state.status = 'running';
    state.current_stage = claimedStage;
    state.updated_at = now;
    persistPaymentDeploymentState_(state);
    claimedState = JSON.parse(JSON.stringify(state));

    Logger.log(JSON.stringify({
      event: 'payment_configuration_deployment_stage_started',
      operationId: state.operation_id,
      stage: claimedStage,
      attempt: stageState.attempts,
      configurationVersion: state.configuration_version,
      configurationHash: state.configuration_hash
    }));

    const stageResult = executePaymentDeploymentStage_(claimedStage, claimedState);
    const current = readPaymentDeploymentState_();

    if (!current || current.operation_id !== claimedState.operation_id) {
      schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
      const superseded = {
        status: 'superseded',
        operationId: claimedState.operation_id,
        stage: claimedStage,
        currentOperationId: current && current.operation_id || null
      };
      Logger.log(JSON.stringify({ event: 'payment_configuration_deployment_stage_superseded', ...superseded }));
      return superseded;
    }

    const completedAt = new Date().toISOString();
    current.stages[claimedStage].status = 'completed';
    current.stages[claimedStage].completed_at = completedAt;
    current.stages[claimedStage].error = null;
    current.stages[claimedStage].result = compactPaymentDeploymentStageResult_(claimedStage, stageResult);
    current.updated_at = completedAt;
    current.last_error = null;

    const nextStage = getNextPaymentDeploymentStage_(current, false);
    if (nextStage) {
      current.status = 'pending';
      current.current_stage = nextStage;
      persistPaymentDeploymentState_(current);
      updatePaymentDeploymentReceipt_(current);
      schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
    } else {
      current.status = 'completed';
      current.current_stage = 'completed';
      current.completed_at = completedAt;
      persistPaymentDeploymentState_(current);
      updatePaymentDeploymentReceipt_(current);
      deletePaymentDeploymentWorkerTriggers_();
    }

    const result = summarizePaymentDeploymentState_(current, false);
    Logger.log(JSON.stringify({ event: 'payment_configuration_deployment_stage_completed', stage: claimedStage, ...result }));
    return result;
  } catch (error) {
    const current = readPaymentDeploymentState_();
    let retryScheduled = false;

    if (claimedState && current && current.operation_id === claimedState.operation_id && claimedStage) {
      const failedAt = new Date().toISOString();
      const stageState = current.stages[claimedStage];
      stageState.error = String(error && error.message || error);
      stageState.completed_at = failedAt;
      current.updated_at = failedAt;
      current.last_error = stageState.error;

      if (Number(stageState.attempts || 0) < PAYMENT_OPERATIONAL_DEPLOYMENT.maxStageAttempts) {
        stageState.status = 'pending';
        current.status = 'pending';
        current.current_stage = claimedStage;
        retryScheduled = true;
      } else {
        stageState.status = 'failed';
        current.status = 'failed';
        current.current_stage = claimedStage;
      }

      persistPaymentDeploymentState_(current);
      updatePaymentDeploymentReceipt_(current);
      if (retryScheduled) schedulePaymentDeploymentWorker_(PAYMENT_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs);
    }

    Logger.log(JSON.stringify({
      event: 'payment_configuration_deployment_stage_failed',
      operationId: claimedState && claimedState.operation_id || null,
      stage: claimedStage,
      retryScheduled,
      error: String(error && error.message || error)
    }));

    if (retryScheduled) {
      return {
        status: 'retry_scheduled',
        operationId: claimedState.operation_id,
        stage: claimedStage,
        error: String(error && error.message || error)
      };
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function executePaymentDeploymentStage_(stage, state) {
  if (stage === 'bigquery') {
    const configuration = validatePaymentEntityConfiguration_(state.configuration, state.configuration_version);
    if (configuration.configuration_hash !== state.configuration_hash) {
      throw new Error('Deployment configuration hash no longer matches the queued operation.');
    }
    return executePaymentBigQuerySnapshot_({ source: 'configuration_push_operation', configuration });
  }
  if (stage === 'data_source_sheets') return refreshPaymentConnectedSheetsStage_('data_source_sheets');
  if (stage === 'extracts') return refreshPaymentConnectedSheetsStage_('extracts');
  throw new Error('Unsupported Payments deployment stage: ' + stage);
}

function refreshPaymentConnectedSheetsPipeline_(spreadsheet) {
  const sourceSheets = refreshPaymentConnectedSheetsStage_('data_source_sheets', spreadsheet);
  const extracts = refreshPaymentConnectedSheetsStage_('extracts', spreadsheet);
  return {
    status: 'passed',
    refreshedObjectCount: sourceSheets.refreshedObjectCount + extracts.refreshedObjectCount,
    stages: { dataSourceSheets: sourceSheets, extracts }
  };
}

function refreshPaymentConnectedSheetsStage_(stage, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getPaymentReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getPaymentConnectedSheetTargets_(spreadsheet, stage);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(PAYMENT_CONNECTED_SHEETS_CONFIG.timeoutSeconds);

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

  const failures = executions.filter(execution => execution.state !== 'SUCCESS' || execution.errorCode !== 'NONE' || execution.truncated);
  if (failures.length) {
    throw new Error('Payments Connected Sheets stage failed: ' + JSON.stringify({ stage, failures }));
  }

  const result = { status: 'passed', stage, refreshedObjectCount: executions.length, executions };
  Logger.log(JSON.stringify({ event: 'payment_connected_sheets_stage_completed', ...result }));
  return result;
}

function getPaymentConnectedSheetTargets_(spreadsheet, stage) {
  let targets;
  let expectedNames;

  if (stage === 'data_source_sheets') {
    expectedNames = PAYMENT_CONNECTED_SHEETS_CONFIG.sourceSheets;
    targets = spreadsheet.getDataSourceSheets()
      .filter(source => expectedNames.includes(source.asSheet().getName()))
      .map(source => ({
        name: source.asSheet().getName(),
        type: 'data_source_sheet',
        refresh: () => source.refreshData(),
        getStatus: () => source.getStatus()
      }));
  } else if (stage === 'extracts') {
    expectedNames = PAYMENT_CONNECTED_SHEETS_CONFIG.extractSheets;
    targets = spreadsheet.getDataSourceTables()
      .filter(extract => expectedNames.includes(extract.getRange().getSheet().getName()))
      .map(extract => ({
        name: extract.getRange().getSheet().getName(),
        type: 'extract',
        refresh: () => extract.refreshData(),
        getStatus: () => extract.getStatus()
      }));
  } else {
    throw new Error('Unsupported Connected Sheets stage: ' + stage);
  }

  const counts = {};
  targets.forEach(target => counts[target.name] = (counts[target.name] || 0) + 1);
  const missing = expectedNames.filter(name => !counts[name]);
  const duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
  if (missing.length || duplicates.length) {
    throw new Error('Payments data source object validation failed: ' + JSON.stringify({ stage, missing, duplicates, counts }));
  }
  return targets;
}

function getPaymentReportSpreadsheet_() {
  return getTargetSpreadsheet_();
}

function getNextPaymentDeploymentStage_(state, includeFailed) {
  const sequence = ['bigquery', 'data_source_sheets', 'extracts'];
  for (let index = 0; index < sequence.length; index++) {
    const stage = sequence[index];
    const status = state && state.stages && state.stages[stage] && state.stages[stage].status;
    if (status === 'pending' || status === 'running' || (includeFailed && status === 'failed')) return stage;
  }
  return null;
}

function readPaymentDeploymentState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(PAYMENT_OPERATIONAL_DEPLOYMENT.statePropertyKey);
  if (!serialized) return null;
  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('State is not an object.');
    if (String(state.report_key || '') !== PAYMENT_ENTITY_CONTROL.reportKey) throw new Error('Unexpected report_key.');
    if (!String(state.operation_id || '').trim()) throw new Error('Missing operation_id.');
    return state;
  } catch (error) {
    throw new Error('Invalid Payments deployment state: ' + error.message);
  }
}

function persistPaymentDeploymentState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PAYMENT_OPERATIONAL_DEPLOYMENT.maxStateBytes) {
    throw new Error('Payments deployment state exceeds the Script Property limit. Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(PAYMENT_OPERATIONAL_DEPLOYMENT.statePropertyKey, serialized);
  return { byteCount };
}

function schedulePaymentDeploymentWorker_(delayMs) {
  const normalizedDelayMs = Math.max(1000, Number(delayMs || 0));
  const existing = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler);

  existing.forEach(trigger => ScriptApp.deleteTrigger(trigger));

  const trigger = ScriptApp.newTrigger(PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler)
    .timeBased()
    .after(normalizedDelayMs)
    .create();

  return {
    triggerId: trigger.getUniqueId(),
    delayMs: normalizedDelayMs,
    reused: false,
    previousTriggersDeleted: existing.length
  };
}

function deletePaymentDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PAYMENT_OPERATIONAL_DEPLOYMENT.workerHandler);
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function updatePaymentDeploymentReceipt_(state) {
  const properties = PropertiesService.getScriptProperties();
  const serialized = properties.getProperty(PAYMENT_ENTITY_CONTROL.pushReceiptProperty);
  if (!serialized) return null;

  let receipt;
  try { receipt = JSON.parse(serialized); } catch (error) { return null; }
  if (Number(receipt.configuration_version || 0) !== Number(state.configuration_version || 0) ||
      String(receipt.configuration_hash || '') !== String(state.configuration_hash || '')) return null;

  receipt.operation_id = state.operation_id;
  receipt.deployment_status = state.status;
  receipt.current_stage = state.current_stage;
  receipt.deployment_updated_at = state.updated_at;
  receipt.deployment_completed_at = state.completed_at || null;
  receipt.deployment_error = state.last_error || null;
  properties.setProperty(PAYMENT_ENTITY_CONTROL.pushReceiptProperty, JSON.stringify(receipt));
  return receipt;
}

function compactPaymentDeploymentStageResult_(stage, result) {
  if (stage === 'bigquery') {
    return {
      period: result.period,
      clientCount: result.clientCount,
      paymentCount: result.paymentCount,
      rowCount: result.rowCount,
      headerRowCount: result.headerRowCount,
      lineRowCount: result.lineRowCount,
      jobId: result.jobId,
      verificationStatus: result.verification && result.verification.status || null
    };
  }
  return { status: result.status, refreshedObjectCount: result.refreshedObjectCount, executions: result.executions };
}

function summarizePaymentDeploymentState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operation_id,
    status: state.status,
    currentStage: state.current_stage,
    configurationVersion: state.configuration_version,
    configurationHash: state.configuration_hash,
    updatedAt: state.updated_at,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null
  };
}
