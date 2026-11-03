/***********************
 * QBO P&L Account Detail - Historical monthly backfill
 ***********************/

function buildAccountDetailBackfillCandidates_(loaded, sourceClients, referenceIsoDate) {
  const selection = resolveAccountDetailEntitySelection_(loaded, sourceClients);
  const reference = formatAccountDetailDate_(referenceIsoDate || accountDetailToday_());
  const lastClosedMonth = shiftAccountDetailMonths_(accountDetailMonthStart_(reference), -1);
  const jobs = [];
  selection.clients.forEach(client => {
    let month = accountDetailMonthStart_(client.reportSettings.history_start_date);
    while (accountDetailDate_(month).getTime() <= accountDetailDate_(lastClosedMonth).getTime()) {
      const range = buildAccountDetailMonthRange_(client.reportSettings, month);
      client.reportSettings.detail_account_ids.forEach(accountId => {
        jobs.push({ clientId: client.id, accountId: accountId, range: range });
      });
      month = shiftAccountDetailMonths_(month, 1);
      if (jobs.length > 1000) throw new Error('Account detail backfill exceeded 1,000 scopes.');
    }
  });
  return {
    strategy: 'missing_closed_months',
    configurationHash: selection.configurationHash,
    referenceDate: reference,
    jobs: jobs
  };
}

function readAccountDetailCoverageKeys_(jobs) {
  if (!jobs.length) return {};
  const predicates = jobs.map(job => '(' + [
    'ClientId = ' + accountDetailSqlString_(job.clientId),
    'SubAccountId = ' + accountDetailSqlString_(job.accountId),
    "SnapshotType = '" + ACCOUNT_DETAIL_SNAPSHOT_MONTHLY + "'",
    'PeriodStart = DATE ' + accountDetailSqlString_(job.range.periodStart),
    'PeriodEnd = DATE ' + accountDetailSqlString_(job.range.periodEnd)
  ].join(' AND ') + ')').join('\n OR ');
  const result = runAccountDetailBigQuery_([
    'SELECT ClientId, SubAccountId, CAST(PeriodStart AS STRING) AS PeriodStart,',
    '  CAST(PeriodEnd AS STRING) AS PeriodEnd, MAX(RowCount) AS RowCount',
    'FROM `' + ACCOUNT_DETAIL_RUNS_TABLE + '`',
    'WHERE ' + predicates,
    "  AND Status = 'COMPLETED'",
    'GROUP BY ClientId, SubAccountId, PeriodStart, PeriodEnd'
  ].join('\n'));
  const fields = result.schema && result.schema.fields || [];
  const keys = {};
  (result.rows || []).forEach(row => {
    const values = {};
    fields.forEach((field, index) => values[field.name] = row.f[index] && row.f[index].v);
    keys[[values.ClientId, values.SubAccountId, values.PeriodStart, values.PeriodEnd].join('|')] =
      Number(values.RowCount || 0);
  });
  return keys;
}

function planAccountDetailBackfill_(loaded, sourceClients, referenceIsoDate, coverageOverride) {
  const candidates = buildAccountDetailBackfillCandidates_(loaded, sourceClients, referenceIsoDate);
  const coverage = coverageOverride || readAccountDetailCoverageKeys_(candidates.jobs);
  const missing = candidates.jobs.filter(job => !Object.prototype.hasOwnProperty.call(coverage, [
    job.clientId, job.accountId, job.range.periodStart, job.range.periodEnd
  ].join('|')));
  return {
    strategy: candidates.strategy,
    configurationHash: candidates.configurationHash,
    referenceDate: candidates.referenceDate,
    candidateScopeCount: candidates.jobs.length,
    existingScopeCount: candidates.jobs.length - missing.length,
    missingScopeCount: missing.length,
    jobs: missing
  };
}

function getAccountDetailBackfillPlan(referenceIsoDate) {
  const loaded = loadAccountDetailEntityConfiguration_();
  ensureAccountDetailBigQuerySchema_();
  return planAccountDetailBackfill_(loaded, fetchAccountDetailClients_(), referenceIsoDate);
}

