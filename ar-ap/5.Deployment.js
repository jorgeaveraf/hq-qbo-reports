/***********************
 * Aging Configuration Operational Deployment
 ***********************/

function queueAgingConfigurationDeployment_(pushPayload, configuration, options) {
  const validatedConfiguration = validateAgingEntityConfiguration_(configuration);
  const normalizedOptions = options && typeof options === 'object' ? options : {};
  const range = normalizeAgingDeploymentRange_(normalizedOptions.range);
  const source = String(normalizedOptions.source || 'configuration_push').trim();
  const current = readAgingDeploymentState_();

  const sameOperation = current &&
    current.configuration_version === validatedConfiguration.configuration_version &&
    current.configuration_hash === validatedConfiguration.configuration_hash &&
    current.range &&
    current.range.periodKey === range.periodKey;

  if (sameOperation && ['pending', 'processing', 'completed'].includes(current.status)) {
    if (current.status !== 'completed') {
      ensureAgingDeploymentWorkerScheduled_(AGING_OPERATIONAL_DEPLOYMENT.continuationDelayMs);
    }
    return summarizeAgingDeploymentState_(current, false);
  }

  const existingCheckpoint = readAgingBigQueryCheckpoint_();
  if (existingCheckpoint) {
    deleteAgingBigQueryCheckpoint_(existingCheckpoint.operation_id);
  }
  deleteAgingDeploymentWorkerTriggers_();

  const now = new Date().toISOString();
  const state = {
    schema_version: '1.1',
    operation_id: Utilities.getUuid(),
    request_id: String(pushPayload && pushPayload.request_id || Utilities.getUuid()),
    report_key: AGING_ENTITY_CONTROL.reportKey,
    source,
    configuration_version: validatedConfiguration.configuration_version,
    configuration_hash: validatedConfiguration.configuration_hash,
    configuration: validatedConfiguration,
    range,
    status: 'pending',
    current_stage: 'bigquery',
    attempts: {
      bigquery: 0,
      data_source_sheets: 0,
      extracts: 0
    },
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    stages: {
      bigquery: createAgingDeploymentStageState_(),
      data_source_sheets: createAgingDeploymentStageState_(),
      extracts: createAgingDeploymentStageState_()
    }
  };

  persistAgingDeploymentState_(state);
  replaceAgingDeploymentWorkerSchedule_(AGING_OPERATIONAL_DEPLOYMENT.initialDelayMs);
  return summarizeAgingDeploymentState_(state, true);
}

function createAgingDeploymentStageState_() {
  return {
    status: 'pending',
    attempt: 0,
    execution_count: 0,
    continuation_count: 0,
    timeout_recovery_count: 0,
    retry_scheduled: false,
    started_at: null,
    completed_at: null,
    error: null,
    result: null
  };
}

function normalizeAgingDeploymentRange_(range) {
  const normalized = range && typeof range === 'object'
    ? buildAgingSnapshotRange_(range.snapshotDate)
    : buildAgingSnapshotRange_();

  if (range && range.snapshotWeek && String(range.snapshotWeek) !== normalized.snapshotWeek) {
    throw new Error(
      'Aging deployment snapshotWeek mismatch. Expected=' +
        normalized.snapshotWeek +
        ', received=' +
        range.snapshotWeek
    );
  }

  return normalized;
}

