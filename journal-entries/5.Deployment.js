/***********************
 * Configuration Publication Deployment
 *
 * A configuration publication is persisted synchronously and queued.
 * The operational work runs outside doPost in ordered time-triggered stages:
 *
 * 1. BigQuery snapshot
 * 2. Connected Sheets data-source views
 * 3. Connected Sheets extracts
 *
 * The BigQuery stage is resumable. It processes at most five clients per
 * execution, persists a checkpoint after every confirmed client, and yields
 * before the Apps Script execution limit. A watchdog trigger recovers a
 * worker that is terminated by a hard timeout.
 ***********************/

function queueJournalConfigurationDeployment_(
  pushPayload,
  configuration,
  options
) {
  const validatedConfiguration =
    validateJournalEntityConfiguration_(configuration);
  const deploymentOptions = options || {};
  const range = normalizeJournalDeploymentRange_(
    deploymentOptions.range ||
      getPreviousCompletedWeekRange_()
  );
  const source = String(
    deploymentOptions.source ||
      pushPayload &&
      pushPayload.source ||
      'configuration_push'
  ).trim();

  const current = readJournalDeploymentState_();
  const sameOperation =
    current &&
    Number(current.configuration_version) ===
      Number(validatedConfiguration.configuration_version) &&
    String(current.configuration_hash || '') ===
      String(validatedConfiguration.configuration_hash || '') &&
    String(
      current.period &&
      current.period.periodKey ||
      ''
    ) === range.periodKey;

  if (
    sameOperation &&
    ['pending', 'running', 'completed'].includes(current.status)
  ) {
    if (current.status !== 'completed') {
      ensureJournalDeploymentWorkerScheduled_(
        JOURNAL_OPERATIONAL_DEPLOYMENT.nextStageDelayMs
      );
    }

    return summarizeJournalDeploymentState_(
      current,
      false
    );
  }

  if (sameOperation && current.status === 'failed') {
    const recovered = JSON.parse(JSON.stringify(current));
    const failedStage = getNextJournalDeploymentStage_(
      recovered,
      true
    );

    if (!failedStage) {
      return summarizeJournalDeploymentState_(
        recovered,
        false
      );
    }

    const stageState = recovered.stages[failedStage];
    recovered.status = 'pending';
    recovered.current_stage = failedStage;
    recovered.updated_at = new Date().toISOString();
    recovered.completed_at = null;
    recovered.last_error = null;

    stageState.status = 'pending';
    stageState.attempts = 0;
    stageState.timeout_recovery_count = 0;
    stageState.error = null;
    stageState.completed_at = null;

    persistJournalDeploymentState_(recovered);
    replaceJournalDeploymentWorkerSchedule_(
      JOURNAL_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs
    );

    return summarizeJournalDeploymentState_(
      recovered,
      true
    );
  }

  deleteJournalBigQueryCheckpoint_();

  const now = new Date().toISOString();
  const state = {
    schema_version: '1.1',
    operation_id: Utilities.getUuid(),
    request_id: String(
      pushPayload &&
      pushPayload.request_id ||
      Utilities.getUuid()
    ),
    source,
    report_key: JOURNAL_ENTITY_CONTROL.reportKey,
    configuration_version:
      validatedConfiguration.configuration_version,
    configuration_hash:
      validatedConfiguration.configuration_hash,
    configuration: validatedConfiguration,
    period: range,
    status: 'pending',
    current_stage: 'bigquery',
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    stages: {
      configuration: {
        status: 'completed',
        attempts: 1,
        execution_count: 1,
        continuation_count: 0,
        timeout_recovery_count: 0,
        completed_at: now
      },
      bigquery: createJournalDeploymentStageState_(),
      data_source_sheets:
        createJournalDeploymentStageState_(),
      extracts: createJournalDeploymentStageState_()
    }
  };

  persistJournalDeploymentState_(state);
  replaceJournalDeploymentWorkerSchedule_(
    JOURNAL_OPERATIONAL_DEPLOYMENT.initialDelayMs
  );

  return summarizeJournalDeploymentState_(
    state,
    true
  );
}

function createJournalDeploymentStageState_() {
  return {
    status: 'pending',
    attempts: 0,
    execution_count: 0,
    continuation_count: 0,
    timeout_recovery_count: 0,
    started_at: null,
    completed_at: null,
    error: null,
    result: null
  };
}

function normalizeJournalDeploymentRange_(range) {
  const normalized = {
    snapshotDate: String(
      range && range.snapshotDate || ''
    ).trim(),
    snapshotWeek: String(
      range && range.snapshotWeek || ''
    ).trim(),
    dateFrom: String(
      range && range.dateFrom || ''
    ).trim(),
    dateTo: String(
      range && range.dateTo || ''
    ).trim(),
    periodKey: String(
      range && range.periodKey || ''
    ).trim()
  };

  [
    'snapshotDate',
    'snapshotWeek',
    'dateFrom',
    'dateTo'
  ].forEach(field => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized[field])) {
      throw new Error(
        'Invalid Journal Entries deployment period field ' +
          field +
          ': ' +
          normalized[field]
      );
    }
  });

  const expectedPeriodKey =
    normalized.dateFrom +
    '|' +
    normalized.dateTo;

  if (!normalized.periodKey) {
    normalized.periodKey = expectedPeriodKey;
  }

  if (normalized.periodKey !== expectedPeriodKey) {
    throw new Error(
      'Journal Entries deployment periodKey mismatch. Expected=' +
        expectedPeriodKey +
        ', actual=' +
        normalized.periodKey
    );
  }

  return normalized;
}

