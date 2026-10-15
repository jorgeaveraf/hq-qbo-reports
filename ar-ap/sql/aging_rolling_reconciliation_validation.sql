-- Read-only evidence for the active 12-week AR/AP reconciliation window.
-- The window ends on the last completed Sunday in America/Mexico_City.
WITH bounds AS (
  SELECT
    DATE_SUB(DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)), INTERVAL 78 DAY) AS start_date,
    DATE_SUB(DATE_TRUNC(CURRENT_DATE('America/Mexico_City'), WEEK(MONDAY)), INTERVAL 1 DAY) AS end_date
),
canonical_dates AS (
  SELECT snapshot_date
  FROM bounds,
  UNNEST(GENERATE_DATE_ARRAY(start_date, end_date, INTERVAL 7 DAY)) AS snapshot_date
),
window_rows AS (
  SELECT t.*
  FROM `qbo-gateway-reporting.raw.aging_snapshots` t
  INNER JOIN canonical_dates d USING (snapshot_date)
)
SELECT
  MIN(snapshot_date) AS first_snapshot_date,
  MAX(snapshot_date) AS last_snapshot_date,
  COUNT(DISTINCT snapshot_date) AS completed_sundays,
  COUNT(*) AS row_count,
  COUNT(*) - COUNT(DISTINCT FARM_FINGERPRINT(
    TO_JSON_STRING((SELECT AS STRUCT window_rows.* EXCEPT(loaded_at)))
  )) AS repeated_source_rows,
  COUNTIF(
    snapshot_week != DATE_TRUNC(snapshot_date, WEEK(MONDAY)) OR
    as_of_date != snapshot_date OR
    EXTRACT(DAYOFWEEK FROM snapshot_date) != 1
  ) AS noncanonical_date_rows,
  COUNTIF(report_type NOT IN ('AR', 'AP')) AS invalid_report_type_rows,
  COUNTIF(
    bucket != CASE
      WHEN days_overdue IS NULL OR days_overdue <= 0 THEN 'Current'
      WHEN days_overdue <= 30 THEN '1–30'
      WHEN days_overdue <= 60 THEN '31–60'
      WHEN days_overdue <= 90 THEN '61–90'
      ELSE '91+'
    END
  ) AS invalid_bucket_rows,
  COUNTIF(report_type = 'AR') AS ar_rows,
  COUNTIF(report_type = 'AP') AS ap_rows,
  SUM(IF(report_type = 'AR', open_amount, 0)) AS ar_open_amount,
  SUM(IF(report_type = 'AP', open_amount, 0)) AS ap_open_amount
FROM window_rows;
