/********************************
 * Rolling Invoices reconciliation
 *
 * Rebuilds the latest closed weekly window from QBO and replaces only
 * successfully processed clients. Final validation protects data outside
 * the planned window before the existing Connected Sheets refresh runs.
 ********************************/

function normalizeInvoiceSnapshotRange_(rangeOverride) {
  if (!rangeOverride || typeof rangeOverride !== 'object' || Array.isArray(rangeOverride)) {
    throw new Error('Invoice snapshot range must be an object.');
  }
  const dateFrom = normalizeDateForOutput_(rangeOverride.dateFrom);
  const dateTo = normalizeDateForOutput_(rangeOverride.dateTo);
  const fromDate = safeParseDate_(dateFrom);
  const toDate = safeParseDate_(dateTo);
  if (!fromDate || !toDate || fromDate.getTime() > toDate.getTime()) {
    throw new Error('Invoice snapshot range requires a valid Monday-to-Sunday date range.');
  }
  if (fromDate.getUTCDay() !== 1 || toDate.getUTCDay() !== 0) {
    throw new Error('Invoice snapshot range must begin on Monday and end on Sunday.');
  }
  const expectedEnd = new Date(fromDate.getTime());
  expectedEnd.setUTCDate(expectedEnd.getUTCDate() + 6);
  if (expectedEnd.getTime() !== toDate.getTime()) {
    throw new Error('Invoice snapshot range must contain exactly one canonical week.');
  }
  const snapshotDate = new Date(toDate.getTime());
  snapshotDate.setUTCDate(snapshotDate.getUTCDate() + 1);
  return {
    snapshotDate: formatUtcDate_(snapshotDate),
    snapshotWeek: dateFrom,
    dateFrom: dateFrom,
    dateTo: dateTo,
    periodKey: dateFrom + '|' + dateTo
  };
}

function getInvoiceRollingSnapshotPlan_(referenceIsoDate, weekCountOverride) {
  const weekCount = Number(
    weekCountOverride === undefined || weekCountOverride === null
      ? INVOICE_CONFIG.weeklyLookbackWeeks
      : weekCountOverride
  );
  if (!Number.isInteger(weekCount) || weekCount < 1 || weekCount > 52) {
    throw new Error('Invoice rolling snapshot week count must be an integer between 1 and 52.');
  }
  const latest = getPreviousCompletedWeekRange_(referenceIsoDate);
  const latestWeekStart = safeParseDate_(latest.snapshotWeek);
  const periods = [];
  for (let offset = weekCount - 1; offset >= 0; offset--) {
    const dateFrom = new Date(latestWeekStart.getTime());
    dateFrom.setUTCDate(dateFrom.getUTCDate() - offset * 7);
    const dateTo = new Date(dateFrom.getTime());
    dateTo.setUTCDate(dateTo.getUTCDate() + 6);
    periods.push(normalizeInvoiceSnapshotRange_({
      dateFrom: formatUtcDate_(dateFrom),
      dateTo: formatUtcDate_(dateTo)
    }));
  }
  return {
    strategy: 'rolling_transaction_date',
    weekCount: weekCount,
    startDate: periods[0].dateFrom,
    horizonDate: periods[periods.length - 1].dateTo,
    firstPeriod: periods[0],
    lastPeriod: periods[periods.length - 1],
    snapshotWeeks: periods.map(period => period.snapshotWeek),
    periods: periods
  };
}

function getInvoiceRollingPeriodForTxnDate_(txnDateValue, plan) {
  const txnDate = normalizeDateForOutput_(txnDateValue);
  if (!txnDate || !plan || txnDate < plan.startDate || txnDate > plan.horizonDate) return null;
  for (let index = 0; index < plan.periods.length; index++) {
    const period = plan.periods[index];
    if (txnDate >= period.dateFrom && txnDate <= period.dateTo) return period;
  }
  return null;
}

function getInvoiceSourceTxnDate_(invoice) {
  const paths = INVOICE_SOURCE_FIELDS.invoice.txnDate.paths || [];
  for (let index = 0; index < paths.length; index++) {
    const value = invoice && invoice[paths[index]];
    const normalized = normalizeDateForOutput_(value);
    if (normalized) return normalized;
  }
  return '';
}

