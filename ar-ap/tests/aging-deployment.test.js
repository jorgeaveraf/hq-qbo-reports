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