function processAgingConfigurationDeployment() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    replaceAgingDeploymentWorkerSchedule_(AGING_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
    const deferred = {
      status: 'deferred_lock_busy',
      retryScheduled: true
    };
    Logger.log(JSON.stringify({
      event: 'aging_configuration_deployment_deferred',
      ...deferred
    }));
    return deferred;
  }

  let claimedState = null;
  let claimedStage = null;

  try {
    let state = readAgingDeploymentState_();
    if (!state) return { status: 'no_pending_deployment' };

    if (state.status === 'completed' || state.status === 'failed') {
      deleteAgingDeploymentWorkerTriggers_();
      if (state.status === 'completed') {
        deleteAgingBigQueryCheckpoint_(state.operation_id);
      }
      return summarizeAgingDeploymentState_(state, false);
    }

    if (state.status === 'processing') {
      const activeStage = state.current_stage;
      const activeStageState = state.stages && state.stages[activeStage];
      const startedAt = activeStageState && Date.parse(activeStageState.started_at || '');
      const ageSeconds = Number.isFinite(startedAt)
        ? (Date.now() - startedAt) / 1000
        : Infinity;

      if (ageSeconds < AGING_OPERATIONAL_DEPLOYMENT.staleRunningSeconds) {
        replaceAgingDeploymentWorkerSchedule_(AGING_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs);
        return {
          status: 'deferred_stage_processing',
          operationId: state.operation_id,
          currentStage: activeStage
        };
      }

      if (activeStageState) {
        activeStageState.timeout_recovery_count =
          Number(activeStageState.timeout_recovery_count || 0) + 1;

        if (
          activeStageState.timeout_recovery_count >
          AGING_OPERATIONAL_DEPLOYMENT.maxTimeoutRecoveries
        ) {
          const timeoutError =
            'Aging deployment exceeded the maximum timeout recoveries for stage ' +
            activeStage +
            '.';
          activeStageState.status = 'failed';
          activeStageState.error = timeoutError;
          state.status = 'failed';
          state.last_error = timeoutError;
          state.updated_at = new Date().toISOString();
          persistAgingDeploymentState_(state);
          updateAgingDeploymentReceipt_(state);
          deleteAgingDeploymentWorkerTriggers_();
          throw new Error(timeoutError);
        }

        activeStageState.status = 'pending';
        activeStageState.error = 'Recovered after a stale processing state.';
      }

      state.status = 'pending';
      state.updated_at = new Date().toISOString();
      persistAgingDeploymentState_(state);

      Logger.log(JSON.stringify({
        event: 'aging_configuration_deployment_timeout_recovered',
        operationId: state.operation_id,
        stage: activeStage,
        timeoutRecoveryCount: activeStageState &&
          activeStageState.timeout_recovery_count || 0
      }));
    }

    claimedStage = getNextAgingDeploymentStage_(state);

    if (!claimedStage) {
      const completedAt = new Date().toISOString();
      state.status = 'completed';
      state.current_stage = 'completed';
      state.completed_at = state.completed_at || completedAt;
      state.updated_at = completedAt;
      state.last_error = null;
      persistAgingDeploymentState_(state);
      updateAgingDeploymentReceipt_(state);
      deleteAgingBigQueryCheckpoint_(state.operation_id);
      deleteAgingDeploymentWorkerTriggers_();
      return summarizeAgingDeploymentState_(state, false);
    }

    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];
    stageState.status = 'processing';
    stageState.execution_count = Number(stageState.execution_count || 0) + 1;
    stageState.retry_scheduled = false;
    stageState.started_at = now;
    stageState.error = null;
    state.status = 'processing';
    state.current_stage = claimedStage;
    state.updated_at = now;
    persistAgingDeploymentState_(state);

    replaceAgingDeploymentWorkerSchedule_(
      AGING_OPERATIONAL_DEPLOYMENT.watchdogDelayMs
    );

    claimedState = JSON.parse(JSON.stringify(state));

    Logger.log(JSON.stringify({
      event: 'aging_configuration_deployment_stage_started',
      operationId: state.operation_id,
      stage: claimedStage,
      attempt: Number(stageState.attempt || 0) + 1,
      executionCount: stageState.execution_count,
      continuationCount: stageState.continuation_count,
      configurationVersion: state.configuration_version,
      configurationHash: state.configuration_hash,
      snapshotDate: state.range && state.range.snapshotDate
    }));

    const stageResult = executeAgingDeploymentStage_(claimedStage, claimedState);
    const current = readAgingDeploymentState_();

    if (!current || current.operation_id !== claimedState.operation_id) {
      ensureAgingDeploymentWorkerScheduled_(
        AGING_OPERATIONAL_DEPLOYMENT.continuationDelayMs
      );
      return {
        status: 'superseded',
        operationId: claimedState.operation_id,
        stage: claimedStage,
        currentOperationId: current && current.operation_id || null
      };
    }

    const updatedAt = new Date().toISOString();
    const currentStageState = current.stages[claimedStage];

    if (stageResult && stageResult.status === 'yielded') {
      currentStageState.status = 'pending';
      currentStageState.continuation_count =
        Number(currentStageState.continuation_count || 0) + 1;
      currentStageState.retry_scheduled = true;
      currentStageState.error = null;
      currentStageState.result = compactAgingDeploymentStageResult_(
        claimedStage,
        stageResult
      );
      current.status = 'pending';
      current.current_stage = claimedStage;
      current.updated_at = updatedAt;
      current.last_error = null;
      persistAgingDeploymentState_(current);
      updateAgingDeploymentReceipt_(current);
      replaceAgingDeploymentWorkerSchedule_(
        AGING_OPERATIONAL_DEPLOYMENT.continuationDelayMs
      );

      const yieldedResult = summarizeAgingDeploymentState_(current, false);
      Logger.log(JSON.stringify({
        event: 'aging_configuration_deployment_stage_yielded',
        stage: claimedStage,
        reason: stageResult.reason,
        processedClientCount: stageResult.processedClientCount,
        remainingClientCount: stageResult.remainingClientCount,
        nextClientIndex: stageResult.nextClientIndex,
        continuationCount: stageResult.continuationCount,
        ...yieldedResult
      }));
      return yieldedResult;
    }

    currentStageState.status = 'completed';
    currentStageState.completed_at = updatedAt;
    currentStageState.error = null;
    currentStageState.retry_scheduled = false;
    currentStageState.result = compactAgingDeploymentStageResult_(
      claimedStage,
      stageResult
    );
    current.updated_at = updatedAt;
    current.last_error = null;

    if (claimedStage === 'bigquery') {
      deleteAgingBigQueryCheckpoint_(current.operation_id);
    }

    const nextStage = getNextAgingDeploymentStage_(current);
    if (nextStage) {
      current.status = 'pending';
      current.current_stage = nextStage;
      persistAgingDeploymentState_(current);
      updateAgingDeploymentReceipt_(current);
      replaceAgingDeploymentWorkerSchedule_(
        AGING_OPERATIONAL_DEPLOYMENT.nextStageDelayMs
      );
    } else {
      current.status = 'completed';
      current.current_stage = 'completed';
      current.completed_at = updatedAt;
      persistAgingDeploymentState_(current);
      updateAgingDeploymentReceipt_(current);
      deleteAgingDeploymentWorkerTriggers_();
    }

    const result = summarizeAgingDeploymentState_(current, false);
    Logger.log(JSON.stringify({
      event: 'aging_configuration_deployment_stage_completed',
      stage: claimedStage,
      ...result
    }));
    return result;
  } catch (error) {
    const current = readAgingDeploymentState_();
    let retryScheduled = false;

    if (
      claimedState &&
      current &&
      current.operation_id === claimedState.operation_id &&
      claimedStage
    ) {
      const failedAt = new Date().toISOString();
      const stageState = current.stages[claimedStage];
      stageState.attempt = Number(stageState.attempt || 0) + 1;
      stageState.error = String(error && error.message || error);
      stageState.completed_at = failedAt;
      current.attempts[claimedStage] = stageState.attempt;
      current.updated_at = failedAt;
      current.last_error = stageState.error;

      if (claimedStage === 'bigquery') {
        prepareAgingBigQueryCheckpointForRetry_(current.operation_id);
      }

      if (stageState.attempt < AGING_OPERATIONAL_DEPLOYMENT.maxStageAttempts) {
        stageState.status = 'pending';
        stageState.retry_scheduled = true;
        current.status = 'pending';
        current.current_stage = claimedStage;
        retryScheduled = true;
      } else {
        stageState.status = 'failed';
        stageState.retry_scheduled = false;
        current.status = 'failed';
        current.current_stage = claimedStage;
      }

      persistAgingDeploymentState_(current);
      updateAgingDeploymentReceipt_(current);

      if (retryScheduled) {
        replaceAgingDeploymentWorkerSchedule_(
          AGING_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs
        );
      } else {
        deleteAgingDeploymentWorkerTriggers_();
      }
    }

    Logger.log(JSON.stringify({
      event: 'aging_configuration_deployment_stage_failed',
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

function executeAgingDeploymentStage_(stage, state) {
  if (stage === 'bigquery') {
    const configuration = validateAgingEntityConfiguration_(
      state.configuration,
      state.configuration_version
    );
    if (configuration.configuration_hash !== state.configuration_hash) {
      throw new Error(
        'Deployment configuration hash no longer matches the queued operation.'
      );
    }
    return executeAgingBigQueryContinuationStage_(state);
  }

  if (stage === 'data_source_sheets') {
    return refreshAgingConnectedSheetsStage_('data_source_sheets');
  }

  if (stage === 'extracts') {
    return refreshAgingConnectedSheetsStage_('extracts');
  }

  throw new Error('Unsupported Aging deployment stage: ' + stage);
}

function executeAgingBigQueryContinuationStage_(state) {
  const executionStartedAt = Date.now();
  let checkpoint = readAgingBigQueryCheckpoint_();

  if (!checkpoint || !agingBigQueryCheckpointMatchesState_(checkpoint, state)) {
    if (checkpoint) deleteAgingBigQueryCheckpoint_(checkpoint.operation_id);
    checkpoint = initializeAgingBigQueryCheckpoint_(state);
  }

  Logger.log(JSON.stringify({
    event: 'aging_bigquery_continuation_started',
    operationId: checkpoint.operation_id,
    snapshotDate: checkpoint.range.snapshotDate,
    nextClientIndex: checkpoint.next_client_index,
    processedClientCount: checkpoint.processed_client_count,
    totalClientCount: checkpoint.clients.length,
    continuationCount: checkpoint.continuation_count
  }));

  if (!checkpoint.partition_initialized) {
    if (!checkpoint.partition_clear_job_id) {
      checkpoint.partition_clear_job_id = buildAgingBigQueryJobId_(
        checkpoint.operation_id,
        checkpoint.range.snapshotDate,
        'partition_clear',
        '',
        checkpoint.partition_clear_generation
      );
      persistAgingBigQueryCheckpoint_(checkpoint);
    }

    const clearResult = ensureAgingBigQueryQueryJob_(
      checkpoint.partition_clear_job_id,
      buildAgingPartitionClearQuery_(checkpoint.range.snapshotDate)
    );

    if (!clearResult.done) {
      return yieldAgingBigQueryCheckpoint_(
        checkpoint,
        'partition_clear_job_pending'
      );
    }

    checkpoint.partition_initialized = true;
    checkpoint.partition_clear_completed_at = new Date().toISOString();
    persistAgingBigQueryCheckpoint_(checkpoint);
  }

  let processedThisExecution = 0;

  while (checkpoint.next_client_index < checkpoint.clients.length) {
    if (
      processedThisExecution >=
      AGING_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution
    ) {
      return yieldAgingBigQueryCheckpoint_(checkpoint, 'client_batch_limit');
    }

    if (agingExecutionBudgetReached_(executionStartedAt)) {
      return yieldAgingBigQueryCheckpoint_(checkpoint, 'execution_budget');
    }

    const clientResult = processAgingBigQueryCheckpointClient_(
      checkpoint,
      executionStartedAt
    );

    if (clientResult.status === 'yielded') {
      return yieldAgingBigQueryCheckpoint_(
        clientResult.checkpoint,
        clientResult.reason
      );
    }

    checkpoint = clientResult.checkpoint;
    processedThisExecution++;
  }

  if (checkpoint.verification) {
    return buildAgingBigQueryCompletionResult_(checkpoint);
  }

  if (!checkpoint.verification_job_id) {
    checkpoint.verification_job_id = buildAgingBigQueryJobId_(
      checkpoint.operation_id,
      checkpoint.range.snapshotDate,
      'verification',
      '',
      checkpoint.verification_generation
    );
    persistAgingBigQueryCheckpoint_(checkpoint);
  }

  const verificationJob = ensureAgingBigQueryQueryJob_(
    checkpoint.verification_job_id,
    buildAgingVerificationQuery_(checkpoint.range.snapshotDate)
  );

  if (!verificationJob.done) {
    return yieldAgingBigQueryCheckpoint_(
      checkpoint,
      'verification_job_pending'
    );
  }

  const verificationQueryResult = getAgingBigQueryQueryResult_(
    checkpoint.verification_job_id
  );

  if (!verificationQueryResult.done) {
    return yieldAgingBigQueryCheckpoint_(
      checkpoint,
      'verification_results_pending'
    );
  }

  checkpoint.verification = parseAgingVerificationResult_(
    checkpoint.range.snapshotDate,
    verificationQueryResult.result,
    {
      rowCount: checkpoint.row_count,
      uniqueRowCount: checkpoint.unique_row_count,
      clientCount: checkpoint.clients_with_rows_count,
      reportRowCounts: checkpoint.report_row_counts,
      openAmountCents: checkpoint.open_amount_cents
    }
  );
  checkpoint.updated_at = new Date().toISOString();
  persistAgingBigQueryCheckpoint_(checkpoint);

  return buildAgingBigQueryCompletionResult_(checkpoint);
}

function initializeAgingBigQueryCheckpoint_(state) {
  const configuration = validateAgingEntityConfiguration_(
    state.configuration,
    state.configuration_version
  );
  const loaded = {
    source: String(state.source || 'configuration_push_operation'),
    configuration
  };
  const snapshotClients = getAgingSnapshotClients_(loaded);
  const now = new Date().toISOString();
  const checkpoint = {
    schema_version: '1.0',
    operation_id: state.operation_id,
    configuration_version: state.configuration_version,
    configuration_hash: state.configuration_hash,
    range: normalizeAgingDeploymentRange_(state.range),
    loaded_at: now,
    entity_configuration: buildAgingEntityConfigurationSummary_(
      snapshotClients.selection
    ),
    schema_validation: validateAgingBigQuerySchema_(),
    clients: snapshotClients.clients,
    next_client_index: 0,
    processed_client_count: 0,
    clients_with_rows_count: 0,
    report_row_counts: { AR: 0, AP: 0 },
    row_count: 0,
    unique_row_count: 0,
    open_amount_cents: { AR: 0, AP: 0 },
    continuation_count: 0,
    partition_initialized: false,
    partition_clear_generation: 0,
    partition_clear_job_id: null,
    partition_clear_completed_at: null,
    verification_generation: 0,
    verification_job_id: null,
    verification: null,
    current_client: null,
    created_at: now,
    updated_at: now
  };

  persistAgingBigQueryCheckpoint_(checkpoint);
  Logger.log(JSON.stringify({
    event: 'aging_bigquery_checkpoint_initialized',
    operationId: checkpoint.operation_id,
    snapshotDate: checkpoint.range.snapshotDate,
    clientCount: checkpoint.clients.length,
    maxClientsPerExecution:
      AGING_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution,
    executionBudgetMs: AGING_OPERATIONAL_DEPLOYMENT.executionBudgetMs
  }));
  return checkpoint;
}

function processAgingBigQueryCheckpointClient_(checkpoint, executionStartedAt) {
  const client = checkpoint.clients[checkpoint.next_client_index];
  if (!client) {
    throw new Error(
      'Aging checkpoint client is missing at index ' +
        checkpoint.next_client_index +
        '.'
    );
  }

  let currentClient = checkpoint.current_client;
  let clientSnapshot = null;

  if (!currentClient) {
    clientSnapshot = buildAgingClientSnapshot_(
      client,
      checkpoint.range,
      checkpoint.loaded_at
    );

    currentClient = {
      index: checkpoint.next_client_index,
      client_id: client.id,
      client_name: client.name,
      generation: 0,
      phase: 'prepared',
      row_count: clientSnapshot.rowCount,
      unique_row_count: clientSnapshot.uniqueRowCount,
      report_row_counts: clientSnapshot.reportRowCounts,
      open_amount_cents: clientSnapshot.openAmountCents,
      delete_job_id: null,
      load_job_id: null,
      prepared_at: new Date().toISOString()
    };
    checkpoint.current_client = currentClient;
    checkpoint.updated_at = new Date().toISOString();
    persistAgingBigQueryCheckpoint_(checkpoint);
  } else {
    assertAgingCheckpointCurrentClient_(checkpoint, client);
  }

  if (!currentClient.delete_job_id) {
    currentClient.delete_job_id = buildAgingBigQueryJobId_(
      checkpoint.operation_id,
      checkpoint.range.snapshotDate,
      'client_delete',
      client.id,
      currentClient.generation
    );
    checkpoint.updated_at = new Date().toISOString();
    persistAgingBigQueryCheckpoint_(checkpoint);
  }

  const deleteResult = ensureAgingBigQueryQueryJob_(
    currentClient.delete_job_id,
    buildAgingClientDeleteQuery_(checkpoint.range.snapshotDate, client.id)
  );

  if (!deleteResult.done) {
    currentClient.phase = 'deleting';
    checkpoint.updated_at = new Date().toISOString();
    persistAgingBigQueryCheckpoint_(checkpoint);
    return {
      status: 'yielded',
      reason: 'client_delete_job_pending',
      checkpoint
    };
  }

  currentClient.phase = 'deleted';
  checkpoint.updated_at = new Date().toISOString();
  persistAgingBigQueryCheckpoint_(checkpoint);

  if (currentClient.row_count > 0) {
    if (!currentClient.load_job_id) {
      currentClient.load_job_id = buildAgingBigQueryJobId_(
        checkpoint.operation_id,
        checkpoint.range.snapshotDate,
        'client_load',
        client.id,
        currentClient.generation
      );
      checkpoint.updated_at = new Date().toISOString();
      persistAgingBigQueryCheckpoint_(checkpoint);
    }

    const existingLoadJob = getAgingBigQueryJobIfExists_(
      currentClient.load_job_id
    );

    if (!existingLoadJob && !clientSnapshot) {
      clientSnapshot = buildAgingClientSnapshot_(
        client,
        checkpoint.range,
        checkpoint.loaded_at
      );
      assertAgingClientSnapshotMatchesCheckpoint_(
        clientSnapshot,
        currentClient
      );
    }

    const loadResult = ensureAgingBigQueryLoadJob_(
      currentClient.load_job_id,
      checkpoint.range.snapshotDate,
      clientSnapshot && clientSnapshot.rows
    );

    if (!loadResult.done) {
      currentClient.phase = 'loading';
      checkpoint.updated_at = new Date().toISOString();
      persistAgingBigQueryCheckpoint_(checkpoint);
      return {
        status: 'yielded',
        reason: 'client_load_job_pending',
        checkpoint
      };
    }

    if (
      loadResult.outputRows !== null &&
      loadResult.outputRows !== currentClient.row_count
    ) {
      throw new Error(
        'Aging client load output row mismatch. ClientId=' +
          client.id +
          ', expected=' +
          currentClient.row_count +
          ', actual=' +
          loadResult.outputRows
      );
    }
  }

  checkpoint.row_count += currentClient.row_count;
  checkpoint.unique_row_count += currentClient.unique_row_count;
  checkpoint.report_row_counts.AR +=
    Number(currentClient.report_row_counts.AR || 0);
  checkpoint.report_row_counts.AP +=
    Number(currentClient.report_row_counts.AP || 0);
  checkpoint.open_amount_cents.AR +=
    Number(currentClient.open_amount_cents.AR || 0);
  checkpoint.open_amount_cents.AP +=
    Number(currentClient.open_amount_cents.AP || 0);

  if (currentClient.row_count > 0) {
    checkpoint.clients_with_rows_count++;
  }

  checkpoint.processed_client_count++;
  checkpoint.next_client_index++;
  checkpoint.current_client = null;
  checkpoint.updated_at = new Date().toISOString();
  persistAgingBigQueryCheckpoint_(checkpoint);

  Logger.log(JSON.stringify({
    event: 'aging_bigquery_client_completed',
    operationId: checkpoint.operation_id,
    clientIndex: currentClient.index,
    clientId: currentClient.client_id,
    clientName: currentClient.client_name,
    rowCount: currentClient.row_count,
    reportRowCounts: currentClient.report_row_counts,
    processedClientCount: checkpoint.processed_client_count,
    remainingClientCount:
      checkpoint.clients.length - checkpoint.next_client_index
  }));

  return {
    status: 'completed',
    checkpoint
  };
}

function assertAgingCheckpointCurrentClient_(checkpoint, client) {
  const current = checkpoint.current_client;
  if (!current) throw new Error('Aging checkpoint current_client is missing.');
  if (
    Number(current.index) !== Number(checkpoint.next_client_index) ||
    String(current.client_id) !== String(client.id)
  ) {
    throw new Error('Aging checkpoint current client does not match the manifest.');
  }
}

function assertAgingClientSnapshotMatchesCheckpoint_(snapshot, currentClient) {
  const mismatches = [];
  if (snapshot.rowCount !== Number(currentClient.row_count)) {
    mismatches.push('rowCount');
  }
  if (snapshot.uniqueRowCount !== Number(currentClient.unique_row_count)) {
    mismatches.push('uniqueRowCount');
  }
  ['AR', 'AP'].forEach(reportType => {
    if (
      Number(snapshot.reportRowCounts[reportType] || 0) !==
      Number(currentClient.report_row_counts[reportType] || 0)
    ) {
      mismatches.push(reportType + 'RowCount');
    }
    if (
      Number(snapshot.openAmountCents[reportType] || 0) !==
      Number(currentClient.open_amount_cents[reportType] || 0)
    ) {
      mismatches.push(reportType + 'OpenAmount');
    }
  });

  if (mismatches.length) {
    throw new Error(
      'Aging client snapshot changed while resuming. ClientId=' +
        currentClient.client_id +
        ', mismatches=' +
        mismatches.join(',')
    );
  }
}

function yieldAgingBigQueryCheckpoint_(checkpoint, reason) {
  checkpoint.continuation_count = Number(checkpoint.continuation_count || 0) + 1;
  if (
    checkpoint.continuation_count >
    AGING_OPERATIONAL_DEPLOYMENT.maxContinuationCount
  ) {
    throw new Error(
      'Aging BigQuery exceeded the maximum continuation count. Count=' +
        checkpoint.continuation_count
    );
  }

  checkpoint.updated_at = new Date().toISOString();
  persistAgingBigQueryCheckpoint_(checkpoint);

  return {
    status: 'yielded',
    reason,
    snapshotDate: checkpoint.range.snapshotDate,
    snapshotWeek: checkpoint.range.snapshotWeek,
    clientCount: checkpoint.clients.length,
    processedClientCount: checkpoint.processed_client_count,
    remainingClientCount:
      checkpoint.clients.length - checkpoint.next_client_index,
    nextClientIndex: checkpoint.next_client_index,
    continuationCount: checkpoint.continuation_count,
    rowCount: checkpoint.row_count,
    reportRowCounts: checkpoint.report_row_counts
  };
}

function agingExecutionBudgetReached_(executionStartedAt) {
  return (
    Date.now() - Number(executionStartedAt || 0) >=
    AGING_OPERATIONAL_DEPLOYMENT.executionBudgetMs
  );
}

function buildAgingBigQueryCompletionResult_(checkpoint) {
  return {
    status: 'completed',
    event: 'aging_snapshot_completed',
    entityConfiguration: checkpoint.entity_configuration,
    schemaValidation: checkpoint.schema_validation,
    snapshotDate: checkpoint.range.snapshotDate,
    snapshotWeek: checkpoint.range.snapshotWeek,
    clientCount: checkpoint.clients.length,
    clientsWithRowsCount: checkpoint.clients_with_rows_count,
    processedClientCount: checkpoint.processed_client_count,
    reportRowCounts: checkpoint.report_row_counts,
    rowCount: checkpoint.row_count,
    uniqueRowCount: checkpoint.unique_row_count,
    openAmount: {
      AR: checkpoint.open_amount_cents.AR / 100,
      AP: checkpoint.open_amount_cents.AP / 100
    },
    continuationCount: checkpoint.continuation_count,
    verification: checkpoint.verification
  };
}

function agingBigQueryCheckpointMatchesState_(checkpoint, state) {
  return Boolean(
    checkpoint &&
    state &&
    checkpoint.operation_id === state.operation_id &&
    Number(checkpoint.configuration_version) === Number(state.configuration_version) &&
    checkpoint.configuration_hash === state.configuration_hash &&
    checkpoint.range &&
    state.range &&
    checkpoint.range.periodKey === state.range.periodKey
  );
}

function readAgingBigQueryCheckpoint_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    AGING_OPERATIONAL_DEPLOYMENT.checkpointPropertyKey
  );
  if (!serialized) return null;

  try {
    const checkpoint = JSON.parse(serialized);
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) {
      throw new Error('Checkpoint is not an object.');
    }
    if (!String(checkpoint.operation_id || '').trim()) {
      throw new Error('Checkpoint is missing operation_id.');
    }
    return checkpoint;
  } catch (error) {
    throw new Error('Invalid Aging BigQuery checkpoint: ' + error.message);
  }
}

function persistAgingBigQueryCheckpoint_(checkpoint) {
  const serialized = JSON.stringify(checkpoint);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > AGING_OPERATIONAL_DEPLOYMENT.maxCheckpointBytes) {
    throw new Error(
      'Aging BigQuery checkpoint exceeds Script Property limit. Bytes=' +
        byteCount
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    AGING_OPERATIONAL_DEPLOYMENT.checkpointPropertyKey,
    serialized
  );
  return { byteCount };
}

function deleteAgingBigQueryCheckpoint_(operationId) {
  const properties = PropertiesService.getScriptProperties();
  const checkpoint = readAgingBigQueryCheckpoint_();
  if (
    checkpoint &&
    operationId &&
    checkpoint.operation_id !== operationId
  ) {
    return false;
  }
  properties.deleteProperty(AGING_OPERATIONAL_DEPLOYMENT.checkpointPropertyKey);
  return Boolean(checkpoint);
}

function prepareAgingBigQueryCheckpointForRetry_(operationId) {
  const checkpoint = readAgingBigQueryCheckpoint_();
  if (!checkpoint || checkpoint.operation_id !== operationId) return null;

  checkpoint.verification = null;
  checkpoint.verification_job_id = null;

  if (!checkpoint.partition_initialized) {
    checkpoint.partition_clear_generation =
      Number(checkpoint.partition_clear_generation || 0) + 1;
    checkpoint.partition_clear_job_id = null;
  } else if (checkpoint.current_client) {
    checkpoint.current_client.generation =
      Number(checkpoint.current_client.generation || 0) + 1;
    checkpoint.current_client.phase = 'prepared';
    checkpoint.current_client.delete_job_id = null;
    checkpoint.current_client.load_job_id = null;
  } else if (checkpoint.next_client_index >= checkpoint.clients.length) {
    deleteAgingBigQueryCheckpoint_(operationId);
    return null;
  }

  checkpoint.updated_at = new Date().toISOString();
  persistAgingBigQueryCheckpoint_(checkpoint);
  return checkpoint;
}

function refreshAgingConnectedSheetsStage_(stage, spreadsheetOverride) {
  const spreadsheet = spreadsheetOverride || getAgingReportSpreadsheet_();
  SpreadsheetApp.enableBigQueryExecution();
  const targets = getAgingConnectedSheetTargets_(spreadsheet, stage);
  targets.forEach(target => target.refresh());
  spreadsheet.waitForAllDataExecutionsCompletion(
    AGING_SHEET_REFRESH_CONFIG.timeoutSeconds
  );

  const executions = targets.map(target => {
    const status = target.getStatus();
    const refreshed = status.getLastRefreshedTime();
    const executed = status.getLastExecutionTime();
    return {
      name: target.name,
      type: target.type,
      state: String(status.getExecutionState()),
      errorCode: String(status.getErrorCode()),
      errorMessage: String(status.getErrorMessage() || '').trim() || null,
      lastExecutionAt: executed ? executed.toISOString() : null,
      lastRefreshedAt: refreshed ? refreshed.toISOString() : null,
      truncated: status.isTruncated() === true
    };
  });

  const failures = executions.filter(item =>
    item.state !== 'SUCCESS' ||
    item.errorCode !== 'NONE' ||
    item.truncated
  );

  if (failures.length) {
    throw new Error(
      'Aging Connected Sheets stage failed: ' +
        JSON.stringify({ stage, failures })
    );
  }

  const result = {
    status: 'passed',
    stage,
    refreshedObjectCount: executions.length,
    executions
  };
  Logger.log(JSON.stringify({
    event: 'aging_connected_sheets_stage_completed',
    ...result
  }));
  return result;
}

function getAgingConnectedSheetTargets_(spreadsheet, stage) {
  let targets = [];
  let expectedNames = [];

  if (stage === 'data_source_sheets') {
    expectedNames = AGING_SHEET_REFRESH_CONFIG.sourceSheets;
    targets = spreadsheet.getDataSourceSheets()
      .filter(source =>
        !expectedNames.length ||
        expectedNames.includes(source.asSheet().getName())
      )
      .map(source => ({
        name: source.asSheet().getName(),
        type: 'data_source_sheet',
        refresh: () => source.refreshData(),
        getStatus: () => source.getStatus()
      }));
  } else if (stage === 'extracts') {
    expectedNames = AGING_SHEET_REFRESH_CONFIG.extractSheets;
    targets = spreadsheet.getDataSourceTables()
      .filter(table =>
        !expectedNames.length ||
        expectedNames.includes(table.getRange().getSheet().getName())
      )
      .map(table => ({
        name: table.getRange().getSheet().getName(),
        type: 'extract',
        refresh: () => table.refreshData(),
        getStatus: () => table.getStatus()
      }));
  } else {
    throw new Error('Unsupported Connected Sheets stage: ' + stage);
  }

  if (!targets.length) {
    throw new Error(
      'No Aging Connected Sheets objects found for stage: ' + stage
    );
  }

  const counts = {};
  targets.forEach(target => {
    counts[target.name] = (counts[target.name] || 0) + 1;
  });

  const missing = expectedNames.filter(name => !counts[name]);
  const duplicates = Object.keys(counts).filter(name => counts[name] !== 1);
  if (missing.length || duplicates.length) {
    throw new Error(
      'Aging data source object validation failed: ' +
        JSON.stringify({ stage, missing, duplicates, counts })
    );
  }

  return targets;
}

function getAgingReportSpreadsheet_() {
  return getTargetSpreadsheet_();
}

function getNextAgingDeploymentStage_(state) {
  const sequence = ['bigquery', 'data_source_sheets', 'extracts'];
  for (let index = 0; index < sequence.length; index++) {
    const stage = sequence[index];
    const status = state && state.stages && state.stages[stage] &&
      state.stages[stage].status;
    if (status === 'pending' || status === 'processing') return stage;
  }
  return null;
}

function readAgingDeploymentState_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    AGING_OPERATIONAL_DEPLOYMENT.statePropertyKey
  );
  if (!serialized) return null;

  try {
    const state = JSON.parse(serialized);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('State is not an object.');
    }
    if (String(state.report_key || '') !== AGING_ENTITY_CONTROL.reportKey) {
      throw new Error('Unexpected report_key.');
    }
    if (!String(state.operation_id || '').trim()) {
      throw new Error('Missing operation_id.');
    }
    return state;
  } catch (error) {
    throw new Error('Invalid Aging deployment state: ' + error.message);
  }
}

