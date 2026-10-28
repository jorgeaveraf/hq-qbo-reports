const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadContext() {
  const properties = {};
  const triggers = [];
  let triggerId = 0;
  const context = vm.createContext({
    console,
    Logger: { log() {} },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(_algorithm, value) {
        return Array.from(crypto.createHash('sha256').update(String(value)).digest())
          .map(value => value > 127 ? value - 256 : value);
      },
      formatDate(value) { return new Date(value).toISOString().slice(0, 10); },
      newBlob(value) { return { getBytes: () => Array.from(Buffer.from(String(value))) }; },
      getUuid() { return '12345678-1234-1234-1234-123456789abc'; },
      sleep() {}
    },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => Object.prototype.hasOwnProperty.call(properties, key) ? properties[key] : null,
      setProperty: (key, value) => { properties[key] = String(value); },
      deleteProperty: key => { delete properties[key]; }
    }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {} }) },
    ScriptApp: {
      WeekDay: { MONDAY: 'MONDAY' },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger(trigger) { const index = triggers.indexOf(trigger); if (index >= 0) triggers.splice(index, 1); },
      newTrigger(handler) {
        const schedule = { handler };
        const builder = {
          timeBased() { return builder; },
          everyDays(value) { schedule.everyDays = value; return builder; },
          onMonthDay(value) { schedule.monthDay = value; return builder; },
          onWeekDay(value) { schedule.weekDay = value; return builder; },
          atHour(value) { schedule.hour = value; return builder; },
          after(value) { schedule.after = value; return builder; },
          create() {
            const id = 'trigger-' + ++triggerId;
            const trigger = {
              schedule,
              getUniqueId: () => id,
              getHandlerFunction: () => handler
            };
            triggers.push(trigger);
            return trigger;
          }
        };
        return builder;
      }
    }
  });
  [
    'constellation-account-detail/1.Config.js',
    'constellation-account-detail/3.Functions.js',
    'constellation-account-detail/5.Deployment.js',
    'constellation-account-detail/6.Backfill.js',
    'constellation-account-detail/7.RollingReconciliation.js'
  ].forEach(file => vm.runInContext(
    fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file }
  ));
  context.__properties = properties;
  context.__triggers = triggers;
  return context;
}

function settings() {
  return {
    detail_account_ids: ['1150040007', '1150040008'],
    parent_account_id: null,
    history_start_date: '2026-01-01',
    latest: { enabled: true, cadence: 'DAILY', mode: 'YTD_REPLACE' },
    monthly: { enabled: true, capture_day: 10, months_behind: 1 },
    repair: { enabled: true, cadence: 'WEEKLY', window_weeks: 12 }
  };
}

function loadedConfiguration(context) {
  const entities = [{
    match_type: 'client_id',
    match_value: 'd732ae36-2455-44ae-b458-56ca46774b2a',
    entity_alias: 'constellation',
    report_settings: settings()
  }];
  const hash = context.calculateAccountDetailConfigurationHash_(
    '1.0', 'profit_and_loss_account_detail', entities
  );
  return {
    source: 'test',
    configuration: {
      contract_type: 'qbo_entity_configuration',
      contract_version: '1.0',
      schema_version: '1.0',
      report_key: 'profit_and_loss_account_detail',
      configuration_version: 1,
      configuration_hash: hash,
      published_at: '2026-10-28T12:00:00.000Z',
      entities
    }
  };
}

function clients() {
  return [{
    id: 'd732ae36-2455-44ae-b458-56ca46774b2a',
    name: 'Constellation',
    realmId: '9130355571476916',
    firstWord: 'constellation'
  }];
}

function accounts() {
  return [
    { Id: '175', Name: 'Retail Income', AcctNum: '40000', SubAccount: false },
    {
      Id: '1150040007', Name: 'Retail Returned Product', AcctNum: '40005',
      FullyQualifiedName: 'Retail Income:Retail Returned Product', SubAccount: true,
      ParentRef: { value: '175' }
    },
    {
      Id: '1150040008', Name: 'Retail Refunds/Discounts', AcctNum: '40010',
      FullyQualifiedName: 'Retail Income:Retail Refunds/Discounts', SubAccount: true,
      ParentRef: { value: '175' }
    },
    { Id: '1150040077', Name: 'Retail Returns', AcctNum: '40020', SubAccount: false }
  ];
}

