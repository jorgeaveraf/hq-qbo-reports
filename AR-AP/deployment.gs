/***********************
 * Aging Configuration Operational Deployment
 ***********************/

function queueAgingConfigurationDeployment_(pushPayload, configuration) {
  const validatedConfiguration = validateAgingEntityConfiguration_(configuration);
  const current = readAgingDeploymentState_();
  const sameConfiguration = current && current.configuration_version === validatedConfiguration.configuration_version && current.configuration_hash === validatedConfiguration.configuration_hash;
  if (sameConfiguration && ['pending', 'processing', 'completed', 'failed'].includes(current.status)) return summarizeAgingDeploymentState_(current, false);
  const now = new Date().toISOString();
  const state = {
    schema_version: '1.0',
    operation_id: Utilities.getUuid(),
    request_id: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
    report_key: AGING_ENTITY_CONTROL.reportKey,
    configuration_version: validatedConfiguration.configuration_version,
    configuration_hash: validatedConfiguration.configuration_hash,
    configuration: validatedConfiguration,
    status: 'pending',
    current_stage: 'bigquery',
    attempts: { bigquery: 0, data_source_sheets: 0, extracts: 0 },
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    stages: {
      bigquery: { status: 'pending', attempt: 0, retry_scheduled: false, started_at: null, completed_at: null, error: null, result: null },
      data_source_sheets: { status: 'pending', attempt: 0, retry_scheduled: false, started_at: null, completed_at: null, error: null, result: null },
      extracts: { status: 'pending', attempt: 0, retry_scheduled: false, started_at: null, completed_at: null, error: null, result: null }
    }
  };
  persistAgingDeploymentState_(state);
  scheduleAgingDeploymentWorker_(AGING_OPERATIONAL_DEPLOYMENT.initialDelayMs);
  return summarizeAgingDeploymentState_(state, true);
}

function processAgingConfigurationDeployment() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    scheduleAgingDeploymentWorker_(AGING_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
    Logger.log(JSON.stringify({ event: 'aging_configuration_deployment_deferred', status: 'deferred_lock_busy', retryScheduled: true }));
    return { status: 'deferred_lock_busy', retryScheduled: true };
  }
  let claimedState = null, claimedStage = null;
  try {
    let state = readAgingDeploymentState_();
    if (!state) return { status: 'no_pending_deployment' };
    if (state.status === 'completed' || state.status === 'failed') { deleteAgingDeploymentWorkerTriggers_(); return summarizeAgingDeploymentState_(state, false); }
    if (state.status === 'processing') {
      const stageState = state.stages && state.stages[state.current_stage];
      const startedAt = stageState && Date.parse(stageState.started_at || '');
      const ageSeconds = Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : Infinity;
      if (ageSeconds < AGING_OPERATIONAL_DEPLOYMENT.staleRunningSeconds) {
        scheduleAgingDeploymentWorker_(AGING_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
        return { status: 'deferred_stage_processing', operationId: state.operation_id, currentStage: state.current_stage };
      }
      if (stageState) { stageState.status = 'pending'; stageState.error = 'Recovered after a stale processing state.'; }
      state.status = 'pending'; state.updated_at = new Date().toISOString(); persistAgingDeploymentState_(state);
    }
    claimedStage = getNextAgingDeploymentStage_(state);
    if (!claimedStage) {
      state.status = 'completed'; state.current_stage = 'completed'; state.completed_at = state.completed_at || new Date().toISOString(); state.updated_at = new Date().toISOString(); state.last_error = null;
      persistAgingDeploymentState_(state); updateAgingDeploymentReceipt_(state); deleteAgingDeploymentWorkerTriggers_(); return summarizeAgingDeploymentState_(state, false);
    }
    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];
    stageState.status = 'processing'; stageState.attempt = Number(stageState.attempt || 0) + 1; stageState.retry_scheduled = false; stageState.started_at = now; stageState.error = null;
    state.attempts[claimedStage] = stageState.attempt; state.status = 'processing'; state.current_stage = claimedStage; state.updated_at = now;
    persistAgingDeploymentState_(state);
    deleteAgingDeploymentWorkerTriggers_();
    claimedState = JSON.parse(JSON.stringify(state));
    Logger.log(JSON.stringify({ event: 'aging_configuration_deployment_stage_started', operationId: state.operation_id, stage: claimedStage, attempt: stageState.attempt, configurationVersion: state.configuration_version, configurationHash: state.configuration_hash }));
    const stageResult = executeAgingDeploymentStage_(claimedStage, claimedState);
    const current = readAgingDeploymentState_();
    if (!current || current.operation_id !== claimedState.operation_id) return { status: 'superseded', operationId: claimedState.operation_id, stage: claimedStage };
    const completedAt = new Date().toISOString();
    current.stages[claimedStage].status = 'completed'; current.stages[claimedStage].completed_at = completedAt; current.stages[claimedStage].error = null; current.stages[claimedStage].retry_scheduled = false; current.stages[claimedStage].result = compactAgingDeploymentStageResult_(claimedStage, stageResult);
    current.updated_at = completedAt; current.last_error = null;
    const nextStage = getNextAgingDeploymentStage_(current);
    if (nextStage) { current.status = 'pending'; current.current_stage = nextStage; persistAgingDeploymentState_(current); updateAgingDeploymentReceipt_(current); scheduleAgingDeploymentWorker_(AGING_OPERATIONAL_DEPLOYMENT.nextStageDelayMs); }
    else { current.status = 'completed'; current.current_stage = 'completed'; current.completed_at = completedAt; persistAgingDeploymentState_(current); updateAgingDeploymentReceipt_(current); deleteAgingDeploymentWorkerTriggers_(); }
    const result = summarizeAgingDeploymentState_(current, false);
    Logger.log(JSON.stringify({ event: 'aging_configuration_deployment_stage_completed', stage: claimedStage, ...result }));
    return result;
  } catch (error) {
    const current = readAgingDeploymentState_();
    let retryScheduled = false;
    if (claimedState && current && current.operation_id === claimedState.operation_id && claimedStage) {
      const failedAt = new Date().toISOString(), stageState = current.stages[claimedStage];
      stageState.error = String(error && error.message || error); stageState.completed_at = failedAt; current.updated_at = failedAt; current.last_error = stageState.error;
      if (Number(stageState.attempt || 0) < AGING_OPERATIONAL_DEPLOYMENT.maxStageAttempts) { stageState.status = 'pending'; stageState.retry_scheduled = true; current.status = 'pending'; current.current_stage = claimedStage; retryScheduled = true; }
      else { stageState.status = 'failed'; stageState.retry_scheduled = false; current.status = 'failed'; current.current_stage = claimedStage; }
      persistAgingDeploymentState_(current); updateAgingDeploymentReceipt_(current); if (retryScheduled) scheduleAgingDeploymentWorker_(AGING_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs); else deleteAgingDeploymentWorkerTriggers_();
    }
    Logger.log(JSON.stringify({ event: 'aging_configuration_deployment_stage_failed', operationId: claimedState && claimedState.operation_id || null, stage: claimedStage, retryScheduled, error: String(error && error.message || error) }));
    if (retryScheduled) return { status: 'retry_scheduled', operationId: claimedState.operation_id, stage: claimedStage, error: String(error && error.message || error) };
    throw error;
  } finally { lock.releaseLock(); }
}

