# Repository instructions

## Google Apps Script: payments

- The Google Apps Script project lives in `payments/`.
- Git is the source of truth for Apps Script source files and the manifest.
- OAuth credentials, `.clasprc*.json`, and `payments/.clasp.json` are local-only files and must never be committed or documented with their values.
- Before any `clasp pull` or `clasp push`, verify the authenticated account, the target script ID, and the spreadsheet container.
- A `clasp push` requires the user's explicit confirmation after showing the current file status and exactly which files would be sent.
- Never commit Script Property values or other secrets. Configure them in Apps Script under **Project Settings > Script Properties**.

## Google Apps Script: journal entries

- The Google Apps Script project lives in `journal-entries/`.
- Git is the source of truth for Apps Script source files and the manifest.
- OAuth credentials, `.clasprc*.json`, and `journal-entries/.clasp.json` are local-only files and must never be committed or documented with their values.
- Before any `clasp pull` or `clasp push`, verify the authenticated account, the target script ID, and the spreadsheet container.
- A `clasp push` requires the user's explicit confirmation after showing the current file status and exactly which files would be sent.
- Never commit Script Property values or other secrets. Configure them in Apps Script under **Project Settings > Script Properties**.