function detailPayload(columnOrder) {
  const values = {
    tx_date: { value: '2026-10-01' },
    txn_type: { value: 'Credit Memo', id: 'txn-1' },
    doc_num: { value: 'CM-100' },
    name: { value: 'Customer A', id: 'customer-1' },
    dept_name: { value: 'Seattle', id: 'department-1' },
    memo: { value: 'Returned product' },
    split_acc: { value: 'Accounts Receivable', id: '84' },
    subt_nat_amount: { value: '-25.50' },
    rbal_nat_amount: { value: '-25.50' }
  };
  const order = columnOrder || Object.keys(values);
  return {
    client_id: 'd732ae36-2455-44ae-b458-56ca46774b2a',
    realm_id: '9130355571476916',
    environment: 'prod',
    fetched_at: '2026-10-28T15:00:00.000Z',
    data: {
      Header: {
        ReportName: 'ProfitAndLossDetail', ReportBasis: 'Accrual',
        StartPeriod: '2026-10-01', EndPeriod: '2026-10-31', Currency: 'USD'
      },
      Columns: { Column: order.map(key => ({
        ColTitle: key, ColType: ['subt_nat_amount', 'rbal_nat_amount'].includes(key) ? 'Money' : 'String',
        MetaData: [{ Name: 'ColKey', Value: key }]
      })) },
      Rows: { Row: [{
        type: 'Section', Rows: { Row: [{ type: 'Data', ColData: order.map(key => values[key]) }] }
      }] }
    }
  };
}

function pnlControlPayload() {
  function section(id, label, children) {
    return {
      type: 'Section',
      Header: { ColData: [{ value: label, id }, { value: '' }] },
      Rows: { Row: children || [] },
      Summary: { ColData: [{ value: 'Total for ' + label }, { value: '0.00' }] }
    };
  }
  function accountRow(id, label) {
    return {
      type: 'Data',
      ColData: [{ value: label, id }, { value: '0.00' }]
    };
  }
  return {
    data: {
      Header: { ReportName: 'ProfitAndLoss' },
      Columns: { Column: [
        { ColTitle: 'Account', ColType: 'Account', MetaData: [{ Name: 'ColKey', Value: 'account' }] },
        { ColTitle: 'Total', ColType: 'Money', MetaData: [{ Name: 'ColKey', Value: 'total' }] }
      ] },
      Rows: { Row: [section('175', '40000 Retail Income', [
        accountRow('1150040007', '40005 Retail Returned Product'),
        accountRow('1150040008', '40010 Retail Refunds/Discounts')
      ])] }
    }
  };
}

test('configuration keeps dynamic report settings in its hash and validates them', () => {
  const context = loadContext();
  const loaded = loadedConfiguration(context);
  const validated = context.validateAccountDetailEntityConfiguration_(loaded.configuration);
  assert.deepEqual(Array.from(validated.entities[0].report_settings.detail_account_ids), [
    '1150040007', '1150040008'
  ]);
  const changed = JSON.parse(JSON.stringify(loaded.configuration));
  changed.entities[0].report_settings.detail_account_ids.push('new-account');
  assert.throws(() => context.validateAccountDetailEntityConfiguration_(changed), /hash mismatch/);
});

test('selection authorizes Constellation by client ID', () => {
  const context = loadContext();
  const selection = context.resolveAccountDetailEntitySelection_(loadedConfiguration(context), clients());
  assert.equal(selection.clients.length, 1);
  assert.equal(selection.clients[0].entityAlias, 'constellation');
  assert.equal(selection.clients[0].reportSettings.history_start_date, '2026-01-01');
});

test('account hierarchy comes from ParentRef and rejects a numbered non-subaccount', () => {
  const context = loadContext();
  const resolved = context.resolveAccountDetailTargets_(accounts(), settings());
  assert.equal(resolved.parent.Id, '175');
  assert.equal(resolved.targets[0].parentId, '175');
  assert.equal(resolved.targets[0].path, 'Retail Income:Retail Returned Product');
  const invalid = settings();
  invalid.detail_account_ids = ['1150040077'];
  assert.throws(() => context.resolveAccountDetailTargets_(accounts(), invalid), /not a QBO subaccount/);
});

