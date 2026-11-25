/***********************
 * QBO P&L Account Detail - Menu
 ***********************/

function onOpen() {
  SpreadsheetApp.getUi().createMenu('QBO')
    .addItem('Refresh entity configuration', 'refreshAccountDetailEntityConfigurationFromCentral')
    .addSeparator()
    .addItem('Refresh latest report', 'snapshotAccountDetailLatest')
    .addItem('Capture previous month', 'snapshotAccountDetailMonthly')
    .addItem('Start historical backfill', 'startAccountDetailBackfill')
    .addItem('Start 12-week repair', 'startAccountDetailRollingReconciliation')
    .addSeparator()
    .addItem('Install BigQuery and Sheet', 'deployAccountDetailReport')
    .addItem('Install schedules', 'installAccountDetailCadenceTriggers')
    .addToUi();
}