function persistAgingDeploymentState_(state) {
  const serialized = JSON.stringify(state);
  const byteCount = Utilities.newBlob(serialized).getBytes().length;
  if (byteCount > AGING_OPERATIONAL_DEPLOYMENT.maxStateBytes) {
    throw new Error(
      'Aging deployment state exceeds Script Property limit. Bytes=' +
        byteCount
    );
  }
  PropertiesService.getScriptProperties().setProperty(
    AGING_OPERATIONAL_DEPLOYMENT.statePropertyKey,
    serialized
  );
  return { byteCount };
}

function createAgingDeploymentWorkerTrigger_(delayMs) {
  const delay = Math.max(1000, Number(delayMs || 0));
  const trigger = ScriptApp.newTrigger(
    AGING_OPERATIONAL_DEPLOYMENT.workerHandler
  )
    .timeBased()
    .after(delay)
    .create();
  return {
    triggerId: trigger.getUniqueId(),
    delayMs: delay
  };
}

function replaceAgingDeploymentWorkerSchedule_(delayMs) {
  const deletedTriggerCount = deleteAgingDeploymentWorkerTriggers_();
  const scheduled = createAgingDeploymentWorkerTrigger_(delayMs);
  return {
    ...scheduled,
    deletedTriggerCount,
    replaced: true
  };
}

