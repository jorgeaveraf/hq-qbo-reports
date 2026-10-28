/***********************
 * QBO P&L Account Detail - Functions
 ***********************/

function accountDetailText_(value) {
  return String(value === null || value === undefined ? '' : value).trim();
}

function accountDetailDate_(value) {
  const text = accountDetailText_(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(text + 'T00:00:00.000Z');
  return isNaN(parsed.getTime()) ? null : parsed;
}

function formatAccountDetailDate_(value) {
  const date = value instanceof Date ? value : accountDetailDate_(value);
  if (!date || isNaN(date.getTime())) return null;
  return Utilities.formatDate(date, 'Etc/UTC', 'yyyy-MM-dd');
}

function accountDetailToday_() {
  return Utilities.formatDate(new Date(), 'America/Mexico_City', 'yyyy-MM-dd');
}

function addAccountDetailDays_(value, days) {
  const date = accountDetailDate_(value);
  if (!date) throw new Error('Invalid date: ' + value);
  return formatAccountDetailDate_(new Date(date.getTime() + Number(days) * 86400000));
}

function accountDetailMonthStart_(value) {
  const date = accountDetailDate_(value);
  if (!date) throw new Error('Invalid date: ' + value);
  return formatAccountDetailDate_(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

function accountDetailMonthEnd_(value) {
  const date = accountDetailDate_(value);
  if (!date) throw new Error('Invalid date: ' + value);
  return formatAccountDetailDate_(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
}

function shiftAccountDetailMonths_(value, months) {
  const date = accountDetailDate_(value);
  if (!date) throw new Error('Invalid date: ' + value);
  return formatAccountDetailDate_(new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth() + Number(months), 1
  )));
}

function sha256AccountDetail_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function accountDetailPropertyBytes_(value) {
  return Utilities.newBlob(String(value)).getBytes().length;
}

/***********************
 * Entity configuration
 ***********************/

function normalizeAccountDetailSettings_(settings, entityIndex) {
  const value = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const detailIds = Array.from(new Set((value.detail_account_ids || []).map(accountDetailText_).filter(Boolean))).sort();
  if (!detailIds.length) {
    throw new Error('Missing report_settings.detail_account_ids at entity index ' + entityIndex + '.');
  }
  const historyStartDate = formatAccountDetailDate_(value.history_start_date);
  if (!historyStartDate) {
    throw new Error('Invalid report_settings.history_start_date at entity index ' + entityIndex + '.');
  }
  const latest = value.latest || {};
  const monthly = value.monthly || {};
  const repair = value.repair || {};
  const captureDay = Number(monthly.capture_day === undefined
    ? ACCOUNT_DETAIL_CADENCE.monthlyDay : monthly.capture_day);
  const monthsBehind = Number(monthly.months_behind === undefined ? 1 : monthly.months_behind);
  const windowWeeks = Number(repair.window_weeks === undefined ? 12 : repair.window_weeks);
  if (!Number.isInteger(captureDay) || captureDay < 1 || captureDay > 28) {
    throw new Error('monthly.capture_day must be an integer between 1 and 28.');
  }
  if (!Number.isInteger(monthsBehind) || monthsBehind !== 1) {
    throw new Error('monthly.months_behind must be 1 for the closed-month contract.');
  }
  if (!Number.isInteger(windowWeeks) || windowWeeks < 1 || windowWeeks > 52) {
    throw new Error('repair.window_weeks must be an integer between 1 and 52.');
  }
  const parentAccountId = accountDetailText_(value.parent_account_id) || null;
  return {
    detail_account_ids: detailIds,
    parent_account_id: parentAccountId,
    history_start_date: historyStartDate,
    latest: {
      enabled: latest.enabled !== false,
      cadence: 'DAILY',
      mode: 'YTD_REPLACE'
    },
    monthly: {
      enabled: monthly.enabled !== false,
      capture_day: captureDay,
      months_behind: monthsBehind
    },
    repair: {
      enabled: repair.enabled !== false,
      cadence: 'WEEKLY',
      window_weeks: windowWeeks
    }
  };
}

function canonicalAccountDetailEntity_(entity, index) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) {
    throw new Error('Invalid entity at index ' + index + '.');
  }
  const matchType = accountDetailText_(entity.match_type).toLowerCase();
  let matchValue = accountDetailText_(entity.match_value);
  const entityAlias = accountDetailText_(entity.entity_alias).toLowerCase();
  if (!['client_id', 'first_word'].includes(matchType)) {
    throw new Error('Unsupported match_type at entity index ' + index + ': ' + matchType);
  }
  if (matchType === 'first_word') matchValue = getAccountDetailFirstWord_(matchValue);
  if (!matchValue) throw new Error('Missing match_value at entity index ' + index + '.');
  if (!/^[a-z0-9_]+$/.test(entityAlias)) {
    throw new Error('Invalid entity_alias at entity index ' + index + ': ' + entityAlias);
  }
  return {
    match_type: matchType,
    match_value: matchValue,
    entity_alias: entityAlias,
    report_settings: normalizeAccountDetailSettings_(entity.report_settings, index)
  };
}