function processJournalConfigurationDeployment() {
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    ensureJournalDeploymentWorkerScheduled_(
      JOURNAL_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs
    );

    const deferred = {
      status: 'deferred_lock_busy',
      retryScheduled: true
    };

    Logger.log(JSON.stringify({
      event:
        'journal_configuration_deployment_deferred',
      ...deferred
    }));

    return deferred;
  }

  let claimedState = null;
  let claimedStage = null;

  try {
    replaceJournalDeploymentWorkerSchedule_(
      JOURNAL_OPERATIONAL_DEPLOYMENT.watchdogDelayMs
    );

    let state = readJournalDeploymentState_();

    if (!state) {
      deleteJournalDeploymentWorkerTriggers_();
      return {
        status: 'no_pending_deployment'
      };
    }

    if (state.status === 'completed') {
      deleteJournalBigQueryCheckpoint_();
      deleteJournalDeploymentWorkerTriggers_();
      return summarizeJournalDeploymentState_(
        state,
        false
      );
    }

    if (state.status === 'running') {
      const stageState =
        state.stages &&
        state.stages[state.current_stage];
      const startedAt =
        stageState &&
        Date.parse(stageState.started_at || '');
      const ageSeconds = Number.isFinite(startedAt)
        ? (Date.now() - startedAt) / 1000
        : Infinity;

      if (
        ageSeconds <
        JOURNAL_OPERATIONAL_DEPLOYMENT.staleRunningSeconds
      ) {
        replaceJournalDeploymentWorkerSchedule_(
          JOURNAL_OPERATIONAL_DEPLOYMENT.busyRetryDelayMs
        );

        return {
          status: 'deferred_stage_running',
          operationId: state.operation_id,
          currentStage: state.current_stage,
          ageSeconds: Math.floor(ageSeconds)
        };
      }

      if (stageState) {
        stageState.status = 'pending';
        stageState.timeout_recovery_count =
          Number(
            stageState.timeout_recovery_count || 0
          ) + 1;
        stageState.error = null;

        if (
          stageState.timeout_recovery_count >
          JOURNAL_OPERATIONAL_DEPLOYMENT.maxTimeoutRecoveries
        ) {
          const failedAt = new Date().toISOString();
          stageState.status = 'failed';
          stageState.error =
            'Maximum hard-timeout recoveries exceeded.';
          stageState.completed_at = failedAt;
          state.status = 'failed';
          state.current_stage = state.current_stage;
          state.updated_at = failedAt;
          state.last_error = stageState.error;
          persistJournalDeploymentState_(state);
          updateJournalDeploymentReceipt_(state);
          deleteJournalDeploymentWorkerTriggers_();

          const failed = summarizeJournalDeploymentState_(
            state,
            false
          );

          Logger.log(JSON.stringify({
            event:
              'journal_configuration_deployment_timeout_recovery_failed',
            timeoutRecoveryCount:
              stageState.timeout_recovery_count,
            ...failed
          }));

          return failed;
        }
      }

      state.status = 'pending';
      state.last_error = null;
      state.updated_at = new Date().toISOString();
      persistJournalDeploymentState_(state);

      Logger.log(JSON.stringify({
        event:
          'journal_configuration_deployment_timeout_recovered',
        operationId: state.operation_id,
        stage: state.current_stage,
        timeoutRecoveryCount:
          stageState &&
          stageState.timeout_recovery_count ||
          0
      }));
    }

    claimedStage = getNextJournalDeploymentStage_(
      state,
      false
    );

    if (!claimedStage) {
      const completedAt =
        new Date().toISOString();

      state.status = 'completed';
      state.current_stage = 'completed';
      state.completed_at =
        state.completed_at || completedAt;
      state.updated_at = completedAt;

      persistJournalDeploymentState_(state);
      updateJournalDeploymentReceipt_(state);
      deleteJournalBigQueryCheckpoint_();
      deleteJournalDeploymentWorkerTriggers_();

      return summarizeJournalDeploymentState_(
        state,
        false
      );
    }

    const now = new Date().toISOString();
    const stageState = state.stages[claimedStage];

    stageState.status = 'running';
    stageState.execution_count =
      Number(stageState.execution_count || 0) + 1;
    stageState.started_at = now;
    stageState.completed_at = null;
    stageState.error = null;

    state.status = 'running';
    state.current_stage = claimedStage;
    state.updated_at = now;

    persistJournalDeploymentState_(state);
    replaceJournalDeploymentWorkerSchedule_(
      JOURNAL_OPERATIONAL_DEPLOYMENT.watchdogDelayMs
    );

    claimedState = JSON.parse(
      JSON.stringify(state)
    );

    Logger.log(JSON.stringify({
      event:
        'journal_configuration_deployment_stage_started',
      operationId: state.operation_id,
      stage: claimedStage,
      attempt:
        Number(stageState.attempts || 0) + 1,
      executionCount:
        stageState.execution_count,
      continuationCount:
        Number(stageState.continuation_count || 0),
      configurationVersion:
        state.configuration_version,
      configurationHash:
        state.configuration_hash,
      period: state.period
    }));

    const stageResult =
      executeJournalDeploymentStage_(
        claimedStage,
        claimedState
      );
    const current =
      readJournalDeploymentState_();

    if (
      !current ||
      current.operation_id !==
        claimedState.operation_id
    ) {
      ensureJournalDeploymentWorkerScheduled_(
        JOURNAL_OPERATIONAL_DEPLOYMENT.nextStageDelayMs
      );

      const superseded = {
        status: 'superseded',
        operationId:
          claimedState.operation_id,
        stage: claimedStage,
        currentOperationId:
          current &&
          current.operation_id ||
          null
      };

      Logger.log(JSON.stringify({
        event:
          'journal_configuration_deployment_stage_superseded',
        ...superseded
      }));

      return superseded;
    }

    if (
      stageResult &&
      stageResult.status === 'yielded'
    ) {
      const yieldedAt =
        new Date().toISOString();
      const yieldedStage =
        current.stages[claimedStage];

      yieldedStage.status = 'pending';
      yieldedStage.continuation_count =
        Number(
          stageResult.continuationCount ||
          yieldedStage.continuation_count ||
          0
        );
      yieldedStage.error = null;
      yieldedStage.result =
        compactJournalDeploymentStageResult_(
          claimedStage,
          stageResult
        );

      current.status = 'pending';
      current.current_stage = claimedStage;
      current.updated_at = yieldedAt;
      current.last_error = null;

      persistJournalDeploymentState_(current);
      updateJournalDeploymentReceipt_(current);
      replaceJournalDeploymentWorkerSchedule_(
        JOURNAL_OPERATIONAL_DEPLOYMENT.continuationDelayMs
      );

      const result = {
        ...summarizeJournalDeploymentState_(
          current,
          false
        ),
        yielded: true,
        reason: stageResult.reason,
        processedClientCount:
          stageResult.processedClientCount,
        remainingClientCount:
          stageResult.remainingClientCount,
        nextClientIndex:
          stageResult.nextClientIndex,
        continuationCount:
          stageResult.continuationCount
      };

      Logger.log(JSON.stringify({
        event:
          'journal_configuration_deployment_stage_yielded',
        stage: claimedStage,
        ...result
      }));

      return result;
    }

    const completedAt =
      new Date().toISOString();
    const completedStage =
      current.stages[claimedStage];

    completedStage.status = 'completed';
    completedStage.completed_at = completedAt;
    completedStage.error = null;
    completedStage.result =
      compactJournalDeploymentStageResult_(
        claimedStage,
        stageResult
      );

    current.updated_at = completedAt;
    current.last_error = null;

    const nextStage =
      getNextJournalDeploymentStage_(
        current,
        false
      );

    if (nextStage) {
      current.status = 'pending';
      current.current_stage = nextStage;
      persistJournalDeploymentState_(current);
      updateJournalDeploymentReceipt_(current);

      if (claimedStage === 'bigquery') {
        deleteJournalBigQueryCheckpoint_();
      }

      replaceJournalDeploymentWorkerSchedule_(
        JOURNAL_OPERATIONAL_DEPLOYMENT.nextStageDelayMs
      );
    } else {
      current.status = 'completed';
      current.current_stage = 'completed';
      current.completed_at = completedAt;

      persistJournalDeploymentState_(current);
      updateJournalDeploymentReceipt_(current);
      deleteJournalBigQueryCheckpoint_();
      deleteJournalDeploymentWorkerTriggers_();
    }

    const result =
      summarizeJournalDeploymentState_(
        current,
        false
      );

    Logger.log(JSON.stringify({
      event:
        'journal_configuration_deployment_stage_completed',
      stage: claimedStage,
      ...result
    }));

    return result;
  } catch (error) {
    const current =
      readJournalDeploymentState_();
    let retryScheduled = false;

    if (
      claimedState &&
      current &&
      current.operation_id ===
        claimedState.operation_id &&
      claimedStage
    ) {
      const failedAt =
        new Date().toISOString();
      const stageState =
        current.stages[claimedStage];

      stageState.attempts =
        Number(stageState.attempts || 0) + 1;
      stageState.error = String(
        error &&
        error.message ||
        error
      );
      stageState.completed_at = failedAt;

      current.updated_at = failedAt;
      current.last_error = stageState.error;

      if (claimedStage === 'bigquery') {
        prepareJournalBigQueryCheckpointForRetry_();
      }

      if (
        stageState.attempts <
        JOURNAL_OPERATIONAL_DEPLOYMENT.maxStageAttempts
      ) {
        stageState.status = 'pending';
        current.status = 'pending';
        current.current_stage = claimedStage;
        retryScheduled = true;
      } else {
        stageState.status = 'failed';
        current.status = 'failed';
        current.current_stage = claimedStage;
      }

      persistJournalDeploymentState_(current);
      updateJournalDeploymentReceipt_(current);

      if (retryScheduled) {
        replaceJournalDeploymentWorkerSchedule_(
          JOURNAL_OPERATIONAL_DEPLOYMENT.failureRetryDelayMs
        );
      } else {
        deleteJournalDeploymentWorkerTriggers_();
      }
    }

    Logger.log(JSON.stringify({
      event:
        'journal_configuration_deployment_stage_failed',
      operationId:
        claimedState &&
        claimedState.operation_id ||
        null,
      stage: claimedStage,
      retryScheduled,
      error: String(
        error &&
        error.message ||
        error
      )
    }));

    if (retryScheduled) {
      return {
        status: 'retry_scheduled',
        operationId:
          claimedState.operation_id,
        stage: claimedStage,
        error: String(
          error &&
          error.message ||
          error
        )
      };
    }

    throw error;
  } finally {
    lock.releaseLock();
  }
}

