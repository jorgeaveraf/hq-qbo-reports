/********************************
 * Rolling Payments reconciliation
 *
 * Rebuilds the latest closed weekly window from QBO and replaces only
 * successfully processed clients. Validation runs before the downstream
 * Connected Sheets refresh performed by the existing deployment flow.
 ********************************/

function getPaymentRollingSnapshotPlan(referenceIsoDate) {
  return getPaymentRollingSnapshotPlan_(referenceIsoDate);
}

function executePaymentBigQuerySnapshot_(loadedEntityConfiguration) {
  Logger.log('--- PAYMENT BIGQUERY SNAPSHOT START ---');
  const schemaValidation = validatePaymentBigQuerySchema_();
  const result = buildPaymentRollingSnapshot_(loadedEntityConfiguration, {
    continueOnClientError: true
  });
  const hasClientFailures = result.clientFailures.length > 0;
  const loadResult = replacePaymentSnapshotRangeClients_(
    result.plan,
    result.rows,
    result.successfulClientIds
  );
  const verification = verifyPaymentRollingSnapshot_(
    result.plan,
    result.rows,
    result.successfulClientIds
  );
  const executionResult = {
    status: hasClientFailures ? 'completed_with_entity_errors' : 'completed',
    entityConfiguration: result.entityConfiguration,
    schemaValidation,
    plan: result.plan,
    clientCount: result.clientCount,
    sourcePaymentCount: result.sourcePaymentCount,
    paymentCount: result.paymentCount,
    pageCount: result.pageCount,
    sourceRowCount: result.rows.length,
    hierarchyValidation: result.hierarchyValidation,
    schemaMonitoring: result.schemaMonitoring,
    baselinePersistence: result.baselinePersistence,
    successfulClientIds: result.successfulClientIds,
    clientFailures: result.clientFailures,
    loadResult,
    verification
  };
  Logger.log(JSON.stringify(executionResult, null, 2));
  Logger.log('--- PAYMENT BIGQUERY SNAPSHOT END ---');
  if (hasClientFailures) {
    throw new Error(
      'Payments snapshot loaded successful entities but completed with entity errors: ' +
      JSON.stringify({
        startDate: result.plan.startDate,
        horizonDate: result.plan.horizonDate,
        successfulClientCount: result.successfulClientIds.length,
        failedClientCount: result.clientFailures.length,
        failures: result.clientFailures
      })
    );
  }
  return {
    status: executionResult.status,
    entityConfiguration: result.entityConfiguration,
    period: result.plan.lastPeriod,
    plan: result.plan,
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

function getPaymentRollingSnapshotPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = Number(
    weekCountOverride === undefined || weekCountOverride === null
      ? PAYMENT_CONFIG.weeklyLookbackWeeks
      : weekCountOverride
  );
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('Payments rolling snapshot week count must be an integer between 1 and 52.');
  }

  const latest = getPreviousCompletedWeekRange_(referenceIsoDate);
  const latestWeekStart = safeParseDate_(latest.snapshotWeek);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    const dateFrom = new Date(latestWeekStart.getTime());
    dateFrom.setUTCDate(dateFrom.getUTCDate() - offset * 7);
    const dateTo = new Date(dateFrom.getTime());
    dateTo.setUTCDate(dateTo.getUTCDate() + 6);
    periods.push(normalizePaymentSnapshotRange_({
      dateFrom: formatUtcDate_(dateFrom),
      dateTo: formatUtcDate_(dateTo)
    }));
  }

  return {
    strategy: 'rolling_transaction_date',
    weekCount,
    startDate: periods[0].dateFrom,
    horizonDate: periods[periods.length - 1].dateTo,
    firstPeriod: periods[0],
    lastPeriod: periods[periods.length - 1],
    snapshotWeeks: periods.map(period => period.snapshotWeek),
    periods
  };
}

function getPaymentRollingPeriodForTxnDate_(txnDateValue, plan) {
  const txnDate = normalizeDateForOutput_(txnDateValue);
  if (!txnDate || !plan || txnDate < plan.startDate || txnDate > plan.horizonDate) {
    return null;
  }
  for (let index = 0; index < plan.periods.length; index++) {
    const period = plan.periods[index];
    if (txnDate >= period.dateFrom && txnDate <= period.dateTo) return period;
  }
  return null;
}