function calculateAccountDetailConfigurationHash_(schemaVersion, reportKey, entities) {
  return sha256AccountDetail_(JSON.stringify({
    schema_version: schemaVersion,
    report_key: reportKey,
    entities: entities
  }));
}

function validateAccountDetailEntityConfiguration_(configuration, expectedVersion) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new Error('Entity configuration must be a JSON object.');
  }
  const contractType = accountDetailText_(configuration.contract_type);
  const contractVersion = accountDetailText_(configuration.contract_version);
  const schemaVersion = accountDetailText_(configuration.schema_version);
  const reportKey = accountDetailText_(configuration.report_key);
  const configurationVersion = Number(configuration.configuration_version);
  const configurationHash = accountDetailText_(configuration.configuration_hash).toLowerCase();
  const publishedAt = accountDetailText_(configuration.published_at);
  if (contractType !== ACCOUNT_DETAIL_ENTITY_CONTROL.contractType) {
    throw new Error('Unexpected contract_type: ' + contractType);
  }
  if (contractVersion !== ACCOUNT_DETAIL_ENTITY_CONTROL.contractVersion) {
    throw new Error('Unexpected contract_version: ' + contractVersion);
  }
  if (schemaVersion !== ACCOUNT_DETAIL_ENTITY_CONTROL.schemaVersion) {
    throw new Error('Unexpected schema_version: ' + schemaVersion);
  }
  if (reportKey !== ACCOUNT_DETAIL_CONFIG.reportKey) {
    throw new Error('Unexpected report_key: ' + reportKey);
  }
  if (!Number.isInteger(configurationVersion) || configurationVersion < 1) {
    throw new Error('Invalid configuration_version: ' + configuration.configuration_version);
  }
  if (expectedVersion !== undefined && configurationVersion !== Number(expectedVersion)) {
    throw new Error('Configuration version mismatch.');
  }
  if (!publishedAt || isNaN(new Date(publishedAt).getTime())) {
    throw new Error('Invalid published_at: ' + publishedAt);
  }
  if (!Array.isArray(configuration.entities) || !configuration.entities.length) {
    throw new Error('Configuration must authorize at least one entity.');
  }
  const seen = {};
  const entities = configuration.entities.map(canonicalAccountDetailEntity_).sort((left, right) =>
    left.match_type.localeCompare(right.match_type) || left.match_value.localeCompare(right.match_value)
  );
  entities.forEach(entity => {
    const key = entity.match_type + '|' + entity.match_value;
    if (seen[key]) throw new Error('Duplicate entity authorization: ' + key);
    seen[key] = true;
  });
  const calculatedHash = calculateAccountDetailConfigurationHash_(schemaVersion, reportKey, entities);
  if (configurationHash !== calculatedHash) {
    throw new Error('Configuration hash mismatch. Expected=' + configurationHash + ', calculated=' + calculatedHash);
  }
  return {
    contract_type: contractType,
    contract_version: contractVersion,
    schema_version: schemaVersion,
    report_key: reportKey,
    configuration_version: configurationVersion,
    configuration_hash: configurationHash,
    published_at: new Date(publishedAt).toISOString(),
    entities: entities
  };
}

function readLocalAccountDetailConfiguration_() {
  const serialized = PropertiesService.getScriptProperties().getProperty(
    ACCOUNT_DETAIL_ENTITY_CONTROL.localPropertyKey
  );
  if (!serialized) return null;
  return validateAccountDetailEntityConfiguration_(JSON.parse(serialized));
}

function persistAccountDetailConfiguration_(configuration) {
  const validated = validateAccountDetailEntityConfiguration_(configuration);
  const serialized = JSON.stringify(validated);
  const bytes = accountDetailPropertyBytes_(serialized);
  if (bytes > ACCOUNT_DETAIL_ENTITY_CONTROL.maxPropertyBytes) {
    throw new Error('Entity configuration exceeds safe Script Properties size. bytes=' + bytes);
  }
  PropertiesService.getScriptProperties().setProperty(
    ACCOUNT_DETAIL_ENTITY_CONTROL.localPropertyKey, serialized
  );
  CacheService.getScriptCache().put(
    ACCOUNT_DETAIL_ENTITY_CONTROL.cacheKey,
    serialized,
    ACCOUNT_DETAIL_ENTITY_CONTROL.cacheTtlSeconds
  );
  return { byteCount: bytes, configuration: validated };
}

function loadAccountDetailEntityConfiguration_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ACCOUNT_DETAIL_ENTITY_CONTROL.cacheKey);
  if (cached) {
    try {
      return { source: 'script_cache', configuration: validateAccountDetailEntityConfiguration_(JSON.parse(cached)) };
    } catch (error) {
      cache.remove(ACCOUNT_DETAIL_ENTITY_CONTROL.cacheKey);
    }
  }
  const local = readLocalAccountDetailConfiguration_();
  if (!local) {
    throw new Error('No local entity configuration is available. Publish and refresh ' +
      ACCOUNT_DETAIL_CONFIG.reportKey + ' from QBO Report Control.');
  }
  cache.put(ACCOUNT_DETAIL_ENTITY_CONTROL.cacheKey, JSON.stringify(local),
    ACCOUNT_DETAIL_ENTITY_CONTROL.cacheTtlSeconds);
  return { source: 'script_properties', configuration: local };
}

