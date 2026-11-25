-- Generated from the reviewed local GAS view builders; view identifiers and column order are preserved.
-- Run after 2026-11-16-manual-view-cutover.sql and after all new mart writers are deployed.
CREATE TEMP TABLE view_schema_before AS
SELECT table_name, column_name, data_type, ordinal_position
FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
WHERE table_name IN ('vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics', 'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports', 'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports', 'vw_profit_and_loss_by_class_report_latest', 'vw_monthly_profit_and_loss_reports', 'vw_monthly_profit_and_loss_by_class_reports', 'vw_invoice_reports', 'vw_latest_invoice_reports', 'vw_payment_reports_accumulated', 'vw_payment_report_latest');

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_weekly_balance_sheet_metrics` AS
SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,
  MetricName, NormalizedCategory, AccountName, AccountPath, Amount, Currency, Source, LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
WHERE IsKeyMetric = TRUE
  AND COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
  AND EXTRACT(DAYOFWEEK FROM SnapshotWeek) = 2
  AND SnapshotDate = DATE_ADD(SnapshotWeek, INTERVAL 7 DAY)
  AND AsOfDate = DATE_ADD(SnapshotWeek, INTERVAL 6 DAY)
ORDER BY SnapshotDate DESC, Entity ASC, ClientName ASC, NormalizedCategory ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_latest_balance_sheet_metrics` AS
SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,
  MetricName, NormalizedCategory, AccountName, AccountPath, Amount, Currency, Source, LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
WHERE IsLatestKeyMetric = TRUE
ORDER BY Entity ASC, ClientName ASC, NormalizedCategory ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_monthly_balance_sheet_metrics` AS
SELECT SnapshotWeek, SnapshotDate, Entity, ClientName, ClientId, AsOfDate,
  MetricName, NormalizedCategory, AccountName, AccountPath, Amount, Currency, Source, LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_balance_sheet`
WHERE IsKeyMetric = TRUE
  AND COALESCE(SnapshotType, 'WEEKLY') = 'MONTHLY'