function buildPaymentRollingClientSnapshot_(client, plan, loadedAt) {
  if (!client || !String(client.id || '').trim()) {
    throw new Error('A valid Payments client is required for the rolling snapshot.');
  }
  const response = fetchPayments_(client.id, {
    dateFrom: plan.startDate,
    dateTo: plan.horizonDate
  });
  const rows = [];
  const periodPaymentCounts = {};

  response.items.forEach(payment => {
    const period = getPaymentRollingPeriodForTxnDate_(payment && payment.TxnDate, plan);
    if (!period) {
      throw new Error(
        'Payments gateway returned a transaction outside the rolling window. ' +
          'ClientId=' + client.id + ', PaymentId=' +
          String(payment && (payment.Id || payment.PaymentId) || '') +
          ', TxnDate=' + String(payment && payment.TxnDate || '')
      );
    }
    const normalized = normalizePayment_(client, period, payment, loadedAt);
    normalized.rows.forEach(row => rows.push(row));
    periodPaymentCounts[period.snapshotWeek] =
      Number(periodPaymentCounts[period.snapshotWeek] || 0) + 1;
  });

  sortPaymentRows_(rows);
  const hierarchyValidation = validatePaymentSnapshotHierarchy_(rows);
  const profile = buildPaymentSchemaProfile_(client, plan.lastPeriod, response.items);
  const previous = loadPaymentSchemaProfile_(client.id);
  const comparison = comparePaymentSchemaProfiles_(previous, profile);
  return {
    sourcePaymentCount: response.items.length,
    paymentCount: hierarchyValidation.paymentCount,
    pageCount: response.pageCount,
    rows,
    periodPaymentCounts,
    hierarchyValidation,
    baselineUpdate: response.items.length ? profile : null,
    clientCheck: {
      clientId: client.id,
      clientName: client.name,
      status: response.items.length ? comparison.status : 'skipped_no_payments',
      paymentCount: response.items.length,
      newPaths: comparison.newPaths,
      missingPaths: comparison.missingPaths,
      typeChanges: comparison.typeChanges
    },
    schemaStatus: response.items.length ? comparison.status : 'skipped_no_payments'
  };
}

function buildPaymentRollingSnapshot_(loadedEntityConfigurationOverride, options) {
  const settings = options || {};
  const plan = getPaymentRollingSnapshotPlan_(
    settings.referenceIsoDate,
    settings.weekCount
  );
  const loadedAt = new Date().toISOString();
  const loadedEntityConfiguration = loadedEntityConfigurationOverride
    ? {
        source: String(loadedEntityConfigurationOverride.source || 'configuration_deployment'),
        configuration: validatePaymentEntityConfiguration_(loadedEntityConfigurationOverride.configuration)
      }
    : loadPaymentEntityConfiguration_();
  const clientsById = fetchClients_(loadedEntityConfiguration);
  const clients = Object.keys(clientsById)
    .map(clientId => clientsById[clientId])
    .sort((left, right) =>
      String(left.entityAlias || '').localeCompare(String(right.entityAlias || '')) ||
      String(left.name || '').localeCompare(String(right.name || ''))
    );

  const rows = [];
  const clientChecks = [];
  const baselineUpdates = [];
  const successfulClientIds = [];
  const clientFailures = [];
  let sourcePaymentCount = 0;
  let paymentCount = 0;
  let pageCount = 0;

  Logger.log(JSON.stringify({
    event: 'payment_rolling_snapshot_plan',
    weekCount: plan.weekCount,
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    clientCount: clients.length
  }));

  clients.forEach(client => {
    try {
      const clientSnapshot = buildPaymentRollingClientSnapshot_(client, plan, loadedAt);
      clientSnapshot.rows.forEach(row => rows.push(row));
      sourcePaymentCount += clientSnapshot.sourcePaymentCount;
      paymentCount += clientSnapshot.paymentCount;
      pageCount += clientSnapshot.pageCount;
      clientChecks.push(clientSnapshot.clientCheck);
      if (clientSnapshot.baselineUpdate) baselineUpdates.push(clientSnapshot.baselineUpdate);
      successfulClientIds.push(client.id);
    } catch (error) {
      if (settings.continueOnClientError !== true) throw error;
      const failure = getPaymentClientFailure_(client, error);
      clientFailures.push(failure);
      Logger.log(JSON.stringify({ event: 'payment_rolling_client_failed', ...failure }));
    }
  });

  sortPaymentRows_(rows);
  const hierarchyValidation = validatePaymentSnapshotHierarchy_(rows);
  const baselinePersistence = settings.persistSchemaBaselines === false
    ? { status: 'skipped_debug', attemptedCount: baselineUpdates.length, savedCount: 0, results: [] }
    : {
        status: 'completed',
        attemptedCount: baselineUpdates.length,
        savedCount: baselineUpdates.length,
        results: baselineUpdates.map(persistPaymentSchemaProfile_)
      };

  return {
    entityConfiguration: {
      source: loadedEntityConfiguration.source,
      reportKey: loadedEntityConfiguration.configuration.report_key,
      configurationVersion: loadedEntityConfiguration.configuration.configuration_version,
      configurationHash: loadedEntityConfiguration.configuration.configuration_hash,
      publishedAt: loadedEntityConfiguration.configuration.published_at,
      authorizedEntityCount: loadedEntityConfiguration.configuration.entities.length
    },
    plan,
    clientCount: clients.length,
    sourcePaymentCount,
    paymentCount,
    pageCount,
    rows,
    successfulClientIds,
    clientFailures,
    hierarchyValidation,
    schemaMonitoring: {
      clientCount: clientChecks.length,
      changedCount: clientChecks.filter(check => check.status === 'changed').length,
      observedVariationCount: clientChecks.filter(check => check.status === 'observed_variation').length,
      unchangedCount: clientChecks.filter(check => check.status === 'unchanged').length,
      baselineMissingCount: clientChecks.filter(check => check.status === 'baseline_missing').length,
      skippedNoPaymentsCount: clientChecks.filter(check => check.status === 'skipped_no_payments').length,
      clientChecks
    },
    baselinePersistence
  };
}

