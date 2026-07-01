# Payment Operator Tool Gaps

Manual recovery ([`PAYMENT_RECOVERY_RUNBOOK.md`](PAYMENT_RECOVERY_RUNBOOK.md)) today leans on raw SQL, the
Mollie dashboard, and direct edge-function calls. These are the **operator tools that don't exist yet** but
would make recovery faster + safer. None are required for correctness; they reduce time-to-resolve and the
chance of a manual-SQL mistake. Ranked by value.

| # | Proposed tool | Why | Effort | Backed by (already exists) |
|---|---|---|---:|---|
| 1 | **Admin reconciliation dashboard** — a page running `reconcile_payments()` + the `payment_audit_log` "stranded" query, grouped by check/severity, with links to each entity | Turns the read-only RPC into a daily glanceable health view; P0 findings surface without SQL | M | `reconcile_payments()` (Phase 5), `payment_audit_log` (Phase 4) |
| 2 | **Daily reconciliation cron + `reconciliation_findings` table + Slack on P0** | Trends, not point-in-time; alerts on new overlapping/duplicate invoices | S | `reconcile_payments()`, `pg_cron`, `slack-notify` |
| 3 | **"Verify this payment" button** in the admin invoice/booking view | One click → `verify-mollie-payment` (the sanctioned replay) instead of hand-calling the fn | S | `verify-mollie-payment` edge fn |
| 4 | **"Re-link guest to account" admin action** | §11 recovery without raw SQL; idempotent | S | `link_guest_data_to_profile` RPC |
| 5 | **"Resend invoice email (force)" button** + suppression/bounce indicator | §7 without calling the API by hand; shows why a send was skipped | S | `send-invoice-email` + `email_delivery_events` + `is_email_suppressed` |
| 6 | **Scoped Mollie refund helper** — an admin action that refunds ONE payment via the Mollie API, records the reason, and flags the DB record | §4/§5/§6/§10 escalations are currently "log into the Mollie dashboard"; a scoped, audited in-app refund is safer + traceable. **Money-movement — must be explicitly approved + permission-gated** | M | Mollie API + the connected-account tokens |
| 7 | **Charge-org vs confirm-org audit view** — join `payment_audit_log` on `mollie_payment_id`, show `recipient_type`/`mollie_org_id` at charge vs confirm | Makes an F3 mis-route (Invariant #6) detectable at a glance | S | needs the org-id logged on both sides (Phase 4 remaining item #5) |
| 8 | **Cron-health tile** — last run + affected-row count for `release_expired_guest_slot_holds` / `release_expired_rebook_holds` | §9: a growing stale-hold count = a cron problem; today invisible | S | the release crons (add a `cron_run_log`) |
| 9 | **`reconcile-mollie` read-only edge fn** — for the small candidate set from `reconcile_payments()` + the audit-log query, fetch each from Mollie and report (never mutate) | Covers the "Mollie says paid but we don't" gap the DB RPC can't (see reconciliation plan) | M | Mollie API, `reconcile_payments()`, `payment_audit_log` |

## Notes

- **Do not build #6 (refunds) without an explicit product/permissions decision.** Automating money movement is
  the one place where a bug is unrecoverable; it must be permission-gated, audited, and one-payment-at-a-time.
- #1 + #2 are the highest leverage: they turn the Phase 4/5 durability work into something an operator actually
  watches, so incidents are caught by us, not by customers.
- Everything here is **additive** and read-only except #6; none change the payment flows.
