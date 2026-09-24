/***********************
 * QBO Balance Sheet - Spreadsheet Menu
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QBO')
    .addItem('Update Balance Sheet Export', 'updateBalanceSheetExport')
    .addItem('Push Balance Sheet to BigQuery', 'snapshotBalanceSheetToBigQuery')
    .addToUi();
}