/***********************
 * BigQuery Schema Validation
 ***********************/

function validatePaymentRollingSnapshotRows_(plan, rows, successfulClientIds) {
  if (!plan || !Array.isArray(plan.periods) || !plan.periods.length) {
    throw new Error('Payments rolling snapshot requires a non-empty period plan.');
  }
  if (!Array.isArray(rows)) throw new Error('Payments rolling snapshot rows must be an array.');
  const clientIds = Array.from(new Set(
    (successfulClientIds || []).map(clientId => String(clientId || '').trim()).filter(Boolean)
  ));
  const allowedClients = {};
  clientIds.forEach(clientId => { allowedClients[clientId] = true; });
  const periodsByWeek = {};
  plan.periods.forEach(period => { periodsByWeek[period.snapshotWeek] = period; });

  rows.forEach((row, index) => {
    const clientId = String(row.ClientId || '').trim();
    const period = periodsByWeek[String(row.SnapshotWeek || '').trim()];
    if (!allowedClients[clientId]) {
      throw new Error('Payment rolling row ' + index + ' belongs to a client outside the successful scope.');
    }
    if (!period) {
      throw new Error('Payment rolling row ' + index + ' belongs to a week outside the rolling plan.');
    }
    if (
      row.DateFrom !== period.dateFrom ||
      row.DateTo !== period.dateTo ||
      row.SnapshotDate !== period.snapshotDate ||
      !paymentTxnDateInRange_(row, period)
    ) {
      throw new Error('Payment rolling row ' + index + ' has non-canonical period dates.');
    }
    validatePaymentBigQueryRow_(row, index);
  });
  const hierarchy = validatePaymentSnapshotHierarchy_(rows);
  return {
    status: 'passed',
    weekCount: plan.periods.length,
    successfulClientCount: clientIds.length,
    ...hierarchy
  };
}