function buildInvoiceRollingClientSnapshot_(client, plan, loadedAt) {
  if (!client || !String(client.id || '').trim()) {
    throw new Error('A valid Invoice client is required for the rolling snapshot.');
  }
  const response = fetchInvoices_(client.id, plan.startDate, plan.horizonDate);
  const rows = [];
  const diagnostics = createInvoiceSourceDiagnostics_();
  const periodInvoiceCounts = {};

  response.items.forEach((invoice, index) => {
    const txnDate = getInvoiceSourceTxnDate_(invoice);
    const period = getInvoiceRollingPeriodForTxnDate_(txnDate, plan);
    if (!period) {
      throw new Error(
        'Invoice gateway returned a transaction outside the rolling window. ' +
        'ClientId=' + client.id + ', InvoiceIndex=' + index +
        ', InvoiceId=' + String(invoice && (invoice.Id || invoice.InvoiceId || invoice.invoice_id) || '') +
        ', TxnDate=' + String(txnDate || '')
      );
    }
    const normalized = normalizeInvoices_(client, period, { items: [invoice] }, loadedAt);
    normalized.rows.forEach(row => rows.push(row));
    mergeInvoiceSourceDiagnostics_(diagnostics, normalized.diagnostics);
    periodInvoiceCounts[period.snapshotWeek] = Number(periodInvoiceCounts[period.snapshotWeek] || 0) + 1;
  });

  sortInvoiceRows_(rows);
  const hierarchyValidation = validateInvoiceSnapshotHierarchy_(rows);
  const clientDiagnostics = summarizeInvoiceSourceDiagnostics_(diagnostics);
  const schemaBaseline = prepareInvoiceSchemaBaseline_(
    client,
    plan.lastPeriod,
    response.items.length,
    diagnostics
  );
  return {
    rows: rows,
    sourceInvoiceCount: response.items.length,
    invoiceCount: hierarchyValidation.invoiceCount,
    periodInvoiceCounts: periodInvoiceCounts,
    hierarchyValidation: hierarchyValidation,
    diagnostics: diagnostics,
    clientDiagnostics: clientDiagnostics,
    schemaCheck: schemaBaseline.check,
    schemaBaselineUpdate: schemaBaseline.update
  };
}

function buildInvoiceRollingSnapshot_(loadedEntityConfigurationOverride, options) {
  const settings = options || {};
  const plan = getInvoiceRollingSnapshotPlan_(settings.referenceIsoDate, settings.weekCount);
  const loadedAt = new Date().toISOString();
  const loadedEntityConfiguration = loadedEntityConfigurationOverride || loadInvoiceEntityConfiguration_();
  if (!loadedEntityConfiguration || !loadedEntityConfiguration.configuration) {
    throw new Error('A valid loaded Invoice entity configuration is required.');
  }
  const validatedConfiguration = validateInvoiceEntityConfiguration_(loadedEntityConfiguration.configuration);
  const effectiveConfiguration = {
    source: String(loadedEntityConfiguration.source || 'configuration_override'),
    configuration: validatedConfiguration
  };
  const clientsById = fetchClients_(effectiveConfiguration);
  const requestedClientIds = Array.from(new Set((settings.clientIds || []).map(String)));
  const requested = {};
  requestedClientIds.forEach(id => { requested[id] = true; });
  const clients = Object.keys(clientsById)
    .filter(clientId => !requestedClientIds.length || requested[clientId])
    .map(clientId => clientsById[clientId])
    .sort((a, b) => String(a.entityAlias || '').localeCompare(String(b.entityAlias || '')) ||
      String(a.name || '').localeCompare(String(b.name || '')));

  const rows = [];
  const diagnostics = createInvoiceSourceDiagnostics_();
  const mappingWarnings = [];
  const schemaChecks = [];
  const schemaBaselineUpdates = [];
  const successfulClientIds = [];
  const clientFailures = [];
  let sourceInvoiceCount = 0;
  let invoiceCount = 0;

  Logger.log(JSON.stringify({
    event: 'invoice_rolling_snapshot_plan',
    weekCount: plan.weekCount,
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    clientCount: clients.length
  }));

  clients.forEach(client => {
    try {
      const clientSnapshot = buildInvoiceRollingClientSnapshot_(client, plan, loadedAt);
      clientSnapshot.rows.forEach(row => rows.push(row));
      sourceInvoiceCount += clientSnapshot.sourceInvoiceCount;
      invoiceCount += clientSnapshot.invoiceCount;
      mergeInvoiceSourceDiagnostics_(diagnostics, clientSnapshot.diagnostics);
      schemaChecks.push(clientSnapshot.schemaCheck);
      if (clientSnapshot.schemaBaselineUpdate) schemaBaselineUpdates.push(clientSnapshot.schemaBaselineUpdate);
      if (clientSnapshot.clientDiagnostics.aliasResolutionCount > 0 ||
          clientSnapshot.clientDiagnostics.normalizedKeyMatchCount > 0) {
        mappingWarnings.push({
          clientId: client.id,
          clientName: client.name,
          aliasResolutionCount: clientSnapshot.clientDiagnostics.aliasResolutionCount,
          normalizedKeyMatchCount: clientSnapshot.clientDiagnostics.normalizedKeyMatchCount,
          aliasesUsed: clientSnapshot.clientDiagnostics.aliasesUsed,
          normalizedKeyMatches: clientSnapshot.clientDiagnostics.normalizedKeyMatches
        });
      }
      successfulClientIds.push(client.id);
    } catch (error) {
      if (settings.continueOnClientError !== true) throw error;
      const failure = getInvoiceClientFailure_(client, error);
      clientFailures.push(failure);
      Logger.log(JSON.stringify({ event: 'invoice_rolling_client_failed', failure: failure }));
    }
  });

  sortInvoiceRows_(rows);
  const hierarchyValidation = validateInvoiceSnapshotHierarchy_(rows);
  return {
    plan: plan,
    loadedAt: loadedAt,
    clientCount: clients.length,
    sourceInvoiceCount: sourceInvoiceCount,
    invoiceCount: invoiceCount,
    lineRows: rows,
    successfulClientIds: successfulClientIds,
    clientFailures: clientFailures,
    hierarchyValidation: hierarchyValidation,
    entityConfiguration: {
      source: effectiveConfiguration.source,
      reportKey: validatedConfiguration.report_key,
      configurationVersion: validatedConfiguration.configuration_version,
      configurationHash: validatedConfiguration.configuration_hash,
      publishedAt: validatedConfiguration.published_at,
      authorizedEntityCount: validatedConfiguration.entities.length
    },
    sourceDiagnostics: summarizeInvoiceSourceDiagnostics_(diagnostics),
    mappingWarnings: mappingWarnings,
    schemaMonitoring: summarizeInvoiceSchemaMonitoring_(schemaChecks),
    schemaBaselineUpdates: schemaBaselineUpdates
  };
}

