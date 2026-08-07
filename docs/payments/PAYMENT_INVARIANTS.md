# Payment Invariants

Hard rules that must never break on the money path. Each is stated as an assertion, then: **why it
matters**, **where enforced today** (file:line), **existing tests**, **missing tests**, and
**recommended additional enforcement**. Companion: [`PAYMENT_FLOW_MAP.md`](PAYMENT_FLOW_MAP.md).

Severity of a violation: **P0** = money lost / double-charged / cross-tenant leak; **P1** = stuck money
or capacity requiring manual recovery; **P2** = observability/UX degradation.

Legend for the gap column below: 🟢 well-enforced + tested · 🟡 enforced, test gap · 🔴 enforcement or
test gap that should be closed.

| # | Invariant | Status |
|---|---|---|
| 1 | A booking cannot be charged twice | 🟡 |
| 2 | An invoice cannot be paid twice | 🟢 |
| 3 | A paid booking cannot be silently cancelled / downgraded | 🟢 |
| 4 | A cancelled booking cannot be resurrected by a stale webhook | 🟢 |
| 5 | Paid amount must equal invoice total / booking payment sum (± tolerance) | 🟡 |
| 6 | Charge org must equal confirm org | 🟡 |
| 7 | Tenant A can never read/write/pay tenant B's records | 🟡 |
| 8 | Guest and logged-in paths converge to equivalent paid states | 🟡 |
| 9 | Failed payment must not leave permanent ghost capacity | 🟢 |
| 10 | Expired payment holds must release capacity | 🟢 |
| 11 | Public tokens must not expose unrelated PII | 🟡 |
| 12 | Every successful payment is visible in player + academy dashboards | 🟡 |
| 13 | Every money-path failure is logged or alertable | 🟡 |
| 14 | No live edge function requires an undeployed migration column | 🔴 (process) |
| 15 | Payment webhooks are idempotent | 🟢 |

---

## 1. A booking cannot be charged twice 🟡 (P0)

**Why:** double-charging a customer is the worst money bug; it destroys trust and triggers chargebacks.

**Enforced today:**
- Guest re-click: `book_guest_slot_for_payment` / `book_guest_cyclus_for_payment` return the existing
  live hold instead of a new one (`supabase/migrations/20260704150000…`, redefined `…210000`).
- Logged-in: `create-mollie-payment` M-15 idempotency (`create-mollie-payment/index.ts:501-556`) —
  reuse an `open` payment if the amount matches, **refuse** if already `paid` (409), delete-on-drift.
- Mollie payment re-probe on prior `mollie_payment_id` (guest fns): reuse open+matching, cancel stale.

**Existing tests:** `guestSlotBooking.pglite.test.ts` ("re-booking returns SAME live hold"),
`guestCyclusBooking.pglite.test.ts`, `mollieWebhookWriteback.pglite.test.ts` (duplicate paid → 0 rows).

**Missing tests:** concurrent re-click **while the Mollie probe is in flight** (advisory lock is released
before probing → two threads may race the probe — with the shipped deterministic idempotency key both now
converge on ONE Mollie payment; the owed test asserts that convergence). (Corrected 2026-08-08: G2 ✅ —
`mollieIdempotencyKey`, `_shared/mollie-idempotency.ts`.)

**Shipped + remaining:** the deterministic `Idempotency-Key` on `POST /v2/payments` is SHIPPED (all five
charge fns). Remaining hardening: hold the advisory lock across the probe or re-check inside it; add the
concurrent-re-click convergence test.

## 2. An invoice cannot be paid twice 🟢 (P0)

**Why:** double-collecting on one invoice = refund + reconciliation pain.

**Enforced today:** `mollie-webhook` invoice branch atomic UPDATE `status='paid' WHERE status!='paid'
AND status!='cancelled'` with `.select()` returning only transitioned rows (`mollie-webhook/index.ts:432-438`);
`public_token` auto-revoked on paid/cancelled (`trg_revoke_invoice_public_token`); `create-invoice-payment`
reuses the open payment if amount matches (`:277-313`).