function getAccountDetailControlSpreadsheet_() {
  const id = accountDetailText_(PropertiesService.getScriptProperties().getProperty(
    ACCOUNT_DETAIL_ENTITY_CONTROL.spreadsheetIdProperty
  ));
  if (!id) throw new Error('Missing Script Property: ' + ACCOUNT_DETAIL_ENTITY_CONTROL.spreadsheetIdProperty);
  return SpreadsheetApp.openById(id);
}

function readPublishedAccountDetailConfiguration_() {
  const spreadsheet = getAccountDetailControlSpreadsheet_();
  const metadataSheet = spreadsheet.getSheetByName(ACCOUNT_DETAIL_ENTITY_CONTROL.metadataSheetName);
  const publishedSheet = spreadsheet.getSheetByName(ACCOUNT_DETAIL_ENTITY_CONTROL.publishedSheetName);
  if (!metadataSheet || !publishedSheet) throw new Error('QBO Report Control sheets are incomplete.');
  const metadata = {};
  const metadataRows = metadataSheet.getRange(2, 1, Math.max(0, metadataSheet.getLastRow() - 1), 2)
    .getDisplayValues();
  metadataRows.forEach(row => {
    const key = accountDetailText_(row[0]);
    if (key) metadata[key] = accountDetailText_(row[1]);
  });
  const version = Number(metadata.current_version || 0);
  if (!Number.isInteger(version) || version < 1 || !accountDetailText_(metadata.status).startsWith('published')) {
    throw new Error('QBO Report Control does not have a valid published version.');
  }
  const rows = publishedSheet.getRange(2, 1, Math.max(0, publishedSheet.getLastRow() - 1), 7)
    .getDisplayValues().filter(row => accountDetailText_(row[0]) === ACCOUNT_DETAIL_CONFIG.reportKey);
  if (rows.length !== 1) {
    throw new Error('Expected one published row for ' + ACCOUNT_DETAIL_CONFIG.reportKey + ', found=' + rows.length);
  }
  const row = rows[0];
  if (Number(row[2]) !== version) throw new Error('Published configuration version mismatch.');
  const configuration = validateAccountDetailEntityConfiguration_(JSON.parse(row[6]), version);
  if (configuration.configuration_hash !== accountDetailText_(row[3])) {
    throw new Error('Published row hash does not match Configuration JSON.');
  }
  return configuration;
}

function refreshAccountDetailEntityConfigurationFromCentral() {
  const configuration = readPublishedAccountDetailConfiguration_();
  const result = persistAccountDetailConfiguration_(configuration);
  Logger.log(JSON.stringify({
    event: 'account_detail_configuration_refreshed',
    version: configuration.configuration_version,
    hash: configuration.configuration_hash,
    entityCount: configuration.entities.length,
    byteCount: result.byteCount
  }));
  return result;
}

/***********************
 * HTTP and entity/account selection
 ***********************/

function getAccountDetailApiKey_() {
  const value = accountDetailText_(PropertiesService.getScriptProperties().getProperty(
    ACCOUNT_DETAIL_CONFIG.apiKeyProperty
  ));
  if (!value) throw new Error('Missing Script Property: ' + ACCOUNT_DETAIL_CONFIG.apiKeyProperty);
  return value;
}

function fetchAccountDetailJson_(url, label) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'X-API-Key': getAccountDetailApiKey_() },
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  if (status < 200 || status >= 300) {
    throw new Error(label + ' returned HTTP ' + status + ': ' + body.slice(0, 500));
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(label + ' returned invalid JSON: ' + error.message);
  }
}

function extractAccountDetailArray_(payload, keys) {
  if (Array.isArray(payload)) return payload;
  const candidates = [payload];
  if (payload && payload.data) candidates.push(payload.data);
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (!candidate || typeof candidate !== 'object') continue;
    for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      if (Array.isArray(candidate[keys[keyIndex]])) return candidate[keys[keyIndex]];
    }
  }
  return [];
}

function getAccountDetailFirstWord_(value) {
  return accountDetailText_(value).toLowerCase().split(/[\s_-]+/).filter(Boolean)[0] || '';
}

function fetchAccountDetailClients_() {
  const payload = fetchAccountDetailJson_(ACCOUNT_DETAIL_CONFIG.baseUrl + '/clients', '/clients');
  const clients = extractAccountDetailArray_(payload, ['clients', 'items']);
  return clients.map(client => ({
    id: accountDetailText_(client.id || client.clientId || client.client_id),
    name: accountDetailText_(client.name || client.clientName || client.displayName || client.companyName),
    realmId: accountDetailText_(client.realm_id || client.realmId),
    firstWord: getAccountDetailFirstWord_(client.name || client.clientName || client.displayName || client.companyName)
  })).filter(client => client.id && client.name);
}