function getInvoiceRollingSnapshotPlan(referenceIsoDate) {
  return getInvoiceRollingSnapshotPlan_(referenceIsoDate);
}

function executeInvoiceRollingBigQuerySnapshot_(loadedEntityConfiguration, options) {
  Logger.log('--- INVOICE ROLLING BIGQUERY SNAPSHOT START ---');
  const settings = options || {};
  const schemaValidation = validateInvoiceBigQuerySchema_();
  const plan = getInvoiceRollingSnapshotPlan_(settings.referenceIsoDate, settings.weekCount);
  const outsideWindowBefore = readInvoiceOutsideWindowFingerprint_(plan);
  const result = buildInvoiceRollingSnapshot_(loadedEntityConfiguration, {
    continueOnClientError: true,
    referenceIsoDate: settings.referenceIsoDate,
    weekCount: settings.weekCount,
    clientIds: settings.clientIds || null
  });
  const hasClientFailures = result.clientFailures.length > 0;
  const loadResult = replaceInvoiceSnapshotRangeClients_(
    result.plan,
    result.lineRows,
    result.successfulClientIds
  );
  const verification = verifyInvoiceRollingSnapshot_(
    result.plan,
    result.lineRows,
    result.successfulClientIds,
    outsideWindowBefore
  );
  const baselinePersistence = persistInvoiceSchemaBaselineUpdates_(result.schemaBaselineUpdates);
  const executionResult = {
    status: hasClientFailures ? 'completed_with_entity_errors' : 'completed',
    entityConfiguration: result.entityConfiguration,
    schemaValidation: schemaValidation,
    plan: result.plan,
    clientCount: result.clientCount,
    sourceInvoiceCount: result.sourceInvoiceCount,
    invoiceCount: result.invoiceCount,
    sourceRowCount: result.lineRows.length,
    hierarchyValidation: result.hierarchyValidation,
    sourceDiagnostics: result.sourceDiagnostics,
    mappingWarnings: result.mappingWarnings,
    schemaMonitoring: result.schemaMonitoring,
    baselinePersistence: baselinePersistence,
    successfulClientIds: result.successfulClientIds,
    clientFailures: result.clientFailures,
    loadResult: loadResult,
    verification: verification
  };
  Logger.log(JSON.stringify(executionResult, null, 2));
  Logger.log('--- INVOICE ROLLING BIGQUERY SNAPSHOT END ---');
  if (hasClientFailures && settings.returnPartialResult !== true) {
    throw new Error('Invoice rolling snapshot loaded successful entities but completed with entity errors: ' +
      JSON.stringify({
        startDate: result.plan.startDate,
        horizonDate: result.plan.horizonDate,
        successfulClientCount: result.successfulClientIds.length,
        failedClientCount: result.clientFailures.length,
        failures: result.clientFailures
      }));
  }
  return executionResult;
}