function executeAgingDeploymentStage_(stage, state) {
  if (stage === 'bigquery') {
    const configuration = validateAgingEntityConfiguration_(state.configuration, state.configuration_version);
    if (configuration.configuration_hash !== state.configuration_hash) throw new Error('Deployment configuration hash no longer matches the queued operation.');
    return executeAgingBigQuerySnapshot_({ source: 'configuration_push_operation', configuration });
  }
  if (stage === 'data_source_sheets') return refreshAgingConnectedSheetsStage_('data_source_sheets');
  if (stage === 'extracts') return refreshAgingConnectedSheetsStage_('extracts');
  throw new Error('Unsupported Aging deployment stage: ' + stage);
}

function refreshAgingConnectedSheetsStage_(stage, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getAgingReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getAgingConnectedSheetTargets_(spreadsheet, stage);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(AGING_SHEET_REFRESH_CONFIG.timeoutSeconds);
  const executions = targets.map(target => {
    const status = target.getStatus(), refreshed = status.getLastRefreshedTime(), executed = status.getLastExecutionTime();
    return { name: target.name, type: target.type, state: String(status.getExecutionState()), errorCode: String(status.getErrorCode()), errorMessage: String(status.getErrorMessage() || '').trim() || null, lastExecutionAt: executed ? executed.toISOString() : null, lastRefreshedAt: refreshed ? refreshed.toISOString() : null, truncated: status.isTruncated() === true };
  });
  const failures = executions.filter(item => item.state !== 'SUCCESS' || item.errorCode !== 'NONE' || item.truncated);
  if (failures.length) throw new Error('Aging Connected Sheets stage failed: ' + JSON.stringify({ stage, failures }));
  const result = { status: 'passed', stage, refreshedObjectCount: executions.length, executions };
  Logger.log(JSON.stringify({ event: 'aging_connected_sheets_stage_completed', ...result }));
  return result;
}