function readAccountDetailBackfillState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    ACCOUNT_DETAIL_WORKER.backfillStateProperty
  );
  return value ? JSON.parse(value) : null;
}

function persistAccountDetailBackfillState_(state) {
  const serialized = JSON.stringify(state);
  const bytes = accountDetailPropertyBytes_(serialized);
  if (bytes > ACCOUNT_DETAIL_WORKER.maxStateBytes) {
    throw new Error('Account detail backfill state exceeds safe size. bytes=' + bytes);
  }
  PropertiesService.getScriptProperties().setProperty(
    ACCOUNT_DETAIL_WORKER.backfillStateProperty, serialized
  );
  return bytes;
}

function deleteAccountDetailBackfillTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === ACCOUNT_DETAIL_WORKER.backfillHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceAccountDetailBackfillSchedule_(delayMs) {
  deleteAccountDetailBackfillTriggers_();
  ScriptApp.newTrigger(ACCOUNT_DETAIL_WORKER.backfillHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function startAccountDetailBackfill(referenceIsoDate) {
  const loaded = loadAccountDetailEntityConfiguration_();
  const plan = planAccountDetailBackfill_(loaded, fetchAccountDetailClients_(), referenceIsoDate);
  const current = readAccountDetailBackfillState_();
  if (current && current.configurationHash === plan.configurationHash &&
      ['pending', 'running'].includes(current.status)) {
    replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
    return current;
  }
  const now = new Date().toISOString();
  const state = {
    operationId: Utilities.getUuid(),
    status: plan.jobs.length ? 'pending' : 'completed',
    configurationHash: plan.configurationHash,
    referenceDate: plan.referenceDate,
    jobs: plan.jobs,
    jobIndex: 0,
    completedScopeCount: 0,
    attempts: 0,
    lastResult: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: plan.jobs.length ? null : now
  };
  persistAccountDetailBackfillState_(state);
  if (plan.jobs.length) replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.initialDelayMs);
  else deleteAccountDetailBackfillTriggers_();
  return state;
}

function processAccountDetailBackfill() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteAccountDetailBackfillTriggers_();
    const state = readAccountDetailBackfillState_();
    if (!state || state.status === 'completed') return state || { status: 'not_started' };
    const loaded = loadAccountDetailEntityConfiguration_();
    if (loaded.configuration.configuration_hash !== state.configurationHash) {
      throw new Error('Entity configuration changed during account detail backfill.');
    }
    state.status = 'running';
    state.attempts = Number(state.attempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistAccountDetailBackfillState_(state);
    replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.watchdogDelayMs);
    const job = state.jobs[state.jobIndex];
    const result = executeAccountDetailSnapshot_({
      loadedConfiguration: loaded,
      clientIds: [job.clientId],
      accountIds: [job.accountId],
      range: job.range,
      returnPartialResult: false
    });
    const completedScope = result.successfulScopes.filter(scope =>
      scope.clientId === job.clientId && scope.accountId === job.accountId &&
      scope.periodStart === job.range.periodStart && scope.periodEnd === job.range.periodEnd
    );
    if (completedScope.length !== 1) {
      throw new Error('Backfill did not complete the planned scope: ' + JSON.stringify(job));
    }
    state.lastResult = {
      clientId: job.clientId,
      accountId: job.accountId,
      periodKey: job.range.periodKey,
      rowCount: result.rowCount
    };
    state.jobIndex += 1;
    state.completedScopeCount += 1;
    state.attempts = 0;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    if (state.jobIndex >= state.jobs.length) {
      state.status = 'completed';
      state.completedAt = state.updatedAt;
      refreshAccountDetailConnectedSheets_();
      deleteAccountDetailBackfillTriggers_();
    } else {
      state.status = 'pending';
      replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
    }
    persistAccountDetailBackfillState_(state);
    return state;
  } catch (error) {
    const state = readAccountDetailBackfillState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.attempts || 0) < ACCOUNT_DETAIL_WORKER.maxAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistAccountDetailBackfillState_(state);
      if (state.status === 'pending') {
        replaceAccountDetailBackfillSchedule_(ACCOUNT_DETAIL_WORKER.failureRetryDelayMs);
      } else {
        deleteAccountDetailBackfillTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