function validateInvoiceRollingSnapshotRows_(plan, rows, successfulClientIds) {
  if (!plan || !Array.isArray(plan.periods) || !plan.periods.length) {
    throw new Error('Invoice rolling snapshot requires a non-empty period plan.');
  }
  if (!Array.isArray(rows)) throw new Error('Invoice rolling snapshot rows must be an array.');
  const clientIds = Array.from(new Set(
    (successfulClientIds || []).map(clientId => String(clientId || '').trim()).filter(Boolean)
  ));
  const allowedClients = {};
  clientIds.forEach(clientId => { allowedClients[clientId] = true; });
  const periodsByWeek = {};
  plan.periods.forEach(period => { periodsByWeek[period.snapshotWeek] = period; });

  rows.forEach((row, index) => {
    const clientId = String(row && row.ClientId || '').trim();
    const period = periodsByWeek[String(row && row.SnapshotWeek || '').trim()];
    const txnDate = normalizeDateForOutput_(row && row.TxnDate);
    const recordType = String(row && row.RecordType || '').trim().toUpperCase();
    if (!allowedClients[clientId]) {
      throw new Error('Invoice rolling row ' + index + ' belongs to a client outside the successful scope.');
    }
    if (!period) {
      throw new Error('Invoice rolling row ' + index + ' belongs to a week outside the rolling plan.');
    }
    if (
      row.DateFrom !== period.dateFrom ||
      row.DateTo !== period.dateTo ||
      row.SnapshotDate !== period.snapshotDate ||
      (recordType === 'HEADER' && (!txnDate || txnDate < period.dateFrom || txnDate > period.dateTo))
    ) {
      throw new Error('Invoice rolling row ' + index + ' has non-canonical period dates. ' + JSON.stringify({
        recordType: recordType,
        snapshotWeek: row && row.SnapshotWeek,
        snapshotDate: row && row.SnapshotDate,
        dateFrom: row && row.DateFrom,
        dateTo: row && row.DateTo,
        txnDate: txnDate || null
      }));
    }
    validateInvoiceBigQueryRow_(row, index);
  });
  const hierarchy = validateInvoiceSnapshotHierarchy_(rows);
  return {
    status: 'passed',
    weekCount: plan.periods.length,
    successfulClientCount: clientIds.length,
    ...hierarchy
  };
}

function replaceInvoiceSnapshotRangeClients_(plan, rows, successfulClientIds) {
  const validation = validateInvoiceRollingSnapshotRows_(plan, rows, successfulClientIds);
  const ids = Array.from(new Set(
    (successfulClientIds || []).map(clientId => String(clientId || '').trim()).filter(Boolean)
  ));
  const tableReference = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  if (!ids.length) {
    return {
      mode: 'rolling_client_scope_noop', destinationTable: tableReference,
      weekCount: plan.periods.length, successfulClientCount: 0, rowCount: 0, state: 'SKIPPED'
    };
  }
  const prepared = buildInvoiceBigQueryRows_(rows);
  const token = Utilities.getUuid().replace(/-/g, '');
  const stagingTableId = 'invoice_rolling_stage_' + token;
  const weekScopeSql = plan.periods.map(period => "DATE '" + period.snapshotWeek + "'").join(', ');
  let stagingLoadJobs = [];
  try {
    if (prepared.length) {
      stagingLoadJobs = loadInvoiceRollingStagingChunks_(prepared, stagingTableId, token);
    }
    const statements = [
      'BEGIN TRANSACTION;',
      'DELETE FROM `' + tableReference + '`',
      'WHERE SnapshotWeek IN (' + weekScopeSql + ')',
      '  AND ClientId IN (' + buildInvoiceClientScopeSql_(ids) + ');'
    ];
    if (prepared.length) {
      const columns = INVOICE_EXPORT_COLUMNS.map(column => '`' + column + '`').join(', ');
      statements.push(
        'INSERT INTO `' + tableReference + '` (' + columns + ')',
        'SELECT ' + columns,
        'FROM `' + [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, stagingTableId].join('.') + '`;'
      );
    }
    statements.push('COMMIT TRANSACTION;');
    const queryResult = runBigQuerySingleRowQuery_(statements.join('\n'));
    return {
      mode: 'rolling_successful_clients_replace',
      jobId: queryResult && queryResult.jobReference && queryResult.jobReference.jobId || null,
      stagingLoadJobId: stagingLoadJobs.length ? stagingLoadJobs[0].jobId : null,
      stagingLoadJobIds: stagingLoadJobs.map(job => job.jobId),
      stagingChunkCount: stagingLoadJobs.length,
      stagingPayloadBytes: stagingLoadJobs.reduce((total, job) => total + job.payloadBytes, 0),
      destinationTable: tableReference,
      startDate: plan.startDate,
      horizonDate: plan.horizonDate,
      weekCount: plan.periods.length,
      successfulClientCount: ids.length,
      rowCount: prepared.length,
      validation: validation,
      state: 'DONE'
    };
  } finally {
    if (prepared.length) {
      try { BigQuery.Tables.remove(BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, stagingTableId); }
      catch (error) { Logger.log('Invoice rolling staging cleanup failed: ' + String(error && error.message || error)); }
    }
  }
}

