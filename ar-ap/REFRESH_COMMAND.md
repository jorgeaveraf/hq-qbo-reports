# Aging refresh command (FinOps BFF contract)

This command starts **`updateAgingExport()` only**. It does not call
`snapshotAgingToBigQuery()`, change the published entity configuration, or
accept a client subset. The existing configuration-push `doPost` contract is
unchanged.

The FinOps BFF sends a POST to the deployed Apps Script web-app URL. The body
is an envelope with `contract_type: "qbo_report_refresh_envelope"`,
`contract_version: "1.0"`, a JSON **string** in `payload`, and a lowercase
SHA-256 HMAC hex `signature` of that exact payload string. The signing key is
the separate `QBO_AGING_REFRESH_COMMAND_SECRET` Script Property. Its matching
BFF environment value must never be sent to a browser or committed to Git.

The payload contains exactly these fields:

```json
{
  "contract_type": "qbo_report_refresh_command",
  "contract_version": "1.0",
  "report_key": "aging",
  "action": "start",
  "run_id": "08b63eb8-04d6-459c-a93f-aeeec961e492",
  "requested_at": "2026-11-25T15:00:00.000Z"
}
```

`action` is `start` or `status`; a status request is also freshly signed and
uses the same `run_id`. The timestamp must be no more than 10 minutes old or
2 minutes in the future. The BFF generates and retains the UUID, associates it
with the authenticated requester, and allows only a server-side allowlisted
report action. GAS does not authorize the end user; that check belongs in the
BFF. Retrying `start` with the same UUID is idempotent. Another UUID while a
run is queued or running returns `already_running` and `activeRunId`.

The `start` response reports `queued`, not completion. The BFF must inspect
the JSON `success` and `status` fields, not just the HTTP status. `status`
returns `queued`, `running`, the `updateAgingExport()` result status,
`failed`, `timed_out`, or `not_found`. Only the latest run is retained in the
`QBO_AGING_REFRESH_LATEST_RUN` Script Property; the stored result is a compact
summary, not report rows or the full sheet result. Retain longer-lived history
in FinOps if needed.

The worker is a one-shot installable trigger. It runs under the account that
deployed the web app, and the existing `updateAgingExport()` script lock and
configuration-deployment guard remain in force. `deferred_lock_busy` and
`delegated_to_configuration_deployment` are terminal outcomes for this request,
not proof that its export completed. The BFF should present them as not run and
offer a new request later.

No `clasp push`, deployment update, or Script Property change is performed by
these source edits alone.
