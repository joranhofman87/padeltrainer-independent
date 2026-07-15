# Payment Flow Map

End-to-end map of every money flow in padeltrainer. Grounded in the code (file:line refs). Companion
docs: [`PAYMENT_INVARIANTS.md`](PAYMENT_INVARIANTS.md) (the rules these flows must never break),
[`PAYMENT_RECONCILIATION_PLAN.md`](PAYMENT_RECONCILIATION_PLAN.md) (detecting drift),
[`PAYMENT_RECOVERY_RUNBOOK.md`](PAYMENT_RECOVERY_RUNBOOK.md) (fixing it),
[`../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md`](../deployment/EDGE_FUNCTION_DEPLOY_SAFETY.md).

> Line numbers are as of the mapping date (2026-07). Treat them as strong hints — the symbol names are
> the durable anchor.

## Shared money-path primitives (used by many flows)

| Primitive | File | Role |
|---|---|---|
| `mollie-webhook` | `supabase/functions/mollie-webhook/index.ts` | THE confirm path. HTTP-status contract (200 = success or deliberate refusal, no retry; 500 = transient, Mollie retries). Booking branch (`metadata.booking_ids`) + invoice branch (`metadata.invoice_id`). |
| `applyBookingPaymentWriteback` | `supabase/functions/_shared/mollie-webhook-payment.ts:98-112` | Atomic guarded UPDATE: `SET paid/confirmed WHERE payment_status!='paid' AND status!='cancelled'`, `.select()` returns only rows THIS delivery transitioned. Enforces idempotency + no-downgrade + no-resurrection in one predicate. |
| `resolveSlotRecipient` (charge) / `resolveAccessToken` (confirm) | `_shared/guest-payment.ts:83-141` / `mollie-webhook/index.ts:143-198` | Recipient resolution. IDENTICAL predicate on both sides keyed off `slot.academy_profile_id` (Codex F3) → charge-org == confirm-org. trainer → active academy membership → academy Mollie (if ready), else trainer's own. |
| `runBookingPaidSideEffects` | `_shared/mollie-booking-paid-side-effects.ts:26-140` | Post-paid side effects (invoice, email, Slack), gated to the FIRST paid transition. Non-fatal (swallows errors so a failed email/invoice never un-does the paid claim). |
| `auto-create-invoice` | `supabase/functions/auto-create-invoice/index.ts` | Mints the invoice from booking rows. Guest-aware (`player_id` OR `guest_player_id`). Split auto-detect, VAT, dedup (`overlaps(booking_ids)` + identity), atomic `next_invoice_sequence` numbering, `forward-invoice` to bookkeeping. |
| `create-invoice-payment` + `PublicInvoicePay` + `get-public-invoice` | `supabase/functions/…`, `src/pages/PublicInvoicePay.tsx` | The **no-login** `/pay/:token` stack (`verify_jwt=false`, token-gated). |
| Booking RPCs | `book_slot_for_payment` (logged-in), `book_guest_slot_for_payment` / `book_guest_cyclus_for_payment` (guest), `respond_to_priority_claim` (rebook) | The **only** mutation boundary that inserts seats. Advisory-locked capacity checks; guest RPCs create TTL `payment_pending` holds. |

Key tables: `bookings` (status/payment_status/hold_expires_at/mollie_payment_id/paid_at), `invoices`
(status/total/booking_ids/public_token/player_id/guest_player_id/academy_profile_id/trainer_id/cycle_id/
rebook_group_id/rebook_cyclus_id/paid_at/forwarded_at), `slot_priority_claims`, `guest_players`,
`academy_mollie_accounts` / `trainer_mollie_accounts`, `academy_trainers`, `intake_requests`,
`payment_audit_log`, `email_delivery_events`, `rate_limits`.

---

## 1. Public single-slot booking (guest, pay-first)

