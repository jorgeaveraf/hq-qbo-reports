const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadAgingContext() {
  const context = vm.createContext({});
  const projectDir = path.resolve(__dirname, '..');

  ['1.Config.js', '3.Functions.js', '5.Deployment.js'].forEach(fileName => {
    const source = fs.readFileSync(path.join(projectDir, fileName), 'utf8');
    vm.runInContext(source, context, { filename: fileName });
  });

  context.Logger = { log: () => {} };
  return context;
}

function installFunction(context, name, implementation) {
  context.__testImplementation = implementation;
  vm.runInContext(`${name} = __testImplementation`, context);
  delete context.__testImplementation;
}

function createSheet(name, hidden = false) {
  return {
    name,
    hidden,
    headers: null,
    isSheetHidden() {
      return this.hidden;
    },
    showSheet() {
      this.hidden = false;
    },
    getRange() {
      return {
        setValues: values => {
          this.headers = values;
        }
      };
    }
  };
}

test('the deployment pipeline provisions and exports sheets around BigQuery', () => {
  const context = loadAgingContext();
  const state = {
    stages: {
      output_sheets: { status: 'pending' },
      bigquery: { status: 'pending' },
      output_sheet_export: { status: 'pending' },
      data_source_sheets: { status: 'pending' },
      extracts: { status: 'pending' }
    }
  };

  assert.equal(context.getNextAgingDeploymentStage_(state), 'output_sheets');
  state.stages.output_sheets.status = 'completed';
  assert.equal(context.getNextAgingDeploymentStage_(state), 'bigquery');
  state.stages.bigquery.status = 'completed';
  assert.equal(context.getNextAgingDeploymentStage_(state), 'output_sheet_export');
});

test('sheet provisioning creates missing sheets, adds headers, and shows hidden sheets', () => {
  const context = loadAgingContext();
  const hidden = createSheet('hidden_alias', true);
  const sheets = { hidden_alias: hidden };
  const spreadsheet = {
    getSheetByName: name => sheets[name] || null,
    insertSheet: name => {
      sheets[name] = createSheet(name);
      return sheets[name];
    }
  };
  const selection = {
    source: 'test',
    configuration: {
      report_key: 'aging',
      configuration_version: 1,
      configuration_hash: 'hash',
      published_at: '2026-09-01T00:00:00.000Z',
      entities: [{}, {}]
    },
    clientsById: {
      one: { outputSheetName: 'new_alias' },
      two: { outputSheetName: 'hidden_alias' },
      three: { outputSheetName: 'new_alias' }
    }
  };

  installFunction(context, 'resolveAgingDeploymentSelection_', () => selection);
  installFunction(context, 'getTargetSpreadsheet_', () => spreadsheet);

  const result = context.executeAgingOutputSheetsProvisionStage_({});

  assert.equal(result.status, 'passed');
  assert.equal(result.sheetCount, 2);
  assert.equal(result.createdSheetCount, 1);
  assert.equal(result.shownSheetCount, 1);
  assert.equal(hidden.hidden, false);
  assert.equal(sheets.new_alias.headers[0].length, 13);
});

test('sheet export groups the verified BigQuery snapshot by output alias', () => {
  const context = loadAgingContext();
  const selection = {
    source: 'test',
    configuration: {
      report_key: 'aging',
      configuration_version: 1,
      configuration_hash: 'hash',
      published_at: '2026-09-01T00:00:00.000Z',
      entities: [{}]
    },
    clientsById: {
      client_a: { outputSheetName: 'constellation' },
      client_b: { outputSheetName: 'constellation' },
      client_c: { outputSheetName: 'empty_alias' }
    }
  };
  const writes = {};

  installFunction(context, 'resolveAgingDeploymentSelection_', () => selection);
  installFunction(context, 'queryAgingSnapshotExportRows_', () => ({
    rows: [
      {
        clientId: 'client_a',
        exportRow: ['AR', 'constellation_a', '2026-09-01', 'Current', 'A', '', 'Invoice', '', '', 0, 10, 'USD', 'QBO']
      },
      {
        clientId: 'client_b',
        exportRow: ['AP', 'constellation_b', '2026-09-01', '1–30', 'B', '', 'Bill', '', '', 1, 20, 'USD', 'QBO']
      }
    ]
  }));
  installFunction(context, 'writeOutputSheet_', (rows, sheetName) => {
    writes[sheetName] = rows.map(row => [...row]);
  });
  installFunction(context, 'getTargetSpreadsheet_', () => ({}));

  const result = context.executeAgingOutputSheetExportStage_({
    range: { snapshotDate: '2026-09-01' },
    stages: { bigquery: { status: 'completed', result: { rowCount: 2 } } }
  });

  assert.equal(result.status, 'passed');
  assert.equal(result.rowCount, 2);
  assert.equal(result.reportRowCounts.AR, 1);
  assert.equal(result.reportRowCounts.AP, 1);
  assert.equal(writes.constellation.length, 2);
  assert.equal(writes.empty_alias.length, 0);
});

