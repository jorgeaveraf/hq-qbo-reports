/***********************
 * QBO Profit and Loss - Menu
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QBO')
    .addItem('Update P&L Sheet Export', 'updateProfitAndLossSheetExport').addToUi();
}