function resolveAccountDetailEntitySelection_(loadedOverride, sourceClientsOverride) {
  const loaded = loadedOverride || loadAccountDetailEntityConfiguration_();
  const clients = sourceClientsOverride || fetchAccountDetailClients_();
  const selected = [];
  loaded.configuration.entities.forEach(entity => {
    const matches = clients.filter(client => entity.match_type === 'client_id'
      ? client.id === entity.match_value
      : client.firstWord === entity.match_value);
    if (matches.length !== 1) {
      throw new Error('Entity authorization must resolve exactly one client. match=' +
        entity.match_type + '|' + entity.match_value + ', found=' + matches.length);
    }
    selected.push(Object.assign({}, matches[0], {
      entityAlias: entity.entity_alias,
      reportSettings: entity.report_settings
    }));
  });
  return {
    clients: selected,
    configurationHash: loaded.configuration.configuration_hash,
    configurationVersion: loaded.configuration.configuration_version,
    source: loaded.source || 'provided_configuration'
  };
}

function buildAccountDetailAccountsUrl_(clientId) {
  return ACCOUNT_DETAIL_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(accountDetailText_(clientId)) +
    '/accounts?environment=' + encodeURIComponent(ACCOUNT_DETAIL_CONFIG.environment);
}

function fetchAccountDetailAccounts_(clientId) {
  const payload = fetchAccountDetailJson_(buildAccountDetailAccountsUrl_(clientId), '/accounts');
  return extractAccountDetailArray_(payload, ['accounts', 'items']);
}

function resolveAccountDetailTargets_(accounts, settings) {
  const byId = {};
  (accounts || []).forEach(account => {
    const id = accountDetailText_(account.Id || account.id);
    if (id) byId[id] = account;
  });
  const targets = settings.detail_account_ids.map(id => {
    const account = byId[id];
    if (!account) throw new Error('Configured detail account was not returned by /accounts: ' + id);
    if (account.SubAccount !== true) {
      throw new Error('Configured detail account is not a QBO subaccount: ' + id);
    }
    const parentId = accountDetailText_(account.ParentRef && account.ParentRef.value);
    if (!parentId || !byId[parentId]) {
      throw new Error('Unable to resolve parent for configured detail account: ' + id);
    }
    if (settings.parent_account_id && settings.parent_account_id !== parentId) {
      throw new Error('Configured parent_account_id does not match QBO ParentRef for account ' + id + '.');
    }
    const parent = byId[parentId];
    return {
      parentId: parentId,
      parentNumber: accountDetailText_(parent.AcctNum),
      parentName: accountDetailText_(parent.Name),
      id: id,
      number: accountDetailText_(account.AcctNum),
      name: accountDetailText_(account.Name),
      path: accountDetailText_(account.FullyQualifiedName) ||
        [accountDetailText_(parent.Name), accountDetailText_(account.Name)].filter(Boolean).join(':')
    };
  });
  const parentIds = Array.from(new Set(targets.map(target => target.parentId)));
  if (parentIds.length !== 1) {
    throw new Error('Configured detail accounts must share one QBO parent. parents=' + parentIds.join(','));
  }
  return { parent: byId[parentIds[0]], targets: targets };
}

function buildAccountDetailUrl_(clientId, accountId, dateFrom, dateTo) {
  if (!accountDetailText_(clientId) || !accountDetailText_(accountId)) {
    throw new Error('Client ID and account ID are required for account detail.');
  }
  if (!accountDetailDate_(dateFrom) || !accountDetailDate_(dateTo) ||
      accountDetailDate_(dateFrom).getTime() > accountDetailDate_(dateTo).getTime()) {
    throw new Error('Invalid account detail range: ' + dateFrom + '|' + dateTo);
  }
  return ACCOUNT_DETAIL_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(accountDetailText_(clientId)) +
    '/reports/profit-and-loss/accounts/' + encodeURIComponent(accountDetailText_(accountId)) + '/detail?' + [
      'environment=' + encodeURIComponent(ACCOUNT_DETAIL_CONFIG.environment),
      'start_date=' + encodeURIComponent(dateFrom),
      'end_date=' + encodeURIComponent(dateTo),
      'accounting_method=' + encodeURIComponent(ACCOUNT_DETAIL_CONFIG.accountingMethod)
    ].join('&');
}

function fetchAccountDetailReport_(clientId, accountId, dateFrom, dateTo) {
  return fetchAccountDetailJson_(
    buildAccountDetailUrl_(clientId, accountId, dateFrom, dateTo),
    '/profit-and-loss/accounts/' + accountId + '/detail'
  );
}

function buildAccountDetailPnlControlUrl_(clientId, dateFrom, dateTo) {
  return ACCOUNT_DETAIL_CONFIG.baseUrl + '/qbo/' + encodeURIComponent(accountDetailText_(clientId)) +
    '/reports/profit-and-loss?' + [
      'environment=' + encodeURIComponent(ACCOUNT_DETAIL_CONFIG.environment),
      'start_date=' + encodeURIComponent(dateFrom),
      'end_date=' + encodeURIComponent(dateTo),
      'accounting_method=' + encodeURIComponent(ACCOUNT_DETAIL_CONFIG.accountingMethod)
    ].join('&');
}