test('sheet export fails closed when the BigQuery row count changes', () => {
  const context = loadAgingContext();
  const selection = {
    clientsById: { client_a: { outputSheetName: 'constellation' } },
    configuration: { entities: [] }
  };

  installFunction(context, 'resolveAgingDeploymentSelection_', () => selection);
  installFunction(context, 'queryAgingSnapshotExportRows_', () => ({ rows: [] }));

  assert.throws(
    () => context.executeAgingOutputSheetExportStage_({
      range: { snapshotDate: '2026-09-01' },
      stages: { bigquery: { status: 'completed', result: { rowCount: 1 } } }
    }),
    /row count does not match/
  );
});

test('BigQuery sheet export reads every result page and maps nullable fields', () => {
  const context = loadAgingContext();
  const apiCalls = [];
  const row = values => ({ f: values.map(value => ({ v: value })) });
  const firstRow = row([
    'AR', 'constellation', '2026-09-01', 'Current', 'Customer A', null,
    'Invoice', null, '2026-09-10', null, '10.50', 'USD', 'QBO', 'client_a'
  ]);
  const secondRow = row([
    'AP', 'constellation', '2026-09-01', '1–30', 'Vendor B', 'B-1',
    'Bill', '2026-08-01', '2026-08-15', '17', '20', 'USD', 'QBO', 'client_a'
  ]);

  context.BigQuery = {
    Jobs: {
      query: request => {
        apiCalls.push({ type: 'query', request });
        return {
          jobReference: { jobId: 'job-1' },
          jobComplete: true,
          rows: [firstRow],
          pageToken: 'next-page'
        };
      },
      getQueryResults: (projectId, jobId, options) => {
        apiCalls.push({ type: 'page', projectId, jobId, options });
        return { jobComplete: true, rows: [secondRow] };
      }
    }
  };
  context.Utilities = { sleep: () => {} };

  const result = context.queryAgingSnapshotExportRows_('2026-09-01');

  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].clientId, 'client_a');
  assert.equal(result.rows[0].exportRow[5], '');
  assert.equal(result.rows[0].exportRow[7], '');
  assert.equal(result.rows[0].exportRow[9], '');
  assert.equal(result.rows[0].exportRow[10], 10.5);
  assert.equal(result.rows[1].exportRow[9], 17);
  assert.equal(apiCalls.length, 2);
  assert.equal(apiCalls[1].options.pageToken, 'next-page');
});

