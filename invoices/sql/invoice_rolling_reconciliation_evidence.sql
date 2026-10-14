-- Post-deployment evidence for the 12-week Invoice reconciliation.
-- Read-only: this script does not mutate BigQuery.

-- 1) Coverage, canonical dates, duplicates, and late-updated invoices.
WITH bounds AS (
  SELECT
    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 WEEK), WEEK(MONDAY)) AS last_week,
    DATE_SUB(
      DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 WEEK), WEEK(MONDAY)),
      INTERVAL 11 WEEK
    ) AS first_week
), expected_weeks AS (
  SELECT week
  FROM bounds, UNNEST(GENERATE_DATE_ARRAY(first_week, last_week, INTERVAL 1 WEEK)) AS week
), headers AS (
  SELECT *
  FROM `qbo-gateway-reporting.raw.invoice_snapshots`, bounds
  WHERE RecordType = 'HEADER'
    AND SnapshotWeek BETWEEN first_week AND last_week
), duplicate_keys AS (
  SELECT SnapshotWeek, ClientId, InvoiceId
  FROM headers
  GROUP BY SnapshotWeek, ClientId, InvoiceId
  HAVING COUNT(*) > 1
)
SELECT
  (SELECT CAST(first_week AS STRING) FROM bounds) AS first_week,
  (SELECT CAST(last_week AS STRING) FROM bounds) AS last_week,
  (SELECT COUNT(*) FROM expected_weeks) AS expected_week_count,
  COUNT(DISTINCT SnapshotWeek) AS actual_week_count,
  COUNTIF(
    SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
    OR DateFrom != SnapshotWeek
    OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)
    OR TxnDate < DateFrom
    OR TxnDate > DateTo
  ) AS noncanonical_header_count,
  (SELECT COUNT(*) FROM duplicate_keys) AS duplicate_invoice_count,
  COUNTIF(UpdatedAt > TIMESTAMP(SnapshotDate)) AS invoices_updated_after_original_snapshot,
  COUNTIF(COALESCE(IsVoided, FALSE)) AS raw_voided_invoice_count
FROM headers;

-- 2) Raw retains void evidence while both consumption views hide the complete invoice.
WITH voided_keys AS (
  SELECT DISTINCT SnapshotWeek, ClientId, InvoiceId
  FROM `qbo-gateway-reporting.raw.invoice_snapshots`
  WHERE RecordType = 'HEADER' AND COALESCE(IsVoided, FALSE)
)
SELECT
  (SELECT COUNT(*) FROM voided_keys) AS raw_voided_invoices_preserved,
  (SELECT COUNT(*)
   FROM `qbo-gateway-reporting.views.vw_invoice_reports` AS visible
   INNER JOIN voided_keys USING (SnapshotWeek, ClientId, InvoiceId)) AS history_view_voided_rows,
  (SELECT COUNT(*)
   FROM `qbo-gateway-reporting.views.vw_latest_invoice_reports` AS visible
   INNER JOIN voided_keys USING (SnapshotWeek, ClientId, InvoiceId)) AS latest_view_voided_rows;

-- 3) Ten concrete reconciled candidates for visual review in raw.
SELECT
  SnapshotWeek, SnapshotDate, ClientName, ClientId, InvoiceId, DocNumber,
  TxnDate, TotalAmount, Balance, PaymentStatus, PrivateNote, IsVoided,
  CreatedAt, UpdatedAt, LoadedAt
FROM `qbo-gateway-reporting.raw.invoice_snapshots`
WHERE RecordType = 'HEADER'
  AND SnapshotWeek >= DATE_SUB(
    DATE_TRUNC(DATE_SUB(CURRENT_DATE(), INTERVAL 1 WEEK), WEEK(MONDAY)),
    INTERVAL 11 WEEK
  )
  AND (UpdatedAt > TIMESTAMP(SnapshotDate) OR COALESCE(IsVoided, FALSE))
ORDER BY UpdatedAt DESC, ClientName, InvoiceId
LIMIT 10;