function getAgingConnectedSheetTargets_(spreadsheet, stage) {
  let targets = [], expectedNames = [];
  if (stage === 'data_source_sheets') {
    expectedNames = AGING_SHEET_REFRESH_CONFIG.sourceSheets;
    targets = spreadsheet.getDataSourceSheets().filter(source => !expectedNames.length || expectedNames.includes(source.asSheet().getName())).map(source => ({ name: source.asSheet().getName(), type: 'data_source_sheet', refresh: () => source.refreshData(), getStatus: () => source.getStatus() }));
  } else if (stage === 'extracts') {
    expectedNames = AGING_SHEET_REFRESH_CONFIG.extractSheets;
    targets = spreadsheet.getDataSourceTables().filter(table => !expectedNames.length || expectedNames.includes(table.getRange().getSheet().getName())).map(table => ({ name: table.getRange().getSheet().getName(), type: 'extract', refresh: () => table.refreshData(), getStatus: () => table.getStatus() }));
  } else throw new Error('Unsupported Connected Sheets stage: ' + stage);
  if (!targets.length) throw new Error('No Aging Connected Sheets objects found for stage: ' + stage);
  const counts = {}; targets.forEach(target => counts[target.name] = (counts[target.name] || 0) + 1);
  const missing = expectedNames.filter(name => !counts[name]), duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
  if (missing.length || duplicates.length) throw new Error('Aging data source object validation failed: ' + JSON.stringify({ stage, missing, duplicates, counts }));
  return targets;
}

function getAgingReportSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const configuredId = String(properties.getProperty(AGING_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty) || '').trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Missing Script Property: ' + AGING_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty);
  properties.setProperty(AGING_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty, active.getId());
  return active;
}

function getNextAgingDeploymentStage_(state) {
  const sequence = ['bigquery', 'data_source_sheets', 'extracts'];
  for (let i = 0; i < sequence.length; i++) { const stage = sequence[i], status = state && state.stages && state.stages[stage] && state.stages[stage].status; if (status === 'pending' || status === 'processing') return stage; }
  return null;
}

function readAgingDeploymentState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(AGING_OPERATIONAL_DEPLOYMENT.statePropertyKey);
  if (!serialized) return null;
  try { const state = JSON.parse(serialized); if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('State is not an object.'); if (String(state.report_key || '') !== AGING_ENTITY_CONTROL.reportKey) throw new Error('Unexpected report_key.'); if (!String(state.operation_id || '').trim()) throw new Error('Missing operation_id.'); return state; }
  catch (error) { throw new Error('Invalid Aging deployment state: ' + error.message); }
}

function persistAgingDeploymentState_(state) {
  const serialized = JSON.stringify(state), byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > AGING_OPERATIONAL_DEPLOYMENT.maxStateBytes) throw new Error('Aging deployment state exceeds Script Property limit. Bytes=' + byteCount);
  PropertiesService.getScriptProperties().setProperty(AGING_OPERATIONAL_DEPLOYMENT.statePropertyKey, serialized);
  return { byteCount };
}

function scheduleAgingDeploymentWorker_(delayMs) {
  const existing = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === AGING_OPERATIONAL_DEPLOYMENT.workerHandler);
  if (existing.length) return { triggerId: existing[0].getUniqueId(), delayMs: null, existing: true };
  const delay = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(AGING_OPERATIONAL_DEPLOYMENT.workerHandler).timeBased().after(delay).create();
  return { triggerId: trigger.getUniqueId(), delayMs: delay, existing: false };
}

function deleteAgingDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === AGING_OPERATIONAL_DEPLOYMENT.workerHandler);
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function updateAgingDeploymentReceipt_(state) {
  const properties = PropertiesService.getScriptProperties(), serialized = properties.getProperty(AGING_ENTITY_CONTROL.pushReceiptProperty);
  if (!serialized) return null;
  let receipt; try { receipt = JSON.parse(serialized); } catch (error) { return null; }
  if (Number(receipt.configuration_version || 0) !== Number(state.configuration_version || 0) || String(receipt.configuration_hash || '') !== String(state.configuration_hash || '')) return null;
  receipt.operation_id = state.operation_id; receipt.deployment_status = state.status; receipt.current_stage = state.current_stage; receipt.deployment_updated_at = state.updated_at; receipt.deployment_completed_at = state.completed_at || null; receipt.deployment_error = state.last_error || null;
  properties.setProperty(AGING_ENTITY_CONTROL.pushReceiptProperty, JSON.stringify(receipt)); return receipt;
}

function compactAgingDeploymentStageResult_(stage, result) {
  if (stage === 'bigquery') return { snapshotDate: result.snapshotDate, snapshotWeek: result.snapshotWeek, clientCount: result.clientCount, reportRowCounts: result.reportRowCounts, rowCount: result.rowCount, schemaValidation: result.schemaValidation, loadResult: result.loadResult, verification: result.verification };
  return { status: result.status, refreshedObjectCount: result.refreshedObjectCount, executions: result.executions };
}

function summarizeAgingDeploymentState_(state, queued) {
  return { queued: queued === true, operationId: state.operation_id, status: state.status, currentStage: state.current_stage, configurationVersion: state.configuration_version, configurationHash: state.configuration_hash, updatedAt: state.updated_at, completedAt: state.completed_at || null, lastError: state.last_error || null };
}