function executeJournalDeploymentStage_(
  stage,
  state
) {
  if (stage === 'bigquery') {
    const configuration =
      validateJournalEntityConfiguration_(
        state.configuration,
        state.configuration_version
      );

    if (
      configuration.configuration_hash !==
      state.configuration_hash
    ) {
      throw new Error(
        'Deployment configuration hash no longer matches the queued operation.'
      );
    }

    return executeJournalBigQueryContinuationStage_(
      state,
      {
        source:
          state.source ||
          'configuration_push_operation',
        configuration
      }
    );
  }

  if (stage === 'data_source_sheets') {
    return refreshJournalConnectedSheetsStage_(
      'data_source_sheets'
    );
  }

  if (stage === 'extracts') {
    return refreshJournalConnectedSheetsStage_(
      'extracts'
    );
  }

  throw new Error(
    'Unsupported Journal Entries deployment stage: ' +
      stage
  );
}

function executeJournalBigQueryContinuationStage_(
  state,
  loadedEntityConfiguration
) {
  const executionStartedAt = Date.now();
  let checkpoint =
    readJournalBigQueryCheckpoint_();

  if (
    !journalBigQueryCheckpointMatchesState_(
      checkpoint,
      state
    )
  ) {
    deleteJournalBigQueryCheckpoint_();
    checkpoint =
      initializeJournalBigQueryCheckpoint_(
        state,
        loadedEntityConfiguration
      );
  }

  Logger.log(JSON.stringify({
    event:
      'journal_bigquery_continuation_started',
    operationId: state.operation_id,
    period: checkpoint.period,
    nextClientIndex:
      checkpoint.next_client_index,
    processedClientCount:
      checkpoint.processed_client_count,
    totalClientCount:
      checkpoint.clients.length,
    continuationCount:
      checkpoint.continuation_count
  }));

  if (!checkpoint.partition_cleared) {
    const clearResult =
      ensureJournalBigQueryQueryJob_(
        checkpoint.clear_job_id,
        buildJournalPartitionClearQuery_(
          checkpoint.period.snapshotWeek
        )
      );

    if (!clearResult.done) {
      return yieldJournalBigQueryCheckpoint_(
        checkpoint,
        'waiting_for_partition_clear'
      );
    }

    checkpoint.partition_cleared = true;
    checkpoint.last_job_id =
      checkpoint.clear_job_id;
    checkpoint.updated_at =
      new Date().toISOString();
    persistJournalBigQueryCheckpoint_(
      checkpoint
    );
  }

  let processedThisExecution = 0;

  while (
    checkpoint.next_client_index <
    checkpoint.clients.length
  ) {
    if (
      processedThisExecution >=
      JOURNAL_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution
    ) {
      return yieldJournalBigQueryCheckpoint_(
        checkpoint,
        'max_clients_per_execution'
      );
    }

    if (
      journalExecutionBudgetReached_(
        executionStartedAt
      )
    ) {
      return yieldJournalBigQueryCheckpoint_(
        checkpoint,
        'execution_budget_reached'
      );
    }

    const clientResult =
      processJournalBigQueryCheckpointClient_(
        checkpoint
      );

    checkpoint = clientResult.checkpoint;

    if (!clientResult.completed) {
      return yieldJournalBigQueryCheckpoint_(
        checkpoint,
        clientResult.reason ||
          'waiting_for_bigquery_job'
      );
    }

    processedThisExecution++;
  }

  assertJournalBalanced_(
    checkpoint.total_debit_cents,
    checkpoint.total_credit_cents,
    'Combined journal snapshot checkpoint'
  );

  const verification =
    verifyJournalSnapshotPartitionDetailed_(
      checkpoint.period.snapshotWeek,
      {
        rowCount:
          checkpoint.total_row_count,
        accountingTransactionCount:
          checkpoint.total_accounting_transaction_count,
        debitCents:
          checkpoint.total_debit_cents,
        creditCents:
          checkpoint.total_credit_cents
      }
    );

  const result = {
    status: 'completed',
    entityConfiguration:
      checkpoint.entity_configuration,
    schemaValidation:
      checkpoint.schema_validation,
    period: checkpoint.period,
    clientCount:
      checkpoint.clients.length,
    transactionCount:
      checkpoint.total_transaction_count,
    accountingTransactionCount:
      checkpoint.total_accounting_transaction_count,
    rowCount:
      checkpoint.total_row_count,
    totals: {
      debitAmount: centsToAmount_(
        checkpoint.total_debit_cents
      ),
      creditAmount: centsToAmount_(
        checkpoint.total_credit_cents
      ),
      netAmount: centsToAmount_(
        checkpoint.total_debit_cents -
        checkpoint.total_credit_cents
      )
    },
    loadResult: {
      mode:
        'incremental_partition_rebuild',
      destinationTable:
        JOURNAL_BIGQUERY_TABLE,
      snapshotWeek:
        checkpoint.period.snapshotWeek,
      clientCount:
        checkpoint.clients.length,
      processedClientCount:
        checkpoint.processed_client_count,
      loadJobCount:
        checkpoint.load_job_count,
      queryJobCount:
        checkpoint.query_job_count,
      lastJobId:
        checkpoint.last_job_id,
      state: 'DONE'
    },
    jobId: checkpoint.last_job_id,
    verification,
    continuationCount:
      checkpoint.continuation_count
  };

  Logger.log(JSON.stringify(result, null, 2));
  Logger.log(
    '--- JOURNAL BIGQUERY SNAPSHOT END ---'
  );

  return result;
}

