-- Read-only evidence for the Journal Entries 12-week rolling reconciliation.
-- Replace the dates only when validating a different completed window.
DECLARE start_week DATE DEFAULT DATE '2026-07-20';
DECLARE end_week DATE DEFAULT DATE '2026-10-05';

WITH window_rows AS (
  SELECT *
  FROM `qbo-gateway-reporting.raw.journal_entry_snapshots`
  WHERE SnapshotWeek BETWEEN start_week AND end_week
),
imbalanced AS (
  SELECT SnapshotWeek, ClientId
  FROM window_rows
  GROUP BY SnapshotWeek, ClientId
  HAVING ABS(ROUND(COALESCE(SUM(DebitAmount), 0) - COALESCE(SUM(CreditAmount), 0), 2)) > 0.01
),
cross_week_duplicates AS (
  SELECT ClientId, TransactionId, LineNumber
  FROM window_rows
  GROUP BY ClientId, TransactionId, LineNumber
  HAVING COUNT(DISTINCT SnapshotWeek) > 1
)
SELECT
  MIN(SnapshotWeek) AS first_week,
  MAX(SnapshotWeek) AS last_week,
  COUNT(DISTINCT SnapshotWeek) AS weeks_with_rows,
  COUNT(*) AS row_count,
  COUNTIF(
    SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY) OR
    DateFrom != SnapshotWeek OR
    DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)
  ) AS noncanonical_rows,
  COUNTIF(TransactionDate < DateFrom OR TransactionDate > DateTo) AS transactions_outside_week,
  COUNTIF(idempotency_key IS NULL OR TRIM(idempotency_key) = '') AS missing_keys,
  COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_keys,
  (SELECT COUNT(*) FROM imbalanced) AS imbalanced_client_weeks,
  (SELECT COUNT(*) FROM cross_week_duplicates) AS cross_week_duplicates
FROM window_rows;