test('account hierarchy can be resolved from the P&L used for reconciliation', () => {
  const context = loadContext();
  const resolved = context.resolveAccountDetailTargetsFromPnl_(pnlControlPayload(), settings());
  assert.equal(resolved.parent.id, '175');
  assert.equal(resolved.parent.number, '40000');
  assert.equal(resolved.targets[0].parentId, '175');
  assert.equal(resolved.targets[0].number, '40005');
  assert.equal(resolved.targets[0].path, 'Retail Income:Retail Returned Product');
});

test('detail endpoint is called only for configured subaccount IDs', () => {
  const context = loadContext();
  const url = context.buildAccountDetailUrl_(
    clients()[0].id, '1150040007', '2026-01-01', '2026-10-28'
  );
  assert.match(url, /accounts\/1150040007\/detail/);
  assert.doesNotMatch(url, /accounts\/175\/detail/);
  assert.match(url, /start_date=2026-01-01/);
  assert.match(url, /end_date=2026-10-28/);
});

test('normalizer uses ColKey instead of fixed positions and preserves cell IDs', () => {
  const context = loadContext();
  const target = context.resolveAccountDetailTargets_(accounts(), settings()).targets[0];
  const range = {
    snapshotType: 'MONTHLY', snapshotDate: '2026-11-10',
    periodStart: '2026-10-01', periodEnd: '2026-10-31',
    dateFrom: '2026-10-01', dateTo: '2026-10-31'
  };
  const order = [
    'memo', 'subt_nat_amount', 'txn_type', 'rbal_nat_amount', 'doc_num',
    'tx_date', 'split_acc', 'name', 'dept_name'
  ];
  const client = Object.assign({}, clients()[0], { entityAlias: 'constellation' });
  const rows = context.normalizeAccountDetailReport_(
    detailPayload(order), client, target, range, '2026-10-28T16:00:00.000Z'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].TxnId, 'txn-1');
  assert.equal(rows[0].NameId, 'customer-1');
  assert.equal(rows[0].SplitAccountId, '84');
  assert.equal(rows[0].Amount, -25.5);
  assert.equal(rows[0].SubAccountNumber, '40005');
});

test('detail reconciliation accepts cents and rejects a material difference', () => {
  const context = loadContext();
  const target = { id: '1150040007', number: '40005' };
  assert.equal(context.reconcileAccountDetailRows_([{ Amount: -25.5 }], -25.5, target).status, 'passed');
  assert.throws(() => context.reconcileAccountDetailRows_([{ Amount: -25.5 }], -20, target),
    /does not reconcile/);
});

test('a configured account omitted from a zero-activity P&L period reconciles against zero', () => {
  const context = loadContext();
  const payload = pnlControlPayload();
  payload.data.Rows.Row[0].Rows.Row = payload.data.Rows.Row[0].Rows.Row.slice(1);
  const target = context.resolveAccountDetailTargets_(accounts(), settings()).targets[0];
  assert.equal(context.findAccountDetailPnlAmount_(payload, target), 0);
  assert.equal(context.reconcileAccountDetailRows_([], 0, target).status, 'passed');
  assert.throws(() => context.reconcileAccountDetailRows_([{ Amount: 1 }], 0, target),
    /does not reconcile/);
});

test('latest and monthly periods follow the approved cadence', () => {
  const context = loadContext();
  assert.deepEqual(JSON.parse(JSON.stringify(context.getAccountDetailLatestRange_(settings(), '2026-10-28'))), {
    snapshotType: 'LATEST', snapshotDate: '2026-10-28',
    periodStart: '2026-01-01', periodEnd: '2026-10-28',
    dateFrom: '2026-01-01', dateTo: '2026-10-28', periodKey: '2026-01-01|2026-10-28'
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.getAccountDetailPreviousMonthRange_(settings(), '2026-10-28'))), {
    snapshotType: 'MONTHLY', snapshotDate: '2026-10-10',
    periodStart: '2026-09-01', periodEnd: '2026-09-30',
    dateFrom: '2026-09-01', dateTo: '2026-09-30', periodKey: '2026-09-01|2026-09-30'
  });
});

