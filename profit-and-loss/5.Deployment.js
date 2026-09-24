/***********************
 * Asynchronous Configuration Deployment
 *
 * A centralized configuration is validated and persisted synchronously.
 * Operational work runs outside doPost in one time-triggered stage per execution:
 * bigquery -> data_source_sheets -> extracts -> completed
 ***********************/

function queuePnlConfigurationDeployment_(pushPayload, configuration, definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget);
  const validatedConfiguration = validatePnlEntityConfiguration_(configuration, definition);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Unable to acquire the P&L deployment queue lock.');

  try {
    const current = readPnlDeploymentState_(definition);
    const sameConfiguration = current &&
      Number(current.configurationVersion || 0) === validatedConfiguration.configuration_version &&
      String(current.configurationHash || '') === validatedConfiguration.configuration_hash;

    if (sameConfiguration) return summarizePnlDeploymentState_(current, false);
    if (current && ['pending', 'processing'].includes(current.status)) {
      throw new Error('Another deployment is already active for ' + definition.reportKey + '. ' +
        'ActiveOperationId=' + current.operationId + ', ActiveVersion=' + current.configurationVersion);
    }

    const now = new Date().toISOString();
    const state = {
      schemaVersion: '1.0',
      operationId: Utilities.getUuid(),
      requestId: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
      reportKey: definition.reportKey,
      variant: definition.variantKey,
      configurationVersion: validatedConfiguration.configuration_version,
      configurationHash: validatedConfiguration.configuration_hash,
      configuration: validatedConfiguration,
      status: 'pending',
      currentStage: 'bigquery',
      attempts: { bigquery: 0, data_source_sheets: 0, extracts: 0 },
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
      lastRetry: null,
      stages: {
        bigquery: createPnlDeploymentStageState_(),
        data_source_sheets: createPnlDeploymentStageState_(),
        extracts: createPnlDeploymentStageState_()
      }
    };

    persistPnlDeploymentState_(state, definition);
    ensurePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.initialDelayMs);
    return summarizePnlDeploymentState_(state, true);
  } finally {
    lock.releaseLock();
  }
}

function createPnlDeploymentStageState_() {
  return {
    status: 'pending', attempt: 0, startedAt: null, completedAt: null,
    retryScheduled: false, error: null, result: null
  };
}

function processProfitAndLossConfigurationDeployment() {
  return processPnlConfigurationDeployment_(null);
}

