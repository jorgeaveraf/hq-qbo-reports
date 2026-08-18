function getTargetSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty("TARGET_SPREADSHEET_ID");

  if (!spreadsheetId) {
    throw new Error(
      "Missing Script Property: TARGET_SPREADSHEET_ID"
    );
  }

  return SpreadsheetApp.openById(spreadsheetId);
}