function fetchAccountDetailPnlControl_(clientId, dateFrom, dateTo) {
  return fetchAccountDetailJson_(
    buildAccountDetailPnlControlUrl_(clientId, dateFrom, dateTo),
    '/reports/profit-and-loss control'
  );
}

function parseAccountDetailAccountLabel_(value) {
  const label = accountDetailText_(value);
  const match = label.match(/^(\S+)\s+(.+)$/);
  return {
    number: match ? accountDetailText_(match[1]) : '',
    name: match ? accountDetailText_(match[2]) : label
  };
}

function collectAccountDetailPnlHierarchy_(payload) {
  const data = payload && payload.data;
  if (!data || !data.Rows) throw new Error('P&L control payload is missing report rows.');
  const byId = {};
  function walk(node, ancestors) {
    if (!node || typeof node !== 'object') return;
    const headerCells = node.Header && Array.isArray(node.Header.ColData)
      ? node.Header.ColData : [];
    const rowCells = Array.isArray(node.ColData) ? node.ColData : [];
    const accountCell = headerCells.concat(rowCells).find(cell =>
      accountDetailText_(cell && cell.id) && accountDetailText_(cell && cell.value)
    );
    let nextAncestors = ancestors;
    if (accountCell) {
      const id = accountDetailText_(accountCell.id);
      const parsed = parseAccountDetailAccountLabel_(accountCell.value);
      const parent = ancestors.length ? ancestors[ancestors.length - 1] : null;
      byId[id] = {
        id: id,
        number: parsed.number,
        name: parsed.name,
        label: accountDetailText_(accountCell.value),
        parentId: parent ? parent.id : null
      };
      nextAncestors = ancestors.concat([byId[id]]);
    }
    const children = node.Rows && Array.isArray(node.Rows.Row) ? node.Rows.Row : [];
    children.forEach(child => walk(child, nextAncestors));
    if (Array.isArray(node.Row)) node.Row.forEach(child => walk(child, nextAncestors));
  }
  walk(data.Rows, []);
  return byId;
}

function resolveAccountDetailTargetsFromPnl_(payload, settings) {
  const byId = collectAccountDetailPnlHierarchy_(payload);
  const targets = settings.detail_account_ids.map(id => {
    const account = byId[id];
    if (!account) throw new Error('Configured detail account was not returned by P&L: ' + id);
    const parentId = account.parentId;
    const parent = parentId && byId[parentId];
    if (!parent) throw new Error('Unable to resolve P&L parent for configured detail account: ' + id);
    if (settings.parent_account_id && settings.parent_account_id !== parentId) {
      throw new Error('Configured parent_account_id does not match the P&L hierarchy for account ' + id + '.');
    }
    return {
      parentId: parentId,
      parentNumber: parent.number,
      parentName: parent.name,
      id: id,
      number: account.number,
      name: account.name,
      path: [parent.name, account.name].filter(Boolean).join(':')
    };
  });
  const parentIds = Array.from(new Set(targets.map(target => target.parentId)));
  if (parentIds.length !== 1) {
    throw new Error('Configured detail accounts must share one P&L parent. parents=' + parentIds.join(','));
  }
  return { parent: byId[parentIds[0]], targets: targets };
}

/***********************
 * QBO response normalization and reconciliation
 ***********************/

function getAccountDetailColumnKey_(column) {
  const metadata = column && Array.isArray(column.MetaData) ? column.MetaData : [];
  const item = metadata.filter(entry => accountDetailText_(entry.Name).toLowerCase() === 'colkey')[0];
  return item ? accountDetailText_(item.Value) : '';
}

function buildAccountDetailColumnMap_(reportData) {
  const columns = reportData && reportData.Columns && Array.isArray(reportData.Columns.Column)
    ? reportData.Columns.Column : [];
  const map = {};
  columns.forEach((column, index) => {
    const key = getAccountDetailColumnKey_(column);
    if (key) map[key] = { index: index, type: accountDetailText_(column.ColType), title: accountDetailText_(column.ColTitle) };
  });
  ACCOUNT_DETAIL_CONFIG.requiredColumnKeys.forEach(key => {
    if (!map[key]) throw new Error('Account detail response is missing required ColKey: ' + key);
  });
  return map;
}

function collectAccountDetailDataRows_(node, rows) {
  if (!node || typeof node !== 'object') return rows;
  if (String(node.type || '').toLowerCase() === 'data' && Array.isArray(node.ColData)) {
    rows.push(node.ColData);
  }
  const children = node.Rows && Array.isArray(node.Rows.Row) ? node.Rows.Row : [];
  children.forEach(child => collectAccountDetailDataRows_(child, rows));
  if (Array.isArray(node.Row)) node.Row.forEach(child => collectAccountDetailDataRows_(child, rows));
  return rows;
}