function replacePaymentSnapshotRangeClients_(plan, rows, successfulClientIds) {
  const validation = validatePaymentRollingSnapshotRows_(plan, rows, successfulClientIds);
  const normalizedClientIds = Array.from(new Set(
    (successfulClientIds || []).map(clientId => String(clientId || '').trim()).filter(Boolean)
  ));
  if (!normalizedClientIds.length) {
    return {
      mode: 'rolling_client_scope_noop',
      destinationTable: PAYMENT_BIGQUERY_TABLE,
      weekCount: plan.periods.length,
      successfulClientCount: 0,
      rowCount: 0,
      state: 'SKIPPED'
    };
  }

  const preparedRows = rows.map(row => PAYMENT_EXPORT_COLUMNS.reduce((json, column) => {
    json[column] = row[column] === undefined ? null : row[column];
    return json;
  }, {}));
  const token = Utilities.getUuid().replace(/-/g, '');
  const stagingTableId = 'payment_rolling_stage_' + token;
  const clientScopeSql = buildPaymentClientScopeSql_(normalizedClientIds);
  const weekScopeSql = plan.periods
    .map(period => "DATE '" + period.snapshotWeek + "'")
    .join(', ');
  let stagingLoadJob = null;

  try {
    if (preparedRows.length) {
      const ndjson = preparedRows.map(JSON.stringify).join('\n');
      const blob = Utilities.newBlob(
        ndjson,
        'application/octet-stream',
        stagingTableId + '.ndjson'
      );
      const insertedJob = BigQuery.Jobs.insert({
        jobReference: {
          projectId: BQ_CONFIG.projectId,
          jobId: 'payment_rolling_stage_' + token
        },
        configuration: { load: {
          destinationTable: {
            projectId: BQ_CONFIG.projectId,
            datasetId: BQ_CONFIG.rawDatasetId,
            tableId: stagingTableId
          },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          createDisposition: 'CREATE_IF_NEEDED',
          writeDisposition: 'WRITE_TRUNCATE',
          autodetect: false,
          ignoreUnknownValues: false,
          maxBadRecords: 0,
          schema: { fields: PAYMENT_BIGQUERY_SCHEMA }
        }}
      }, BQ_CONFIG.projectId, blob);
      if (!insertedJob || !insertedJob.jobReference) {
        throw new Error('BigQuery did not return a job reference for the Payments rolling staging load.');
      }
      stagingLoadJob = waitForBigQueryJob_(insertedJob.jobReference, 120000);
    }

    const statements = [
      'BEGIN TRANSACTION;',
      'DELETE FROM `' + PAYMENT_BIGQUERY_TABLE + '`',
      'WHERE SnapshotWeek IN (' + weekScopeSql + ')',
      '  AND ClientId IN (' + clientScopeSql + ');'
    ];
    if (preparedRows.length) {
      const columns = PAYMENT_EXPORT_COLUMNS.map(column => '`' + column + '`').join(', ');
      statements.push(
        'INSERT INTO `' + PAYMENT_BIGQUERY_TABLE + '` (' + columns + ')',
        'SELECT ' + columns,
        'FROM `' + [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, stagingTableId].join('.') + '`;'
      );
    }
    statements.push('COMMIT TRANSACTION;');
    const queryResult = runBigQueryQuery_(statements.join('\n'));
    return {
      mode: 'rolling_successful_clients_replace',
      jobId: queryResult.jobReference && queryResult.jobReference.jobId || null,
      stagingLoadJobId: stagingLoadJob && stagingLoadJob.jobReference && stagingLoadJob.jobReference.jobId || null,
      destinationTable: PAYMENT_BIGQUERY_TABLE,
      startDate: plan.startDate,
      horizonDate: plan.horizonDate,
      weekCount: plan.periods.length,
      successfulClientCount: normalizedClientIds.length,
      rowCount: preparedRows.length,
      validation,
      state: 'DONE'
    };
  } finally {
    if (preparedRows.length) removePaymentStagingTable_(stagingTableId);
  }
}

function verifyPaymentRollingSnapshot_(plan, rows, successfulClientIds) {
  const inputValidation = validatePaymentRollingSnapshotRows_(plan, rows, successfulClientIds);
  const periodVerifications = plan.periods.map(period => {
    const periodRows = rows.filter(row => row.SnapshotWeek === period.snapshotWeek);
    const expectedHierarchy = validatePaymentSnapshotHierarchy_(periodRows);
    return verifyPaymentSnapshotClients_(
      period.snapshotWeek,
      successfulClientIds,
      expectedHierarchy
    );
  });
  return {
    status: 'passed',
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    weekCount: plan.periods.length,
    successfulClientCount: inputValidation.successfulClientCount,
    rowCount: inputValidation.rowCount,
    paymentCount: inputValidation.paymentCount,
    periodVerifications
  };
}