function initializeJournalBigQueryCheckpoint_(
  state,
  loadedEntityConfiguration
) {
  Logger.log(
    '--- JOURNAL BIGQUERY SNAPSHOT START ---'
  );

  const range = normalizeJournalDeploymentRange_(
    state.period ||
      getPreviousCompletedWeekRange_()
  );
  const normalizedLoadedConfiguration =
    normalizeJournalLoadedEntityConfiguration_(
      loadedEntityConfiguration
    );
  const clients = getJournalSnapshotClients_(
    normalizedLoadedConfiguration
  );
  const now = new Date().toISOString();

  const checkpoint = {
    schema_version: '1.0',
    operation_id: state.operation_id,
    configuration_version:
      state.configuration_version,
    configuration_hash:
      state.configuration_hash,
    period: range,
    loaded_at: now,
    entity_configuration:
      buildJournalEntityConfigurationSummary_(
        normalizedLoadedConfiguration
      ),
    schema_validation:
      validateJournalBigQuerySchema_(),
    clients,
    next_client_index: 0,
    processed_client_count: 0,
    continuation_count: 0,
    total_transaction_count: 0,
    total_accounting_transaction_count: 0,
    total_row_count: 0,
    total_debit_cents: 0,
    total_credit_cents: 0,
    partition_cleared: false,
    clear_job_id:
      buildJournalBigQueryJobId_(
        'journal_clear',
        state.operation_id,
        range.snapshotWeek,
        ''
      ),
    current_client: null,
    load_job_count: 0,
    query_job_count: 0,
    last_completed_client_id: null,
    last_job_id: null,
    created_at: now,
    updated_at: now
  };

  persistJournalBigQueryCheckpoint_(
    checkpoint
  );

  Logger.log(JSON.stringify({
    event:
      'journal_bigquery_checkpoint_initialized',
    operationId: state.operation_id,
    period: range,
    clientCount: clients.length,
    maxClientsPerExecution:
      JOURNAL_OPERATIONAL_DEPLOYMENT.maxClientsPerExecution,
    executionBudgetMs:
      JOURNAL_OPERATIONAL_DEPLOYMENT.executionBudgetMs
  }));

  return checkpoint;
}