function processPnlConfigurationDeployment_(targetReportKey) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replacePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
    const deferred = { status: 'deferred_lock_busy', retryScheduled: true };
    Logger.log(JSON.stringify({ event: 'pnl_configuration_deployment_deferred', ...deferred }));
    return deferred;
  }

  let claimedState = null;
  let claimedDefinition = null;
  let claimedStage = null;

  try {
    deletePnlDeploymentWorkerTriggers_();
    recoverStalePnlDeploymentStates_();
    const selected = selectNextPnlDeployment_(targetReportKey);
    if (!selected) {
      return { status: 'no_pending_deployment', reportKey: targetReportKey || null };
    }

    claimedDefinition = selected.definition;
    let state = selected.state;
    claimedStage = getNextPnlDeploymentStage_(state, false);
    if (!claimedStage) {
      state.status = 'completed';
      state.currentStage = 'completed';
      state.completedAt = state.completedAt || new Date().toISOString();
      state.updatedAt = new Date().toISOString();
      persistPnlDeploymentState_(state, claimedDefinition);
      updatePnlDeploymentReceipt_(state, claimedDefinition);
      scheduleNextPnlDeploymentIfNeeded_();
      return summarizePnlDeploymentState_(state, false);
    }

    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];
    stageState.status = 'processing';
    stageState.attempt = Number(stageState.attempt || 0) + 1;
    stageState.startedAt = now;
    stageState.completedAt = null;
    stageState.retryScheduled = false;
    stageState.error = null;
    state.attempts[claimedStage] = stageState.attempt;
    state.status = 'processing';
    state.currentStage = claimedStage;
    state.updatedAt = now;
    state.lastError = null;
    persistPnlDeploymentState_(state, claimedDefinition);
    claimedState = JSON.parse(JSON.stringify(state));

    Logger.log(JSON.stringify({
      event: state.reportKey + '_configuration_deployment_stage_started',
      operationId: state.operationId,
      stage: claimedStage,
      attempt: stageState.attempt,
      configurationVersion: state.configurationVersion,
      configurationHash: state.configurationHash
    }));

    const stageResult = executePnlDeploymentStage_(claimedStage, claimedState);
    const current = readPnlDeploymentState_(claimedDefinition);
    if (!current || current.operationId !== claimedState.operationId) {
      ensurePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
      const superseded = {
        status: 'superseded', operationId: claimedState.operationId, stage: claimedStage,
        currentOperationId: current && current.operationId || null
      };
      Logger.log(JSON.stringify({ event: state.reportKey + '_configuration_deployment_stage_superseded', ...superseded }));
      return superseded;
    }

    const completedAt = new Date().toISOString();
    current.stages[claimedStage].status = 'completed';
    current.stages[claimedStage].completedAt = completedAt;
    current.stages[claimedStage].retryScheduled = false;
    current.stages[claimedStage].error = null;
    current.stages[claimedStage].result = compactPnlDeploymentStageResult_(claimedStage, stageResult);
    current.updatedAt = completedAt;
    current.lastError = null;
    current.lastRetry = null;

    const nextStage = getNextPnlDeploymentStage_(current, false);
    if (nextStage) {
      current.status = 'pending';
      current.currentStage = nextStage;
    } else {
      current.status = 'completed';
      current.currentStage = 'completed';
      current.completedAt = completedAt;
    }

    persistPnlDeploymentState_(current, claimedDefinition);
    updatePnlDeploymentReceipt_(current, claimedDefinition);
    scheduleNextPnlDeploymentIfNeeded_();

    const result = summarizePnlDeploymentState_(current, false);
    Logger.log(JSON.stringify({
      event: current.reportKey + '_configuration_deployment_stage_completed',
      operationId: current.operationId,
      stage: claimedStage,
      attempt: current.stages[claimedStage].attempt,
      configurationVersion: current.configurationVersion,
      configurationHash: current.configurationHash,
      status: current.status,
      currentStage: current.currentStage
    }));
    return result;
  } catch (error) {
    let retryScheduled = false;
    let stateAfterFailure = null;

    if (claimedState && claimedDefinition && claimedStage) {
      const current = readPnlDeploymentState_(claimedDefinition);
      if (current && current.operationId === claimedState.operationId) {
        const failedAt = new Date().toISOString();
        const stageState = current.stages[claimedStage];
        const errorMessage = String(error && error.message || error);
        stageState.error = errorMessage;
        stageState.completedAt = failedAt;
        current.updatedAt = failedAt;
        current.lastError = errorMessage;

        if (Number(stageState.attempt || 0) < PNL_OPERATIONAL_DEPLOYMENT.maxStageAttempts) {
          stageState.status = 'pending';
          stageState.retryScheduled = true;
          current.status = 'pending';
          current.currentStage = claimedStage;
          retryScheduled = true;
        } else {
          stageState.status = 'failed';
          stageState.retryScheduled = false;
          current.status = 'failed';
          current.currentStage = claimedStage;
        }

        current.lastRetry = {
          stage: claimedStage,
          attempt: Number(stageState.attempt || 0),
          retryScheduled,
          error: errorMessage
        };
        persistPnlDeploymentState_(current, claimedDefinition);
        updatePnlDeploymentReceipt_(current, claimedDefinition);
        stateAfterFailure = current;
      }
    }

    if (retryScheduled) {
      ensurePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs);
    } else {
      scheduleNextPnlDeploymentIfNeeded_();
    }

    Logger.log(JSON.stringify({
      event: (claimedState && claimedState.reportKey || 'pnl') + '_configuration_deployment_stage_failed',
      operationId: claimedState && claimedState.operationId || null,
      stage: claimedStage,
      attempt: stateAfterFailure && stateAfterFailure.stages[claimedStage]
        ? stateAfterFailure.stages[claimedStage].attempt : null,
      retryScheduled,
      error: String(error && error.message || error)
    }));

    if (retryScheduled) {
      return {
        status: 'retry_scheduled', operationId: claimedState.operationId,
        reportKey: claimedState.reportKey, stage: claimedStage,
        attempt: stateAfterFailure.stages[claimedStage].attempt,
        error: String(error && error.message || error)
      };
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function executePnlDeploymentStage_(stage, state) {
  const definition = getPnlEntityControlDefinition_(state.reportKey);
  if (stage === 'bigquery') {
    const configuration = validatePnlEntityConfiguration_(
      state.configuration, definition, state.configurationVersion
    );
    if (configuration.configuration_hash !== state.configurationHash) {
      throw new Error('Deployment configuration hash no longer matches the queued operation.');
    }
    const loaded = { source: 'configuration_push_operation', definition, configuration };
    return executeProfitAndLossVariantSnapshot_(definition.variantKey, loaded);
  }
  if (stage === 'data_source_sheets') {
    return refreshPnlConnectedSheetsStage_('data_source_sheets', state.reportKey);
  }
  if (stage === 'extracts') {
    return refreshPnlConnectedSheetsStage_('extracts', state.reportKey);
  }
  throw new Error('Unsupported P&L deployment stage: ' + stage);
}

function refreshPnlConnectedSheetsPipeline_(spreadsheetOverride, reportKey) {
  const sourceSheets = refreshPnlConnectedSheetsStage_('data_source_sheets', reportKey, spreadsheetOverride);
  const extracts = refreshPnlConnectedSheetsStage_('extracts', reportKey, spreadsheetOverride);
  return {
    status: 'passed', reportKey: reportKey || 'all',
    refreshedObjectCount: sourceSheets.refreshedObjectCount + extracts.refreshedObjectCount,
    stages: { dataSourceSheets: sourceSheets, extracts }
  };
}

function refreshPnlConnectedSheetsStage_(stage, reportKey, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getPnlReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getPnlConnectedSheetTargets_(spreadsheet, stage, reportKey);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(PNL_CONNECTED_SHEETS_CONFIG.timeoutSeconds);

  const executions = targets.map(target => {
    const status = target.getStatus();
    const state = String(status.getExecutionState());
    const errorCode = String(status.getErrorCode() || 'NONE');
    const lastExecutionTime = status.getLastExecutionTime();
    const lastRefreshedTime = status.getLastRefreshedTime();
    return {
      name: target.name,
      type: target.type,
      state,
      errorCode,
      errorMessage: String(status.getErrorMessage() || '').trim() || null,
      lastExecutionAt: lastExecutionTime ? lastExecutionTime.toISOString() : null,
      lastRefreshedAt: lastRefreshedTime ? lastRefreshedTime.toISOString() : null,
      truncated: status.isTruncated() === true
    };
  });

  const failures = executions.filter(execution =>
    execution.state !== 'SUCCESS' || execution.errorCode !== 'NONE' || execution.truncated
  );
  if (failures.length) {
    throw new Error('P&L Connected Sheets stage failed: ' + JSON.stringify({ reportKey, stage, failures }));
  }

  const result = {
    status: 'passed', reportKey: reportKey || 'all', stage,
    refreshedObjectCount: executions.length, executions
  };
  Logger.log(JSON.stringify({
    event: (reportKey || 'pnl') + '_connected_sheets_stage_completed', ...result
  }));
  return result;
}

function getPnlConnectedSheetTargets_(spreadsheet, stage, reportKey) {
  const targetConfig = loadOrDiscoverPnlConnectedSheetTargets_(spreadsheet);
  const reportKeys = reportKey
    ? [getPnlEntityControlDefinition_(reportKey).reportKey]
    : [PNL_ENTITY_CONTROL.reports.normal.reportKey, PNL_ENTITY_CONTROL.reports.by_class.reportKey];
  const expectedNames = [];

  reportKeys.forEach(key => {
    const report = targetConfig.reports && targetConfig.reports[key];
    if (!report) throw new Error('Missing Connected Sheets target configuration for ' + key + '.');
    const names = stage === 'data_source_sheets' ? report.dataSourceSheets : report.extracts;
    (names || []).forEach(name => {
      if (!expectedNames.includes(name)) expectedNames.push(name);
    });
  });
  if (!expectedNames.length) {
    throw new Error('No configured P&L Connected Sheets targets were found for stage=' + stage +
      ', reportKey=' + (reportKey || 'all'));
  }

  let targets;
  if (stage === 'data_source_sheets') {
    targets = spreadsheet.getDataSourceSheets()
      .filter(source => expectedNames.includes(source.asSheet().getName()))
      .map(source => ({
        name: source.asSheet().getName(), type: 'data_source_sheet',
        refresh: () => source.refreshData(), getStatus: () => source.getStatus()
      }));
  } else if (stage === 'extracts') {
    targets = spreadsheet.getDataSourceTables()
      .filter(extract => expectedNames.includes(extract.getRange().getSheet().getName()))
      .map(extract => ({
        name: extract.getRange().getSheet().getName(), type: 'extract',
        refresh: () => extract.refreshData(), getStatus: () => extract.getStatus()
      }));
  } else {
    throw new Error('Unsupported Connected Sheets stage: ' + stage);
  }

  const counts = {};
  targets.forEach(target => counts[target.name] = (counts[target.name] || 0) + 1);
  const missing = expectedNames.filter(name => !counts[name]);
  const duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
  if (missing.length || duplicates.length) {
    throw new Error('P&L Connected Sheets object validation failed: ' + JSON.stringify({
      reportKey: reportKey || 'all', stage, expectedNames, missing, duplicates, counts
    }));
  }
  return targets;
}

function getPnlReportSpreadsheet_() {
  const properties = PropertiesService.getScriptProperties();
  const configuredId = String(properties.getProperty(
    PNL_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty
  ) || '').trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('Missing Script Property: ' + PNL_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty);
  }
  properties.setProperty(PNL_OPERATIONAL_DEPLOYMENT.reportSpreadsheetIdProperty, active.getId());
  return active;
}