test('direct export fetches reports in bounded concurrent batches', () => {
  const context = loadAgingContext();
  const batchSizes = [];
  const selection = {
    clientsById: {
      a: { id: 'a', outputSheetName: 'alpha' },
      b: { id: 'b', outputSheetName: 'beta' },
      c: { id: 'c', outputSheetName: 'gamma' },
      d: { id: 'd', outputSheetName: 'delta' }
    }
  };

  installFunction(context, 'getAgingQboApiKey_', () => 'test-key');
  installFunction(context, 'extractAsOfDate_', () => '2026-09-01');
  installFunction(context, 'flattenReport_', payload => [payload]);
  installFunction(context, 'mapToExportRows_', (rows, client, reportKind) => [[
    reportKind === 'customer' ? 'AR' : 'AP',
    client.outputSheetName,
    '2026-09-01',
    'Current',
    client.id,
    '',
    reportKind,
    '',
    '',
    0,
    1,
    'USD',
    'QBO'
  ]]);

  context.Utilities = { sleep: () => {} };
  context.UrlFetchApp = {
    fetchAll: requests => {
      batchSizes.push(requests.length);
      return requests.map(request => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ url: request.url })
      }));
    }
  };

  const result = context.fetchAgingDirectExport_(selection);

  assert.deepEqual(batchSizes, [6, 2]);
  assert.equal(result.requestCount, 8);
  assert.equal(result.batchCount, 2);
  assert.equal(result.failedReportCount, 0);
  assert.equal(result.sheets.length, 4);
  result.sheets.forEach(sheet => {
    assert.equal(sheet.status, 'fresh_qbo');
    assert.equal(sheet.expectedReportCount, 2);
    assert.equal(sheet.successfulReportCount, 2);
    assert.equal(sheet.rows.length, 2);
  });
});

test('a failed report affects only its output entity', () => {
  const context = loadAgingContext();
  const selection = {
    clientsById: {
      a: { id: 'a', outputSheetName: 'alpha' },
      b: { id: 'b', outputSheetName: 'beta' }
    }
  };

  installFunction(context, 'fetchAgingReportBatch_', requests => requests.map(request => ({
    ...request,
    success: !(request.clientId === 'a' && request.reportKind === 'vendor'),
    status: request.clientId === 'a' && request.reportKind === 'vendor' ? 503 : 200,
    attempts: 2,
    payload: {},
    error: request.clientId === 'a' && request.reportKind === 'vendor'
      ? 'Gateway returned HTTP 503'
      : null
  })));
  installFunction(context, 'extractAsOfDate_', () => '2026-09-01');
  installFunction(context, 'flattenReport_', () => [{}]);
  installFunction(context, 'mapToExportRows_', (rows, client, reportKind) => [[
    reportKind === 'customer' ? 'AR' : 'AP', client.outputSheetName
  ]]);

  const result = context.fetchAgingDirectExport_(selection);
  const alpha = result.sheets.find(sheet => sheet.sheetName === 'alpha');
  const beta = result.sheets.find(sheet => sheet.sheetName === 'beta');

  assert.equal(alpha.status, 'incomplete_qbo');
  assert.equal(alpha.failures.length, 1);
  assert.equal(beta.status, 'fresh_qbo');
  assert.equal(beta.rows.length, 2);
  assert.equal(result.failedReportCount, 1);
});

test('transient gateway failures retry only the affected reports', () => {
  const context = loadAgingContext();
  const callUrls = [];
  let callNumber = 0;
  const requests = [
    { clientId: 'a', client: {}, sheetName: 'alpha', reportKind: 'customer', url: 'customer-url' },
    { clientId: 'a', client: {}, sheetName: 'alpha', reportKind: 'vendor', url: 'vendor-url' }
  ];

  installFunction(context, 'getAgingQboApiKey_', () => 'test-key');
  context.Utilities = { sleep: () => {} };
  context.UrlFetchApp = {
    fetchAll: batch => {
      callUrls.push(batch.map(request => request.url));
      callNumber++;
      return batch.map(request => ({
        getResponseCode: () => callNumber === 1 && request.url === 'vendor-url' ? 503 : 200,
        getContentText: () => callNumber === 1 && request.url === 'vendor-url'
          ? JSON.stringify({ error: 'temporary' })
          : JSON.stringify({ ok: true })
      }));
    }
  };

  const results = context.fetchAgingReportBatch_(requests);

  assert.deepEqual(JSON.parse(JSON.stringify(callUrls)), [
    ['customer-url', 'vendor-url'],
    ['vendor-url']
  ]);
  assert.equal(results.length, 2);
  assert.equal(results.every(result => result.success), true);
  assert.equal(results.find(result => result.reportKind === 'customer').attempts, 1);
  assert.equal(results.find(result => result.reportKind === 'vendor').attempts, 2);
});