function processJournalBigQueryCheckpointClient_(
  checkpoint
) {
  const clientIndex =
    Number(checkpoint.next_client_index);
  const client =
    checkpoint.clients[clientIndex];

  if (!client) {
    throw new Error(
      'Journal Entries checkpoint client is missing at index ' +
        clientIndex
    );
  }

  let clientSnapshot = null;

  if (!checkpoint.current_client) {
    clientSnapshot =
      buildJournalClientSnapshot_(
        client,
        checkpoint.period,
        checkpoint.loaded_at
      );

    checkpoint.current_client = {
      index: clientIndex,
      client_id: client.id,
      client_name: client.name,
      transaction_count:
        clientSnapshot.transactionCount,
      accounting_transaction_count:
        clientSnapshot.accountingTransactionCount,
      row_count:
        clientSnapshot.rowCount,
      debit_cents:
        clientSnapshot.debitCents,
      credit_cents:
        clientSnapshot.creditCents,
      delete_job_id:
        buildJournalBigQueryJobId_(
          'journal_delete_client',
          checkpoint.operation_id,
          checkpoint.period.snapshotWeek,
          client.id
        ),
      load_job_id:
        clientSnapshot.rowCount
          ? buildJournalBigQueryJobId_(
            'journal_load_client',
            checkpoint.operation_id,
            checkpoint.period.snapshotWeek,
            client.id
          )
          : null,
      prepared_at:
        new Date().toISOString()
    };

    checkpoint.updated_at =
      new Date().toISOString();
    persistJournalBigQueryCheckpoint_(
      checkpoint
    );
  } else {
    assertJournalCheckpointCurrentClient_(
      checkpoint,
      client,
      clientIndex
    );
  }

  const current =
    checkpoint.current_client;
  const deleteWasAlreadyComplete =
    getJournalBigQueryJobIfExists_(
      current.delete_job_id
    );

  const deleteResult =
    ensureJournalBigQueryQueryJob_(
      current.delete_job_id,
      buildJournalClientDeleteQuery_(
        checkpoint.period.snapshotWeek,
        client.id
      )
    );

  if (!deleteResult.done) {
    return {
      completed: false,
      reason:
        'waiting_for_client_delete_job',
      checkpoint
    };
  }

  if (!deleteWasAlreadyComplete) {
    checkpoint.query_job_count =
      Number(checkpoint.query_job_count || 0) + 1;
    checkpoint.updated_at =
      new Date().toISOString();
    persistJournalBigQueryCheckpoint_(
      checkpoint
    );
  }

  if (Number(current.row_count) > 0) {
    const existingLoadJob =
      getJournalBigQueryJobIfExists_(
        current.load_job_id
      );

    if (!existingLoadJob) {
      if (!clientSnapshot) {
        clientSnapshot =
          buildJournalClientSnapshot_(
            client,
            checkpoint.period,
            checkpoint.loaded_at
          );
      }

      assertJournalClientSnapshotMatchesCheckpoint_(
        clientSnapshot,
        current
      );
    }

    const loadResult =
      ensureJournalBigQueryLoadJob_(
        current.load_job_id,
        checkpoint.period.snapshotWeek,
        clientSnapshot
          ? clientSnapshot.lineRows
          : []
      );

    if (!loadResult.done) {
      return {
        completed: false,
        reason:
          'waiting_for_client_load_job',
        checkpoint
      };
    }

    if (!existingLoadJob) {
      checkpoint.load_job_count =
        Number(checkpoint.load_job_count || 0) + 1;
    }

    checkpoint.last_job_id =
      current.load_job_id;
  } else {
    checkpoint.last_job_id =
      current.delete_job_id;
  }

  checkpoint.total_transaction_count +=
    Number(current.transaction_count || 0);
  checkpoint.total_accounting_transaction_count +=
    Number(
      current.accounting_transaction_count || 0
    );
  checkpoint.total_row_count +=
    Number(current.row_count || 0);
  checkpoint.total_debit_cents +=
    Number(current.debit_cents || 0);
  checkpoint.total_credit_cents +=
    Number(current.credit_cents || 0);
  checkpoint.processed_client_count += 1;
  checkpoint.next_client_index =
    clientIndex + 1;
  checkpoint.last_completed_client_id =
    client.id;
  checkpoint.current_client = null;
  checkpoint.updated_at =
    new Date().toISOString();

  persistJournalBigQueryCheckpoint_(
    checkpoint
  );

  Logger.log(JSON.stringify({
    event:
      'journal_bigquery_client_completed',
    operationId:
      checkpoint.operation_id,
    clientIndex,
    clientId: client.id,
    clientName: client.name,
    transactionCount:
      current.transaction_count,
    accountingTransactionCount:
      current.accounting_transaction_count,
    rowCount: current.row_count,
    processedClientCount:
      checkpoint.processed_client_count,
    remainingClientCount:
      checkpoint.clients.length -
      checkpoint.next_client_index
  }));

  return {
    completed: true,
    checkpoint
  };
}

function assertJournalCheckpointCurrentClient_(
  checkpoint,
  client,
  clientIndex
) {
  const current =
    checkpoint.current_client;

  if (
    Number(current.index) !==
      Number(clientIndex) ||
    String(current.client_id || '') !==
      String(client.id || '')
  ) {
    throw new Error(
      'Journal Entries checkpoint current client mismatch. ' +
        JSON.stringify({
          expectedIndex: clientIndex,
          expectedClientId: client.id,
          checkpointIndex: current.index,
          checkpointClientId:
            current.client_id
        })
    );
  }
}

function assertJournalClientSnapshotMatchesCheckpoint_(
  snapshot,
  checkpointClient
) {
  const comparisons = {
    transaction_count:
      snapshot.transactionCount,
    accounting_transaction_count:
      snapshot.accountingTransactionCount,
    row_count:
      snapshot.rowCount,
    debit_cents:
      snapshot.debitCents,
    credit_cents:
      snapshot.creditCents
  };

  Object.keys(comparisons).forEach(field => {
    if (
      Number(comparisons[field]) !==
      Number(checkpointClient[field])
    ) {
      throw new Error(
        'Journal Entries client data changed while recovering a checkpoint. ' +
          JSON.stringify({
            clientId:
              checkpointClient.client_id,
            field,
            checkpointValue:
              checkpointClient[field],
            rebuiltValue:
              comparisons[field]
          })
      );
    }
  });
}

