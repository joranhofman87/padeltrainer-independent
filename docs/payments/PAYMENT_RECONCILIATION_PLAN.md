# Payment Reconciliation Plan

A **non-destructive**, read-only daily safety check that detects payment/booking/invoice drift from local
DB state. Companion: [`PAYMENT_INVARIANTS.md`](PAYMENT_INVARIANTS.md), [`PAYMENT_RECOVERY_RUNBOOK.md`](PAYMENT_RECOVERY_RUNBOOK.md).

## What ships here

**`public.reconcile_payments(_since interval default '30 days')`** — a `SECURITY DEFINER`, admin-gated
(`has_role(auth.uid(),'admin')`), **read-only** RPC (migration `20260705140000`). It runs a set of checks
and RETURNS one row per finding: `(check_name, severity, entity_kind, entity_id, detail jsonb)`. It **never
writes or fixes anything** — it only reports. Proven by `src/test/reconcilePayments.pglite.test.ts` (checks
fire, no rows mutated, non-admin refused).

### Run it

```sql
-- As an admin (RLS/role enforced inside the fn):
select * from public.reconcile_payments();                    -- default 30-day window
select * from public.reconcile_payments(interval '90 days')   -- wider window
  order by severity, check_name;

-- Count by check + severity (dashboard tile):
select check_name, severity, count(*) from public.reconcile_payments() group by 1,2 order by 2,1;
```

## Checks (each maps to an invariant + a recovery)

| check_name | Sev | Detects | Invariant | Recovery |
|---|---|---|---|---|
| `stranded_invoice` | P1 | invoice has `mollie_payment_id` but never reached paid/cancelled (>1h old) | #5/#13 | verify Mollie, mark paid or cancel — runbook §"webhook never arrived" |
| `invoice_paid_bookings_unpaid` | P1 | a paid invoice whose linked booking is still unpaid + not cancelled | #8/#12 | re-run booking writeback — runbook §"invoice paid, bookings not updated" |
| `cancelled_booking_on_paid_invoice` | P1 | a cancelled booking still billed by a paid invoice | #4 | manual refund / reissue — runbook §"cancelled invoice paid" |
| `overlapping_active_invoices` | **P0** | two non-cancelled invoices billing the SAME booking | #1/#2 | cancel the duplicate — runbook §"duplicate invoice" |
| `duplicate_rebook_group_invoice` | **P0** | >1 active invoice for one `rebook_group_id` (unique index should prevent) | #1 | cancel the loser; the index makes this rare |
| `stale_hold` | P1 | expired `payment_pending` hold still occupying capacity (>10min) | #9/#10 | the release cron should clear it — check `pg_cron`; runbook §"stuck holds" |
| `sent_invoice_no_token` | P1 | a sent, payable invoice with no `public_token` → cannot be paid | #11 | regenerate token / resend |
| `invoice_total_booking_sum_mismatch` | P1 | a paid invoice whose total ≠ sum of its booked amounts (beyond tolerance) | #5 | manual review — runbook §"amount mismatch" |
| `booking_paid_no_invoice` | P2 | a booking paid >1 day ago that no active invoice bills | #12 | `auto-create-invoice` for it, or confirm it's an out-of-band cash payment |

## The live-Mollie limitation (documented, out of scope here)

One important check — **"Mollie reports paid but our invoice/booking is unpaid"** — cannot be done from local
DB state alone; it requires calling the Mollie API for each open payment. That is deliberately **not** in
`reconcile_payments()` (a read-only DB RPC must not make external calls, and doing so per-payment is a
rate-limit and secrets concern).

**Two safe ways to cover it without live-querying every payment:**
1. **`payment_audit_log` join** (needs Phase 4's webhook audit deployed): a payment the webhook *received* but
   never marked paid/duplicate is a stranded candidate —
   ```sql
   select r.mollie_payment_id
   from public.payment_audit_log r
   where r.status = 'webhook_received' and r.created_at > now() - interval '7 days'
     and not exists (select 1 from public.payment_audit_log p
       where p.mollie_payment_id = r.mollie_payment_id
         and p.status in ('invoice_marked_paid','booking_marked_paid','duplicate_webhook_ignored'));
   ```
2. **Targeted `verify-mollie-payment`** for the `stranded_invoice` / audit-log candidates only (an operator
   action, not a bulk sweep) — see the recovery runbook.

A future enhancement could add a **read-only** edge function `reconcile-mollie` that, given the small
candidate set from `reconcile_payments()` + the audit-log query, fetches each from Mollie and reports
(never mutates). Scoped, low-volume, and still non-destructive.

## Cadence & wiring (recommended, not in this PR)

- **Daily** `pg_cron` job calling `reconcile_payments()` and writing any findings to a small
  `reconciliation_findings` table (or emitting `reconciliation_mismatch_detected` audit rows) so trends are
  visible, not just point-in-time. Alert (Slack) if any **P0** appears.
- An **admin dashboard tile** running the count-by-check query.
- Do **NOT** auto-fix. Every finding routes to a human via `PAYMENT_RECOVERY_RUNBOOK.md`. Auto-remediation is
  a separate, explicitly-approved effort (money movement / refunds must not be automated without sign-off).

## Owner deploy

Apply migration `20260705140000` (adds the read-only RPC; idempotent `CREATE OR REPLACE`). No edge-fn or
frontend deploy needed. The `payment_audit_log`-based Mollie-strand query additionally needs Phase 4's
`mollie-webhook` redeploy to start populating `webhook_received` rows.
