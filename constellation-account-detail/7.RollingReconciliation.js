/***********************
 * QBO P&L Account Detail - Weekly repair of closed monthly snapshots
 ***********************/

function buildAccountDetailRollingPlan_(loaded, sourceClients, referenceIsoDate) {
  const selection = resolveAccountDetailEntitySelection_(loaded, sourceClients);
  const reference = formatAccountDetailDate_(referenceIsoDate || accountDetailToday_());
  const referenceDate = accountDetailDate_(reference);
  const currentMonday = new Date(referenceDate.getTime());
  currentMonday.setUTCDate(currentMonday.getUTCDate() - ((currentMonday.getUTCDay() + 6) % 7));
  const lastCompletedSunday = new Date(currentMonday.getTime() - 86400000);
  const jobs = [];
  selection.clients.forEach(client => {
    if (!client.reportSettings.repair.enabled) return;
    const firstMonday = new Date(lastCompletedSunday.getTime() -
      (client.reportSettings.repair.window_weeks * 7 - 1) * 86400000);
    const currentMonth = accountDetailMonthStart_(reference);
    const lastClosedMonth = shiftAccountDetailMonths_(currentMonth, -1);
    let month = accountDetailMonthStart_(formatAccountDetailDate_(firstMonday));
    while (accountDetailDate_(month).getTime() <= accountDetailDate_(lastClosedMonth).getTime()) {
      const range = buildAccountDetailMonthRange_(client.reportSettings, month);
      jobs.push({ clientId: client.id, range: range });
      month = shiftAccountDetailMonths_(month, 1);
    }
  });
  return {
    strategy: 'weekly_repair_closed_months_intersecting_window',
    configurationHash: selection.configurationHash,
    referenceDate: reference,
    jobs: jobs
  };
}

function getAccountDetailRollingReconciliationPlan(referenceIsoDate) {
  const loaded = loadAccountDetailEntityConfiguration_();
  return buildAccountDetailRollingPlan_(loaded, fetchAccountDetailClients_(), referenceIsoDate);
}

function readAccountDetailRollingState_() {
  const value = PropertiesService.getScriptProperties().getProperty(
    ACCOUNT_DETAIL_WORKER.repairStateProperty
  );
  return value ? JSON.parse(value) : null;
}

function persistAccountDetailRollingState_(state) {
  const serialized = JSON.stringify(state);
  const bytes = accountDetailPropertyBytes_(serialized);
  if (bytes > ACCOUNT_DETAIL_WORKER.maxStateBytes) {
    throw new Error('Account detail repair state exceeds safe size. bytes=' + bytes);
  }
  PropertiesService.getScriptProperties().setProperty(
    ACCOUNT_DETAIL_WORKER.repairStateProperty, serialized
  );
  return bytes;
}

function deleteAccountDetailRollingTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === ACCOUNT_DETAIL_WORKER.repairHandler)
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
}

function replaceAccountDetailRollingSchedule_(delayMs) {
  deleteAccountDetailRollingTriggers_();
  ScriptApp.newTrigger(ACCOUNT_DETAIL_WORKER.repairHandler).timeBased()
    .after(Math.max(1000, Number(delayMs) || 1000)).create();
}

function startAccountDetailRollingReconciliation(referenceIsoDate) {
  const backfill = readAccountDetailBackfillState_();
  if (backfill && ['pending', 'running'].includes(backfill.status)) {
    throw new Error('Account detail historical backfill must finish before rolling repair starts.');
  }
  const loaded = loadAccountDetailEntityConfiguration_();
  const plan = buildAccountDetailRollingPlan_(loaded, fetchAccountDetailClients_(), referenceIsoDate);
  const current = readAccountDetailRollingState_();
  if (current && current.configurationHash === plan.configurationHash &&
      ['pending', 'running'].includes(current.status)) {
    replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
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
    completedPeriodCount: 0,
    attempts: 0,
    lastResult: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    completedAt: plan.jobs.length ? null : now
  };
  persistAccountDetailRollingState_(state);
  if (plan.jobs.length) replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.initialDelayMs);
  return state;
}

function processAccountDetailRollingReconciliation() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
    return { status: 'deferred_lock_busy' };
  }
  try {
    deleteAccountDetailRollingTriggers_();
    const state = readAccountDetailRollingState_();
    if (!state || state.status === 'completed') return state || { status: 'not_started' };
    const loaded = loadAccountDetailEntityConfiguration_();
    if (loaded.configuration.configuration_hash !== state.configurationHash) {
      throw new Error('Entity configuration changed during account detail rolling repair.');
    }
    state.status = 'running';
    state.attempts = Number(state.attempts || 0) + 1;
    state.updatedAt = new Date().toISOString();
    persistAccountDetailRollingState_(state);
    replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.watchdogDelayMs);
    const job = state.jobs[state.jobIndex];
    const result = executeAccountDetailSnapshot_({
      loadedConfiguration: loaded,
      clientIds: [job.clientId],
      range: job.range,
      returnPartialResult: false
    });
    state.lastResult = {
      clientId: job.clientId,
      periodKey: job.range.periodKey,
      rowCount: result.rowCount,
      scopeCount: result.scopeCount
    };
    state.jobIndex += 1;
    state.completedPeriodCount += 1;
    state.attempts = 0;
    state.lastError = null;
    state.updatedAt = new Date().toISOString();
    if (state.jobIndex >= state.jobs.length) {
      state.status = 'completed';
      state.completedAt = state.updatedAt;
      refreshAccountDetailConnectedSheets_();
      deleteAccountDetailRollingTriggers_();
    } else {
      state.status = 'pending';
      replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.continuationDelayMs);
    }
    persistAccountDetailRollingState_(state);
    return state;
  } catch (error) {
    const state = readAccountDetailRollingState_();
    if (state) {
      state.lastError = String(error && error.message || error).slice(0, 1500);
      state.status = Number(state.attempts || 0) < ACCOUNT_DETAIL_WORKER.maxAttempts
        ? 'pending' : 'failed';
      state.updatedAt = new Date().toISOString();
      persistAccountDetailRollingState_(state);
      if (state.status === 'pending') {
        replaceAccountDetailRollingSchedule_(ACCOUNT_DETAIL_WORKER.failureRetryDelayMs);
      } else {
        deleteAccountDetailRollingTriggers_();
      }
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

