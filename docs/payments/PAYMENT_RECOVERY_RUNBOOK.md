# Payment Recovery Runbook

Safe, **manual** operator procedures for money-path incidents. Companions:
[`PAYMENT_RECONCILIATION_PLAN.md`](PAYMENT_RECONCILIATION_PLAN.md) (how to detect these),
[`PAYMENT_FLOW_MAP.md`](PAYMENT_FLOW_MAP.md), [`PAYMENT_OPERATOR_TOOL_GAPS.md`](PAYMENT_OPERATOR_TOOL_GAPS.md).

## Golden rules

1. **Never auto-refund or auto-mutate in bulk.** Money movement is a human decision.
2. **Reads first.** Run `reconcile_payments()` + the queries below before changing anything.
3. **Soft-cancel, never DELETE** a booking/invoice — the paid state and audit trail must survive.
4. **Respect the guards.** The webhook's `payment_status != 'paid'` / `status != 'cancelled'` predicates
   exist so a stale delivery can't corrupt state — don't hand-edit around them.
5. **When money was taken but the seat/invoice is unsafe → escalate for a manual Mollie refund** (Mollie
   dashboard → the payment → Refund). Record the reason.
6. Prefer the **existing tools** (`verify-mollie-payment`, `forward-invoice force=true`,
   `link_guest_data_to_profile`, the release crons) over raw SQL writes.

Find the payment's trail first:
```sql
select * from public.payment_audit_log where mollie_payment_id = '<tr_...>' order by created_at;
select * from public.reconcile_payments() order by severity, check_name;  -- admin
```

---

## 1. Replay / verify a Mollie webhook

**Symptoms:** a payment looks paid in Mollie but the booking/invoice is still pending; no
`invoice_marked_paid` / `booking_marked_paid` audit row.
**Inspect:** `payment_audit_log` for `webhook_received` without a terminal row; the booking/invoice status.
**Do:** call **`verify-mollie-payment`** (the sync verifier — it re-fetches from Mollie and applies the SAME
guarded writeback, so it's idempotent + race-safe against the webhook). This is the sanctioned "replay".
**Do NOT:** hand-set `status='paid'` in SQL (skips the amount/cancelled guards + the side effects).
**Escalate if:** Mollie shows paid but `verify-mollie-payment` refuses (amount mismatch / cancelled) → go to §5 / §4.

## 2. Invoice paid but linked bookings not updated

**Detect:** `reconcile_payments()` → `invoice_paid_bookings_unpaid`.
**Inspect:** the invoice `booking_ids`; each booking's `payment_status`/`status`.
**Do:** re-trigger the webhook's booking sync by calling **`verify-mollie-payment`** for the payment, or (if the
payment is truly done) re-invoke the paid-writeback path. The invoice-branch already syncs `booking_ids`; a
transient failure is retryable.
**Do NOT:** flip only the bookings to paid without confirming the invoice is genuinely paid.

## 3. Bookings paid but invoice unpaid / missing

**Detect:** `reconcile_payments()` → `booking_paid_no_invoice`.
**Inspect:** is it an out-of-band **cash** payment (legitimately no Mollie invoice), or a missing auto-invoice?
**Do:** if an invoice is expected, invoke **`auto-create-invoice`** with the booking ids (it dedups + is
guest-aware). If cash, no action — it's expected.
**Do NOT:** create a second invoice if `auto-create-invoice` already deduped one (check `overlaps(booking_ids)`).

## 4. Duplicate invoice created

**Detect:** `reconcile_payments()` → `overlapping_active_invoices` / `duplicate_rebook_group_invoice`.
**Inspect:** which invoice is paid / has the live `public_token`; the `rebook_group_id` / `booking_ids` overlap.
**Do:** **cancel the LOSER** (`status='cancelled'` — the token auto-revokes via trigger). Keep the paid/active one.
**Do NOT:** delete either; don't cancel the paid one.
**Escalate if:** BOTH are paid (double-charge) → refund one via Mollie (§ golden rule 5) + keep the other.

## 5. Cancelled invoice/booking paid via a stale payment (money taken, seat gone)

**Detect:** `reconcile_payments()` → `cancelled_booking_on_paid_invoice`; webhook Slack alert "money received,
no active booking / CANCELLED invoice"; audit `payment_for_cancelled_invoice` / `payment_for_cancelled_booking`.
**Inspect:** confirm the entity is genuinely cancelled + the Mollie payment is genuinely paid.
**Do:** decide with the academy — either **refund** the payment (Mollie dashboard) OR **re-book + reissue** an
invoice for the same amount and reconcile. The webhook correctly refused to resurrect it.
**Do NOT:** un-cancel the booking/invoice to "make it match" (breaks the no-resurrection invariant).

## 6. Payment amount mismatch

**Detect:** `reconcile_payments()` → `invoice_total_booking_sum_mismatch`; webhook Slack "amount mismatch";
audit `amount_mismatch_blocked`.
**Inspect:** `invoice.total` vs `sum(booking.payment_amount)`; the Mollie paid amount; whether a booking/line
was edited after the payment was created.
**Do:** if the Mollie amount is correct and our record drifted (rare), correct the record + re-verify. If the
Mollie amount is wrong (tampering), **refund + re-book** with the correct amount.
**Do NOT:** force the invoice to paid to clear the alert — the mismatch is the signal.