function yieldJournalBigQueryCheckpoint_(
  checkpoint,
  reason
) {
  checkpoint.continuation_count =
    Number(checkpoint.continuation_count || 0) + 1;

  if (
    checkpoint.continuation_count >
    JOURNAL_OPERATIONAL_DEPLOYMENT.maxContinuationCount
  ) {
    throw new Error(
      'Journal Entries BigQuery continuation limit exceeded. Count=' +
        checkpoint.continuation_count
    );
  }

  checkpoint.updated_at =
    new Date().toISOString();
  persistJournalBigQueryCheckpoint_(
    checkpoint
  );

  return {
    status: 'yielded',
    reason,
    period: checkpoint.period,
    clientCount:
      checkpoint.clients.length,
    processedClientCount:
      checkpoint.processed_client_count,
    remainingClientCount:
      checkpoint.clients.length -
      checkpoint.next_client_index,
    nextClientIndex:
      checkpoint.next_client_index,
    rowCount:
      checkpoint.total_row_count,
    transactionCount:
      checkpoint.total_transaction_count,
    accountingTransactionCount:
      checkpoint.total_accounting_transaction_count,
    continuationCount:
      checkpoint.continuation_count,
    currentClient:
      checkpoint.current_client
        ? {
          index:
            checkpoint.current_client.index,
          clientId:
            checkpoint.current_client.client_id,
          clientName:
            checkpoint.current_client.client_name,
          rowCount:
            checkpoint.current_client.row_count
        }
        : null
  };
}

function journalExecutionBudgetReached_(
  executionStartedAt
) {
  return (
    Date.now() -
    Number(executionStartedAt || 0)
  ) >=
    JOURNAL_OPERATIONAL_DEPLOYMENT.executionBudgetMs;
}

function journalBigQueryCheckpointMatchesState_(
  checkpoint,
  state
) {
  return Boolean(
    checkpoint &&
    state &&
    String(checkpoint.operation_id || '') ===
      String(state.operation_id || '') &&
    Number(checkpoint.configuration_version) ===
      Number(state.configuration_version) &&
    String(checkpoint.configuration_hash || '') ===
      String(state.configuration_hash || '') &&
    String(
      checkpoint.period &&
      checkpoint.period.periodKey ||
      ''
    ) ===
      String(
        state.period &&
        state.period.periodKey ||
        ''
      )
  );
}

function readJournalBigQueryCheckpoint_() {
  const serialized =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .checkpointPropertyKey
      );

  if (!serialized) return null;

  try {
    const checkpoint =
      JSON.parse(serialized);

    if (
      !checkpoint ||
      typeof checkpoint !== 'object' ||
      Array.isArray(checkpoint)
    ) {
      throw new Error(
        'Checkpoint is not an object.'
      );
    }

    if (
      !String(
        checkpoint.operation_id || ''
      ).trim()
    ) {
      throw new Error(
        'Checkpoint is missing operation_id.'
      );
    }

    if (
      !Array.isArray(checkpoint.clients)
    ) {
      throw new Error(
        'Checkpoint is missing clients.'
      );
    }

    return checkpoint;
  } catch (error) {
    throw new Error(
      'Invalid Journal Entries BigQuery checkpoint: ' +
        error.message
    );
  }
}

