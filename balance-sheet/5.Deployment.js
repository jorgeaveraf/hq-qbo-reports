/***********************
 * Balance Sheet Configuration Deployment
 ***********************/

function queueBalanceConfigurationDeployment_(pushPayload,  configuration) {
  const validated = validateBalanceEntityConfiguration_(configuration);
  const now = new Date().toISOString();
  const state = {
    schemaVersion: '1.0',
    operationId: Utilities.getUuid(),
    operationKey: buildBalanceDeploymentKey_(validated),
    requestId: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
    reportKey: BALANCE_ENTITY_CONTROL.reportKey,
    configurationVersion: validated.configuration_version,
    configurationHash: validated.configuration_hash,
    configuration: validated,
    status: 'pending',
    currentStage: 'bigquery',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    lastError: null,
    stages: {
      bigquery: {
        status: 'pending',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        retryScheduled: false,
        error: null,
        result: null
      },
      data_source_sheets: {
        status: 'pending',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        retryScheduled: false,
        error: null,
        result: null
      },
      extracts: {
        status: 'pending',
        attempts: 0,
        startedAt: null,
        completedAt: null,
        retryScheduled: false,
        error: null,
        result: null
      }
    }
  };
  persistBalanceDeploymentState_(state);
  scheduleBalanceDeploymentWorker_(BALANCE_OPERATIONAL_DEPLOYMENT.initialDelayMs);
  return summarizeBalanceDeploymentState_(state);
}