**Existing tests:** `mollieWebhookPayment.test.ts` (evaluateInvoicePayment + side-effect gating).

**Missing tests:** explicit "duplicate paid webhook for the same invoice → second delivery transitions 0
rows, no second forward/email".

**Recommended:** add the explicit duplicate-invoice-webhook test. Enforcement is solid.

## 3. A paid booking cannot be silently cancelled / downgraded 🟢 (P0)

**Why:** flipping a `paid` booking back to pending/cancelled loses the paid state → customer paid, no seat.

**Enforced today:** `applyBookingPaymentWriteback` UPDATE carries `.neq('payment_status','paid')`
**unconditionally** (`mollie-webhook-payment.ts:107`) — any out-of-order/stale delivery (open→paid then a
late open) cannot downgrade. Booking cancellation is soft (`status='cancelled'`, never `DELETE`), so the
paid row is preserved.

**Existing tests:** `mollieWebhookWriteback.pglite.test.ts:81-97` (stale open/pending does NOT downgrade paid).

**Missing tests:** webhook arriving **after `verify-mollie-payment` already marked paid** (M-26 race);
out-of-order status sequence (paid → open → failed) on one payment.

**Recommended:** add the verify-vs-webhook race test; confirm `verify-mollie-payment` uses the same
guarded write (it should — `verify-mollie-payment/index.ts:350-361`).

## 4. A cancelled booking cannot be resurrected by a stale webhook 🟢 (P0)

**Why:** a late `paid` webhook on a released/cancelled seat must not re-sell it (would overbook / take money for nothing).

**Enforced today:** `applyBookingPaymentWriteback` `.neq('status','cancelled')` (`mollie-webhook-payment.ts:108`);
`findCancelledPaidBookings` (`:121-127`) detects "money landed on a cancelled booking" and Slack-alerts for
**manual refund** (deliberately not auto-refunded).

**Existing tests:** `mollieWebhookWriteback.pglite.test.ts:139-169` (no-resurrection; strict hold not resurrected).

**Missing tests:** soft-cancel-then-late-paid timing (payment created → hold TTL → `softCancelGuestHolds` →
late paid webhook); the cross-lifecycle case where the player **rebooks a new booking id** on the same slot
before the old webhook arrives (no invariant spans booking ids).

**Recommended:** add the soft-cancel-race test; consider a Mollie **auto-refund** path for the
`findCancelledPaidBookings` case (currently manual) — see `PAYMENT_OPERATOR_TOOL_GAPS.md`.

## 5. Paid amount must equal invoice total / booking payment sum (± tolerance) 🟡 (P0)

**Why:** confirming a mis-priced payment (tampering, rounding drift) books a seat for the wrong money.

**Enforced today:** invoice branch `parseMollieAmountValue(payment) == invoice.total` (`mollie-webhook/index.ts:397-410`);
booking branch `sum(payment_amount) == paid` with tolerance `max(0.01, bookingIds.length*0.01)` (`:668-677`);
client amount is **ignored** server-side (`create-mollie-payment:345-347`); `distributeAmountCents` guarantees
per-booking amounts sum exactly to the charge.

**Existing tests:** `mollieWebhookPayment.test.ts:24-30` (blocks marking paid on mismatch),
`booking-pricing.test.ts` (`amountsMatch`, `distributeAmountCents`).

**Missing tests:** an actual mismatch on a **multi-booking** payment (a booking deleted after payment
creation → fewer rows → sum fails even though money was correct); the `0.01` tolerance is an undocumented
magic number.

**Recommended:** forbid deleting/mutating a `bookings.payment_amount` once `mollie_payment_id` is set
(schema trigger); document the tolerance; add a multi-booking mismatch test.

## 6. Charge org must equal confirm org 🟡 (P0)

**Why:** if the payment is created on academy A's Mollie but the webhook confirms against academy B (or the
trainer's own), the payment **strands** (webhook can't find it) or money routes to the wrong org.