function persistJournalBigQueryCheckpoint_(
  checkpoint
) {
  const serialized =
    JSON.stringify(checkpoint);
  const byteCount =
    Utilities
      .newBlob(serialized)
      .getBytes()
      .length;

  if (
    byteCount >
    JOURNAL_OPERATIONAL_DEPLOYMENT
      .maxCheckpointBytes
  ) {
    throw new Error(
      'Journal Entries BigQuery checkpoint exceeds the Script Property limit. Bytes=' +
        byteCount
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .checkpointPropertyKey,
      serialized
    );

  return {
    byteCount
  };
}

function deleteJournalBigQueryCheckpoint_() {
  const properties =
    PropertiesService.getScriptProperties();
  const existed = Boolean(
    properties.getProperty(
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .checkpointPropertyKey
    )
  );

  properties.deleteProperty(
    JOURNAL_OPERATIONAL_DEPLOYMENT
      .checkpointPropertyKey
  );

  return existed;
}


function prepareJournalBigQueryCheckpointForRetry_() {
  const checkpoint =
    readJournalBigQueryCheckpoint_();

  if (!checkpoint) {
    return {
      updated: false,
      reason: 'checkpoint_not_found'
    };
  }

  const generation =
    Number(checkpoint.job_retry_generation || 0) + 1;
  let updated = false;

  if (!checkpoint.partition_cleared) {
    const clearJob =
      getJournalBigQueryJobIfExists_(
        checkpoint.clear_job_id
      );

    if (
      clearJob &&
      clearJob.status &&
      clearJob.status.state === 'DONE' &&
      clearJob.status.errorResult
    ) {
      checkpoint.clear_job_id =
        buildJournalBigQueryJobId_(
          'journal_clear_retry_' + generation,
          checkpoint.operation_id,
          checkpoint.period.snapshotWeek,
          ''
        );
      updated = true;
    }
  }

  if (checkpoint.current_client) {
    const current =
      checkpoint.current_client;
    const deleteJob =
      getJournalBigQueryJobIfExists_(
        current.delete_job_id
      );

    if (
      deleteJob &&
      deleteJob.status &&
      deleteJob.status.state === 'DONE' &&
      deleteJob.status.errorResult
    ) {
      current.delete_job_id =
        buildJournalBigQueryJobId_(
          'journal_delete_retry_' + generation,
          checkpoint.operation_id,
          checkpoint.period.snapshotWeek,
          current.client_id
        );

      if (Number(current.row_count || 0) > 0) {
        current.load_job_id =
          buildJournalBigQueryJobId_(
            'journal_load_retry_' + generation,
            checkpoint.operation_id,
            checkpoint.period.snapshotWeek,
            current.client_id
          );
      }

      updated = true;
    } else if (current.load_job_id) {
      const loadJob =
        getJournalBigQueryJobIfExists_(
          current.load_job_id
        );

      if (
        loadJob &&
        loadJob.status &&
        loadJob.status.state === 'DONE' &&
        loadJob.status.errorResult
      ) {
        current.load_job_id =
          buildJournalBigQueryJobId_(
            'journal_load_retry_' + generation,
            checkpoint.operation_id,
            checkpoint.period.snapshotWeek,
            current.client_id
          );
        updated = true;
      }
    }
  }

  if (!updated) {
    return {
      updated: false,
      reason: 'no_failed_bigquery_job'
    };
  }

  checkpoint.job_retry_generation =
    generation;
  checkpoint.updated_at =
    new Date().toISOString();

  persistJournalBigQueryCheckpoint_(
    checkpoint
  );

  Logger.log(JSON.stringify({
    event:
      'journal_bigquery_checkpoint_job_ids_rotated',
    operationId:
      checkpoint.operation_id,
    generation
  }));

  return {
    updated: true,
    generation
  };
}

function refreshJournalConnectedSheetsPipeline_(
  spreadsheet
) {
  const sourceSheets =
    refreshJournalConnectedSheetsStage_(
      'data_source_sheets',
      spreadsheet
    );
  const extracts =
    refreshJournalConnectedSheetsStage_(
      'extracts',
      spreadsheet
    );

  return {
    status: 'passed',
    refreshedObjectCount:
      sourceSheets.refreshedObjectCount +
      extracts.refreshedObjectCount,
    stages: {
      dataSourceSheets: sourceSheets,
      extracts
    }
  };
}

function refreshJournalConnectedSheetsStage_(
  stage,
  spreadsheetOverride
) {
  const spreadsheet =
    spreadsheetOverride ||
    getJournalReportSpreadsheet_();

  SpreadsheetApp.enableBigQueryExecution();

  const targets =
    getJournalConnectedSheetTargets_(
      spreadsheet,
      stage
    );

  targets.forEach(target => target.refresh());

  spreadsheet.waitForAllDataExecutionsCompletion(
    JE_SHEET_REFRESH_CONFIG.timeoutSeconds
  );

  const executions = targets.map(target => {
    const status = target.getStatus();
    const lastRefreshedTime =
      status.getLastRefreshedTime();
    const lastExecutionTime =
      status.getLastExecutionTime();

    return {
      name: target.name,
      type: target.type,
      state: String(
        status.getExecutionState()
      ),
      errorCode: String(
        status.getErrorCode()
      ),
      errorMessage: String(
        status.getErrorMessage() || ''
      ).trim() || null,
      lastExecutionAt:
        lastExecutionTime
          ? lastExecutionTime.toISOString()
          : null,
      lastRefreshedAt:
        lastRefreshedTime
          ? lastRefreshedTime.toISOString()
          : null,
      truncated:
        status.isTruncated() === true
    };
  });

  const failures = executions.filter(
    execution =>
      execution.state !== 'SUCCESS' ||
      execution.truncated
  );

  if (failures.length) {
    throw new Error(
      'Journal Entries Connected Sheets stage failed: ' +
        JSON.stringify({
          stage,
          failures
        })
    );
  }

  const result = {
    status: 'passed',
    stage,
    refreshedObjectCount:
      executions.length,
    executions
  };

  Logger.log(JSON.stringify({
    event:
      'journal_connected_sheets_stage_completed',
    ...result
  }));

  return result;
}

function getJournalConnectedSheetTargets_(
  spreadsheet,
  stage
) {
  let targets;
  let expectedNames;

  if (stage === 'data_source_sheets') {
    expectedNames =
      JE_SHEET_REFRESH_CONFIG.sourceSheets;

    targets = spreadsheet
      .getDataSourceSheets()
      .filter(source =>
        expectedNames.includes(
          source.asSheet().getName()
        )
      )
      .map(source => ({
        name:
          source.asSheet().getName(),
        type: 'data_source_sheet',
        refresh: () =>
          source.refreshData(),
        getStatus: () =>
          source.getStatus()
      }));
  } else if (stage === 'extracts') {
    expectedNames =
      JE_SHEET_REFRESH_CONFIG.extractSheets;

    targets = spreadsheet
      .getDataSourceTables()
      .filter(extract =>
        expectedNames.includes(
          extract
            .getRange()
            .getSheet()
            .getName()
        )
      )
      .map(extract => ({
        name:
          extract
            .getRange()
            .getSheet()
            .getName(),
        type: 'extract',
        refresh: () =>
          extract.refreshData(),
        getStatus: () =>
          extract.getStatus()
      }));
  } else {
    throw new Error(
      'Unsupported Connected Sheets stage: ' +
        stage
    );
  }

  const counts = {};

  targets.forEach(target => {
    counts[target.name] =
      (counts[target.name] || 0) + 1;
  });

  const missing =
    expectedNames.filter(
      name => !counts[name]
    );
  const duplicates =
    Object.keys(counts).filter(
      name => counts[name] !== 1
    );

  if (
    missing.length ||
    duplicates.length
  ) {
    throw new Error(
      'Journal Entries data source object validation failed: ' +
        JSON.stringify({
          stage,
          missing,
          duplicates,
          counts
        })
    );
  }

  return targets;
}

function getJournalReportSpreadsheet_() {
  const properties =
    PropertiesService.getScriptProperties();
  const configuredId = String(
    properties.getProperty(
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .reportSpreadsheetIdProperty
    ) || ''
  ).trim();

  if (configuredId) {
    return SpreadsheetApp.openById(
      configuredId
    );
  }

  const active =
    SpreadsheetApp.getActiveSpreadsheet();

  if (!active) {
    throw new Error(
      'Missing Script Property: ' +
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .reportSpreadsheetIdProperty
    );
  }

  properties.setProperty(
    JOURNAL_OPERATIONAL_DEPLOYMENT
      .reportSpreadsheetIdProperty,
    active.getId()
  );

  return active;
}

function getNextJournalDeploymentStage_(
  state,
  includeFailed
) {
  const sequence = [
    'bigquery',
    'data_source_sheets',
    'extracts'
  ];

  for (
    let index = 0;
    index < sequence.length;
    index++
  ) {
    const stage = sequence[index];
    const status =
      state &&
      state.stages &&
      state.stages[stage] &&
      state.stages[stage].status;

    if (
      status === 'pending' ||
      status === 'running' ||
      (
        includeFailed &&
        status === 'failed'
      )
    ) {
      return stage;
    }
  }

  return null;
}

function readJournalDeploymentState_() {
  const serialized =
    PropertiesService
      .getScriptProperties()
      .getProperty(
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .statePropertyKey
      );

  if (!serialized) return null;

  try {
    const state = JSON.parse(serialized);

    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state)
    ) {
      throw new Error(
        'State is not an object.'
      );
    }

    if (
      String(state.report_key || '') !==
      JOURNAL_ENTITY_CONTROL.reportKey
    ) {
      throw new Error(
        'Unexpected report_key.'
      );
    }

    if (
      !String(
        state.operation_id || ''
      ).trim()
    ) {
      throw new Error(
        'Missing operation_id.'
      );
    }

    return state;
  } catch (error) {
    throw new Error(
      'Invalid Journal Entries deployment state: ' +
        error.message
    );
  }
}

