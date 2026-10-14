-- P&L rolling reconciliation validation.
-- Set reference_date to the Monday on which the process is started.
DECLARE reference_date DATE DEFAULT CURRENT_DATE('America/Mexico_City');
DECLARE current_monday DATE DEFAULT DATE_SUB(reference_date, INTERVAL MOD(EXTRACT(DAYOFWEEK FROM reference_date) + 5, 7) DAY);
DECLARE end_week DATE DEFAULT DATE_SUB(current_monday, INTERVAL 7 DAY);
DECLARE start_week DATE DEFAULT DATE_SUB(end_week, INTERVAL 11 WEEK);

-- 1) Coverage, canonical dates, duplicate keys, and totals by variant/week.
WITH combined AS (
  SELECT 'normal' AS variant, SnapshotWeek, SnapshotDate, DateFrom, DateTo,
    idempotency_key, Amount
  FROM `qbo-gateway-reporting.raw.profit_and_loss_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
  UNION ALL
  SELECT 'by_class', SnapshotWeek, SnapshotDate, DateFrom, DateTo,
    idempotency_key, Amount
  FROM `qbo-gateway-reporting.raw.profit_and_loss_by_class_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
)
SELECT
  variant,
  SnapshotWeek,
  COUNT(*) AS row_count,
  COUNT(DISTINCT idempotency_key) AS distinct_key_count,
  COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
    OR DateFrom != SnapshotWeek
    OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS noncanonical_row_count,
  ROUND(SUM(COALESCE(Amount, 0)), 2) AS amount_total
FROM combined
GROUP BY variant, SnapshotWeek
ORDER BY variant, SnapshotWeek;

-- 2) Summary acceptance checks. Duplicate and noncanonical counts must be zero.
WITH checks AS (
  SELECT 'normal' AS variant,
    COUNT(DISTINCT SnapshotWeek) AS week_count,
    COUNT(*) - COUNT(DISTINCT idempotency_key) AS duplicate_key_count,
    COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
      OR DateFrom != SnapshotWeek
      OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)) AS noncanonical_row_count
  FROM `qbo-gateway-reporting.raw.profit_and_loss_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
  UNION ALL
  SELECT 'by_class',
    COUNT(DISTINCT SnapshotWeek),
    COUNT(*) - COUNT(DISTINCT idempotency_key),
    COUNTIF(SnapshotDate != DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
      OR DateFrom != SnapshotWeek
      OR DateTo != DATE_ADD(SnapshotWeek, INTERVAL 6 DAY))
  FROM `qbo-gateway-reporting.raw.profit_and_loss_by_class_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
)
SELECT * FROM checks ORDER BY variant;

-- 3) Current rows by client and variant. Use this to identify successful
-- zero-row clients alongside the Apps Script execution result.
WITH client_rows AS (
  SELECT 'normal' AS variant, SnapshotWeek, ClientId, ANY_VALUE(ClientName) AS ClientName,
    COUNT(*) AS row_count, ROUND(SUM(COALESCE(Amount, 0)), 2) AS amount_total
  FROM `qbo-gateway-reporting.raw.profit_and_loss_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
  GROUP BY variant, SnapshotWeek, ClientId
  UNION ALL
  SELECT 'by_class', SnapshotWeek, ClientId, ANY_VALUE(ClientName),
    COUNT(*), ROUND(SUM(COALESCE(Amount, 0)), 2)
  FROM `qbo-gateway-reporting.raw.profit_and_loss_by_class_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
  GROUP BY variant, SnapshotWeek, ClientId
)
SELECT * FROM client_rows ORDER BY variant, SnapshotWeek, ClientName;