function processBalanceConfigurationDeployment() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return {
    status: 'deferred_lock_busy',
    retryScheduled: false
  };
  let operationId = null,
  stage = null;
  try {
    deleteBalanceDeploymentWorkerTriggers_();
    let state = readBalanceDeploymentState_();
    if (!state) return {
      status: 'no_pending_deployment'
    };
    operationId = state.operationId;
    if (state.status === 'completed' || state.status === 'failed') return summarizeBalanceDeploymentState_(state);
    if (state.status === 'processing') {
      const current = state.stages[state.currentStage];
      const age = current && current.startedAt ? (Date.now() - Date.parse(current.startedAt)) / 1000 : Infinity;
      if (age < BALANCE_OPERATIONAL_DEPLOYMENT.staleProcessingSeconds) return {
        status: 'deferred_stage_processing',
        operationId,
        currentStage: state.currentStage
      };
      current.status = 'pending';
      current.error = 'Recovered stale processing state.';
      state.status = 'pending';
    } stage = getNextBalanceDeploymentStage_(state);
    if (!stage) {
      state.status = 'completed';
      state.currentStage = 'completed';
      state.completedAt = state.completedAt || new Date().toISOString();
      state.updatedAt = new Date().toISOString();
      state.lastError = null;
      persistBalanceDeploymentState_(state);
      updateBalanceDeploymentReceipt_(state);
      return summarizeBalanceDeploymentState_(state);
    } const stageState = state.stages[stage];
    stageState.status = 'processing';
    stageState.attempts = Number(stageState.attempts || 0) + 1;
    stageState.startedAt = new Date().toISOString();
    stageState.retryScheduled = false;
    stageState.error = null;
    state.status = 'processing';
    state.currentStage = stage;
    state.attempts = Number(state.attempts || 0) + 1;
    state.updatedAt = stageState.startedAt;
    state.lastError = null;
    persistBalanceDeploymentState_(state);
    Logger.log(JSON.stringify({
      event: 'balance_sheet_configuration_deployment_stage_started',
      operationId,
      stage,
      attempt: stageState.attempts,
      configurationVersion: state.configurationVersion,
      configurationHash: state.configurationHash
    }));
    const result = executeBalanceDeploymentStage_(stage,  state);
    state = readBalanceDeploymentState_();
    const completedAt = new Date().toISOString();
    state.stages[stage].status = 'completed';
    state.stages[stage].completedAt = completedAt;
    state.stages[stage].result = compactBalanceDeploymentStageResult_(result);
    state.stages[stage].error = null;
    const next = getNextBalanceDeploymentStage_(state);
    state.status = next ? 'pending' : 'completed';
    state.currentStage = next || 'completed';
    state.updatedAt = completedAt;
    state.completedAt = next ? null : completedAt;
    state.lastError = null;
    persistBalanceDeploymentState_(state);
    updateBalanceDeploymentReceipt_(state);
    Logger.log(JSON.stringify({
      event: 'balance_sheet_configuration_deployment_stage_completed',
      operationId,
      stage,
      attempt: state.stages[stage].attempts,
      nextStage: state.currentStage,
      result: compactBalanceDeploymentStageResult_(result)
    }));
    if (next) scheduleBalanceDeploymentWorker_(BALANCE_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
    return summarizeBalanceDeploymentState_(state);
  } catch (error) {
    const state = readBalanceDeploymentState_();
    let retryScheduled = false;
    if (state && stage && state.operationId === operationId) {
      const ss = state.stages[stage];
      ss.error = String(error && error.message || error);
      ss.completedAt = new Date().toISOString();
      state.updatedAt = ss.completedAt;
      state.lastError = ss.error;
      if (ss.attempts < BALANCE_OPERATIONAL_DEPLOYMENT.maxStageAttempts) {
        ss.status = 'pending';
        ss.retryScheduled = true;
        state.status = 'pending';
        retryScheduled = true;
        scheduleBalanceDeploymentWorker_(BALANCE_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs);
      } else {
        ss.status = 'failed';
        ss.retryScheduled = false;
        state.status = 'failed';
      } persistBalanceDeploymentState_(state);
      updateBalanceDeploymentReceipt_(state);
    } Logger.log(JSON.stringify({
      event: 'balance_sheet_configuration_deployment_stage_failed',
      operationId,
      stage,
      retryScheduled,
      error: String(error && error.message || error)
    }));
    if (retryScheduled) return {
      status: 'retry_scheduled',
      operationId,
      stage,
      retryScheduled,
      error: String(error && error.message || error)
    };
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function executeBalanceDeploymentStage_(stage,  state) {
  if (stage === 'bigquery') {
    const configuration = validateBalanceEntityConfiguration_(state.configuration,  state.configurationVersion);
    if (configuration.configuration_hash !== state.configurationHash) throw new Error('Deployment configuration hash no longer matches the queued operation.');
    return executeBalanceSheetBigQuerySnapshot_({
      source: 'configuration_push_operation',
      configuration
    });
  } if (stage === 'data_source_sheets' || stage === 'extracts') return refreshBalanceConnectedSheetsStage_(stage);
  throw new Error('Unsupported Balance Sheet deployment stage: ' + stage);
}

function refreshBalanceConnectedSheetsStage_(stage,  spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getBalanceReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getBalanceConnectedSheetTargets_(spreadsheet,  stage);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(BALANCE_SHEET_REFRESH_CONFIG.timeoutSeconds);
  const executions = targets.map(target => {
    const status = target.getStatus(),
    executionTime = status.getLastExecutionTime(),
    refreshTime = status.getLastRefreshedTime();
    return {
      name: target.name,
      type: target.type,
      state: String(status.getExecutionState()),
      errorCode: String(status.getErrorCode()),
      errorMessage: String(status.getErrorMessage() || '').trim() || null,
      lastExecutionAt: executionTime ? executionTime.toISOString() : null,
      lastRefreshedAt: refreshTime ? refreshTime.toISOString() : null,
      truncated: status.isTruncated() === true
    };
  });
  const failures = executions.filter(item => item.state !== 'SUCCESS' || item.errorCode !== 'NONE' || item.truncated);
  if (failures.length) throw new Error('Balance Sheet Connected Sheets stage failed: ' + JSON.stringify({
    stage,
    failures
  }));
  const result = {
    status: 'passed',
    stage,
    refreshedObjectCount: executions.length,
    executions
  };
  Logger.log(JSON.stringify({
    event: 'balance_sheet_connected_sheets_stage_completed',
    ...result
  }));
  return result;
}

function getBalanceConnectedSheetTargets_(spreadsheet,  stage) {
  const explicit = stage === 'data_source_sheets' ? BALANCE_SHEET_REFRESH_CONFIG.sourceSheets : BALANCE_SHEET_REFRESH_CONFIG.extractSheets;
  const patterns = stage === 'data_source_sheets' ? BALANCE_SHEET_REFRESH_CONFIG.sourceNamePatterns : BALANCE_SHEET_REFRESH_CONFIG.extractNamePatterns;
  const matchesName = name => explicit.length ? explicit.includes(name) : patterns.some(pattern => String(name).toLowerCase().includes(String(pattern).toLowerCase()));
  let targets;
  if (stage === 'data_source_sheets') targets = spreadsheet.getDataSourceSheets().filter(source => matchesName(source.asSheet().getName())).map(source => ({
    name: source.asSheet().getName(),
    type: 'data_source_sheet',
    refresh: () => source.refreshData(),
    getStatus: () => source.getStatus()
  }));
  else targets = spreadsheet.getDataSourceTables().filter(table => matchesName(table.getRange().getSheet().getName())).map(table => ({
    name: table.getRange().getSheet().getName(),
    type: 'extract',
    refresh: () => table.refreshData(),
    getStatus: () => table.getStatus()
  }));
  if (!targets.length) throw new Error('No Balance Sheet Connected Sheets objects matched stage=' + stage + '. Configure BALANCE_SHEET_REFRESH_CONFIG with exact sheet names.');
  const counts = {
  };
  targets.forEach(target => counts[target.name] = (counts[target.name] || 0) + 1);
  const duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
  if (duplicates.length) throw new Error('Duplicate Balance Sheet Connected Sheets objects: ' + JSON.stringify({
    stage,
    duplicates,
    counts
  }));
  return targets;
}

function getBalanceReportSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const configured = String(properties.getProperty(BALANCE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty) || '').trim();
  if (configured) return SpreadsheetApp.openById(configured);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Missing Script Property: ' + BALANCE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty);
  properties.setProperty(BALANCE_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty,  active.getId());
  return active;
}

function buildBalanceDeploymentKey_(configuration) {
  return [BALANCE_ENTITY_CONTROL.reportKey,  configuration.configuration_version,  configuration.configuration_hash].join('|');
}

function getNextBalanceDeploymentStage_(state) {
  return ['bigquery', 'data_source_sheets', 'extracts'].find(stage => state.stages && state.stages[stage] && state.stages[stage].status === 'pending') || null;
}

function readBalanceDeploymentState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(BALANCE_OPERATIONAL_DEPLOYMENT.statePropertyKey);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    if (!state || state.reportKey !== BALANCE_ENTITY_CONTROL.reportKey || !state.operationId) throw new Error('Invalid identity.');
    return state;
  } catch (error) {
    throw new Error('Invalid Balance Sheet deployment state: ' + error.message);
  }
}