- **Entry:** `PublicAvailabilitySection.tsx` → `GuestBookingDialog` → `create-guest-slot-payment` (`supabase/functions/create-guest-slot-payment/index.ts:74-375`). **Actor:** anonymous guest.
- **DB rows:** `guest_players` (upsert/reuse by email+name+owner — "family rule"), `bookings` (one row, `status='payment_pending'`, `payment_status='pending'`, `guest_player_id`, `hold_expires_at=now()+20min`, `payment_amount`). `mollie_payment_id`+`public_token` stamped after Mollie create.
- **Edge fns/RPCs:** `book_guest_slot_for_payment` RPC (advisory lock on slot, idempotent re-hold, **is_public guard**, whole-slot capacity = `allow_single_booking?max_participants:1`, occupancy counts confirmed/pending/pending_approval + live holds); `resolveOrCreateGuestPlayer`.
- **Mollie:** `resolveSlotRecipient` (academy-first, F3 `slot.academy_profile_id`); server amount = `computeSingleSlotPaymentAmount + sumSlotExtraCosts`; `POST /v2/payments` metadata `{booking_ids:[id], guest_player_id, recipient_type}`; idempotent re-probe (reuse open+matching, cancel stale).
- **Webhook:** booking branch — amount check `sum(payment_amount)==paid`; `applyBookingPaymentWriteback` → paid/confirmed + `hold_expires_at=NULL`; first-paid side effects (invoice + email + Slack).
- **Invoice:** `auto-create-invoice` async post-paid (one invoice, dedup on booking).
- **Email:** confirmation to `guest_players.email` (if provided); trainer via Slack. Non-fatal.
- **Player result:** redirect `/booking/:public_token?status=success`; login-free confirmation page.
- **Academy/trainer result:** Slack `payment_received`; booking confirmed; invoice forwarded to bookkeeping.
- **Failure modes:** not-public → 403; slot full → `slot_full`; no Mollie account → 400; Mollie create fail → soft-cancel hold + alert; hold expiry (>20min) → 5-min sweep cancels; amount mismatch → blocked+Slack; paid on cancelled booking → alert (manual refund); re-click → idempotent (no double charge).
- **Recovery:** TTL sweep releases abandoned holds (capacity self-heals); retry mints fresh payment; paid-on-cancelled → manual refund via Slack alert.
- **Tests:** `src/test/guestSlotBooking.pglite.test.ts` (RPC idempotency/slot_full/is_public/whole-slot/expired-hold); `supabase/functions/_shared/guest-payment.test.ts` (resolveSlotRecipient F3, distributeAmountCents, classifyMollieCreateError). **No end-to-end webhook test.**

## 2. Public whole-cyclus booking (guest, pay-first, atomic)

- **Entry:** same dialog (detects `slot.cyclus_id`) → `create-guest-cyclus-payment` (`…/create-guest-cyclus-payment/index.ts:57-358`). **Actor:** anonymous guest.
- **DB rows:** `guest_players`; `bookings` N rows via `book_guest_cyclus_for_payment` (**all-or-nothing**), each `payment_pending` + `hold_expires_at`, `payment_amount` distributed whole-cents (`sum==cyclus total`), shared `public_token`.
- **Edge/RPC:** RPC does ordered advisory locks on all slots (deadlock-safe), per-slot is_public + capacity, **single-trainer requirement** (all sessions same trainer → charge-org==confirm-org), atomic rollback on any `slot_full`. `distributeAmountCents` splits total.
- **Mollie / Webhook / Invoice / Email:** as flow 1 but N bookings; ONE invoice covering all N; optional `split_payment` (÷ distinct players).
- **Failure modes:** any session not-public/full → whole rollback; mixed/no trainer → 400; split recalc on re-click re-distributes.
- **Tests:** `src/test/guestCyclusBooking.pglite.test.ts` (atomicity + idempotency). **No webhook test.**

## 3. Logged-in player booking (single-slot + cycle)

