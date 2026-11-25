-- Read-only checks after both view cutover scripts have completed.
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.INFORMATION_SCHEMA.TABLES`
  WHERE table_name IN (
    'mart_aging', 'mart_balance_sheet', 'mart_payment', 'mart_invoice',
    'mart_journal_entry', 'mart_profit_and_loss', 'mart_profit_and_loss_by_class'
  )
) = 7 AS 'A report mart is missing';

ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name IN (
    'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
    'vw_journal_entry_reports', 'vw_journal_entry_report_latest',
    'vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics',
    'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports',
    'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports',
    'vw_profit_and_loss_by_class_report_latest',
    'vw_monthly_profit_and_loss_reports',
    'vw_monthly_profit_and_loss_by_class_reports',
    'vw_invoice_reports', 'vw_latest_invoice_reports',
    'vw_payment_reports_accumulated', 'vw_payment_report_latest'
  )
  AND STRPOS(LOWER(view_definition), 'mart.mart_') > 0
) = 17 AS 'A report view is missing or reads a legacy source';

ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name IN (
    'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
    'vw_journal_entry_reports', 'vw_journal_entry_report_latest',
    'vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics',
    'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports',
    'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports',
    'vw_profit_and_loss_by_class_report_latest',
    'vw_monthly_profit_and_loss_reports',
    'vw_monthly_profit_and_loss_by_class_reports',
    'vw_invoice_reports', 'vw_latest_invoice_reports',
    'vw_payment_reports_accumulated', 'vw_payment_report_latest'
  )
  AND STRPOS(LOWER(view_definition), '.raw.') > 0
) = 0 AS 'A report view still reads raw';

SELECT table_name, view_definition
FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
WHERE table_name IN (
  'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
  'vw_journal_entry_reports', 'vw_journal_entry_report_latest',
  'vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics',
  'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports',
  'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports',
  'vw_profit_and_loss_by_class_report_latest',
  'vw_monthly_profit_and_loss_reports',
  'vw_monthly_profit_and_loss_by_class_reports',
  'vw_invoice_reports', 'vw_latest_invoice_reports',
  'vw_payment_reports_accumulated', 'vw_payment_report_latest'
)
ORDER BY table_name;
