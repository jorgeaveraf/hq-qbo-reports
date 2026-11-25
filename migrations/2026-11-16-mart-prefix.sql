-- Run only after comparing each Apps Script project with its deployed HEAD.
-- This is an additive preparation step. Existing mart tables and views remain available.
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.INFORMATION_SCHEMA.TABLES`
  WHERE table_name IN (
    'mart_aging', 'mart_balance_sheet', 'mart_payment', 'mart_invoice',
    'mart_journal_entry', 'mart_profit_and_loss', 'mart_profit_and_loss_by_class'
  )
) = 0 AS 'A target mart table already exists; inspect it before cutover';

CREATE TABLE `qbo-gateway-reporting.mart.mart_aging`
  COPY `qbo-gateway-reporting.mart.aging_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_balance_sheet`
  COPY `qbo-gateway-reporting.mart.balance_sheet_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_payment`
  COPY `qbo-gateway-reporting.mart.payment_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_invoice`
  COPY `qbo-gateway-reporting.mart.invoice_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_journal_entry`
  COPY `qbo-gateway-reporting.mart.journal_entry_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_profit_and_loss`
  COPY `qbo-gateway-reporting.mart.profit_and_loss_snapshots`;
CREATE TABLE `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class`
  COPY `qbo-gateway-reporting.mart.profit_and_loss_by_class_snapshots`;

ALTER TABLE `qbo-gateway-reporting.mart.mart_aging` ADD COLUMN IF NOT EXISTS IsLatest BOOL;
ALTER TABLE `qbo-gateway-reporting.mart.mart_balance_sheet` ADD COLUMN IF NOT EXISTS IsLatestKeyMetric BOOL;
ALTER TABLE `qbo-gateway-reporting.mart.mart_payment` ADD COLUMN IF NOT EXISTS IsLatest BOOL;

UPDATE `qbo-gateway-reporting.mart.mart_aging` AS target
SET IsLatest = (target.snapshot_date = latest.snapshot_date)
FROM (
  SELECT entity, report_type, MAX(snapshot_date) AS snapshot_date
  FROM `qbo-gateway-reporting.mart.mart_aging`
  GROUP BY entity, report_type
) AS latest
WHERE target.entity = latest.entity AND target.report_type = latest.report_type;

UPDATE `qbo-gateway-reporting.mart.mart_payment`
SET IsLatest = (SnapshotWeek = (
  SELECT MAX(SnapshotWeek) FROM `qbo-gateway-reporting.mart.mart_payment`
)) AND COALESCE(IsVoided, FALSE) = FALSE
WHERE TRUE;

CREATE TEMP TABLE latest_balance_rows AS
SELECT ClientId, NormalizedCategory, SnapshotDate, LoadedAt, MetricName, AccountPath
FROM `qbo-gateway-reporting.mart.balance_sheet_latest_metrics`;
UPDATE `qbo-gateway-reporting.mart.mart_balance_sheet`
SET IsLatestKeyMetric = FALSE
WHERE TRUE;
UPDATE `qbo-gateway-reporting.mart.mart_balance_sheet` AS target
SET IsLatestKeyMetric = TRUE
FROM latest_balance_rows AS latest
WHERE TO_JSON_STRING(STRUCT(target.ClientId, target.NormalizedCategory, target.SnapshotDate,
  target.LoadedAt, target.MetricName, target.AccountPath)) =
  TO_JSON_STRING(STRUCT(latest.ClientId, latest.NormalizedCategory, latest.SnapshotDate,
  latest.LoadedAt, latest.MetricName, latest.AccountPath));
DROP TABLE latest_balance_rows;

ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_aging`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.aging_snapshots`
) AS 'Aging copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.balance_sheet_snapshots`
) AS 'Balance Sheet copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_payment`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.payment_snapshots`
) AS 'Payments copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_invoice`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.invoice_snapshots`
) AS 'Invoices copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_journal_entry`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.journal_entry_snapshots`
) AS 'Journal Entries copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_profit_and_loss`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.profit_and_loss_snapshots`
) AS 'P&L copy count differs';
ASSERT (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.profit_and_loss_by_class_snapshots`
) AS 'P&L by class copy count differs';

ASSERT (
  SELECT COUNTIF(IsLatest) FROM `qbo-gateway-reporting.mart.mart_aging`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.aging_latest_snapshot`
) AS 'Aging latest count differs';
ASSERT (
  SELECT COUNTIF(IsLatestKeyMetric) FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.balance_sheet_latest_metrics`
) AS 'Balance Sheet latest count differs';
ASSERT (
  SELECT COUNTIF(IsLatest) FROM `qbo-gateway-reporting.mart.mart_payment`
) = (
  SELECT COUNT(*) FROM `qbo-gateway-reporting.mart.payment_latest`
) AS 'Payments latest count differs';

ASSERT (
  SELECT COUNT(*) FROM (
    SELECT * FROM `qbo-gateway-reporting.mart.aging_latest_snapshot`
    EXCEPT DISTINCT
    SELECT * EXCEPT(IsLatest) FROM `qbo-gateway-reporting.mart.mart_aging` WHERE IsLatest = TRUE
  )
) = 0 AS 'Aging latest rows differ';
ASSERT (
  SELECT COUNT(*) FROM (
    SELECT * FROM `qbo-gateway-reporting.mart.payment_latest`
    EXCEPT DISTINCT
    SELECT * EXCEPT(IsLatest) FROM `qbo-gateway-reporting.mart.mart_payment` WHERE IsLatest = TRUE
  )
) = 0 AS 'Payments latest rows differ';
ASSERT (
  SELECT COUNT(*) FROM (
    SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,
      MetricName, NormalizedCategory, AccountName, AccountPath, Amount,
      Currency, Source, LoadedAt, SnapshotType
    FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
    WHERE IsLatestKeyMetric = TRUE
    EXCEPT DISTINCT
    SELECT * FROM `qbo-gateway-reporting.mart.balance_sheet_latest_metrics`
  )
) = 0 AS 'Balance Sheet latest rows differ';