test('backfill plans January through September and only missing account scopes', () => {
  const context = loadContext();
  const loaded = loadedConfiguration(context);
  const candidates = context.buildAccountDetailBackfillCandidates_(loaded, clients(), '2026-10-28');
  assert.equal(candidates.jobs.length, 18);
  const first = candidates.jobs[0];
  const existingKey = [first.clientId, first.accountId, first.range.periodStart, first.range.periodEnd].join('|');
  const plan = context.planAccountDetailBackfill_(loaded, clients(), '2026-10-28', { [existingKey]: 5 });
  assert.equal(plan.candidateScopeCount, 18);
  assert.equal(plan.existingScopeCount, 1);
  assert.equal(plan.missingScopeCount, 17);
});

test('weekly repair covers only closed months intersecting the 12-week window', () => {
  const context = loadContext();
  const plan = context.buildAccountDetailRollingPlan_(loadedConfiguration(context), clients(), '2026-10-28');
  assert.equal(plan.strategy, 'weekly_repair_closed_months_intersecting_window');
  assert.deepEqual(Array.from(plan.jobs, job => job.range.periodStart), ['2026-08-01', '2026-09-01']);
});

test('BigQuery replacement deletes only explicitly successful scopes', () => {
  const context = loadContext();
  const sql = context.buildAccountDetailAtomicReplaceSql_(
    'p.raw.detail', 'p.raw.stage', [{
      snapshotType: 'MONTHLY', snapshotDate: '2026-10-10',
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      clientId: 'constellation-id', accountId: '1150040007'
    }]
  );
  assert.match(sql, /^MERGE `p\.raw\.detail` AS T/);
  assert.match(sql, /T\.ClientId = 'constellation-id'/);
  assert.match(sql, /T\.SubAccountId = '1150040007'/);
  assert.match(sql, /WHEN NOT MATCHED BY SOURCE/);
  assert.match(sql, /THEN DELETE/);
  assert.doesNotMatch(sql, /1150040008/);

  const latestSql = context.buildAccountDetailAtomicReplaceSql_(
    'p.raw.detail', 'p.raw.stage', [{
      snapshotType: 'LATEST', snapshotDate: '2026-10-28',
      periodStart: '2026-01-01', periodEnd: '2026-10-28',
      clientId: 'constellation-id', accountId: '1150040007'
    }]
  );
  assert.match(latestSql, /T\.SnapshotType = 'LATEST'/);
  assert.doesNotMatch(latestSql, /T\.SnapshotDate/);
  assert.doesNotMatch(latestSql, /T\.PeriodEnd/);
});

test('views expose separate latest and monthly contracts', () => {
  const context = loadContext();
  const latest = context.buildAccountDetailViewSql_('latest_view', 'LATEST');
  const monthly = context.buildAccountDetailViewSql_('monthly_view', 'MONTHLY');
  assert.match(latest, /SnapshotType = 'LATEST'/);
  assert.match(monthly, /SnapshotType = 'MONTHLY'/);
  assert.match(latest, /SubAccountNumber/);
  assert.match(latest, /TxnType/);
  assert.match(latest, /DocNumber/);
});

test('schedule installs daily 5, monthly day 10 at 6, and Monday repair at 7', () => {
  const context = loadContext();
  const result = context.installAccountDetailCadenceTriggers();
  assert.equal(result.daily.hour, 5);
  assert.equal(result.monthly.day, 10);
  assert.equal(result.monthly.hour, 6);
  assert.equal(result.repair.weekDay, 'MONDAY');
  assert.equal(result.repair.hour, 7);
  assert.deepEqual(context.__triggers.map(trigger => trigger.schedule), [
    { handler: 'snapshotAccountDetailLatest', everyDays: 1, hour: 5 },
    { handler: 'snapshotAccountDetailMonthly', monthDay: 10, hour: 6 },
    { handler: 'startAccountDetailRollingReconciliation', weekDay: 'MONDAY', hour: 7 }
  ]);
});

