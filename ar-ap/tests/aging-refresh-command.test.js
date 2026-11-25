const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const SECRET = 'test-refresh-secret';
const RUN_ID = '08b63eb8-04d6-459c-a93f-aeeec961e492';
const OTHER_RUN_ID = '68c63eb8-04d6-459c-a93f-aeeec961e492';

function setup() {
  const context = vm.createContext({});
  const project = path.resolve(__dirname, '..');
  for (const file of ['1.Config.js', '3.Functions.js', '8.RefreshCommand.js']) {
    vm.runInContext(fs.readFileSync(path.join(project, file), 'utf8'), context, { filename: file });
  }
  const values = new Map([['QBO_AGING_REFRESH_COMMAND_SECRET', SECRET]]);
  const triggers = [];
  let nextTrigger = 0;
  let lockAvailable = true;
  context.PropertiesService = { getScriptProperties: () => ({
    getProperty: key => values.get(key) || null,
    setProperty: (key, value) => values.set(key, value)
  }) };
  context.LockService = { getScriptLock: () => ({
    tryLock: () => lockAvailable,
    releaseLock: () => {}
  }) };
  context.ScriptApp = {
    getProjectTriggers: () => triggers,
    deleteTrigger: trigger => {
      const index = triggers.indexOf(trigger);
      if (index >= 0) triggers.splice(index, 1);
    },
    newTrigger: handler => ({ timeBased: () => ({ after: () => ({ create: () => {
      const id = `trigger-${++nextTrigger}`;
      const trigger = {
        getHandlerFunction: () => handler,
        getUniqueId: () => id
      };
      triggers.push(trigger);
      return trigger;
    } }) }) })
  };
  context.Utilities = { Charset: { UTF_8: 'UTF-8' }, computeHmacSha256Signature: (payload, secret) =>
    [...crypto.createHmac('sha256', secret).update(payload).digest()].map(byte => byte > 127 ? byte - 256 : byte) };
  context.ContentService = {
    MimeType: { JSON: 'json' },
    createTextOutput: value => ({ setMimeType: () => ({ value }) })
  };
  context.Logger = { log: () => {} };
  const send = (action, runId = RUN_ID, overrides = {}) => {
    const payload = JSON.stringify({
      action, contract_type: 'qbo_report_refresh_command', contract_version: '1.0',
      report_key: 'aging', requested_at: new Date().toISOString(), run_id: runId,
      ...overrides
    });
    const envelope = {
      contract_type: 'qbo_report_refresh_envelope', contract_version: '1.0', payload,
      signature: crypto.createHmac('sha256', SECRET).update(payload).digest('hex')
    };
    return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(envelope) } }).value);
  };
  return { context, values, triggers, send, setLockAvailable: value => { lockAvailable = value; } };
}

test('signed start is queued once and a different run is blocked while active', () => {
  const { send, triggers } = setup();
  const started = send('start');
  assert.equal(started.status, 'queued', JSON.stringify(started));
  assert.equal(triggers.length, 1);
  assert.equal(send('start').status, 'queued');
  assert.equal(triggers.length, 1);
  const conflict = send('start', OTHER_RUN_ID);
  assert.equal(conflict.status, 'already_running');
  assert.equal(conflict.activeRunId, RUN_ID);
  assert.equal(send('status').status, 'queued');
});

test('only the matching trigger runs the export and reports a compact result', () => {
  const { context, send, triggers } = setup();
  let called = 0;
  context.updateAgingExport = () => {
    called++;
    return { status: 'completed_with_warnings', clientCount: 5, outputSheetCount: 2,
      fallbackSheetCount: 1, failedReportCount: 1, writtenRowCount: 40,
      sheets: [{ rows: Array(10000).fill('large result is not stored') }] };
  };
  send('start');
  context.runQueuedAgingRefresh({ triggerUid: 'wrong-trigger' });
  assert.equal(called, 0);
  context.runQueuedAgingRefresh({ triggerUid: triggers[0].getUniqueId() });
  assert.equal(called, 1);
  const status = send('status');
  assert.equal(status.status, 'completed_with_warnings');
  assert.equal(status.result.fallbackSheetCount, 1);
  assert.equal(status.result.writtenRowCount, 40);
  assert.equal(JSON.stringify(status).includes('large result'), false);
});

test('invalid signature and stale timestamp cannot schedule a run', () => {
  const { context, send, triggers } = setup();
  assert.equal(send('start', RUN_ID, { requested_at: '2020-01-01T00:00:00.000Z' }).status, 'rejected');
  const payload = JSON.stringify({ action: 'start' });
  const invalid = context.doPost({ postData: { contents: JSON.stringify({
    contract_type: 'qbo_report_refresh_envelope', contract_version: '1.0', payload,
    signature: '0'.repeat(64)
  }) } });
  assert.equal(JSON.parse(invalid.value).status, 'rejected');
  assert.equal(triggers.length, 0);
});

test('a busy script lock does not schedule a run, and an expired queued run can be replaced', () => {
  const { send, values, triggers, setLockAvailable } = setup();
  setLockAvailable(false);
  assert.equal(send('start').status, 'busy');
  assert.equal(triggers.length, 0);
  setLockAvailable(true);
  values.set('QBO_AGING_REFRESH_LATEST_RUN', JSON.stringify({
    run_id: OTHER_RUN_ID, status: 'queued', requested_at: '2020-01-01T00:00:00.000Z',
    trigger_id: 'obsolete'
  }));
  assert.equal(send('start').status, 'queued');
  assert.equal(triggers.length, 1);
});

test('export failures are visible and do not prevent a later request', () => {
  const { context, send, triggers } = setup();
  context.updateAgingExport = () => { throw new Error('Gateway unavailable'); };
  send('start');
  context.runQueuedAgingRefresh({ triggerUid: triggers[0].getUniqueId() });
  assert.equal(send('status').status, 'failed');
  assert.equal(send('status').error, 'Gateway unavailable');
  assert.equal(send('start', OTHER_RUN_ID).status, 'queued');
});

test('the existing configuration-push path remains routed to its handler', () => {
  const { context } = setup();
  context.handleAgingEntityConfigurationPush_ = () => ({ success: true, status: 'legacy_push' });
  const result = context.doPost({ postData: { contents: JSON.stringify({ contract_type: 'qbo_entity_configuration_envelope' }) } });
  assert.equal(JSON.parse(result.value).status, 'legacy_push');
});