## 7. Missing invoice email / resend

**Symptoms:** recipient says no email; `email_delivery_events` shows `send_failed` or nothing; or the address bounced.
**Inspect:** `email_delivery_events` for the invoice; the resolved recipient (`get_invoice_recipient_identity`);
`is_email_suppressed`.
**Do:** update the **`billing_email` override** (`academy_player_metadata`) if the address is wrong, then resend.
For a transient failure or a closed 2-min window, resend with **`force=true`**. Suppression (hard bounce) →
fix the address (don't blanket-`force` real bounces).

## 8. Failed invoice PDF generation

**Symptoms:** invoice exists but has no downloadable PDF; `generate-invoice` logged a failure.
**Inspect:** the invoice row; the function log.
**Do:** PDF generation is **non-fatal** — the invoice + payment are unaffected. Regenerate on demand
(re-open/re-send the invoice). No money action.

## 9. Expired / stuck payment holds

**Detect:** `reconcile_payments()` → `stale_hold` (payment_pending, `hold_expires_at` past).
**Inspect:** is `pg_cron` running the release jobs (`release_expired_guest_slot_holds`,
`release_expired_rebook_holds`)? A growing stale-hold count = a cron problem.
**Do:** capacity **self-heals** (the capacity predicate ignores expired holds), so slots are still bookable.
To clean the rows, ensure the cron is enabled; the crons cancel expired `payment_pending` holds. For a
one-off, an admin can cancel the specific stale holds (`status='cancelled'`) — but check the cron first.
**Do NOT:** cancel a hold whose `hold_expires_at` is still in the future (it's an in-flight checkout).

## 10. Wrong Mollie account routing suspected (Codex F3)

**Symptoms:** an academy says a payment didn't arrive; money landed in the trainer's personal Mollie.
**Inspect:** `payment_audit_log` for the payment's `recipient_type` / `mollie_org_id` (charge vs confirm);
the slot's `academy_profile_id`; the trainer's `academy_trainers` memberships.
**Do:** confirm charge-org == confirm-org (the F3 fix ensures both resolve off `slot.academy_profile_id`). If a
past payment mis-routed (pre-fix / data corruption), **reconcile/refund** via Mollie and re-issue. Verify the
edge fns are deployed (see the deploy-safety doc).
**Do NOT:** change `slot.academy_profile_id` on a slot with live payments without understanding the effect on
in-flight webhooks.

## 11. Guest paid but can't see booking/invoice after claiming an account

**Symptoms:** a guest signed up but `/my-bookings` / `/my-invoices` is empty.
**Inspect:** `guest_players.linked_profile_id` for the new profile; whether `link_guest_data_to_profile` ran;
whether the booking/invoice carries the right `guest_player_id`.
**Do:** re-run **`link_guest_data_to_profile(<profile_id>)`** (idempotent — it relinks bookings + invoices by
matching email / `linked_profile_id`). If the email differs (typo), correct `guest_players.email` to the
account's email first, then re-run the RPC. Do **NOT** set `linked_profile_id` by hand — it is never
identity truth (INVARIANTS I-21) and hand-writes bypass the trigger/`person_links` consistency the
RPC + `merge_guest_players` maintain. If the guest has a pending `person_merge_review` row
(split-frozen, I-17), resolve the review instead of linking.
**Do NOT:** copy rows / change `player_id` by hand on paid records — use the linking RPC; reconcile
same-person duplicates only via `merge_guest_players`.

## 12. Rebooking invite clicked YES but payment abandoned

**Symptoms:** a claim shows `response_intent='accept'` (Slice B) but no payment; the seat may be a
`payment_pending` hold (strict) or a confirmed-unpaid booking (non-strict).
**Inspect:** `slot_priority_claims.response_intent` + `status`; the linked booking's status; any active rebook
invoice (`rebook_cyclus_id` / `rebook_group_id`).
**Do:** strict holds expire + re-offer via the cron; non-strict = a reserved commitment (invoice later or the
player can re-click the pay link — the A-7 unique index returns the existing invoice, no double-mint). Send a
reminder (`send-rebook-reminder`) if appropriate.
**Do NOT:** mint a second invoice — the unique index guards it; hand it the existing `public_token`.

## 13. Rebooking invite clicked NO but dashboard still shows pending

**Symptoms:** player declined but the academy view still shows the claim as pending.
**Inspect:** the claim `status` (should be `declined`) + `responded_at`; the dashboard query
(`get_my_pending_priority_claims` filters `status='pending'`).
**Do:** if `status` is genuinely still `pending` (the decline write failed), it can be re-declined via the
claim page or `respond_to_priority_claim(..., 'decline')`. If `status='declined'` but the UI shows pending,
it's a stale read — refresh / check the query, not the data.
**Do NOT:** force-release the seat to public — a single decline does not open the seat (owner rule: only
whole-cycle abandonment releases; the group arranges its own replacements).

---

## Escalation

Any case where **money was taken but the booking/invoice is in an unsafe state** (§4 double-paid, §5
cancelled-paid, §6 real mismatch, §10 mis-route) → **manual Mollie refund** (dashboard → payment → Refund),
record the `mollie_payment_id` + reason in the incident log, and reconcile the DB record to match reality.
Never leave a real payment un-reconciled.
