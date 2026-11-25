/*
 * Server-to-server command for the FinOps report refresh control.
 * The browser must never call this web app or receive its signing secret.
 * The configuration-push contract in 3.Functions.js remains independent.
 */

function handleAgingRefreshCommand_(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) ||
      envelope.contract_type !== AGING_REFRESH_COMMAND.envelopeContractType ||
      envelope.contract_version !== AGING_REFRESH_COMMAND.envelopeContractVersion ||
      typeof envelope.payload !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(String(envelope.signature || ''))) {
    throw new Error('Invalid report refresh envelope.');
  }

  const secret = String(PropertiesService.getScriptProperties()
    .getProperty(AGING_REFRESH_COMMAND.secretProperty) || '').trim();
  if (!secret) throw new Error('Report refresh command is not configured.');
  if (!agingSecureHexEquals_(
    agingHmacSha256Hex_(envelope.payload, secret), envelope.signature
  )) throw new Error('Invalid report refresh signature.');

  let command;
  try {
    command = JSON.parse(envelope.payload);
  } catch (error) {
    throw new Error('Invalid report refresh payload JSON.');
  }
  validateAgingRefreshCommand_(command);
  return command.action === 'start'
    ? startAgingRefresh_(command.run_id)
    : getAgingRefreshStatus_(command.run_id);
}

function validateAgingRefreshCommand_(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new Error('Invalid report refresh command.');
  }
  const expected = ['action', 'contract_type', 'contract_version', 'report_key', 'requested_at', 'run_id'];
  if (Object.keys(command).sort().join(',') !== expected.join(',')) {
    throw new Error('Unexpected report refresh command fields.');
  }
  if (command.contract_type !== AGING_REFRESH_COMMAND.payloadContractType ||
      command.contract_version !== AGING_REFRESH_COMMAND.payloadContractVersion ||
      command.report_key !== AGING_REFRESH_COMMAND.reportKey ||
      !['start', 'status'].includes(command.action) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(command.run_id || ''))) {
    throw new Error('Unsupported report refresh command.');
  }
  const requestedAt = Date.parse(command.requested_at);
  const ageMs = Date.now() - requestedAt;
  if (!Number.isFinite(requestedAt) ||
      ageMs > AGING_REFRESH_COMMAND.maxAgeSeconds * 1000 ||
      ageMs < -AGING_REFRESH_COMMAND.futureToleranceSeconds * 1000) {
    throw new Error('Report refresh command has expired.');
  }
}

function readAgingRefreshState_() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(AGING_REFRESH_COMMAND.stateProperty);
  if (!raw) return null;
  const state = JSON.parse(raw);
  if (!state || typeof state !== 'object' || !state.run_id || !state.status) {
    throw new Error('Invalid report refresh state.');
  }
  const activeSince = Date.parse(state.started_at || state.requested_at);
  const staleAfter = state.status === 'queued'
    ? AGING_REFRESH_COMMAND.queuedStaleMs
    : AGING_REFRESH_COMMAND.runningStaleMs;
  if (['queued', 'running'].includes(state.status) &&
      (!Number.isFinite(activeSince) || Date.now() - activeSince > staleAfter)) {
    return { ...state, status: 'timed_out', finished_at: new Date().toISOString(),
      error: 'No completion was recorded within the expected time.' };
  }
  return state;
}

function writeAgingRefreshState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    AGING_REFRESH_COMMAND.stateProperty, JSON.stringify(state)
  );
}

function publicAgingRefreshState_(state) {
  return {
    success: true,
    reportKey: AGING_REFRESH_COMMAND.reportKey,
    runId: state.run_id,
    status: state.status,
    requestedAt: state.requested_at,
    startedAt: state.started_at || null,
    finishedAt: state.finished_at || null,
    result: state.result || null,
    error: state.error || null
  };
}

function getAgingRefreshStatus_(runId) {
  const state = readAgingRefreshState_();
  return state && state.run_id === runId
    ? publicAgingRefreshState_(state)
    : { success: false, reportKey: AGING_REFRESH_COMMAND.reportKey,
      runId, status: 'not_found' };
}

function startAgingRefresh_(runId) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(AGING_REFRESH_COMMAND.lockWaitMs)) {
    return { success: false, reportKey: AGING_REFRESH_COMMAND.reportKey,
      runId, status: 'busy' };
  }
  try {
    const current = readAgingRefreshState_();
    if (current && current.run_id === runId) return publicAgingRefreshState_(current);
    if (current && ['queued', 'running'].includes(current.status)) {
      return { success: false, reportKey: AGING_REFRESH_COMMAND.reportKey,
        runId, activeRunId: current.run_id, status: 'already_running' };
    }

    // Only our own obsolete worker triggers are removed. The configuration
    // deployment and other report triggers are never touched.
    ScriptApp.getProjectTriggers()
      .filter(trigger => trigger.getHandlerFunction() === AGING_REFRESH_COMMAND.workerHandler)
      .forEach(trigger => ScriptApp.deleteTrigger(trigger));
    const trigger = ScriptApp.newTrigger(AGING_REFRESH_COMMAND.workerHandler)
      .timeBased().after(AGING_REFRESH_COMMAND.triggerDelayMs).create();
    const state = {
      run_id: runId,
      status: 'queued',
      requested_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      trigger_id: trigger.getUniqueId(),
      result: null,
      error: null
    };
    try {
      writeAgingRefreshState_(state);
    } catch (error) {
      ScriptApp.deleteTrigger(trigger);
      throw error;
    }
    Logger.log(JSON.stringify({ event: 'aging_refresh_queued', runId }));
    return publicAgingRefreshState_(state);
  } finally {
    lock.releaseLock();
  }
}

function runQueuedAgingRefresh(e) {
  const state = readAgingRefreshState_();
  const triggerId = String(e && e.triggerUid || '');
  if (!state || state.status !== 'queued' || !triggerId ||
      state.trigger_id !== triggerId) return;

  const running = { ...state, status: 'running', started_at: new Date().toISOString() };
  writeAgingRefreshState_(running);
  try {
    const result = updateAgingExport();
    if (!result || typeof result.status !== 'string') {
      throw new Error('Aging export returned no status.');
    }
    const summary = {
      clientCount: result.clientCount || 0,
      outputSheetCount: result.outputSheetCount || 0,
      freshSheetCount: result.freshSheetCount || 0,
      fallbackSheetCount: result.fallbackSheetCount || 0,
      preservedSheetCount: result.preservedSheetCount || 0,
      failedWriteCount: result.failedWriteCount || 0,
      failedReportCount: result.failedReportCount || 0,
      writtenRowCount: result.writtenRowCount || 0,
      durationMs: result.durations && result.durations.totalMs || result.durationMs || null
    };
    writeAgingRefreshState_({ ...running, status: result.status,
      finished_at: new Date().toISOString(), result: summary });
    Logger.log(JSON.stringify({ event: 'aging_refresh_finished', runId: state.run_id,
      status: result.status }));
  } catch (error) {
    writeAgingRefreshState_({ ...running, status: 'failed',
      finished_at: new Date().toISOString(), error: String(error && error.message || error).slice(0, 500) });
    Logger.log(JSON.stringify({ event: 'aging_refresh_failed', runId: state.run_id,
      error: String(error && error.message || error) }));
  }
}
