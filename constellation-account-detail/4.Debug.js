/***********************
 * QBO P&L Account Detail - Read-only diagnostics
 ***********************/

function debugAccountDetailConfiguration() {
  const loaded = loadAccountDetailEntityConfiguration_();
  const selection = resolveAccountDetailEntitySelection_(loaded);
  const result = {
    source: loaded.source,
    configurationVersion: loaded.configuration.configuration_version,
    configurationHash: loaded.configuration.configuration_hash,
    clients: selection.clients.map(client => ({
      clientId: client.id,
      clientName: client.name,
      entity: client.entityAlias,
      settings: client.reportSettings
    }))
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAccountDetailPreflight() {
  const loaded = loadAccountDetailEntityConfiguration_();
  const selection = resolveAccountDetailEntitySelection_(loaded);
  const clients = selection.clients.map(client => {
    const range = getAccountDetailLatestRange_(client.reportSettings);
    const resolved = resolveAccountDetailTargetsFromPnl_(
      fetchAccountDetailPnlControl_(client.id, range.dateFrom, range.dateTo),
      client.reportSettings
    );
    return {
      clientId: client.id,
      clientName: client.name,
      parent: {
        id: accountDetailText_(resolved.parent.id),
        number: accountDetailText_(resolved.parent.number),
        name: accountDetailText_(resolved.parent.name)
      },
      targets: resolved.targets
    };
  });
  const result = {
    schema: validateAccountDetailBigQuerySchema_(),
    clients: clients,
    backfill: planAccountDetailBackfill_(loaded, fetchAccountDetailClients_()),
    repair: buildAccountDetailRollingPlan_(loaded, fetchAccountDetailClients_())
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function debugAccountDetailConnectedSheets() {
  const spreadsheet = getAccountDetailSpreadsheet_();
  const result = {
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    dataSourceSheets: spreadsheet.getDataSourceSheets().map(source => ({
      name: source.asSheet().getName(),
      state: String(source.getStatus().getExecutionState())
    })),
    extracts: spreadsheet.getDataSourceTables().map(table => ({
      name: table.getRange().getSheet().getName(),
      range: table.getRange().getA1Notation(),
      rowLimit: table.getRowLimit(),
      state: String(table.getStatus().getExecutionState())
    }))
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

