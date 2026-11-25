-- Run after the new mart tables have been backfilled, checked, and their GAS writers deployed.
-- View identifiers and output columns stay unchanged. Constellation Account Detail is excluded.
CREATE TEMP TABLE view_schema_before AS
SELECT table_name, column_name, data_type, ordinal_position
FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN (
  'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
  'vw_journal_entry_reports', 'vw_journal_entry_report_latest'
);

ASSERT (
  SELECT STRPOS(view_definition, 'mart.aging_snapshots') > 0
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name = 'vw_aging_snapshots_accumulated'
) AS 'Unexpected Aging accumulated view definition';
ASSERT (
  SELECT STRPOS(view_definition, 'mart.aging_latest_snapshot') > 0
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name = 'vw_latest_aging_snapshot'
) AS 'Unexpected Aging latest view definition';
ASSERT (
  SELECT STRPOS(view_definition, 'mart.journal_entry_snapshots') > 0
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name = 'vw_journal_entry_reports'
) AS 'Unexpected Journal Entries history view definition';
ASSERT (
  SELECT STRPOS(view_definition, 'mart.journal_entry_snapshots') > 0
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
  WHERE table_name = 'vw_journal_entry_report_latest'
) AS 'Unexpected Journal Entries latest view definition';

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_aging_snapshots_accumulated` AS
SELECT snapshot_date, snapshot_week, report_type, entity, as_of_date, bucket,
  counterparty, document_number, document_type, transaction_date, due_date,
  days_overdue, open_amount, currency, source, client_id, client_name, loaded_at
FROM `qbo-gateway-reporting.mart.mart_aging`
WHERE snapshot_date IS NOT NULL;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_latest_aging_snapshot` AS
SELECT * EXCEPT(IsLatest)
FROM `qbo-gateway-reporting.mart.mart_aging`
WHERE IsLatest = TRUE;

EXECUTE IMMEDIATE CONCAT(
  'CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_journal_entry_reports` AS ',
  REPLACE((SELECT view_definition
    FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
    WHERE table_name = 'vw_journal_entry_reports'),
    'mart.journal_entry_snapshots', 'mart.mart_journal_entry')
);

EXECUTE IMMEDIATE CONCAT(
  'CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_journal_entry_report_latest` AS ',
  REPLACE((SELECT view_definition
    FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.VIEWS`
    WHERE table_name = 'vw_journal_entry_report_latest'),
    'mart.journal_entry_snapshots', 'mart.mart_journal_entry')
);

ASSERT (
  SELECT COUNT(*) FROM (
    SELECT * FROM view_schema_before
    EXCEPT DISTINCT
    SELECT table_name, column_name, data_type, ordinal_position
    FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
    WHERE table_name IN (
      'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
      'vw_journal_entry_reports', 'vw_journal_entry_report_latest')
  )
) = 0 AS 'View columns removed or changed';
ASSERT (
  SELECT COUNT(*) FROM (
    SELECT table_name, column_name, data_type, ordinal_position
    FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
    WHERE table_name IN (
      'vw_aging_snapshots_accumulated', 'vw_latest_aging_snapshot',
      'vw_journal_entry_reports', 'vw_journal_entry_report_latest')
    EXCEPT DISTINCT
    SELECT * FROM view_schema_before
  )
) = 0 AS 'View columns added or changed';
