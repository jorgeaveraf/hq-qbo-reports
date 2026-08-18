/***********************
 * Spreadsheet Menu and Manual Refresh
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QBO')
    .addItem('Update JE Sheet Export', 'updateJeSheetExport')
    .addToUi();
}

function updateJeSheetExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another Journal Entries snapshot or deployment execution is already running.');
  }

  const spreadsheet = getJournalReportSpreadsheet_();
  spreadsheet.toast('The Journal Entries views and extracts are being refreshed.', 'QBO', 5);

  try {
    const result = refreshJournalConnectedSheetsPipeline_(spreadsheet);
    spreadsheet.toast('The Journal Entries views and extracts were refreshed successfully.', 'QBO', 5);
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    spreadsheet.toast('The Journal Entries refresh failed. Review the Apps Script execution log.', 'QBO', 8);
    throw error;
  } finally {
    lock.releaseLock();
  }
}