function inspectPnlConnectedSheetsInventory_(spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getPnlReportSpreadsheet_();
  const sourceSheets = spreadsheet.getDataSourceSheets().map(source =>
    describePnlConnectedSheetObject_(source, 'data_source_sheet', source.asSheet().getName())
  );
  const extracts = spreadsheet.getDataSourceTables().map(extract =>
    describePnlConnectedSheetObject_(extract, 'extract', extract.getRange().getSheet().getName())
  );
  return {
    spreadsheetId: spreadsheet.getId(), spreadsheetName: spreadsheet.getName(),
    dataSourceSheets: sourceSheets, extracts,
    objectCount: sourceSheets.length + extracts.length
  };
}

function describePnlConnectedSheetObject_(object, type, name) {
  const sourceDetails = {};
  try {
    const dataSource = typeof object.getDataSource === 'function' ? object.getDataSource() : null;
    if (dataSource && typeof dataSource.getId === 'function') sourceDetails.dataSourceId = String(dataSource.getId() || '');
    const spec = dataSource && typeof dataSource.getSpec === 'function' ? dataSource.getSpec() : null;
    if (spec && typeof spec.getType === 'function') sourceDetails.specType = String(spec.getType() || '');
    const bigQuery = spec && typeof spec.asBigQuery === 'function' ? spec.asBigQuery() : null;
    if (bigQuery) {
      ['getProjectId', 'getRawQuery', 'getTableProjectId', 'getTableDatasetId', 'getTableId'].forEach(method => {
        if (typeof bigQuery[method] === 'function') {
          try { sourceDetails[method.replace(/^get/, '').replace(/^./, value => value.toLowerCase())] = String(bigQuery[method]() || ''); }
          catch (error) { sourceDetails[method + 'Error'] = String(error.message || error); }
        }
      });
    }
  } catch (error) {
    sourceDetails.inspectionError = String(error.message || error);
  }
  const classificationText = normalizePnlConnectedSourceText_(name + ' ' + JSON.stringify(sourceDetails));
  return {
    name, type, sourceDetails,
    matchedReportKey: classifyPnlConnectedSheetObject_(classificationText)
  };
}