function accountDetailCell_(cells, definition) {
  const cell = definition && cells[definition.index] || {};
  return {
    value: accountDetailText_(cell.value),
    id: accountDetailText_(cell.id)
  };
}

function parseAccountDetailNumber_(value, required) {
  const text = accountDetailText_(value).replace(/,/g, '');
  if (!text && !required) return null;
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error('Invalid numeric value in account detail: ' + value);
  return number;
}

function validateAccountDetailEnvelope_(payload, clientId, dateFrom, dateTo) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.data) {
    throw new Error('Invalid account detail payload for client ' + clientId + '.');
  }
  const responseClientId = accountDetailText_(payload.client_id);
  if (responseClientId && responseClientId !== clientId) {
    throw new Error('Account detail client mismatch. requested=' + clientId + ', received=' + responseClientId);
  }
  const header = payload.data.Header || {};
  if (accountDetailText_(header.ReportName) !== ACCOUNT_DETAIL_CONFIG.reportName) {
    throw new Error('Unexpected account detail report name: ' + header.ReportName);
  }
  if (formatAccountDetailDate_(header.StartPeriod) !== dateFrom ||
      formatAccountDetailDate_(header.EndPeriod) !== dateTo) {
    throw new Error('Account detail response period mismatch.');
  }
  if (accountDetailText_(header.ReportBasis).toLowerCase() !==
      ACCOUNT_DETAIL_CONFIG.accountingMethod.toLowerCase()) {
    throw new Error('Unexpected account detail accounting method: ' + header.ReportBasis);
  }
  return payload.data;
}

function normalizeAccountDetailReport_(payload, client, target, range, loadedAt) {
  const reportData = validateAccountDetailEnvelope_(payload, client.id, range.dateFrom, range.dateTo);
  const columnMap = buildAccountDetailColumnMap_(reportData);
  const dataRows = collectAccountDetailDataRows_(reportData.Rows || {}, []);
  const header = reportData.Header || {};
  return dataRows.map((cells, index) => {
    const txnDate = accountDetailCell_(cells, columnMap.tx_date);
    const txnType = accountDetailCell_(cells, columnMap.txn_type);
    const docNumber = accountDetailCell_(cells, columnMap.doc_num);
    const name = accountDetailCell_(cells, columnMap.name);
    const location = accountDetailCell_(cells, columnMap.dept_name);
    const memo = accountDetailCell_(cells, columnMap.memo);
    const split = accountDetailCell_(cells, columnMap.split_acc);
    const amount = parseAccountDetailNumber_(accountDetailCell_(cells, columnMap.subt_nat_amount).value, true);
    const runningBalance = parseAccountDetailNumber_(
      accountDetailCell_(cells, columnMap.rbal_nat_amount).value, false
    );
    const sourceRowOrder = index + 1;
    const keyParts = [
      range.snapshotType, range.periodStart, range.periodEnd, client.id, target.id,
      txnType.id, txnDate.value, txnType.value, docNumber.value,
      amount.toFixed(9), sourceRowOrder
    ];
    return {
      idempotency_key: sha256AccountDetail_(keyParts.join('|')),
      SnapshotType: range.snapshotType,
      SnapshotDate: range.snapshotDate,
      PeriodStart: range.periodStart,
      PeriodEnd: range.periodEnd,
      Entity: client.entityAlias,
      ClientId: client.id,
      ClientName: client.name,
      RealmId: accountDetailText_(payload.realm_id || client.realmId) || null,
      Environment: accountDetailText_(payload.environment) || ACCOUNT_DETAIL_CONFIG.environment,
      ParentAccountId: target.parentId,
      ParentAccountNumber: target.parentNumber || null,
      ParentAccountName: target.parentName,
      SubAccountId: target.id,
      SubAccountNumber: target.number || null,
      SubAccountName: target.name,
      AccountPath: target.path,
      TxnDate: formatAccountDetailDate_(txnDate.value),
      TxnType: txnType.value || null,
      TxnId: txnType.id || null,
      DocNumber: docNumber.value || null,
      NameId: name.id || null,
      Name: name.value || null,
      LocationId: location.id || null,
      Location: location.value || null,
      Memo: memo.value || null,
      SplitAccountId: split.id || null,
      SplitAccountName: split.value || null,
      Amount: amount,
      RunningBalance: runningBalance,
      SourceRowOrder: sourceRowOrder,
      AccountingMethod: accountDetailText_(header.ReportBasis) || ACCOUNT_DETAIL_CONFIG.accountingMethod,
      Currency: accountDetailText_(header.Currency) || null,
      FetchedAt: accountDetailText_(payload.fetched_at) || null,
      LoadedAt: loadedAt,
      Source: ACCOUNT_DETAIL_CONFIG.source
    };
  });
}