function ensureAgingDeploymentWorkerScheduled_(delayMs) {
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger =>
      trigger.getHandlerFunction() ===
      AGING_OPERATIONAL_DEPLOYMENT.workerHandler
  );

  if (triggers.length) {
    triggers.slice(1).forEach(trigger => ScriptApp.deleteTrigger(trigger));
    return {
      triggerId: triggers[0].getUniqueId(),
      delayMs: null,
      existing: true,
      duplicateTriggersDeleted: Math.max(0, triggers.length - 1)
    };
  }

  return {
    ...createAgingDeploymentWorkerTrigger_(delayMs),
    existing: false,
    duplicateTriggersDeleted: 0
  };
}

function scheduleAgingDeploymentWorker_(delayMs) {
  return ensureAgingDeploymentWorkerScheduled_(delayMs);
}

function deleteAgingDeploymentWorkerTriggers_() {
  const triggers = ScriptApp.getProjectTriggers().filter(
    trigger =>
      trigger.getHandlerFunction() ===
      AGING_OPERATIONAL_DEPLOYMENT.workerHandler
  );
  triggers.forEach(trigger => ScriptApp.deleteTrigger(trigger));
  return triggers.length;
}

function updateAgingDeploymentReceipt_(state) {
  const properties = PropertiesService.getScriptProperties();
  const serialized = properties.getProperty(
    AGING_ENTITY_CONTROL.pushReceiptProperty
  );
  if (!serialized) return null;

  let receipt;
  try {
    receipt = JSON.parse(serialized);
  } catch (error) {
    return null;
  }

  if (
    Number(receipt.configuration_version || 0) !==
      Number(state.configuration_version || 0) ||
    String(receipt.configuration_hash || '') !==
      String(state.configuration_hash || '')
  ) {
    return null;
  }

  receipt.operation_id = state.operation_id;
  receipt.deployment_status = state.status;
  receipt.current_stage = state.current_stage;
  receipt.deployment_updated_at = state.updated_at;
  receipt.deployment_completed_at = state.completed_at || null;
  receipt.deployment_error = state.last_error || null;
  receipt.snapshot_date = state.range && state.range.snapshotDate || null;
  receipt.snapshot_week = state.range && state.range.snapshotWeek || null;
  properties.setProperty(
    AGING_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );
  return receipt;
}

