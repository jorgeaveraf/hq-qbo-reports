/***********************
 * Menu
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('QBO')
    .addItem('Update Aging Export (AR+AP, multi-client)', 'updateAgingExport')
    .addItem('Snapshot Aging to BigQuery', 'snapshotAgingToBigQuery')
    .addToUi();
}

function toggleCheckboxes() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getRange('Q19:Q1000');
  const values = range.getValues();
  range.setValues(values.map(row => [!row[0]]));
}