function persistJournalDeploymentState_(
  state
) {
  const serialized =
    JSON.stringify(state);
  const byteCount =
    Utilities
      .newBlob(serialized)
      .getBytes()
      .length;

  if (
    byteCount >
    JOURNAL_OPERATIONAL_DEPLOYMENT
      .maxStateBytes
  ) {
    throw new Error(
      'Journal Entries deployment state exceeds the Script Property limit. Bytes=' +
        byteCount
    );
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(
      JOURNAL_OPERATIONAL_DEPLOYMENT
        .statePropertyKey,
      serialized
    );

  return {
    byteCount
  };
}

function createJournalDeploymentWorkerTrigger_(
  delayMs
) {
  const normalizedDelayMs =
    Math.max(
      1000,
      Number(delayMs || 0)
    );
  const trigger =
    ScriptApp
      .newTrigger(
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .workerHandler
      )
      .timeBased()
      .after(normalizedDelayMs)
      .create();

  return {
    triggerId:
      trigger.getUniqueId(),
    delayMs:
      normalizedDelayMs
  };
}

function replaceJournalDeploymentWorkerSchedule_(
  delayMs
) {
  deleteJournalDeploymentWorkerTriggers_();
  return createJournalDeploymentWorkerTrigger_(
    delayMs
  );
}

function ensureJournalDeploymentWorkerScheduled_(
  delayMs
) {
  const existing =
    ScriptApp
      .getProjectTriggers()
      .filter(trigger =>
        trigger.getHandlerFunction() ===
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .workerHandler
      );

  if (existing.length) {
    return {
      triggerId:
        existing[0].getUniqueId(),
      delayMs: null,
      existing: true,
      triggerCount:
        existing.length
    };
  }

  return {
    ...createJournalDeploymentWorkerTrigger_(
      delayMs
    ),
    existing: false,
    triggerCount: 1
  };
}

function scheduleJournalDeploymentWorker_(
  delayMs
) {
  return replaceJournalDeploymentWorkerSchedule_(
    delayMs
  );
}

function deleteJournalDeploymentWorkerTriggers_() {
  const triggers =
    ScriptApp
      .getProjectTriggers()
      .filter(trigger =>
        trigger.getHandlerFunction() ===
        JOURNAL_OPERATIONAL_DEPLOYMENT
          .workerHandler
      );

  triggers.forEach(trigger =>
    ScriptApp.deleteTrigger(trigger)
  );

  return triggers.length;
}

function updateJournalDeploymentReceipt_(
  state
) {
  const properties =
    PropertiesService.getScriptProperties();
  const serialized =
    properties.getProperty(
      JOURNAL_ENTITY_CONTROL.pushReceiptProperty
    );

  if (!serialized) return null;

  let receipt;

  try {
    receipt = JSON.parse(serialized);
  } catch (error) {
    return null;
  }

  if (
    Number(
      receipt.configuration_version || 0
    ) !==
      Number(
        state.configuration_version || 0
      ) ||
    String(
      receipt.configuration_hash || ''
    ) !==
      String(
        state.configuration_hash || ''
      )
  ) {
    return null;
  }

  receipt.operation_id =
    state.operation_id;
  receipt.deployment_status =
    state.status;
  receipt.current_stage =
    state.current_stage;
  receipt.deployment_updated_at =
    state.updated_at;
  receipt.deployment_completed_at =
    state.completed_at || null;
  receipt.deployment_error =
    state.last_error || null;
  receipt.period =
    state.period || null;

  properties.setProperty(
    JOURNAL_ENTITY_CONTROL.pushReceiptProperty,
    JSON.stringify(receipt)
  );

  return receipt;
}

function compactJournalDeploymentStageResult_(
  stage,
  result
) {
  if (stage === 'bigquery') {
    return {
      status:
        result.status || null,
      period:
        result.period || null,
      clientCount:
        Number(
          result.clientCount || 0
        ),
      processedClientCount:
        Number(
          result.processedClientCount ||
          result.clientCount ||
          0
        ),
      remainingClientCount:
        Number(
          result.remainingClientCount || 0
        ),
      transactionCount:
        Number(
          result.transactionCount || 0
        ),
      accountingTransactionCount:
        Number(
          result.accountingTransactionCount || 0
        ),
      rowCount:
        Number(
          result.rowCount || 0
        ),
      continuationCount:
        Number(
          result.continuationCount || 0
        ),
      jobId:
        result.jobId ||
        result.loadResult &&
        result.loadResult.lastJobId ||
        null,
      verificationStatus:
        result.verification &&
        result.verification.status ||
        null,
      reason:
        result.reason || null
    };
  }

  return {
    status: result.status,
    refreshedObjectCount:
      result.refreshedObjectCount,
    executions:
      result.executions
  };
}

function summarizeJournalDeploymentState_(
  state,
  queued
) {
  return {
    queued: queued === true,
    operationId:
      state.operation_id,
    status:
      state.status,
    currentStage:
      state.current_stage,
    configurationVersion:
      state.configuration_version,
    configurationHash:
      state.configuration_hash,
    period:
      state.period || null,
    updatedAt:
      state.updated_at,
    completedAt:
      state.completed_at || null,
    lastError:
      state.last_error || null
  };
}