function normalizePnlConnectedSourceText_(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_&]+/g, ' ').replace(/\s+/g, ' ');
}

function classifyPnlConnectedSheetObject_(normalizedText) {
  const text = normalizePnlConnectedSourceText_(normalizedText);
  const byClass = PNL_CONNECTED_SHEETS_CONFIG.reportSources.by_class;
  if (byClass.includeTokens.some(token => text.includes(normalizePnlConnectedSourceText_(token)))) {
    return byClass.reportKey;
  }
  const normal = PNL_CONNECTED_SHEETS_CONFIG.reportSources.normal;
  const excluded = normal.excludeTokens.some(token => text.includes(normalizePnlConnectedSourceText_(token)));
  if (!excluded && normal.includeTokens.some(token => text.includes(normalizePnlConnectedSourceText_(token)))) {
    return normal.reportKey;
  }
  if (!excluded && (text.includes('p&l normal') || text.includes('profit and loss normal') ||
      text.includes('p&l') || text.includes('profit and loss'))) {
    return normal.reportKey;
  }
  return null;
}

function discoverPnlConnectedSheetTargets_(spreadsheetOverride) {
  const inventory = inspectPnlConnectedSheetsInventory_(spreadsheetOverride);
  const reports = {};
  [PNL_ENTITY_CONTROL.reports.normal.reportKey, PNL_ENTITY_CONTROL.reports.by_class.reportKey]
    .forEach(reportKey => reports[reportKey] = { dataSourceSheets: [], extracts: [] });

  inventory.dataSourceSheets.forEach(item => {
    if (item.matchedReportKey) reports[item.matchedReportKey].dataSourceSheets.push(item.name);
  });
  inventory.extracts.forEach(item => {
    if (item.matchedReportKey) reports[item.matchedReportKey].extracts.push(item.name);
  });

  Object.keys(reports).forEach(reportKey => {
    reports[reportKey].dataSourceSheets = Array.from(new Set(reports[reportKey].dataSourceSheets)).sort();
    reports[reportKey].extracts = Array.from(new Set(reports[reportKey].extracts)).sort();
  });
  const incomplete = Object.keys(reports).filter(reportKey =>
    !reports[reportKey].dataSourceSheets.length || !reports[reportKey].extracts.length
  );
  if (incomplete.length) {
    throw new Error('Unable to classify all P&L Connected Sheets objects. Run ' +
      'debugProfitAndLossConnectedSheetsInventory() and inspect matchedReportKey. ' +
      JSON.stringify({ incompleteReports: incomplete, inventory }));
  }

  return {
    schemaVersion: '1.0', spreadsheetId: inventory.spreadsheetId,
    generatedAt: new Date().toISOString(), reports
  };
}