**Enforced today:** `resolveSlotRecipient` (charge) and `resolveAccessToken` (webhook + `verify-mollie-payment`)
apply the **byte-identical** predicate keyed off `slot.academy_profile_id` (Codex F3):
`academy_trainers.eq(trainer).eq(status,active)[.eq(academy_profile_id, slot.academy_profile_id)]` →
academy Mollie if ready, else trainer's own (`_shared/guest-payment.ts:83-141`, `mollie-webhook/index.ts:143-198`,
`verify-mollie-payment/index.ts:114-166`). Invoice payments resolve off `invoice.academy_profile_id` on both sides.

**Existing tests:** `guest-payment.test.ts:48-80` (2-academy WITH hint routes correctly; WITHOUT collapses; single-academy unchanged).

**Missing tests:** **no end-to-end** test that the webhook's `resolveAccessToken` resolves the SAME org the
charge used (only `resolveSlotRecipient` is unit-tested); no test for `academy_profile_id` becoming null/changed
between charge and confirm (trainer removed from academy mid-flight).

**Recommended:** a shared golden test asserting `resolveSlotRecipient` and `resolveAccessToken` return the same
org for the same slot fixtures (extract the predicate into a shared helper so one test covers both); log the
resolved `mollie_org_id` to `payment_audit_log` on both charge and confirm for reconciliation (see #13).

## 7. Tenant A can never read/write/pay tenant B's records 🟡 (P0)

**Why:** cross-tenant access = data breach + money misrouting in multi-tenant software.

**Enforced today:** RLS on `bookings`/`invoices`/`intake_requests`; `create-mollie-payment` validates
`booking.player_id==caller` (`:231`); guest RPCs accept only `guest_player_id` (never a client `player_id` —
`resolveOrCreateGuestPlayer` never attributes an existing player); guests are owner-scoped XOR
(academy/trainer); token-gated public fns derive identity from the token, never the request body; academy
invoices route academy-only (no trainer fallback).

**Existing tests:** `guestPlayers.test.ts` (owner scoping), `bookingFinancialGuard.test.ts` (ownership).

**Missing tests:** **adversarial** — a token holder minting/charging another claimant's bookings (partly
covered by `rebookPublicGatherScope.pglite.test.ts` for rebook); forged `guest_player_id` UUID in an RPC;
trainer booking a slot scoped to an academy they're not in; RLS bypass attempts.

**Recommended:** an adversarial cross-tenant test suite (one file, several attacks); keep asserting identity
is derived server-side from the token/claim, never client input.

## 8. Guest and logged-in paths converge to equivalent paid states 🟡 (P1)

**Why:** the same booking must end `confirmed`+`paid` with an invoice + dashboard visibility regardless of
whether the payer was logged in.

**Enforced today:** both paths converge on the **same** `mollie-webhook` (`applyBookingPaymentWriteback`),
the same `auto-create-invoice` (guest-aware), and — for guests — `link_guest_data_to_profile` relinks
bookings + invoices to `player_id` on signup so they appear in the player dashboard.

**Existing tests:** `playerBookingsLinkedGuest.test.ts` (linked-guest visibility + paid override),
`link_guest_data_to_profile_test.sql`.

**Missing tests:** an end-to-end "guest pays → invoice minted guest-keyed → signup → sees paid booking +
invoice" characterization; the failure case where the signup link trigger crashes (silent orphan).