function invoiceUtf8ByteLength_(value) {
  const text = String(value || '');
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length &&
        text.charCodeAt(index + 1) >= 0xDC00 && text.charCodeAt(index + 1) <= 0xDFFF) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

function loadInvoiceRollingStagingChunks_(preparedRows, stagingTableId, token, maxChunkBytesOverride) {
  const maxChunkBytes = Number(maxChunkBytesOverride || INVOICE_CONFIG.maxStagingChunkBytes);
  if (!Number.isInteger(maxChunkBytes) || maxChunkBytes < 1024) {
    throw new Error('Invoice staging chunk size must be an integer of at least 1024 bytes.');
  }
  const jobs = [];
  let lines = [];
  let payloadBytes = 0;

  const flush = () => {
    if (!lines.length) return;
    const chunkNumber = jobs.length + 1;
    const jobId = 'invoice_rolling_stage_' + token + '_' + ('0000' + chunkNumber).slice(-4);
    const blob = Utilities.newBlob(
      lines.join('\n'),
      'application/octet-stream',
      stagingTableId + '_' + ('0000' + chunkNumber).slice(-4) + '.ndjson'
    );
    const request = {
      jobReference: { projectId: BQ_CONFIG.projectId, jobId: jobId },
      configuration: { load: {
        destinationTable: {
          projectId: BQ_CONFIG.projectId,
          datasetId: BQ_CONFIG.rawDatasetId,
          tableId: stagingTableId
        },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        createDisposition: chunkNumber === 1 ? 'CREATE_IF_NEEDED' : 'CREATE_NEVER',
        writeDisposition: chunkNumber === 1 ? 'WRITE_TRUNCATE' : 'WRITE_APPEND',
        autodetect: false,
        ignoreUnknownValues: false,
        maxBadRecords: 0,
        schema: { fields: INVOICE_BIGQUERY_SCHEMA }
      }}
    };
    const inserted = BigQuery.Jobs.insert(request, BQ_CONFIG.projectId, blob);
    if (!inserted || !inserted.jobReference) {
      throw new Error('BigQuery did not return a job reference for Invoice staging chunk ' + chunkNumber + '.');
    }
    const completed = waitForBigQueryJob_(inserted.jobReference, 120000);
    jobs.push({
      jobId: completed.jobReference.jobId,
      rowCount: lines.length,
      payloadBytes: payloadBytes,
      writeDisposition: request.configuration.load.writeDisposition,
      state: completed.status.state
    });
    lines = [];
    payloadBytes = 0;
  };

  (preparedRows || []).forEach((row, index) => {
    const line = JSON.stringify(row);
    const lineBytes = invoiceUtf8ByteLength_(line);
    if (lineBytes > maxChunkBytes) {
      throw new Error('Invoice rolling row ' + index + ' exceeds the staging chunk byte limit.');
    }
    const separatorBytes = lines.length ? 1 : 0;
    if (lines.length && payloadBytes + separatorBytes + lineBytes > maxChunkBytes) flush();
    if (lines.length) payloadBytes += 1;
    lines.push(line);
    payloadBytes += lineBytes;
  });
  flush();
  return jobs;
}