function loadOrDiscoverPnlConnectedSheetTargets_(spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getPnlReportSpreadsheet_();
  const properties = PropertiesService.getScriptProperties();
  const serialized = properties.getProperty(PNL_OPERATIONAL_DEPLOYMENT.connectedSheetTargetsProperty);
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized);
      if (parsed && parsed.spreadsheetId === spreadsheet.getId() && parsed.reports) return parsed;
    } catch (error) {
      Logger.log(JSON.stringify({ event: 'pnl_connected_sheet_targets_invalid', error: error.message }));
    }
  }
  const discovered = discoverPnlConnectedSheetTargets_(spreadsheet);
  properties.setProperty(PNL_OPERATIONAL_DEPLOYMENT.connectedSheetTargetsProperty, JSON.stringify(discovered));
  return discovered;
}

function getNextPnlDeploymentStage_(state, includeFailed) {
  for (let index = 0; index < PNL_OPERATIONAL_DEPLOYMENT.stages.length; index++) {
    const stage = PNL_OPERATIONAL_DEPLOYMENT.stages[index];
    const status = state && state.stages && state.stages[stage] && state.stages[stage].status;
    if (status === 'pending' || status === 'processing' || (includeFailed && status === 'failed')) return stage;
  }
  return null;
}

function getPnlDeploymentDefinitions_() {
  return [
    getPnlEntityControlDefinition_(PNL_VARIANT_NORMAL),
    getPnlEntityControlDefinition_(PNL_VARIANT_BY_CLASS)
  ];
}