function findAccountDetailPnlAmount_(payload, target) {
  const data = payload && payload.data;
  if (!data) throw new Error('P&L control payload is missing data.');
  const columns = data.Columns && Array.isArray(data.Columns.Column) ? data.Columns.Column : [];
  const accountIndex = columns.findIndex(column => {
    const key = getAccountDetailColumnKey_(column).toLowerCase();
    return key === 'account' || accountDetailText_(column.ColType).toLowerCase() === 'account';
  });
  const moneyIndexes = columns.map((column, index) => ({ column, index }))
    .filter(item => accountDetailText_(item.column.ColType).toLowerCase() === 'money')
    .map(item => item.index);
  if (accountIndex < 0 || !moneyIndexes.length) {
    throw new Error('P&L control response lacks Account or Money columns.');
  }
  const candidates = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    ['ColData'].forEach(key => {
      if (!Array.isArray(node[key])) return;
      const cell = node[key][accountIndex] || {};
      const value = accountDetailText_(cell.value);
      const id = accountDetailText_(cell.id);
      const matches = id === target.id || value === target.name ||
        value === [target.number, target.name].filter(Boolean).join(' ') ||
        value.indexOf(target.number + ' ') === 0;
      if (matches) {
        const amountCell = node[key][moneyIndexes[moneyIndexes.length - 1]] || {};
        candidates.push(parseAccountDetailNumber_(amountCell.value, true));
      }
    });
    if (node.Rows && Array.isArray(node.Rows.Row)) node.Rows.Row.forEach(walk);
    if (Array.isArray(node.Row)) node.Row.forEach(walk);
  }
  walk(data.Rows || {});
  if (!candidates.length) return 0;
  if (candidates.length !== 1) {
    throw new Error('Expected one P&L control amount for account ' + target.id + ', found=' + candidates.length);
  }
  return candidates[0];
}

function reconcileAccountDetailRows_(rows, expectedAmount, target) {
  const actualAmount = (rows || []).reduce((sum, row) => sum + Number(row.Amount || 0), 0);
  const difference = Math.round((actualAmount - Number(expectedAmount || 0)) * 100) / 100;
  const result = {
    accountId: target.id,
    accountNumber: target.number,
    rowCount: rows.length,
    detailAmount: Math.round(actualAmount * 100) / 100,
    pnlAmount: Math.round(Number(expectedAmount || 0) * 100) / 100,
    difference: difference,
    status: Math.abs(difference) <= 0.01 ? 'passed' : 'failed'
  };
  if (result.status !== 'passed') {
    throw new Error('Account detail does not reconcile to P&L: ' + JSON.stringify(result));
  }
  return result;
}

/***********************
 * Periods and execution
 ***********************/

function getAccountDetailLatestRange_(settings, referenceIsoDate) {
  const today = formatAccountDetailDate_(referenceIsoDate || accountDetailToday_());
  if (!today) throw new Error('Invalid latest reference date: ' + referenceIsoDate);
  return {
    snapshotType: ACCOUNT_DETAIL_SNAPSHOT_LATEST,
    snapshotDate: today,
    periodStart: settings.history_start_date,
    periodEnd: today,
    dateFrom: settings.history_start_date,
    dateTo: today,
    periodKey: settings.history_start_date + '|' + today
  };
}

function getAccountDetailPreviousMonthRange_(settings, referenceIsoDate) {
  const reference = formatAccountDetailDate_(referenceIsoDate || accountDetailToday_());
  if (!reference) throw new Error('Invalid monthly reference date: ' + referenceIsoDate);
  const currentMonth = accountDetailMonthStart_(reference);
  const periodStart = shiftAccountDetailMonths_(currentMonth, -settings.monthly.months_behind);
  const periodEnd = accountDetailMonthEnd_(periodStart);
  const captureMonth = shiftAccountDetailMonths_(periodStart, 1);
  const captureDate = captureMonth.slice(0, 8) + String(settings.monthly.capture_day).padStart(2, '0');
  return {
    snapshotType: ACCOUNT_DETAIL_SNAPSHOT_MONTHLY,
    snapshotDate: captureDate,
    periodStart: periodStart,
    periodEnd: periodEnd,
    dateFrom: periodStart,
    dateTo: periodEnd,
    periodKey: periodStart + '|' + periodEnd
  };
}

function buildAccountDetailMonthRange_(settings, monthStart) {
  const start = accountDetailMonthStart_(monthStart);
  const end = accountDetailMonthEnd_(start);
  const captureMonth = shiftAccountDetailMonths_(start, 1);
  return {
    snapshotType: ACCOUNT_DETAIL_SNAPSHOT_MONTHLY,
    snapshotDate: captureMonth.slice(0, 8) + String(settings.monthly.capture_day).padStart(2, '0'),
    periodStart: start,
    periodEnd: end,
    dateFrom: start,
    dateTo: end,
    periodKey: start + '|' + end
  };
}

