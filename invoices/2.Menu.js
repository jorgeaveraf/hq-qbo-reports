/***********************
 * QBO Invoices - Spreadsheet Menu
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QBO')
    .addItem('Update Invoice Sheet Export', 'updateInvoiceSheetExport')
    .addToUi();
}

function updateInvoiceSheetExport() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('An active Invoice spreadsheet is required.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    spreadsheet.toast('Another Invoice snapshot or sheet refresh is already running.', 'QBO', 5);
    return { status: 'deferred_lock_busy' };
  }

  try {
    spreadsheet.toast('Refreshing Invoice views and extracts.', 'QBO', 5);
    const result = refreshInvoiceConnectedSheetsPipeline_(spreadsheet);
    spreadsheet.toast('Invoice Sheet Export updated successfully.', 'QBO', 5);
    return result;
  } catch (error) {
    spreadsheet.toast('Invoice Sheet Export refresh failed. Review the execution log.', 'QBO', 8);
    throw error;
  } finally {
    lock.releaseLock();
  }
}