function readPnlDeploymentState_(definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget);
  const serialized = PropertiesService.getScriptProperties().getProperty(definition.deploymentStateProperty);
  if (!serialized) return null;
  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('State is not an object.');
    if (String(state.reportKey || '') !== definition.reportKey) throw new Error('Unexpected reportKey.');
    if (!String(state.operationId || '').trim()) throw new Error('Missing operationId.');
    return state;
  } catch (error) {
    throw new Error('Invalid P&L deployment state for ' + definition.reportKey + ': ' + error.message);
  }
}

function readAllPnlDeploymentStates_() {
  return getPnlDeploymentDefinitions_().map(definition => ({
    definition, state: readPnlDeploymentState_(definition)
  })).filter(item => item.state);
}

function persistPnlDeploymentState_(state, definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget || state.reportKey);
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > PNL_OPERATIONAL_DEPLOYMENT.maxStateBytes) {
    throw new Error('P&L deployment state exceeds the Script Property limit. ' +
      'ReportKey=' + definition.reportKey + ', Bytes=' + byteCount);
  }
  PropertiesService.getScriptProperties().setProperty(definition.deploymentStateProperty, serialized);
  return { byteCount, propertyKey: definition.deploymentStateProperty };
}

function selectNextPnlDeployment_(targetReportKey) {
  const target = targetReportKey ? getPnlEntityControlDefinition_(targetReportKey).reportKey : null;
  const candidates = readAllPnlDeploymentStates_().filter(item => {
    if (target && item.definition.reportKey !== target) return false;
    return item.state.status === 'pending';
  });
  candidates.sort((left, right) =>
    String(left.state.createdAt || '').localeCompare(String(right.state.createdAt || '')) ||
    left.definition.reportKey.localeCompare(right.definition.reportKey)
  );
  return candidates[0] || null;
}

function recoverStalePnlDeploymentStates_() {
  readAllPnlDeploymentStates_().forEach(item => {
    const state = item.state;
    if (state.status !== 'processing') return;
    const stageState = state.stages && state.stages[state.currentStage];
    const startedAt = stageState && Date.parse(stageState.startedAt || '');
    const ageSeconds = Number.isFinite(startedAt) ? (Date.now() - startedAt) / 1000 : Infinity;
    if (ageSeconds < PNL_OPERATIONAL_DEPLOYMENT.staleProcessingSeconds) return;
    const now = new Date().toISOString();
    if (stageState) {
      stageState.status = 'pending';
      stageState.retryScheduled = true;
      stageState.error = 'Recovered after a stale processing state.';
    }
    state.status = 'pending';
    state.updatedAt = now;
    state.lastError = stageState && stageState.error || 'Recovered stale deployment.';
    state.lastRetry = {
      stage: state.currentStage,
      attempt: stageState && stageState.attempt || 0,
      retryScheduled: true,
      error: state.lastError
    };
    persistPnlDeploymentState_(state, item.definition);
  });
}

function ensurePnlDeploymentWorkerTrigger_(delayMs) {
  const delay = Math.max(1000, Number(delayMs || 0));
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_OPERATIONAL_DEPLOYMENT.workerHandler);
  if (triggers.length) {
    triggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return { created: false, triggerId: triggers[0].getUniqueId(), delayMs: delay };
  }
  const trigger = ScriptApp.newTrigger(PNL_OPERATIONAL_DEPLOYMENT.workerHandler)
    .timeBased().after(delay).create();
  return { created: true, triggerId: trigger.getUniqueId(), delayMs: delay };
}

function replacePnlDeploymentWorkerTrigger_(delayMs) {
  deletePnlDeploymentWorkerTriggers_();
  return ensurePnlDeploymentWorkerTrigger_(delayMs);
}

function deletePnlDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === PNL_OPERATIONAL_DEPLOYMENT.workerHandler);
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function scheduleNextPnlDeploymentIfNeeded_() {
  const hasWork = readAllPnlDeploymentStates_().some(item =>
    item.state.status === 'pending' || item.state.status === 'processing'
  );
  if (hasWork) return ensurePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.nextStageDelayMs);
  deletePnlDeploymentWorkerTriggers_();
  return { created: false, deleted: true };
}

function updatePnlDeploymentReceipt_(state, definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget || state.reportKey);
  const properties = PropertiesService.getScriptProperties();
  const serialized = properties.getProperty(definition.pushReceiptProperty);
  if (!serialized) return null;

  let receipt;
  try { receipt = JSON.parse(serialized); } catch (error) { return null; }
  if (Number(receipt.configuration_version || 0) !== Number(state.configurationVersion || 0) ||
      String(receipt.configuration_hash || '') !== String(state.configurationHash || '')) return null;

  receipt.operation_id = state.operationId;
  receipt.deployment_status = state.status;
  receipt.current_stage = state.currentStage;
  receipt.deployment_updated_at = state.updatedAt;
  receipt.deployment_completed_at = state.completedAt || null;
  receipt.deployment_error = state.lastError || null;
  properties.setProperty(definition.pushReceiptProperty, JSON.stringify(receipt));
  return receipt;
}

function compactPnlDeploymentStageResult_(stage, result) {
  if (stage === 'bigquery') {
    return {
      variant: result.variant,
      period: result.period,
      clientCount: result.clientCount,
      rowCount: result.rowCount,
      jobId: result.loadResult && result.loadResult.jobId || result.jobId || null,
      loadState: result.loadResult && result.loadResult.state || null,
      schemaValidationStatus: result.schemaValidation && result.schemaValidation.status || null,
      verificationStatus: result.verification && result.verification.status || null,
      expectedRowCount: result.verification && result.verification.expectedRowCount,
      actualRowCount: result.verification && result.verification.actualRowCount,
      missingKeyCount: result.verification && result.verification.missingKeyCount,
      uniqueKeyCount: result.verification && result.verification.uniqueKeyCount
    };
  }
  return {
    status: result.status,
    reportKey: result.reportKey,
    refreshedObjectCount: result.refreshedObjectCount,
    executions: result.executions
  };
}

function summarizePnlDeploymentState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operationId,
    reportKey: state.reportKey,
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

function requeueFailedPnlDeployment_(definitionOrTarget) {
  const definition = definitionOrTarget && definitionOrTarget.reportKey
    ? definitionOrTarget : getPnlEntityControlDefinition_(definitionOrTarget);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Unable to acquire the P&L deployment requeue lock.');
  try {
    const current = readPnlDeploymentState_(definition);
    if (!current) throw new Error('No deployment state exists for ' + definition.reportKey + '.');
    if (current.status !== 'failed') {
      throw new Error('Only a failed deployment can be explicitly requeued. CurrentStatus=' + current.status);
    }
    const failedStage = getNextPnlDeploymentStage_(current, true);
    if (!failedStage) throw new Error('The failed deployment has no recoverable stage.');
    const now = new Date().toISOString();
    current.operationId = Utilities.getUuid();
    current.requestId = 'manual_requeue_' + Utilities.getUuid();
    current.status = 'pending';
    current.currentStage = failedStage;
    current.updatedAt = now;
    current.completedAt = null;
    current.lastError = null;
    current.lastRetry = null;
    current.stages[failedStage].status = 'pending';
    current.stages[failedStage].attempt = 0;
    current.stages[failedStage].startedAt = null;
    current.stages[failedStage].completedAt = null;
    current.stages[failedStage].retryScheduled = false;
    current.stages[failedStage].error = null;
    current.stages[failedStage].result = null;
    current.attempts[failedStage] = 0;
    persistPnlDeploymentState_(current, definition);
    updatePnlDeploymentReceipt_(current, definition);
    ensurePnlDeploymentWorkerTrigger_(PNL_OPERATIONAL_DEPLOYMENT.initialDelayMs);
    return summarizePnlDeploymentState_(current, true);
  } finally {
    lock.releaseLock();
  }
}