-- Payments rolling-window evidence queries.
-- Run section 1 before the first production execution and repeat it afterward.
-- The current 12-week scope is derived from CURRENT_DATE rather than hard-coded.

-- 1) Weekly baseline / after-state summary.
WITH parameters AS (
  SELECT
    DATE_SUB(
      DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)),
      INTERVAL 1 WEEK
    ) AS last_closed_week,
    DATE_SUB(
      DATE_SUB(
        DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)),
        INTERVAL 1 WEEK
      ),
      INTERVAL 11 WEEK
    ) AS first_window_week
)
SELECT
  SnapshotWeek,
  COUNT(DISTINCT ClientId) AS client_count,
  COUNT(DISTINCT IF(RecordType = 'HEADER', CONCAT(ClientId, '|', PaymentId), NULL)) AS payment_count,
  COUNTIF(RecordType = 'HEADER' AND COALESCE(IsVoided, FALSE)) AS voided_payment_count,
  COUNTIF(RecordType = 'HEADER' AND UpdatedAt > TIMESTAMP(SnapshotDate)) AS updated_after_snapshot_count,
  SUM(IF(RecordType = 'HEADER' AND NOT COALESCE(IsVoided, FALSE), TotalAmount, 0)) AS active_payment_total,
  COUNT(*) AS row_count,
  COUNT(DISTINCT idempotency_key) AS unique_key_count
FROM `qbo-gateway-reporting.raw.payment_snapshots`, parameters
WHERE SnapshotWeek BETWEEN first_window_week AND last_closed_week
GROUP BY SnapshotWeek
ORDER BY SnapshotWeek;

-- 2) Candidate PaymentIds proving late additions, edits, and voids.
WITH parameters AS (
  SELECT
    DATE_SUB(
      DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)),
      INTERVAL 1 WEEK
    ) AS last_closed_week,
    DATE_SUB(
      DATE_SUB(
        DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)),
        INTERVAL 1 WEEK
      ),
      INTERVAL 11 WEEK
    ) AS first_window_week
)
SELECT
  SnapshotWeek,
  SnapshotDate,
  Entity,
  ClientId,
  PaymentId,
  TxnDate,
  TotalAmount,
  IsVoided,
  SyncToken,
  UpdatedAt,
  LoadedAt
FROM `qbo-gateway-reporting.raw.payment_snapshots`, parameters
WHERE SnapshotWeek BETWEEN first_window_week AND last_closed_week
  AND RecordType = 'HEADER'
  AND (COALESCE(IsVoided, FALSE) OR UpdatedAt > TIMESTAMP(SnapshotDate))
ORDER BY UpdatedAt DESC, Entity, PaymentId;

-- 3) Acceptance checks after the rolling snapshot and view deployment.
WITH raw_latest AS (
  SELECT *
  FROM `qbo-gateway-reporting.raw.payment_snapshots`
  WHERE SnapshotWeek = (
    SELECT MAX(SnapshotWeek)
    FROM `qbo-gateway-reporting.raw.payment_snapshots`
  )
)
SELECT
  (SELECT COUNT(*) FROM raw_latest WHERE COALESCE(IsVoided, FALSE)) AS raw_voided_rows_preserved,
  (SELECT COUNT(*) FROM `qbo-gateway-reporting.views.vw_payment_report_latest` WHERE COALESCE(IsVoided, FALSE)) AS latest_view_voided_rows,
  (SELECT COUNT(*) FROM `qbo-gateway-reporting.views.vw_payment_report_latest`) AS latest_view_rows,
  (SELECT COUNT(*) FROM raw_latest WHERE NOT COALESCE(IsVoided, FALSE)) AS expected_latest_view_rows,
  (SELECT COUNT(*) - COUNT(DISTINCT idempotency_key)
   FROM `qbo-gateway-reporting.raw.payment_snapshots`) AS duplicate_key_count;

-- 4) Fingerprint outside the rolling window. Capture before and after; it must match.
WITH parameters AS (
  SELECT DATE_SUB(
    DATE_SUB(
      DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)),
      INTERVAL 1 WEEK
    ),
    INTERVAL 11 WEEK
  ) AS first_window_week
)
SELECT
  COUNT(*) AS row_count,
  SUM(FARM_FINGERPRINT(TO_JSON_STRING(t))) AS unchanged_scope_fingerprint
FROM `qbo-gateway-reporting.raw.payment_snapshots` AS t, parameters
WHERE SnapshotWeek < first_window_week;