- **Entry:** `src/pages/BookLesson.tsx` (`handleBook`, single at :465-533, cycle at :358-461). **Actor:** authenticated player.
- **DB rows:** `bookings` (`status='pending'`, `payment_status='pending'`, `payment_amount`); single-slot inserted by `book_slot_for_payment` RPC (Option-A mutation boundary — BookLesson no longer inserts); cycle inserted via `insertBookings` facade then paid.
- **Edge/RPC:** `book_slot_for_payment` (advisory-locked capacity); `create-mollie-payment` (`…/create-mollie-payment/index.ts:134-780`) — **validates `booking.player_id==caller` (:231)**, M-15 idempotency (reuse open / refuse paid / delete-on-drift :501-556), F3 recipient (:349-413), split for cycles (:293-305), amount distributed to sum exactly (:562-575), stamps `mollie_payment_id` (:733); `initiateCyclePayment` wraps rollback-on-failure (`cyclePayment.ts:40-69`).
- **Mollie / Webhook:** as shared; webhook booking branch transitions all `booking_ids`.
- **Invoice / Email:** one invoice per payment (dedup per trainer); one confirmation email (first booking).
- **Player result:** Mollie checkout → `/app/booking-success?booking_id=…`; confirmed+paid; email.
- **Failure modes:** failed payment → not confirmed, soft-cancel for cycles (A3); prior payment → reuse/refuse/cancel; slot full → 409; **cycle insert has no per-slot advisory lock (KEY RISK — concurrent cycle overbook)**; **split-payment divisor race (Codex F4 — no re-division if cohort changes mid-checkout)**.
- **Recovery:** `verify-mollie-payment` (ops manual) re-checks Mollie; `findCancelledPaidBookings` alerts paid-on-cancelled.
- **Tests:** `bookLessonPaymentBookingIds.test.ts`, `cyclePayment.test.ts`, `mollieWebhookWriteback.pglite.test.ts`, `mollie-payment-ready.test.ts`, `bookingFinancialGuard.test.ts`.

## 4. Rebooking — single-player upfront (NO-LOGIN, Slice A)

- **Entry:** rebook invite email YES → `PriorityClaim.tsx` → `acceptClaimAndStartPayment` (`priorityClaims.ts`) routes upfront → `create-rebook-invoice-public` (token-gated, `verify_jwt=false`). **Actor:** guest or logged-in claimant.
- **Flow:** verify `claim_token` → derive identity (`player_id` OR `guest_player_id`) + cyclus server-side → gather claimant's cyclus-wide **non-group** claims → `respond_to_priority_claim` each (marks `claimed`, books seats; strict → TTL holds) → `auto-create-invoice` **full price** over only the claimant's bookings (single identity → no split) → tag `invoices.rebook_cyclus_id` (**A-7 unique index**) → `create-invoice-payment` → return `publicToken`/`checkoutUrl` → `/pay/:token`.
- **Webhook:** invoice branch marks invoice paid + linked bookings confirmed/paid. **Claims are `claimed` at accept, not the webhook.**
- **Failure modes:** double-click → A-7 index conflict → return the winner (no undo of shared bookings); strict + no checkout → server-side cancel+reset; mint failure → non-strict keeps the seat (client shows "reserved"), strict releases.
- **Tests:** `rebookSingleInvoiceDedup.pglite.test.ts` (A-7), `rebookPublicGatherScope.pglite.test.ts` (single-identity/non-group gather), `strictAcceptPayable.test.ts` (client routing). **Design + review:** `docs/audits/SLICE_A_NOLOGIN_REBOOK_PAYMENT_DESIGN.md`.

## 5. Rebooking — single-player deferred / manual invoice

