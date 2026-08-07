# Payment Observability Audit

What money-path telemetry exists today, the gaps, and what this foundation adds. Companion:
[`PAYMENT_INVARIANTS.md`](PAYMENT_INVARIANTS.md) #13, [`PAYMENT_RECONCILIATION_PLAN.md`](PAYMENT_RECONCILIATION_PLAN.md).

## Signals that exist

| Signal | Where | Durable? | Notes |
|---|---|---|---|
| `payment_audit_log` (table) | `create-invoice-payment` (`writeAuditLog`), `create-mollie-payment`, the guest charge fns (inline inserts — e.g. `create-guest-slot-payment/index.ts:71`), and `mollie-webhook` (16 sites via `_shared/payment-audit.ts`; corrected 2026-08-08) | ✅ durable | Charge-side attempts: no-account, no-profile, mollie-error, success. RLS service-role only. Columns: `function_name, invoice_id, booking_id, recipient_type, mollie_org_id, amount, currency, status, error_message, mollie_payment_id, metadata`. |
| Slack alerts (`slack-notify` / `notifySlackEdgeError`) | webhook, charge fns, invoice fns | ❌ ephemeral | Amount mismatch, cancelled-entity, no-account, forward failures. **Best-effort — a Slack outage = no alert.** |
| `console` logs (`logStep`) | every edge fn | ❌ ephemeral | Structured console lines; visible in the Supabase Functions dashboard logs, not queryable historically. |
| `email_delivery_events` (table) | `send-invoice-email`, Resend webhooks | ✅ durable | `sent` / `send_failed` + Resend message id + bounces/complaints. |
| `slot_priority_claims` state | rebook flow | ✅ durable | `invited_at`, `responded_at`, `response_intent` (Slice B), `reminded_at` — a de-facto rebook audit trail. |

## The gap (Invariant #13, P0)

Before this PR the **`mollie-webhook` — the single point where money becomes confirmed — wrote NO durable
audit record.** Its outcomes (paid, duplicate, amount-mismatch, cancelled-entity, no-account) existed only
as console logs + best-effort Slack. So:
- If Slack is down or unmonitored, a stranded/mismatched/cancelled-entity payment is **invisible**.
- There is **no queryable, per-payment trail spanning charge → confirm** — reconciliation (Phase 5) and
  recovery (Phase 6) had nothing durable to join against.

## What this PR adds (low-risk, incremental)

A shared best-effort helper `supabase/functions/_shared/payment-audit.ts` (`writePaymentAuditLog` +
`PaymentAuditStatus` vocabulary) — a thin wrapper over `payment_audit_log.insert` that **never throws**
(a failed audit write must never break a payment). The `mollie-webhook` now writes an audit row at most
outcomes (precision 2026-08-08: NOT every — unroutable/missing metadata and the failed/canceled/expired
paths write no terminal row, and the booking-branch terminal write is paid-gated; see PAYMENT_INVARIANTS
#13 for the exact gaps. Also shipped but missing from the table below: `payment_refunded`/
`payment_charged_back` (:263), `paid_payment_no_bookings` (:912), `paid_hold_over_capacity` (:978)):

| Event (`status`) | Where in `mollie-webhook` |
|---|---|
| `webhook_received` | entry, once per delivery (with `mollie_payment_id`) |
| `no_connected_mollie_account` | M-25 refusal (no token resolved) |
| `payment_for_unknown_invoice` | invoice guard — paid on a deleted invoice |
| `amount_mismatch_blocked` | invoice branch + booking branch (with `expected`/`paid` in `metadata`) |
| `payment_for_cancelled_invoice` | cancelled-invoice guard |
| `payment_for_cancelled_booking` | `findCancelledPaidBookings` (money on a cancelled seat) |
| `invoice_marked_paid` | first (claimed) invoice paid transition |
| `booking_marked_paid` | first booking paid transition (`transitioned > 0`) |
| `duplicate_webhook_ignored` | invoice/booking paid webhook that transitioned 0 rows |
| `member_invoice_cancelled_covered` | group-paid member settlement (F05) — a member's own unpaid rebook invoice cancelled because the captain's full-court payment covers the seat |
| `member_seat_double_collected` | group-paid member settlement (F05) — a member's seat was collected twice (own payment + captain's full-court payment); manual refund |

No payment logic changed — every call is a standalone `await auditLog(...)` at a point that already
logged/returned. Tested: `_shared/payment-audit.test.ts` (inserts the right shape; **never throws** on a
failing insert; the status vocabulary is stable). `deno check` adds zero new errors; the webhook keeps its
2 pre-existing (unrelated) baseline errors.

## Reconciliation queries this unlocks (read-only)

```sql
-- Every money-received-but-not-cleanly-confirmed outcome in the last 7 days (needs manual review):
select created_at, status, mollie_payment_id, invoice_id, booking_id, amount, metadata
from public.payment_audit_log
where status in ('amount_mismatch_blocked','payment_for_cancelled_invoice',
                 'payment_for_cancelled_booking','payment_for_unknown_invoice','no_connected_mollie_account')
  and created_at > now() - interval '7 days'
order by created_at desc;

-- Webhook receipts without a paid terminal row — UNRESOLVED CANDIDATES, not confirmed stranded:
-- failed/canceled/expired/pending payments legitimately have no terminal row today (see
-- PAYMENT_INVARIANTS #13); review each hit against Mollie's own status before treating it as stranded.
select r.mollie_payment_id, r.created_at
from public.payment_audit_log r
where r.status = 'webhook_received'
  and r.created_at > now() - interval '7 days'
  and not exists (
    select 1 from public.payment_audit_log p
    where p.mollie_payment_id = r.mollie_payment_id
      and p.status in ('invoice_marked_paid','booking_marked_paid','duplicate_webhook_ignored')
  );
```

## Remaining observability work (documented, not in this PR)

Ranked, incremental — each is a small follow-up:

1. **Align the guest + rebook charge fns on the shared helper/vocabulary.** `create-mollie-payment`
   and `create-invoice-payment` write audit rows via the shared path; the guest fns write INLINE
   `payment_audit_log` inserts with their own shapes (e.g. `create-guest-slot-payment/index.ts:71` —
   corrected 2026-08-08: they are not audit-silent). Align them (and the rebook fns) on the shared helper +
   `payment_created`/`payment_create_failed` vocabulary. **Value: a uniform charge→confirm join.**
2. **`no_connected_mollie_account` from the charge fns** — they Slack-alert + write some audit rows; align them
   on the shared `PaymentAuditStatus` vocabulary so reconciliation queries are uniform.
3. **`hold_released` / `hold_expired`** — the release crons (`release_expired_guest_slot_holds`,
   `release_expired_rebook_holds`) are SQL cron jobs; emit a durable count (a `payment_audit_log` row or a
   small `cron_run_log`) so a stuck-holds trend is visible.
4. **`reconciliation_mismatch_detected`** — the read-only reconciliation report (Phase 5) should record each
   mismatch it finds so the trend is trackable, not just a point-in-time snapshot.
5. **`mollie_org_id` on both charge + confirm** — log the resolved org id on the charge side AND the webhook
   side so a charge-org != confirm-org drift (Invariant #6) is detectable by joining on `mollie_payment_id`.

Each is deliberately deferred to keep this PR small and the webhook edit minimal + reviewable.
