-- Review and execute in BigQuery before clasp push.
-- This adds nullable evidence fields and preserves the current view column contract.

ALTER TABLE `qbo-gateway-reporting.raw.invoice_snapshots`
ADD COLUMN IF NOT EXISTS PrivateNote STRING;

ALTER TABLE `qbo-gateway-reporting.raw.invoice_snapshots`
ADD COLUMN IF NOT EXISTS IsVoided BOOL;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_invoice_reports` AS
SELECT
  invoices.SnapshotWeek, invoices.SnapshotDate,
  invoices.RecordType, invoices.RecordOrder,
  invoices.Entity, invoices.ClientName, invoices.InvoiceId, invoices.DocNumber,
  invoices.TxnDate, invoices.DueDate,
  invoices.CustomerName, invoices.CurrencyCode, invoices.SalesTermName,
  invoices.DepartmentName, invoices.BillEmail,
  invoices.TotalAmount, invoices.Balance, invoices.PaymentStatus,
  invoices.LineNumber, invoices.Description, invoices.ItemName, invoices.Quantity,
  invoices.UnitPrice, invoices.LineAmountSigned, invoices.AccountName, invoices.ClassName,
  invoices.DiscountPercent, invoices.DiscountAccountName, invoices.LinkedTxnTypes,
  invoices.BillAddress, invoices.ShipAddress, invoices.ShipFromAddress,
  invoices.idempotency_key, invoices.ClientId, invoices.LoadedAt
FROM `qbo-gateway-reporting.raw.invoice_snapshots` AS invoices
WHERE NOT EXISTS (
  SELECT 1
  FROM `qbo-gateway-reporting.raw.invoice_snapshots` AS voided_headers
  WHERE voided_headers.SnapshotWeek = invoices.SnapshotWeek
    AND voided_headers.ClientId = invoices.ClientId
    AND voided_headers.InvoiceId = invoices.InvoiceId
    AND voided_headers.RecordType = 'HEADER'
    AND COALESCE(voided_headers.IsVoided, FALSE)
)
ORDER BY invoices.SnapshotWeek DESC, invoices.SnapshotDate DESC,
  invoices.Entity, invoices.ClientName, invoices.InvoiceId, invoices.RecordOrder;

CREATE OR REPLACE VIEW `qbo-gateway-reporting.views.vw_latest_invoice_reports` AS
WITH latest_snapshot AS (
  SELECT MAX(SnapshotWeek) AS SnapshotWeek
  FROM `qbo-gateway-reporting.raw.invoice_snapshots`
)
SELECT
  invoices.SnapshotWeek, invoices.SnapshotDate,
  invoices.RecordType, invoices.RecordOrder,
  invoices.Entity, invoices.ClientName, invoices.InvoiceId, invoices.DocNumber,
  invoices.TxnDate, invoices.DueDate,
  invoices.CustomerName, invoices.CurrencyCode, invoices.SalesTermName,
  invoices.DepartmentName, invoices.BillEmail,
  invoices.TotalAmount, invoices.Balance, invoices.PaymentStatus,
  invoices.LineNumber, invoices.Description, invoices.ItemName, invoices.Quantity,
  invoices.UnitPrice, invoices.LineAmountSigned, invoices.AccountName, invoices.ClassName,
  invoices.DiscountPercent, invoices.DiscountAccountName, invoices.LinkedTxnTypes,
  invoices.BillAddress, invoices.ShipAddress, invoices.ShipFromAddress,
  invoices.idempotency_key, invoices.ClientId, invoices.LoadedAt
FROM `qbo-gateway-reporting.raw.invoice_snapshots` AS invoices
INNER JOIN latest_snapshot
  ON invoices.SnapshotWeek = latest_snapshot.SnapshotWeek
WHERE NOT EXISTS (
  SELECT 1
  FROM `qbo-gateway-reporting.raw.invoice_snapshots` AS voided_headers
  WHERE voided_headers.SnapshotWeek = invoices.SnapshotWeek
    AND voided_headers.ClientId = invoices.ClientId
    AND voided_headers.InvoiceId = invoices.InvoiceId
    AND voided_headers.RecordType = 'HEADER'
    AND COALESCE(voided_headers.IsVoided, FALSE)
)
ORDER BY invoices.SnapshotWeek DESC, invoices.SnapshotDate DESC,
  invoices.Entity, invoices.ClientName, invoices.InvoiceId, invoices.RecordOrder;