function persistBalanceDeploymentState_(state) {
  const raw = JSON.stringify(state),
  bytes = Utilities.newBlob(raw).getBytes().length;
  if (bytes > BALANCE_OPERATIONAL_DEPLOYMENT.maxStateBytes) throw new Error('Balance Sheet deployment state exceeds Script Property limit. Bytes=' + bytes);
  PropertiesService.getScriptProperties().setProperty(BALANCE_OPERATIONAL_DEPLOYMENT.statePropertyKey,  raw);
  return {
    byteCount: bytes
  };
}

function scheduleBalanceDeploymentWorker_(delayMs) {
  deleteBalanceDeploymentWorkerTriggers_();
  const delay = Math.max(1000,  Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(BALANCE_OPERATIONAL_DEPLOYMENT.workerHandler).timeBased().after(delay).create();
  return {
    triggerId: trigger.getUniqueId(),
    delayMs: delay
  };
}

function deleteBalanceDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === BALANCE_OPERATIONAL_DEPLOYMENT.workerHandler);
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function inspectBalanceDeploymentWorkerTriggers_() {
  return ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === BALANCE_OPERATIONAL_DEPLOYMENT.workerHandler).map(trigger => ({
    uniqueId: trigger.getUniqueId(),
    handlerFunction: trigger.getHandlerFunction(),
    eventType: String(trigger.getEventType()),
    triggerSource: String(trigger.getTriggerSource())
  }));
}

function summarizeBalanceDeploymentState_(state) {
  return {
    operationId: state.operationId,
    reportKey: state.reportKey,
    configurationVersion: state.configurationVersion,
    configurationHash: state.configurationHash,
    deploymentStatus: state.status,
    currentStage: state.currentStage,
    attempts: state.attempts,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    lastError: state.lastError,
    stages: state.stages
  };
}

function compactBalanceDeploymentStageResult_(result) {
  if (!result) return null;
  const raw = JSON.stringify(result);
  return raw.length <= 4500 ? result : {
    status: result.status || 'completed',
    truncated: true,
    summary: raw.slice(0,  4000)
  };
}

function updateBalanceDeploymentReceipt_(state) {
  const properties = PropertiesService.getScriptProperties(),
  raw = properties.getProperty(BALANCE_ENTITY_CONTROL.pushReceiptProperty);
  if (!raw) return null;
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch (error) {
    receipt = {
    };
  } receipt.operation_id = state.operationId;
  receipt.deployment_status = state.status;
  receipt.current_stage = state.currentStage;
  receipt.updated_at = state.updatedAt;
  receipt.completed_at = state.completedAt;
  receipt.last_error = state.lastError;
  properties.setProperty(BALANCE_ENTITY_CONTROL.pushReceiptProperty,  JSON.stringify(receipt));
  return receipt;
}