function readInvoiceOutsideWindowFingerprint_(plan) {
  const tableReference = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const weekScopeSql = plan.periods.map(period => "DATE '" + period.snapshotWeek + "'").join(', ');
  const result = runBigQuerySingleRowQuery_([
    'SELECT',
    '  COUNT(*) AS row_count,',
    '  COUNT(DISTINCT idempotency_key) AS distinct_key_count,',
    '  COALESCE(BIT_XOR(FARM_FINGERPRINT(TO_JSON_STRING(t))), 0) AS row_fingerprint',
    'FROM `' + tableReference + '` AS t',
    'WHERE SnapshotWeek NOT IN (' + weekScopeSql + ')'
  ].join('\n'));
  return {
    rowCount: Number(result.row_count || 0),
    distinctKeyCount: Number(result.distinct_key_count || 0),
    rowFingerprint: String(result.row_fingerprint || '0')
  };
}

function verifyInvoiceRollingSnapshot_(plan, rows, successfulClientIds, outsideWindowBefore) {
  const inputValidation = validateInvoiceRollingSnapshotRows_(plan, rows, successfulClientIds);
  const periodVerifications = plan.periods.map(period => {
    const periodRows = rows.filter(row => row.SnapshotWeek === period.snapshotWeek);
    return verifyInvoiceSnapshotPartition_(
      period.snapshotWeek,
      validateInvoiceSnapshotHierarchy_(periodRows),
      successfulClientIds
    );
  });
  const ids = Array.from(new Set(
    (successfulClientIds || []).map(clientId => String(clientId || '').trim()).filter(Boolean)
  ));
  const tableReference = [BQ_CONFIG.projectId, BQ_CONFIG.rawDatasetId, BQ_CONFIG.snapshotsTableId].join('.');
  const crossWindow = ids.length ? runBigQuerySingleRowQuery_([
    'WITH scoped AS (',
    '  SELECT * FROM `' + tableReference + '`',
    "  WHERE SnapshotWeek BETWEEN DATE '" + plan.firstPeriod.snapshotWeek + "' AND DATE '" + plan.lastPeriod.snapshotWeek + "'",
    '    AND ClientId IN (' + buildInvoiceClientScopeSql_(ids) + ')',
    '), duplicate_invoices AS (',
    '  SELECT ClientId, InvoiceId',
    '  FROM scoped',
    "  WHERE RecordType = 'HEADER'",
    '  GROUP BY ClientId, InvoiceId',
    '  HAVING COUNT(DISTINCT SnapshotWeek) > 1',
    ')',
    'SELECT',
    '  COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)',
    '    OR DateFrom != SnapshotWeek OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)',
    '    OR TxnDate < DateFrom OR TxnDate > DateTo) AS noncanonical_row_count,',
    '  (SELECT COUNT(*) FROM duplicate_invoices) AS duplicate_invoice_week_count',
    'FROM scoped'
  ].join('\n')) : { noncanonical_row_count: 0, duplicate_invoice_week_count: 0 };
  const noncanonicalRowCount = Number(crossWindow.noncanonical_row_count || 0);
  const duplicateInvoiceWeekCount = Number(crossWindow.duplicate_invoice_week_count || 0);
  if (noncanonicalRowCount !== 0 || duplicateInvoiceWeekCount !== 0) {
    throw new Error('Invoice rolling final validation failed: ' + JSON.stringify({
      noncanonicalRowCount: noncanonicalRowCount,
      duplicateInvoiceWeekCount: duplicateInvoiceWeekCount
    }));
  }
  const outsideWindowAfter = readInvoiceOutsideWindowFingerprint_(plan);
  if (JSON.stringify(outsideWindowBefore) !== JSON.stringify(outsideWindowAfter)) {
    throw new Error('Invoice rolling snapshot modified data outside the planned window: ' + JSON.stringify({
      before: outsideWindowBefore,
      after: outsideWindowAfter
    }));
  }
  return {
    status: 'passed',
    startDate: plan.startDate,
    horizonDate: plan.horizonDate,
    weekCount: plan.periods.length,
    successfulClientCount: inputValidation.successfulClientCount,
    rowCount: inputValidation.rowCount,
    invoiceCount: inputValidation.invoiceCount,
    noncanonicalRowCount: noncanonicalRowCount,
    duplicateInvoiceWeekCount: duplicateInvoiceWeekCount,
    outsideWindowFingerprint: outsideWindowAfter,
    periodVerifications: periodVerifications
  };
}