function executeAccountDetailSnapshot_(options) {
  const settings = options || {};
  const loaded = settings.loadedConfiguration || loadAccountDetailEntityConfiguration_();
  const selection = resolveAccountDetailEntitySelection_(loaded, settings.sourceClients);
  const requestedClientIds = Array.from(new Set((settings.clientIds || []).map(accountDetailText_).filter(Boolean)));
  const requestedAccountIds = Array.from(new Set((settings.accountIds || []).map(accountDetailText_).filter(Boolean)));
  const clients = requestedClientIds.length
    ? selection.clients.filter(client => requestedClientIds.includes(client.id))
    : selection.clients;
  if (!clients.length) throw new Error('No authorized clients were selected for account detail.');
  validateAccountDetailBigQuerySchema_();
  const loadedAt = new Date().toISOString();
  const allRows = [];
  const successfulScopes = [];
  const clientResults = [];
  const failures = [];
  clients.forEach(client => {
    const range = settings.range || getAccountDetailLatestRange_(client.reportSettings);
    let targets;
    let pnlControl;
    try {
      const accounts = fetchAccountDetailAccounts_(client.id);
      targets = resolveAccountDetailTargets_(accounts, client.reportSettings).targets;
      pnlControl = fetchAccountDetailPnlControl_(client.id, range.dateFrom, range.dateTo);
      if (requestedAccountIds.length) {
        targets = targets.filter(target => requestedAccountIds.includes(target.id));
      }
      if (!targets.length) throw new Error('No configured account matched the requested account scope.');
    } catch (error) {
      failures.push({ clientId: client.id, stage: 'client_preflight', error: String(error.message || error) });
      return;
    }
    const accountResults = [];
    targets.forEach(target => {
      try {
        const payload = fetchAccountDetailReport_(client.id, target.id, range.dateFrom, range.dateTo);
        const rows = normalizeAccountDetailReport_(payload, client, target, range, loadedAt);
        const expectedAmount = findAccountDetailPnlAmount_(pnlControl, target);
        const reconciliation = reconcileAccountDetailRows_(rows, expectedAmount, target);
        allRows.push.apply(allRows, rows);
        successfulScopes.push({
          snapshotType: range.snapshotType,
          snapshotDate: range.snapshotDate,
          periodStart: range.periodStart,
          periodEnd: range.periodEnd,
          clientId: client.id,
          accountId: target.id
        });
        accountResults.push({ accountId: target.id, rowCount: rows.length, reconciliation: reconciliation });
      } catch (error) {
        failures.push({
          clientId: client.id,
          accountId: target.id,
          stage: 'account_capture',
          error: String(error.message || error)
        });
      }
    });
    clientResults.push({ clientId: client.id, entity: client.entityAlias, accounts: accountResults });
  });
  if (!successfulScopes.length) {
    throw new Error('No account detail scope completed successfully: ' + JSON.stringify(failures));
  }
  const replacement = replaceAccountDetailScopes_(allRows, successfulScopes);
  const verification = verifyAccountDetailScopes_(allRows, successfulScopes);
  if (verification.status !== 'passed') {
    throw new Error('Account detail BigQuery verification failed: ' + JSON.stringify(verification));
  }
  const operationId = Utilities.getUuid();
  const runEvidence = recordAccountDetailRunScopes_(
    operationId, successfulScopes, allRows, selection.configurationHash
  );
  const result = {
    event: 'account_detail_snapshot_completed',
    configurationHash: selection.configurationHash,
    configurationVersion: selection.configurationVersion,
    rowCount: allRows.length,
    scopeCount: successfulScopes.length,
    successfulScopes: successfulScopes,
    clientResults: clientResults,
    failures: failures,
    replacement: replacement,
    verification: verification,
    runEvidence: runEvidence
  };
  Logger.log(JSON.stringify(result));
  if (failures.length && settings.returnPartialResult !== true) {
    throw new Error('Account detail updated successful scopes but some scopes failed: ' + JSON.stringify(failures));
  }
  return result;
}

function snapshotAccountDetailLatest(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another account detail operation is running.');
  try {
    const loaded = loadAccountDetailEntityConfiguration_();
    const reference = event && event.referenceIsoDate;
    const selection = resolveAccountDetailEntitySelection_(loaded);
    const results = [];
    selection.clients.forEach(client => {
      if (!client.reportSettings.latest.enabled) return;
      results.push(executeAccountDetailSnapshot_({
        loadedConfiguration: loaded,
        sourceClients: [client],
        clientIds: [client.id],
        range: getAccountDetailLatestRange_(client.reportSettings, reference),
        returnPartialResult: false
      }));
    });
    refreshAccountDetailConnectedSheets_();
    return { status: 'completed', mode: 'latest', results: results };
  } finally {
    lock.releaseLock();
  }
}

function snapshotAccountDetailMonthly(event) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('Another account detail operation is running.');
  try {
    const loaded = loadAccountDetailEntityConfiguration_();
    const reference = event && event.referenceIsoDate;
    const selection = resolveAccountDetailEntitySelection_(loaded);
    const results = [];
    selection.clients.forEach(client => {
      if (!client.reportSettings.monthly.enabled) return;
      results.push(executeAccountDetailSnapshot_({
        loadedConfiguration: loaded,
        sourceClients: [client],
        clientIds: [client.id],
        range: getAccountDetailPreviousMonthRange_(client.reportSettings, reference),
        returnPartialResult: false
      }));
    });
    refreshAccountDetailConnectedSheets_();
    return { status: 'completed', mode: 'monthly', results: results };
  } finally {
    lock.releaseLock();
  }
}