test('completed BigQuery fallback is grouped by entity and validated by row count', () => {
  const context = loadAgingContext();
  const selection = {
    configuration: { configuration_version: 26, configuration_hash: 'hash-26' },
    clientsById: {
      a: { outputSheetName: 'alpha' },
      b: { outputSheetName: 'beta' }
    }
  };
  const state = {
    status: 'completed',
    pipeline_version: 2,
    configuration_version: 26,
    configuration_hash: 'hash-26',
    range: { snapshotDate: '2026-09-01' },
    stages: {
      bigquery: { status: 'completed', result: { rowCount: 2 } },
      output_sheet_export: { status: 'completed' }
    }
  };

  installFunction(context, 'queryAgingSnapshotExportRows_', () => ({
    rows: [
      { clientId: 'a', exportRow: ['AR', 'alpha'] },
      { clientId: 'b', exportRow: ['AP', 'beta'] }
    ]
  }));

  const fallback = context.loadAgingCompletedSnapshotFallback_(selection, state);

  assert.equal(fallback.available, true);
  assert.equal(fallback.snapshotDate, '2026-09-01');
  assert.equal(fallback.rowsBySheet.alpha.length, 1);
  assert.equal(fallback.rowsBySheet.beta.length, 1);
});

test('fallback preserves a sheet that is already from the same snapshot date', () => {
  const context = loadAgingContext();
  const spreadsheet = {
    getSheetByName: () => ({
      getLastRow: () => 2,
      getRange: () => ({ getDisplayValues: () => [['2026-09-01']] })
    })
  };

  const decision = context.chooseAgingSheetFallback_(spreadsheet, 'alpha', {
    available: true,
    snapshotDate: '2026-09-01',
    rowsBySheet: { alpha: [['AR', 'alpha']] }
  });

  assert.equal(decision.source, 'preserved');
  assert.equal(decision.reason, 'existing_sheet_is_same_or_newer_than_snapshot');
});

test('scheduled export delegates when the configuration deployment is active', () => {
  const context = loadAgingContext();
  let released = false;
  context.LockService = {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { released = true; }
    })
  };
  installFunction(context, 'readAgingDeploymentState_', () => ({
    status: 'processing',
    operation_id: 'operation-1',
    current_stage: 'bigquery'
  }));
  installFunction(context, 'resolveAgingEntitySelection_', () => {
    throw new Error('selection must not run while deployment is active');
  });

  const result = context.updateAgingExport();

  assert.equal(result.status, 'delegated_to_configuration_deployment');
  assert.equal(result.currentStage, 'bigquery');
  assert.equal(released, true);
});

test('sheet writes clear only the export columns and reuse the supplied spreadsheet', () => {
  const context = loadAgingContext();
  const calls = [];
  const sheet = {
    isSheetHidden: () => false,
    getMaxRows: () => 20,
    getLastRow: () => 8,
    getRange: (row, column, rowCount, columnCount) => ({
      clearContent: () => calls.push({ type: 'clear', row, column, rowCount, columnCount }),
      setValues: values => calls.push({ type: 'values', row, column, rowCount, columnCount, values }),
      setNumberFormat: format => calls.push({ type: 'format', row, column, rowCount, columnCount, format })
    })
  };
  const spreadsheet = {
    getSheetByName: name => name === 'alpha' ? sheet : null
  };

  context.writeOutputSheet_([
    ['AR', 'alpha', '2026-09-01', 'Current', 'A', '', 'Invoice', '', '', 0, 10, 'USD', 'QBO'],
    ['AP', 'alpha', '2026-09-01', 'Current', 'B', '', 'Bill', '', '', 0, 20, 'USD', 'QBO']
  ], 'alpha', spreadsheet);

  const clear = calls.find(call => call.type === 'clear');
  assert.deepEqual(clear, {
    type: 'clear', row: 1, column: 1, rowCount: 8, columnCount: 13
  });
  assert.equal(calls.some(call => call.type === 'values' && call.row === 2 && call.rowCount === 2), true);
});
