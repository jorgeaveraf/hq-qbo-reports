const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

for (const report of [
  { dir: 'balance-sheet', prefix: 'Balance', config: 'BALANCE_SHEET_REFRESH_CONFIG' },
  { dir: 'profit-and-loss', prefix: 'Pnl', config: 'PNL_CONNECTED_SHEETS_CONFIG' },
  { dir: 'journal-entries', prefix: 'Journal', config: 'JE_SHEET_REFRESH_CONFIG' }
]) {
  test(`${report.dir} waits for a running extract without refreshing twice`, () => {
    let state = 'RUNNING';
    let refreshedAt = new Date('2026-11-14T08:00:00Z');
    let refreshCount = 0;
    const target = {
      name: 'test_extract', type: 'extract', refresh: () => { refreshCount++; },
      getStatus: () => ({
        getExecutionState: () => state, getErrorCode: () => 'NONE',
        getErrorMessage: () => null, getLastExecutionTime: () => null,
        getLastRefreshedTime: () => refreshedAt, isTruncated: () => false
      })
    };
    const context = vm.createContext({
      Logger: { log: () => {} },
      SpreadsheetApp: { enableBigQueryExecution: () => {} }
    });
    vm.runInContext(`var ${report.config} = { timeoutSeconds: 1 }`, context);
    vm.runInContext(fs.readFileSync(path.join(root, report.dir, '5.Deployment.js'), 'utf8'), context);
    context[`get${report.prefix}ConnectedSheetTargets_`] = () => [target];
    context[`get${report.prefix}ReportSpreadsheet_`] = () => ({
      waitForAllDataExecutionsCompletion: () => {}
    });
    const advance = context[`advance${report.prefix}ConnectedSheetsStage_`];
    const operation = { stageAttempts: 1 };
    assert.equal(advance(operation, 'extracts'), null);
    assert.equal(operation.connectedSheetRefresh.stage, 'extracts');
    assert.equal(refreshCount, 1);
    assert.equal(advance(operation, 'extracts'), null);
    assert.equal(refreshCount, 1);
    state = 'SUCCESS';
    refreshedAt = new Date(Date.now() + 1000);
    assert.equal(advance(operation, 'extracts').status, 'passed');
    assert.equal(operation.connectedSheetRefresh, null);
    assert.equal(refreshCount, 1);
  });
}
