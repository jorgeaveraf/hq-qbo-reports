/***********************
 * Menu
 ***********************/

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  const agingMenu = ui.createMenu('Update Aging Export')
    .addItem('All entities', 'updateAgingExport')
    .addSeparator()
    .addItem('botanical', 'updateAgingExportBotanical')
    .addItem('punch', 'updateAgingExportPunch')
    .addItem('nova_farms', 'updateAgingExportNovaFarms')
    .addItem('headset', 'updateAgingExportHeadset')
    .addItem('primetime', 'updateAgingExportPrimetime')
    .addItem('mfny', 'updateAgingExportMfny')
    .addItem('wessels', 'updateAgingExportWessels')
    .addItem('fresh', 'updateAgingExportFresh')
    .addItem('eaze', 'updateAgingExportEaze')
    .addSeparator()
    .addItem('Select multiple entities...', 'showAgingEntityPicker');

  ui
    .createMenu('QBO')
    .addSubMenu(agingMenu)
    .addItem('Snapshot Aging to BigQuery', 'snapshotAgingToBigQuery')
    .addToUi();
}

function updateAgingExportBotanical() { return updateAgingExport('botanical'); }
function updateAgingExportConstellation() { return updateAgingExport('constellation'); }
function updateAgingExportPunch() { return updateAgingExport('punch'); }
function updateAgingExportNovaFarms() { return updateAgingExport('nova_farms'); }
function updateAgingExportHeadset() { return updateAgingExport('headset'); }
function updateAgingExportPrimetime() { return updateAgingExport('primetime'); }
function updateAgingExportMfny() { return updateAgingExport('mfny'); }
function updateAgingExportWessels() { return updateAgingExport('wessels'); }
function updateAgingExportFresh() { return updateAgingExport('fresh'); }
function updateAgingExportEaze() { return updateAgingExport('eaze'); }
function updateAgingExportDemo() { return updateAgingExport('demo'); }

function showAgingEntityPicker() {
  const html = HtmlService.createHtmlOutputFromFile('AgingEntityPicker')
    .setWidth(420)
    .setHeight(510);
  SpreadsheetApp.getUi().showModalDialog(html, 'Update Aging Export');
}

function getAgingEntityPickerOptions() {
  return getAgingOutputSheetNames_(resolveAgingEntitySelection_())
    .filter(name => name !== 'constellation' && name !== 'demo');
}

function runSelectedAgingExport(entities) {
  if (!Array.isArray(entities)) throw new Error('Select one or more entities.');
  return updateAgingExport(entities);
}

function toggleCheckboxes() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const range = sheet.getRange('Q19:Q1000');
  const values = range.getValues();
  range.setValues(values.map(row => [!row[0]]));
}