**Recommended:** add the guest→signup convergence test; a reconciliation check (see #12) that flags guests
with paid bookings but no linkable path.

## 9. Failed payment must not leave permanent ghost capacity 🟢 (P1)

**Why:** ghost `pending`/`payment_pending` rows that never clear silently fill a slot to capacity.

**Enforced today:** guest holds are TTL (`hold_expires_at`), and the capacity predicate **ignores expired
holds** (`hold_expires_at > now()`) so capacity self-heals in real time; `release_expired_guest_slot_holds`
(5-min cron) + `release_expired_rebook_holds` cancel the stale rows; failed-payment webhook cancels the
booking; cycle payment failure soft-cancels via `cancelBookingsAndSync` (A3).

**Existing tests:** `guestSlotBooking.pglite.test.ts` (expired holds don't occupy capacity; sweep cancels
only unpaid), `cyclePayment.test.ts` (rollback-on-failure).

**Missing tests (corrected 2026-08-08):** the authenticated cycle insert IS advisory-locked + seat-counted
by the current trigger (`20260715100000`); the remaining uncovered capacity path is service-role
`finalize_cycle_proposals` (no lock/recount — backlog B-1). A concurrency test is owed when that RPC is
hardened.

**Recommended:** add the lock/count contract inside `finalize_cycle_proposals` (path-appropriate) + a
concurrent-finalize test.

## 10. Expired payment holds must release capacity 🟢 (P1)

**Why:** same as #9 — the TTL is the safety valve for abandoned checkouts.

**Enforced today:** capacity predicate excludes expired holds; the release crons cancel them; the webhook's
`neq('status','cancelled')` guard means a late paid webhook on an already-swept hold cannot resurrect it
(instead → `findCancelledPaidBookings` alert).

**Existing tests:** as #9.

**Missing tests:** race between the sweep and a paid webhook arriving in the same instant.

**Recommended:** add the sweep-vs-webhook race test; monitor `payment_pending` count over time (should not grow).

## 11. Public tokens must not expose unrelated PII 🟡 (P2/P1)

**Why:** `public_token` (invoice) and booking `public_token` grant login-free access; a token must reveal
only its own record.

**Enforced today:** `get-public-invoice` looks up strictly by `public_token`; the token auto-revokes on
paid/cancelled; guest booking pages read one booking by token.

**Existing tests:** `invoiceAccess.test.ts` (revocation), `publicInvoiceGetPublicInvoice.test.ts` (field presence).

**Missing tests:** that a token returns ONLY its own invoice/booking (no sibling data); that a revoked token
is rejected by `get-public-invoice` (currently relies on `decidePublicInvoiceAccess('paid')` to hide the pay
UI rather than hard-rejecting the read).

**Recommended:** have `get-public-invoice` hard-reject a revoked token; add a "token X cannot read invoice Y"
test; document that tokens are UUIDs (unguessable) but non-expiring — the URL *is* the secret.

## 12. Every successful payment is visible in player + academy dashboards 🟡 (P2)

**Why:** if a paid booking/invoice isn't visible, the customer + academy think it failed.

**Enforced today:** paid bookings show for the player (`fetchPlayerBookings` + `get_my_linked_guest_bookings`)
and academy (roster/invoicing UIs, FAM-02 identity coalesce); guest data becomes visible after account claim
(`link_guest_data_to_profile`).

**Existing tests:** `playerBookingsLinkedGuest.test.ts`.

**Missing tests:** guest paid-invoice visibility post-signup end-to-end; the case where the invoice lacks
`guest_player_id` (auto-create failed) so the link can't move it.

**Recommended:** the reconciliation report should flag "paid booking with no visible invoice trail" and
"guest paid invoice with no `guest_player_id`" (see `PAYMENT_RECONCILIATION_PLAN.md`).

## 13. Every money-path failure is logged or alertable 🟡 (P2, partial — corrected 2026-08-08)

**Why:** silent failures = money problems discovered by angry customers, not by us.

**Enforced today (corrected 2026-08-08 — the old "webhook does NOT write payment_audit_log" claim was
stale):** charge fns write `payment_audit_log` (blocked/no-account/mollie-error/success) and Slack; the
**webhook now writes audit rows at 16 call sites** — `webhook_received` on entry (`mollie-webhook/index.ts:108`),
`invoice_marked_paid`/`booking_marked_paid`, `duplicate_webhook_ignored`, `amount_mismatch_blocked`,
`payment_for_unknown_invoice`, `payment_for_cancelled_invoice`/`_booking`, `no_connected_mollie_account`,
`payment_refunded`/`payment_charged_back`, `paid_payment_no_bookings`, `paid_hold_over_capacity`, and the
F05 group-settlement statuses.

**Remaining gaps (the 🟡):** no terminal row for unroutable/missing metadata (`:227-230`; a missing
`paymentId` returns before ANY row, `:101-105`), and NO terminal rows for `failed`/`canceled`/`expired`/
`pending` outcomes — the booking-branch terminal write is paid-gated (`:1026`) and the status vocabulary
has no failed/expired entries. A `webhook_received`-without-terminal-row reconciliation query therefore
flags legitimate failed/cancelled/expired outcomes as stranded — account for that when querying. The
GUEST charge fns' no-account refusals also return 400 with neither an audit row nor Slack
(`create-guest-slot-payment:190`, `create-guest-cyclus-payment:139`, `create-guest-cart-payment:152`).

**Existing tests:** `create-invoice-payment` audit-log writes (partial); `_shared/payment-audit.test.ts`.

**Missing tests:** terminal-row coverage for non-paid outcomes; alert-fired assertions.

**Recommended:** add terminal audit statuses for unroutable-metadata and failed/canceled/expired outcomes
so the stranded-payment query stops mis-classifying them.

## 14. No live edge function requires an undeployed migration column 🔴 (process invariant, P0 if broken)

**Why:** an edge fn that reads/writes a column or RPC not yet applied to prod errors at runtime → payments
break. Migrations and functions **do not auto-deploy** (frontend does).

**Enforced today:** by **process**, not code — the deploy order (migrations → functions), the money-path PR
checklist, and CI's `supabase db reset` gate (validates the migration applies) in
[`../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md`](../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md). Client uses
`as never` casts for not-yet-typed columns/RPCs, so a merge doesn't fail typecheck — which is exactly why the
runtime dependency must be caught at deploy time.

**Existing tests:** `deployDrift.test.ts` (some drift detection); `phase5Deployment.test.ts`.

**Missing tests:** a CI check that greps changed edge fns for column/RPC names introduced by an
unapplied-vs-main migration.

**Recommended:** add a CI lint that fails a PR if an edge-fn diff references a new column/RPC without the
migration in the same PR being marked deploy-ordered; keep the money-path PR checklist mandatory.

## 15. Payment webhooks are idempotent 🟢 (P0)

**Why:** Mollie retries deliveries; a non-idempotent webhook double-mints invoices / double-sends emails /
double-confirms.

**Enforced today:** the atomic-claim pattern — `applyBookingPaymentWriteback` / the invoice UPDATE return only
the rows THIS delivery transitioned; side effects gate on `transitioned.length > 0` (E-15); `forward-invoice`
atomically claims `forwarded_at IS NULL`; side effects swallow errors so a retry re-runs safely.

**Existing tests:** `mollieWebhookWriteback.pglite.test.ts:56-79` (duplicate → 0 rows, group all-or-nothing),
`mollieWebhookPayment.test.ts` (side-effect gating).

**Missing tests:** truly-concurrent duplicate deliveries (two webhooks racing the same claim); `forward-invoice`
externally invoked (manual resend) concurrent with the webhook gate; `verify-mollie-payment` vs webhook race (M-26).

**Recommended:** the concurrency tests above; rely on Postgres row locking (the atomic UPDATE serializes), but
prove it. Enforcement is architecturally sound.

---

## Priority summary for the test + observability work (Phase 3/4)

- **P0 test gaps to close first:** #6 charge==confirm golden; #7 adversarial cross-tenant; #15 concurrent
  duplicate webhook. (#1's idempotency-key half SHIPPED — G2 ✅; the concurrent-probe race test is still owed.)
- **P0 durability gap:** #13 — ~~write `payment_audit_log` from the webhook~~ SHIPPED (16 call sites);
  remaining: terminal rows for non-paid/unroutable outcomes (see #13, corrected 2026-08-08).
- **P1 correctness gaps:** #9 capacity — re-scoped to service-role `finalize_cycle_proposals` (backlog B-1);
  F4 split divisor — ✅ frozen-at-charge by design (G5 Option A, decided + shipped).
- **Process invariant:** #14 — enforce via the deploy checklist + a CI drift lint.