- **Entry:** same, but cycle `rebook_payment_mode='deferred'` → `acceptClaimAndStartPayment` returns `deferred` (claim accepted, no checkout). Invoice minted at cycle start (cron: `generate-cycle-commitment-invoices`, daily) or via the legacy authed `create-rebook-invoice`. **Scan mechanics (F04):** the cron keyset-paginates cycles (`id > cursor`, page 200), stamps fully-drafted cycles `commitment_invoiced_at` so they drop out of the daily scan, stops at a 110s budget and self-reinvokes to drain the tail (alerting if the continuation can't be scheduled); `cycleId` remains an operator override that bypasses the stamp/cursor filters.
- **Pricing:** deferred keeps the ÷headcount **split** (owner decision: full price applies only to the upfront checkout path). **Actor:** claimant.
- **Recovery / result:** invoiced later; paid via `/pay/:token`; webhook confirms.

## 6. Group / captain rebooking

- **Entry:** `PriorityClaim.tsx` group CTA → `createGroupRebookInvoice` → `create-group-rebook-invoice` (token-gated, `verify_jwt=false`, `…/create-group-rebook-invoice/index.ts`). **Actor:** any group member (whoever acts first = "captain").
- **Flow:** `respond_to_priority_claim` books the captain's own seats (teammates stay pending) → ONE full-price invoice (`rebook_group_id`, **unique partial index** = one active invoice/group) → checkout. **Post-payment** `rebook_group_manage` links kept/added members' covered bookings onto the paid invoice, and the webhook's **member settlement (F05)** handles members who self-accepted "just my spot" BEFORE the captain paid: cancels their still-active untagged invoices, covers their unpaid bookings paid-by-captain, best-effort expires their open Mollie checkouts, and Slack+audit-alerts every double-collected seat (`member_invoice_cancelled_covered` / `member_seat_double_collected`).
- **Failure modes:** two captains pay → unique index picks one, loser gets the winner's invoice; strict + no checkout → abort+reset (`:157-168`); captain hold expired → `findCancelledPaidBookings` alert; member pays a settled (cancelled) invoice's stale checkout later → existing `payment_for_cancelled_invoice` manual-refund alert.
- **Tests:** `rebookSingleInvoiceDedup.pglite.test.ts` (structure); `rebookGroupCapacityHolds.pglite.test.ts` (F5 hold-aware capacity).

## 7. Registration / intake invoice

- **Entry:** `CycleRegistration.tsx` → `CycleApplicationForm.tsx` → `submit-guest-intake` (guest, `…/submit-guest-intake/index.ts:68`) OR `create-registration-invoice` (logged-in). **Actor:** guest or logged-in registrant.
- **DB rows:** `intake_requests` (cycle_id, guest/player id, invoice_id, lesson data, `status='new'`); `guest_players`; `invoices` (cycle_id, registration_id, `booking_ids=[]`, `status='sent'`).
- **Edge/RPC:** rate limits (email+cycle 60s / IP 15h / recipient 3h); `mintEventRegistrationInvoice` (`_shared/event-registration-invoice.ts`); **server-side pricing** `computeRegistrationCharge` (`registration-pricing.ts:123-241`, rejects client-forged lesson/duration/price); `next_invoice_sequence`. **Idempotency:** `uniq_live_event_invoice_per_registrant` unique index on `(cycle_id, COALESCE(player_id,guest_player_id)) WHERE cycle_id IS NOT NULL AND status NOT IN (paid,cancelled)`.
- **Mollie / Webhook:** `/pay/:token` → `create-invoice-payment` → webhook invoice branch (amount==invoice.total, atomic paid).
- **Email:** `registration_confirmation_email` with pay URL (non-blocking); admin notification if enabled.
- **Failure modes:** rate-limit → 429; business profile incomplete → **registration saved but NO invoice / no pay link (silent)**; no valid price → no invoice; number collision (3 retries); amount mismatch → blocked+Slack; concurrent double-submit → unique index (small race window).
- **Tests:** `registrations.test.ts`, `registrationPricing.test.ts`, `registration-pricing.golden.test.ts`, `e2e/registration.spec.ts`. **Gap:** no `submit-guest-intake` / concurrent-submit / mint-failure test.

## 8. Manual invoice payment link (`/pay/:token`)

- **Entry:** `src/pages/PublicInvoicePay.tsx:358-871`, `handlePay()` → `create-invoice-payment`. **Actor:** guest or linked player (no login).
- **Read:** `get-public-invoice` (`verify_jwt=false`) resolves invoice + recipient identity (`get_invoice_recipient_identity`).
- **Mollie:** `create-invoice-payment` resolves academy-first (invoice.academy_profile_id — **NO trainer fallback for invoices**), refresh token, `POST /v2/payments` metadata `{invoice_id}`, stores `mollie_payment_id`/`mollie_payment_url`.
- **Webhook:** invoice branch — amount==invoice.total; atomic `status='paid'` (`neq paid`, `neq cancelled`); sync `booking_ids` → confirmed/paid; `forward-invoice` (first claim, `forwarded_at` atomic).
- **Failure modes:** draft → 403; already paid/cancelled → 409; invalid amount → 400; amount mismatch → 200+Slack (no retry); paid-on-cancelled → alert; stale payment → cancel+re-mint; public token auto-revoked on paid/cancelled (`trg_revoke_invoice_public_token`).
- **Tests:** `mollieWebhookPayment.test.ts`, `mollieWebhookMetadata.test.ts`, `publicInvoiceGetPublicInvoice.test.ts`, `create-invoice-payment/index.test.ts`, `e2e/invoice-health.spec.ts`.

## 9. Invoice email send / resend

- **Entry:** `send-invoice-email` (`…/send-invoice-email/index.ts`). **Actor:** academy manager / trainer / service-role.
- **Recipient:** `get_invoice_recipient_identity` (billing_email override > linked profile email > guest email). Duplicate-send guard (2min), suppression check (`is_email_suppressed`), PDF via `generate-invoice` (best-effort), Resend send, `record_email_event`. Test sends restricted to caller's own email.
- **Failure modes:** `no_email` / `email_suppressed` (bypass `force=true`) / `send_failed` (Slack) / `pdf_generate_failed` (send anyway) / unauthorized 403 / `recently_sent` no-op.
- **Recovery:** update `billing_email` override then resend; `force=true` to bypass suppression/window.
- **Tests:** inline auth/ownership; email formatting **not formally unit-tested** (gap).

## 10-14. Mollie webhook — paid / duplicate / failed·cancelled·expired / amount-mismatch / cancelled-entity

All in `supabase/functions/mollie-webhook/index.ts`. **Actor:** Mollie webhook.

- **10 Paid** (`:210`): resolve token (booking→slot→trainer+F3 academy, or invoice lookup) → fetch Mollie payment → booking branch (`applyBookingPaymentWriteback`) or invoice branch (`status='paid'`) → first-claim side effects. Marks matching `slot_priority_claims` `claimed`.
- **11 Duplicate** (`:715-720`): atomic claim UPDATE returns 0 rows → skip side effects → 200. Idempotent by construction.
- **12 Failed/cancelled/expired** (`:607-626`): booking → `payment_status='failed'`, `status='cancelled'`; strict rebook holds released + claim re-offered (`:729-740`, non-fatal); no invoice/email.
- **13 Amount mismatch** (`:668-677` booking / `:397-410` invoice): NO write; Slack alert; **200 (no retry)** — deliberate refusal (M-25). Tolerance `max(0.01, bookingIds.length*0.01)`.
- **14 Paid on cancelled invoice/booking** (`:416-425` / `:500-517`): guard blocks resurrection; Slack alert **"money received, no active booking — manual refund"**. `findCancelledPaidBookings` (`mollie-webhook-payment.ts:121-127`).
- **Tests:** `mollieWebhookWriteback.pglite.test.ts` (paid/duplicate/no-downgrade/no-resurrection/strict-hold/findCancelledPaidBookings), `mollieWebhookPayment.test.ts` (amount + side-effect gating), `mollieWebhookMetadata.test.ts`.

## 15. Academy Mollie missing / not-ready

- **Where:** every charge fn calls `resolveSlotRecipient` / `getAcademyMolliePaymentReadiness` (`_shared/mollie-payment-ready.ts`). Readiness = `onboarding_complete AND charges_enabled AND access_token NOT NULL AND disconnected_at IS NULL` (+ org id not `pending_*`).
- **Behavior:** academy not ready → fall back to **trainer's own Mollie** (bookings) / **400** (invoices — no trainer fallback). No account resolves → charge fn 400 `no_mollie_account` + audit + Slack; webhook → 200 + Slack refusal (M-25, never uses platform key). **Soft-disconnect (F06):** `mollie-disconnect-academy` never deletes the org row — it refuses while unpaid Mollie-linked invoices / live payment holds exist, then stamps `disconnected_at`; the row + tokens survive so late webhooks still settle, all NEW-charge paths refuse, and `mollie-callback` clears the stamp on reconnect.
- **Reason codes:** `no_row`, `onboarding_incomplete`, `charges_disabled`, `missing_access_token`, `disconnected` (F06 soft-disconnect). Mollie 422 → `mollie_not_ready`.
- **Tests:** `mollie-payment-ready.test.ts` (all reason codes). **Gap:** no M-25 webhook-refusal regression test.

## 16. Multi-academy trainer payment routing (Codex F3)

- **Where:** `resolveSlotRecipient` (charge) + `resolveAccessToken` (webhook + `verify-mollie-payment`) apply the **identical** `.eq('academy_profile_id', slot.academy_profile_id)` filter when set. **Invariant: charge-org == confirm-org.** Without it a 2+-academy trainer's `.maybeSingle()` collapses → routes to the trainer's own Mollie (the fixed bug).
- **Tests:** `guest-payment.test.ts:48-80` (2-academy WITH hint → correct academy; WITHOUT → collapse; single-academy unchanged). **Gap:** no end-to-end charge/confirm-mismatch integration test.

## 17. Guest-player invoice / payment flow

- Covered by flows 1, 2, 8. Guest identity = `guest_players` (owner XOR academy/trainer), `resolveOrCreateGuestPlayer` (family rule, never attributes an existing `player_id`). Guest sees `/booking/:token` (login-free). Invoice recipient via `get_invoice_recipient_identity`.

## 18. Linked guest → player account (signup → auto-link)

- **Entry:** signup → auth trigger `link_guest_invoices_on_signup` → `link_guest_data_to_profile(_profile_id)` (`supabase/migrations/20260530190000…`, redefined `20260611220000…`). **Actor:** guest becoming a registered player.
- **Effect:** SECURITY DEFINER; matches unlinked guests by `linked_profile_id` OR email; **`UPDATE bookings SET player_id=_profile_id`** + **`UPDATE invoices SET player_id=_profile_id`** for matching `guest_player_id` (idempotent, never overwrites non-null). Sets `guest_players.linked_profile_id`; inserts player role + trainer follows.
- **Player result:** guest-origin paid bookings appear in `/my-bookings` (also via `get_my_linked_guest_bookings`, `is_linked_guest=true`, read-only) + invoices in `/my-invoices`.
- **Failure modes:** email collision links all same-email guests (by design, family rule); trigger crash → profile created but unlinked (silent) → re-run `link_guest_data_to_profile` manually.
- **Tests:** `20260530190001_link_guest_data_to_profile_test.sql`, `playerBookingsLinkedGuest.test.ts`.

---

## Cross-cutting recovery patterns

| Situation | Detection | Recovery |
|---|---|---|
| Abandoned/expired hold | capacity predicate ignores expired; `release_expired_guest_slot_holds` / `release_rebook_hold` crons | auto (capacity self-heals); guest retries |
| Paid on cancelled booking/invoice | `findCancelledPaidBookings`; webhook cancelled-entity guard + Slack | **manual refund** via Mollie dashboard |
| Amount mismatch | webhook amount guard + Slack (200, no retry) | manual review + refund/correct |
| Webhook never arrived | booking stuck `pending` | `verify-mollie-payment` (ops) re-checks Mollie |
| Wrong Mollie org (F3) | `payment_audit_log` recipient vs webhook | manual reconciliation/refund |
| Guest can't see paid data | after account claim | re-run `link_guest_data_to_profile` |
| Invoice not forwarded | `forwarded_at` null | `forward-invoice force=true` |

See `PAYMENT_RECOVERY_RUNBOOK.md` for step-by-step procedures.

## Known open risks (feed the invariants + test gaps)

- **Codex F4 split-payment divisor race** (logged-in cycle): divisor fixed at charge time; concurrent booker changes headcount, no re-division. No test.
- **Cycle insert has no per-slot advisory lock** (logged-in): concurrent cycle bookings can overbook.
- **`payment_audit_log` not written by the webhook** (only console + Slack) → no durable webhook audit trail for reconciliation.
- **Rate limits fail open** on DB error (guest flows).
- **Silent registration mint failure** (business profile incomplete) → registrant gets confirmation with no pay link, no Slack alert.
- **No automated Mollie-webhook end-to-end / M-25 refusal / F3 charge-confirm-mismatch tests.**
- **Concurrent re-click during Mollie probe** (guest) could mint two payments.