ORDER BY SnapshotDate DESC, Entity ASC, ClientName ASC, NormalizedCategory ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_profit_and_loss_reports` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordGroupOrder,
  RecordOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  RecordType,
  AccountName,
  AccountPath,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_profit_and_loss_report_latest` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordGroupOrder,
  RecordOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  RecordType,
  AccountName,
  AccountPath,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
  AND SnapshotWeek = (SELECT MAX(SnapshotWeek) FROM `qbo-gateway-reporting.mart.mart_profit_and_loss` WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY')
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_profit_and_loss_by_class_reports` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordType,
  RecordGroupOrder,
  RecordOrder,
  ClassColumnIndex AS RecordColumnOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  AccountName,
  AccountPath,
  ClassName,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_profit_and_loss_by_class_report_latest` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordType,
  RecordGroupOrder,
  RecordOrder,
  ClassColumnIndex AS RecordColumnOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  AccountName,
  AccountPath,
  ClassName,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY'
  AND SnapshotWeek = (SELECT MAX(SnapshotWeek) FROM `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class` WHERE COALESCE(SnapshotType, 'WEEKLY') = 'WEEKLY')
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_monthly_profit_and_loss_reports` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordGroupOrder,
  RecordOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  RecordType,
  AccountName,
  AccountPath,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'MONTHLY'
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_monthly_profit_and_loss_by_class_reports` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordType,
  RecordGroupOrder,
  RecordOrder,
  ClassColumnIndex AS RecordColumnOrder,
  RecordGroupKey,
  Entity,
  ClientName,
  DateFrom,
  DateTo,
  AccountingMethod,
  Currency,
  AccountName,
  AccountPath,
  ClassName,
  Amount,
  MetricName,
  NormalizedMetric,
  IsKeyMetric,
  idempotency_key,
  ClientId,
  LoadedAt,
  SnapshotType
FROM `qbo-gateway-reporting.mart.mart_profit_and_loss_by_class`
WHERE COALESCE(SnapshotType, 'WEEKLY') = 'MONTHLY'
ORDER BY SnapshotWeek DESC, SnapshotDate DESC, Entity ASC, ClientName ASC, ClientId ASC,
  RecordGroupOrder ASC, RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_invoice_reports` AS
SELECT
  invoices.SnapshotWeek,
  invoices.SnapshotDate,
  invoices.RecordType,
  invoices.RecordOrder,
  invoices.Entity,
  invoices.ClientName,
  invoices.InvoiceId,
  invoices.DocNumber,
  invoices.TxnDate,
  invoices.DueDate,
  invoices.CustomerName,
  invoices.CurrencyCode,
  invoices.SalesTermName,
  invoices.DepartmentName,
  invoices.BillEmail,
  invoices.TotalAmount,
  invoices.Balance,
  invoices.PaymentStatus,
  invoices.LineNumber,
  invoices.Description,
  invoices.ItemName,
  invoices.Quantity,
  invoices.UnitPrice,
  invoices.LineAmountSigned,
  invoices.AccountName,
  invoices.ClassName,
  invoices.DiscountPercent,
  invoices.DiscountAccountName,
  invoices.LinkedTxnTypes,
  invoices.BillAddress,
  invoices.ShipAddress,
  invoices.ShipFromAddress,
  invoices.idempotency_key,
  invoices.ClientId,
  invoices.LoadedAt
FROM `qbo-gateway-reporting.mart.mart_invoice` AS invoices
WHERE invoices.IsVisible
ORDER BY
  invoices.SnapshotWeek DESC,
  invoices.SnapshotDate DESC,
  invoices.Entity,
  invoices.ClientName,
  invoices.InvoiceId,
  invoices.RecordOrder;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_latest_invoice_reports` AS
WITH latest_snapshot AS (
  SELECT MAX(SnapshotWeek) AS SnapshotWeek
  FROM `qbo-gateway-reporting.mart.mart_invoice`
)
SELECT
  invoices.SnapshotWeek,
  invoices.SnapshotDate,
  invoices.RecordType,
  invoices.RecordOrder,
  invoices.Entity,
  invoices.ClientName,
  invoices.InvoiceId,
  invoices.DocNumber,
  invoices.TxnDate,
  invoices.DueDate,
  invoices.CustomerName,
  invoices.CurrencyCode,
  invoices.SalesTermName,
  invoices.DepartmentName,
  invoices.BillEmail,
  invoices.TotalAmount,
  invoices.Balance,
  invoices.PaymentStatus,
  invoices.LineNumber,
  invoices.Description,
  invoices.ItemName,
  invoices.Quantity,
  invoices.UnitPrice,
  invoices.LineAmountSigned,
  invoices.AccountName,
  invoices.ClassName,
  invoices.DiscountPercent,
  invoices.DiscountAccountName,
  invoices.LinkedTxnTypes,
  invoices.BillAddress,
  invoices.ShipAddress,
  invoices.ShipFromAddress,
  invoices.idempotency_key,
  invoices.ClientId,
  invoices.LoadedAt
FROM `qbo-gateway-reporting.mart.mart_invoice` AS invoices
INNER JOIN latest_snapshot
  ON invoices.SnapshotWeek = latest_snapshot.SnapshotWeek
WHERE invoices.IsVisible
ORDER BY
  invoices.SnapshotWeek DESC,
  invoices.SnapshotDate DESC,
  invoices.Entity,
  invoices.ClientName,
  invoices.InvoiceId,
  invoices.RecordOrder;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_payment_reports_accumulated` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordType,
  RecordOrder,
  Entity,
  ClientName,
  PaymentId,
  TxnDate,
  CustomerName,
  PaymentRefNum,
  PrivateNote,
  TotalAmount,
  UnappliedAmount,
  ProcessPayment,
  IsVoided,
  PaymentLinkedTxnIds,
  PaymentLinkedTxnTypes,
  LineAmountSigned,
  LinkedTxnType,
  LinkedTxnReferenceNumber,
  LinkedTxnOpenBalance,
  idempotency_key,
  ClientId,
  LoadedAt
FROM `qbo-gateway-reporting.mart.mart_payment`
ORDER BY
  SnapshotWeek DESC,
  Entity ASC,
  ClientName ASC,
  ClientId ASC,
  TxnDate DESC,
  SAFE_CAST(PaymentId AS INT64) DESC,
  PaymentId DESC,
  RecordOrder ASC;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_payment_report_latest` AS
SELECT
  SnapshotWeek,
  SnapshotDate,
  RecordType,
  RecordOrder,
  Entity,
  ClientName,
  PaymentId,
  TxnDate,
  CustomerName,
  PaymentRefNum,
  PrivateNote,
  TotalAmount,
  UnappliedAmount,
  ProcessPayment,
  IsVoided,
  PaymentLinkedTxnIds,
  PaymentLinkedTxnTypes,
  LineAmountSigned,
  LinkedTxnType,
  LinkedTxnReferenceNumber,
  LinkedTxnOpenBalance,
  idempotency_key,
  ClientId,
  LoadedAt
FROM `qbo-gateway-reporting.mart.mart_payment`
WHERE IsLatest = TRUE
ORDER BY
  Entity ASC,
  ClientName ASC,
  ClientId ASC,
  TxnDate DESC,
  SAFE_CAST(PaymentId AS INT64) DESC,
  PaymentId DESC,
  RecordOrder ASC;

ASSERT (SELECT COUNT(*) FROM (
  SELECT * FROM view_schema_before
  EXCEPT DISTINCT
  SELECT table_name, column_name, data_type, ordinal_position
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
  WHERE table_name IN ('vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics', 'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports', 'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports', 'vw_profit_and_loss_by_class_report_latest', 'vw_monthly_profit_and_loss_reports', 'vw_monthly_profit_and_loss_by_class_reports', 'vw_invoice_reports', 'vw_latest_invoice_reports', 'vw_payment_reports_accumulated', 'vw_payment_report_latest')
)) = 0 AS 'View columns removed or changed';
ASSERT (SELECT COUNT(*) FROM (
  SELECT table_name, column_name, data_type, ordinal_position
  FROM `qbo-gateway-reporting.views.INFORMATION_SCHEMA.COLUMNS`
  WHERE table_name IN ('vw_weekly_balance_sheet_metrics', 'vw_latest_balance_sheet_metrics', 'vw_monthly_balance_sheet_metrics', 'vw_profit_and_loss_reports', 'vw_profit_and_loss_report_latest', 'vw_profit_and_loss_by_class_reports', 'vw_profit_and_loss_by_class_report_latest', 'vw_monthly_profit_and_loss_reports', 'vw_monthly_profit_and_loss_by_class_reports', 'vw_invoice_reports', 'vw_latest_invoice_reports', 'vw_payment_reports_accumulated', 'vw_payment_report_latest')
  EXCEPT DISTINCT
  SELECT * FROM view_schema_before
)) = 0 AS 'View columns added or changed';
