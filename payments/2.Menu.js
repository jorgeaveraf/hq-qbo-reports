/***********************
 * Spreadsheet Menu and Manual Refresh
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QBO')
    .addItem('Update Payments Sheet Export', 'updatePaymentSheetExport')
    .addToUi();
}

function updatePaymentSheetExport() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another Payments snapshot or deployment execution is already running.');
  }
  const spreadsheet = getPaymentReportSpreadsheet_();
  spreadsheet.toast('The Payments views and extracts are being refreshed.', 'QBO', 5);
  try {
    const result = refreshPaymentConnectedSheetsPipeline_(spreadsheet);
    spreadsheet.toast('The Payments views and extracts were refreshed successfully.', 'QBO', 5);
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    spreadsheet.toast('The Payments refresh failed. Review the Apps Script execution log.', 'QBO', 8);
    throw error;
  } finally {
    lock.releaseLock();
  }
}