function compactAgingDeploymentStageResult_(stage, result) {
  if (stage === 'bigquery') {
    return {
      status: result.status || null,
      reason: result.reason || null,
      snapshotDate: result.snapshotDate || null,
      snapshotWeek: result.snapshotWeek || null,
      clientCount: result.clientCount === undefined ? null : result.clientCount,
      processedClientCount: result.processedClientCount === undefined
        ? null
        : result.processedClientCount,
      remainingClientCount: result.remainingClientCount === undefined
        ? null
        : result.remainingClientCount,
      reportRowCounts: result.reportRowCounts || null,
      rowCount: result.rowCount === undefined ? null : result.rowCount,
      continuationCount: result.continuationCount || 0,
      schemaValidation: result.schemaValidation || null,
      verification: result.verification || null
    };
  }

  return {
    status: result.status,
    refreshedObjectCount: result.refreshedObjectCount,
    executions: result.executions
  };
}

function summarizeAgingDeploymentState_(state, queued) {
  return {
    queued: queued === true,
    operationId: state.operation_id,
    status: state.status,
    currentStage: state.current_stage,
    configurationVersion: state.configuration_version,
    configurationHash: state.configuration_hash,
    range: state.range || null,
    updatedAt: state.updated_at,
    completedAt: state.completed_at || null,
    lastError: state.last_error || null
  };
}
