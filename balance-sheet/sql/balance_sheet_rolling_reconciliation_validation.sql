-- Read-only validation for the Balance Sheet 12-week rolling reconciliation.
-- Replace the dates only when validating a different completed window.
DECLARE start_week DATE DEFAULT DATE '2026-07-20';
DECLARE end_week DATE DEFAULT DATE '2026-10-05';

WITH canonical_lines AS (
  SELECT *
  FROM `qbo-gateway-reporting.raw.balance_sheet_snapshots`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
    AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
    AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)
),
canonical_audit AS (
  SELECT *
  FROM `qbo-gateway-reporting.intermediate.balance_sheet_audit`
  WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
    AND SnapshotWeek BETWEEN start_week AND end_week
    AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
    AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)
)
SELECT
  (SELECT COUNT(DISTINCT SnapshotWeek) FROM canonical_lines) AS line_weeks,
  (SELECT COUNT(DISTINCT SnapshotWeek) FROM canonical_audit) AS audited_weeks,
  (SELECT COUNT(DISTINCT CONCAT(CAST(SnapshotWeek AS STRING), '|', ClientId))
   FROM canonical_audit) AS audited_client_weeks,
  (SELECT COUNT(*) FROM canonical_lines) AS line_rows,
  (SELECT COUNT(*) FROM canonical_audit) AS audit_rows;
