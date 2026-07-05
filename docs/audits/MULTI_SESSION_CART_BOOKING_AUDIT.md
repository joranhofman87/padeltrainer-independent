# Multi-Session Cart Booking Audit

> Audit + technical design for a "winkelwagen" cart booking flow: a public/guest visitor selects
> several **separate** individual sessions, adds them to a cart, and pays **once** for all of them.
> **Mode: audit/design only — no product code, migrations, or edge functions were written.**
>
> Source of truth: `main` @ `bc397ae9` (P2 fresh-eyes batch, #328), repo `/Users/tom/Cursor/padeltrainer`.
> Re-verified 2026-07-05 with an adversarial claim-by-claim pass (4 parallel code readers) against
> `bc397ae9`; two findings were corrected: the webhook `payment_audit_log` gap is now **closed** (§15),
> and **guests currently receive no post-payment email at all** (§11 — this becomes required v1 work).
> Grounded in the code (file:line refs) and the payment foundation docs
> ([`payments/PAYMENT_FLOW_MAP.md`](../payments/PAYMENT_FLOW_MAP.md),
> [`payments/PAYMENT_INVARIANTS.md`](../payments/PAYMENT_INVARIANTS.md),
> [`payments/PAYMENT_TEST_GAPS.md`](../payments/PAYMENT_TEST_GAPS.md)).
> Line numbers are strong hints; symbol names are the durable anchor.

---

## 1. Executive Summary

**The feature is feasible and low-risk, because cart booking is architecturally ~90% identical to an
existing, hardened, tested flow: the guest whole-cyclus pay-first path**
(`create-guest-cyclus-payment` + `book_guest_cyclus_for_payment`). That flow already does the hard
part — **N bookings, one Mollie payment, one invoice, all-or-nothing, atomic capacity holds, idempotent
webhook, guest identity, charge-org==confirm-org** — for a set of slots. The only thing that makes it a
"cyclus" instead of a "cart" is that the edge function reads the slot set by `cyclus_id` and requires
they share a cyclus. A cart reads an **arbitrary client-supplied slot set** instead, and adds a
**single-recipient-org guard** so the set can still be charged/confirmed against one Mollie account.

**Recommended build:** one new edge function (`create-guest-cart-payment`), one new RPC
(`book_guest_cart_for_payment` — a merge of the two existing guest RPCs), and a client cart layer
(Context + a drawer/summary/checkout dialog). **No changes are required** to the webhook,
`auto-create-invoice`, or `send-invoice-email` — they already accept `booking_ids[]` arrays. The
downstream money path (invoice, dashboard visibility, reconciliation) is reused unchanged. **One small
extension is required in the shared paid-side-effects helper**: today it emails only `player_id`
bookings, so guests get no confirmation email — the cart must add a guest branch (§11).

**On the "nothing reserved until paid" preference:** the audit **recommends against pure Option A**
(no reservation before payment) and **recommends Option B** (short TTL `payment_pending` holds — the
existing model). Option B *satisfies the product intent* ("nothing **confirmed/visible/billed** until
paid") while eliminating a real oversell→refund risk that Option A creates with Mollie. See §4.

**Top risks to accept up front (all pre-existing, not cart-specific):** concurrent re-click during the
Mollie probe (P1, mitigated by the shipped idempotency-key); **guests receive no post-payment email
today** — the paid-side-effects helper resolves the recipient via `player_id` only, so "email contains
all booked sessions" is **new v1 work, not inherited** (§11); the invoice email **body** lists only the
total, not each session (sessions appear on the **PDF/line items**) — acceptable for v1. An earlier
draft flagged "webhook writes no `payment_audit_log`" — that gap was **closed by #328** (§15).

---

## 2. Feasibility Verdict

**Verdict: BUILD IT. Reuse the guest-cyclus stack; do not invent a new money path.**

Evaluated reuse candidates:

| Candidate path | Reuse for cart? | Why |
|---|---|---|
| **Guest single-slot** (`create-guest-slot-payment` + `book_guest_slot_for_payment`) | Partial — capacity/guard rules | Correct per-item semantics (`allow_single_booking?max_participants:1`, `is_public`, `single_booking_not_allowed`), but single-booking only. |
| **Guest whole-cyclus** (`create-guest-cyclus-payment` + `book_guest_cyclus_for_payment`) | **YES — primary template** | Already: N bookings → 1 payment → 1 invoice, atomic all-or-nothing holds, sorted advisory locks, per-slot amount distribution, idempotent re-click, canonical `booking_ids` ordering for the Mollie idempotency-key, single-recipient resolution. `create-guest-cyclus-payment/index.ts:1-377`. |
| **Authenticated `create-mollie-payment`** | Later (logged-in v2) | Validates `booking.player_id==caller` (`:231`); needs a logged-in identity. Not for guest v1. |
| **Public invoice payment** (`create-invoice-payment` + `/pay/:token`) | No (as the primary) | Invoice-first (metadata `{invoice_id}`), not booking-first. Cart is booking-first (metadata `{booking_ids}`). |
| **New cart-specific edge fn + RPC** | **YES** | The thin, correct delta. See §6. |

**Key structural facts that make this safe (verified in code):**

1. `bookings.booking_ids`-style multi-booking is already the norm. `auto-create-invoice` takes
   `bookingIds: string[]` and dedups via the `create_invoice_deduped` RPC (advisory lock + array
   overlap) — `auto-create-invoice/index.ts:32-43,668-742`. `invoices.booking_ids` is `uuid[]`.
2. The webhook booking branch commits **any** `metadata.booking_ids` set atomically and idempotently
   (`applyBookingPaymentWriteback`, `_shared/mollie-webhook-payment.ts:113-140`).
3. The guest-cyclus RPC is **not actually cyclus-coupled** — it takes `(_slot_ids[], _amounts[])` and
   holds each slot with the standard capacity predicate. The cyclus-ness lives only in the edge fn.
4. No existing cart/winkelwagen concept exists anywhere in `src/` (confirmed by search) — clean slate
   on the client, no legacy to unwind.

---

## 3. Recommended V1 Scope

**In scope (v1):**
- Public/guest booking only (no login required).
- Cart of **separate individual sessions** (each a standalone or per-seat session booking).
- **Single recipient org per cart** (all items share one trainer **and** one `academy_profile_id`).
- **All-or-nothing**: all selected sessions booked on payment, or none.
- **Full session price per item** (base price + that item's extra costs), server-authoritative.
- One Mollie payment → one invoice (all sessions as line items) → one confirmation email.
- Short TTL `payment_pending` holds (Option B), reusing the 20-min hold + sweep.
- Clear per-item "no longer available" error at checkout (whole cart refused, nothing charged).

**Out of scope (v1) — deferred with rationale:**
- **Split-payment sessions** — excluded (a cart item charges full price; mixing the ÷capacity split
  model into an arbitrary multi-slot cart re-opens the divisor-drift class of bugs, G5). Reject at add
  and at checkout. See §8.
- **`allow_single_booking=false` cyclus sessions** — cannot be individually booked (the RPC raises
  `single_booking_not_allowed`); route the user to the whole-cyclus flow instead. Standalone
  whole-court slots (`allow_single_booking=false`, `cyclus_id=null`) **are** cartable as a whole-slot item.
- **Mixed-org carts** — a cart spanning >1 trainer/academy must be split into per-org checkouts (or
  blocked). v1: single-org cart. See §9.
- **Logged-in cart** — guest-first; the logged-in variant is a fast follow (§13).
- **Whole-cycle items in a cart** — v1 carts hold individual sessions only; cyclus stays its own CTA.

---

## 4. Recommended Booking/Payment Lifecycle

**Recommendation: Option B — short TTL `payment_pending` holds. Reject pure Option A.**

### Why not Option A ("no reservation until paid")

The product default asked to prefer "nothing reserved until paid" and to *challenge it if it creates a
worse money/refund risk*. It does, with Mollie:

- Between "server creates the Mollie payment" and "paid webhook arrives," there is a **real, minutes-long
  window** (the user is on Mollie's hosted checkout, may use a bank redirect / iDEAL). With no hold,
  **two guests can each pay for the last seat** of the same session. Post-payment the webhook can only
  detect the oversell and **refuse one payment → manual refund** (the existing "paid on cancelled/full"
  path → `findCancelledPaidBookings` → Slack → manual Mollie refund;
  `_shared/mollie-webhook-payment.ts:121-127`). That is exactly the money/refund risk the current
  architecture was built to avoid.
- Option A also has **no post-payment capacity re-check** in the webhook by design (the audit confirms
  the webhook does **not** re-verify capacity — `mollie-webhook` only re-checks *amount*). Under Option A
  the seat is never reserved, so "capacity was fine at pay-time" is never true → oversell is the default
  failure, not the edge case.

### Why Option B satisfies the stated intent anyway

A `payment_pending` hold is **not** a confirmed booking:

- Trainer/academy calendars render only `status IN ('confirmed','pending')` (fetched unfiltered,
  filtered client-side — `AcademyCalendar.tsx:317-358`, `TrainerCalendar.tsx:157-189`) —
  **`payment_pending` is excluded**. A hold is invisible to trainers/academies.
- Player dashboards fetch `player_id` rows; a guest hold has `player_id = NULL`, so it does not surface
  as a "booking" pre-payment either.
- **No invoice and no email** are created until the paid webhook's first transition
  (`shouldRunBookingPaidSideEffects` gates on the atomic claim).
- The hold **auto-expires** (20 min TTL) and capacity **self-heals** — the occupancy predicate ignores
  expired holds and `release_expired_guest_slot_holds` (5-min cron) cancels them.

So "nothing **permanently/visibly/billed** reserved until paid" holds true. The only thing a hold does is
**briefly occupy a capacity seat** so a second guest can't oversell it — which is the safety property we
want. This is the identical, already-shipped behavior of single-slot and cyclus guest booking.

### The chosen lifecycle (per cart checkout)

1. Client posts the selected `slotIds[]` + guest contact to `create-guest-cart-payment`.
2. Server re-reads every slot, re-validates (visibility/tier/org/price/split), recomputes amounts.
3. Server resolves-or-creates one `guest_players` row (family rule).
4. `book_guest_cart_for_payment` RPC: sorted advisory locks over all slots → per-slot capacity check →
   **all-or-nothing** insert of N `payment_pending` holds (`hold_expires_at = now()+20min`,
   `payment_status='pending'`, per-slot `payment_amount`), `amount_includes_extras=true`.
5. Distribute the server total across holds so `sum(payment_amount) == Mollie charge`; stamp a shared
   `public_token`; mint one Mollie payment with `metadata.booking_ids = sorted(bookingIds)` (no
   `invoice_id`); persist `mollie_payment_id` on all holds.
6. Redirect to Mollie checkout.
7. **Paid webhook** (existing, unchanged): amount-sum check → `applyBookingPaymentWriteback` flips all
   holds to `status='confirmed'`, `payment_status='paid'`, `paid_at=now`, `hold_expires_at=NULL` →
   first-transition side effects: auto-create-invoice over all booking_ids + the **guest confirmation
   email (new work — today the helper only emails `player_id` bookings, §11)** + Slack. Duplicate/late
   webhook → 0 rows transitioned → no double effects.
8. **Failed/expired/abandoned** → holds soft-cancelled (edge best-effort) and/or swept by the TTL cron;
   capacity self-heals; no invoice/email.

---

## 5. Architecture Options Considered

| Option | Description | Verdict |
|---|---|---|
| **A. Reuse `create-guest-cyclus-payment` verbatim** | Pass an arbitrary slot set through the existing cyclus fn/RPC. | **Rejected.** The cyclus RPC's per-slot capacity is `(split_payment OR allow_single_booking)?max_participants:1` and it lacks the `single_booking_not_allowed` guard — wrong semantics for individually-booked cart items, and it would silently allow per-seat holds on split sessions we want to exclude. |
| **B. New `create-guest-cart-payment` + new `book_guest_cart_for_payment` RPC** | Clone the cyclus fn/RPC; swap the slot-set source (client `slotIds[]`), apply **single-slot** per-item capacity/guards, add a single-org guard, exclude split. | **RECOMMENDED.** Correct semantics, minimal new surface, reuses all downstream money-path code unchanged. |
| **C. Loop the existing single-slot fn N times** | Call `create-guest-slot-payment` per slot. | **Rejected.** N payments, N invoices, N emails, no atomicity — defeats "pay once," and each failure strands state. |
| **D. Invoice-first (mint invoice, pay via `/pay/:token`)** | Build a cart invoice, then pay it. | **Rejected as primary.** Invoice-first is for pre-existing bills; booking-first (holds → pay → confirm → auto-invoice) is the guest model and keeps capacity reserved during checkout. |

---

## 6. Recommended Architecture

Decision-complete build spec for the next implementation session.

### 6.1 New RPC — `book_guest_cart_for_payment` (mutation boundary)

**Signature** (mirror the cyclus RPC):
```
book_guest_cart_for_payment(
  _guest_player_id uuid,
  _slot_ids uuid[],
  _amounts  numeric[],
  _hold_minutes integer DEFAULT 20,
  _notes text DEFAULT NULL
) RETURNS uuid[]   -- SECURITY DEFINER, search_path=public, service_role only
```

**Body = `book_guest_cyclus_for_payment` (`20260704170000` / `20260706160000`) with two changes:**
1. **Per-slot capacity + guards = the single-slot rules**, not the cyclus rules:
   ```sql
   SELECT CASE WHEN COALESCE(allow_single_booking,false)
               THEN COALESCE(max_participants,1) ELSE 1 END,
          COALESCE(is_public,false), cyclus_id, COALESCE(allow_single_booking,false)
     INTO v_max, v_is_public, v_cyclus_id, v_allow_single
     FROM availability_slots WHERE id = v_slot;
   IF NOT v_is_public THEN RAISE EXCEPTION 'slot_not_public' USING ERRCODE='check_violation'; END IF;
   IF v_cyclus_id IS NOT NULL AND NOT v_allow_single THEN
     RAISE EXCEPTION 'single_booking_not_allowed' USING ERRCODE='check_violation';
   END IF;
   ```
   (Copied from `book_guest_slot_for_payment` in `20260706160000_split_payment_cyclus_capacity.sql`.)
2. Keep everything else identical: sorted `pg_advisory_xact_lock` over all slots, live-hold
   idempotent re-click (return the existing set if the guest already holds every slot), occupancy
   predicate `status IN ('confirmed','pending','pending_approval') OR (payment_pending AND
   hold_expires_at>now())`, all-or-nothing insert (`RAISE slot_full` rolls back the txn), per-slot
   `_amounts[i]`, `status='payment_pending'`, `payment_status='pending'`,
   `hold_expires_at=now()+clamp(hold_minutes)`.

> Alternative: generalize `book_guest_cyclus_for_payment` into `book_guest_slots_for_payment` and have
> both cart and cyclus call it with a capacity-mode flag. Cleaner long-term but touches a live path;
> for v1, a separate RPC is the lower-blast-radius choice.

### 6.2 New edge function — `create-guest-cart-payment` (`verify_jwt=false`)

Clone `create-guest-cyclus-payment/index.ts`; change these steps:

1. **Input:** `{ slotIds: string[], firstName, lastName, fullName?, email, phone, notes? }`.
   Validate: 1 ≤ `slotIds.length` ≤ **N_MAX** (recommend 20 — cap and `log()` if exceeded), dedupe ids,
   email regex, phone required, name required. Same dual fail-open rate limit (IP + email).
2. **Server read** the exact `slotIds` (never trust client fields):
   `select id, trainer_id, academy_profile_id, cyclus_id, price_per_session, start_time, end_time,
   max_participants, allow_single_booking, split_payment, extra_costs, is_public,
   priority_window_ends_at, member_window_ends_at, public_release_status
   from availability_slots where id in (slotIds) and start_time > now()`.
   Any missing/past id → `slot_unavailable` with the offending ids (see §10).
3. **Visibility:** every slot `is_public=true` **and** `resolveSlotTier(...) === 'public'` (reuse the
   cyclus loop). Reject → `slot_not_bookable`.
4. **Single recipient org guard (charge==confirm):** all slots must share one `trainer_id` **and** one
   `academy_profile_id` (treat `null` academy as its own bucket). Else → `mixed_recipient` (client
   splits the cart). This is the cart analog of the cyclus single-trainer guard
   (`create-guest-cyclus-payment/index.ts:125-142`).
5. **Split exclusion:** if any slot `split_payment=true` → reject `split_not_supported` (v1). Also reject
   any `cyclus_id IS NOT NULL AND allow_single_booking=false` → `single_booking_not_allowed` (route to
   cyclus flow). Both are also enforced in the RPC as belt-and-suspenders.
6. **Server pricing (authoritative):** for each slot,
   `itemAmount = computeSingleSlotPaymentAmount(slot, hourlyRate, 1) + sumSlotExtraCosts(slot.extra_costs)`
   (identical to `create-guest-slot-payment`; `_shared/booking-pricing.ts:33-61`). `total = Σ itemAmount`.
   `hourlyRate` is read per-trainer once (single-org cart → one trainer). Reject `total<=0`
   → `invalid_amount`. **No split.**
7. **Guest identity:** `resolveOrCreateGuestPlayer({email,name,phone,owner})` where `owner` =
   `academy_profile_id ? {academyProfileId} : {trainerId}` (all slots share it).
8. **Already-paid guard:** refuse if this guest already has a paid, non-cancelled booking on any of the
   cart's slots (mirror the cyclus guard) → `already_booked` + token.
9. **Hold:** call `book_guest_cart_for_payment(guestPlayerId, slotIds, itemAmounts, 20, notes)`. On
   `slot_full`/`slot_not_public`/`single_booking_not_allowed` → map to the §10 error codes (409/403).
10. **Post-hold:** set `amount_includes_extras=true` on all holds; re-distribute `distributeAmountCents(total, ids.length)`
    onto the returned holds (keeps `sum(payment_amount)==charge` on reuse); stamp shared `public_token`;
    M-15 prior-payment probe/reuse/cancel; mint Mollie with
    `metadata={ booking_ids: sorted(ids), guest_player_id, recipient_type }` (see §10 for the exact
    metadata contract); `Idempotency-Key = mollieIdempotencyKey('gcart'|'gcart:recreate:'+priorId, body)`;
    persist `mollie_payment_id`; audit + Slack `payment_created`.
11. **Return** `{ checkoutUrl, paymentId, token }`. On any post-hold failure: `softCancelGuestHolds`.

### 6.3 Reused downstream (one small extension)

- `mollie-webhook` booking branch (`applyBookingPaymentWriteback`, amount-sum guard, side-effect gate).
- `auto-create-invoice` (accepts `bookingIds[]`, `create_invoice_deduped`, per-session/cyclus line items,
  VAT, extras skip via `amount_includes_extras`).
- `send-invoice-email` (recipient identity, PDF attach, 2-min duplicate-send guard, suppression) —
  reused as-is, but it must now actually be **invoked** for guest carts: nothing auto-triggers it today
  (the only auto-send in the codebase is `create-rebook-invoice/index.ts:117`). See §11.
- **The one downstream edit:** `_shared/mollie-booking-paid-side-effects.ts` resolves the
  confirmation-email recipient via `profiles!bookings_player_id_fkey` (`:70-105`) — guest bookings
  (`player_id=NULL`) silently skip both the email **and** the nested Slack `payment_received` ping.
  Extend it with a guest branch (invoke `send-invoice-email` post-invoice; hoist the Slack ping out of
  the email guard). Done here, it also fixes the standing single-slot/cyclus guest-email P1.
- `get-guest-booking` / `/booking/:token` confirmation page (already token + multi-session aware:
  returns `session_count`).
- TTL sweep, reconciliation RPC, Slack backbone.

### 6.4 Client layer (see §7 for UX)

- `CartProvider` (React Context + `localStorage` persistence) wrapping the public routes in `App.tsx`
  (sibling to `AuthProvider`). Holds `CartItem[]` = a snapshot of the selected `PublicSlot` (id, org
  keys, display fields, indicative price). **Indicative only** — the server reprices.
- Add-to-cart affordance on `PublicSlotRow`; a `BookingCartDrawer`/`BookingCartSummary`; a
  `CartCheckoutDialog` (guest contact form) that calls `create-guest-cart-payment`; a
  `CartUnavailableSlotsWarning` for the §10 stale-slot response.
- Enforce **single-org** at add time (adding a slot from a different trainer/academy prompts "start a
  separate order" or swaps the cart) so the checkout never hits `mixed_recipient`.

---

## 7. UI/UX Requirements

Guest-friendly, mobile-first (matches the mobile-fitness directive). **Do not build yet.**

**Must include:**
- **Selected-sessions summary:** per item — date, start–end time, trainer name, location, court type,
  **price per session** (indicative), and a **remove** control.
- **Running total** (indicative) + a "final price confirmed at checkout" note (server reprices).
- **Cart vs cyclus clarity:** the cart is for **individual sessions**; the whole-cyclus CTA stays a
  distinct button. A cyclus session that can't be individually booked (`allow_single_booking=false`)
  shows "book the whole cyclus" instead of an add-to-cart control.
- **Single-org rule made visible:** if the guest tries to add a session from a different
  trainer/academy, explain they can only pay one provider per order (offer swap / new order).
- **Unavailable-slot warning** (`CartUnavailableSlotsWarning`): after a rejected checkout, mark the
  offending items ("just filled / no longer available"), let the guest remove them and retry. Nothing
  was charged.
- **Mobile checkout:** a drawer/bottom-sheet cart; a single contact form (name/email/phone/notes);
  one "Afrekenen · €X" button → Mollie.
- **Success state:** Mollie redirect → `/booking/:public_token?status=success` (existing multi-session
  confirmation page; shows `session_count`). Clear the cart on success.
- **Failure state:** Mollie failure/cancel returns to a cart page with the items intact and a retry CTA
  (holds may still be live for the TTL, so retry can reuse them via RPC idempotency).

**Recommended component structure (names as proposed):**
`CartProvider` (state) → `BookingCartDrawer` (list + total) → `BookingCartSummary` (line items) →
`CartCheckoutDialog` (contact form + submit) → `CartUnavailableSlotsWarning` (stale-slot surfacing).
`PublicSlotRow` gains an "add to cart" affordance alongside the existing tap-to-book.

---

## 8. Pricing Rules

Audited sources: `price_per_session`, `total_price` (present in `PublicSlot` but **unused** in UI —
do not use it), `extra_costs` (JSON `{description,price,type,vat_rate}[]`), VAT (invoice-side only),
`allow_single_booking`, `max_participants`, `split_payment`, academy/trainer ownership.

**v1 rules (decision-complete):**

- **Charge full session price per item.** For each cart item:
  `computeSingleSlotPaymentAmount(slot, hourlyRate, 1) + sumSlotExtraCosts(slot.extra_costs)`
  (`_shared/booking-pricing.ts:33-61`). `resolveSlotUnitPrice` precedence: `price_per_session` if >0,
  else `hourly_rate/60 × durationMinutes`. **No ÷max_participants per-seat discount** and **no split.**
  - Note: `computeSingleSlotPaymentAmount` *does* return a per-seat price when
    `allow_single_booking && max_participants>1` (it books one of N seats at `price_per_session/max`).
    That is the **correct** individual-session price and is what the single-slot guest path already
    charges — keep it. "Full session price" here means "the full price of booking that one session as an
    individual," matching the single-slot flow exactly.
- **Extra costs:** included in each item's charge (summed), and `amount_includes_extras=true` is set on
  the holds so `auto-create-invoice` does **not** re-append them (`shouldSkipExtrasForPaidExtrasBookings`,
  `booking-pricing.ts:74-81`). Extras are thus in the amount and reflected in the invoice total without
  double-count.
- **VAT:** not shown in guest checkout (payment-only); computed on the invoice per line item
  (`auto-create-invoice/index.ts:413-476`). Unchanged.
- **Should split-payment slots be excluded from cart v1?** **Yes — exclude/reject.** A cart item is a
  full-price individual booking; the split model (÷ court capacity, frozen — G5) is a cyclus concept and
  mixing it into arbitrary multi-slot carts re-opens divisor semantics. Reject `split_payment=true` at
  add-time and at checkout (`split_not_supported`).
- **Should full-slot booking be supported for `allow_single_booking=false`?** **Yes for standalone
  slots** (`cyclus_id=null`): the item is a whole-slot booking (capacity 1, full `price_per_session`),
  exactly like the single-slot flow. **No for cyclus sessions** (`cyclus_id != null`): the RPC raises
  `single_booking_not_allowed` — route to the whole-cyclus flow.
- **Stale price changes:** the **server reprices at checkout** from the live slot rows; the client total
  is display-only and never trusted. If the price changed between add-to-cart and checkout, the guest is
  charged the current server price and sees it on the Mollie page and invoice. (Optional UX: surface a
  "price updated" note if the returned total differs from the indicative one — nice-to-have, not required.)
- **Ownership:** all cart items resolve to one recipient org (§9); pricing uses that org's
  trainer `hourly_rate` where `price_per_session` is absent.

---

## 9. Capacity & Concurrency Rules

**The cart is all-or-nothing.** Yes — mandatory. Either every selected session is held/booked or none.

Mechanisms (all reused from the guest-cyclus RPC, with single-slot per-item semantics):

- **Two players booking the same session:** `pg_advisory_xact_lock(hashtextextended(slot_id))` per slot
  serializes the capacity check+insert; the occupancy predicate counts active bookings + live holds, so
  the second txn sees the first's hold and gets `slot_full`.
- **Overbooking a multi-capacity session:** per-item effective capacity =
  `allow_single_booking?max_participants:1`; the seat count includes live `payment_pending` holds
  (`hold_expires_at>now()`), so N concurrent holds can't exceed capacity.
- **Stale cart booking an unavailable session:** the server re-reads slots at checkout and the RPC
  re-counts under lock; a since-filled or since-hidden slot → `slot_full`/`slot_not_public` → whole cart
  refused, nothing charged (§10).
- **Partial availability (one of the selected sessions gone):** all-or-nothing — the RPC `RAISE`s and the
  entire transaction rolls back; **zero** holds created, guest not charged. The edge fn returns the
  offending id(s) so the UI can prune and retry.
- **Race during payment/webhook:** the hold reserves the seat for the whole checkout window (§4), so the
  webhook's paid transition can't oversell. Duplicate/late webhook → `applyBookingPaymentWriteback`
  transitions 0 rows → idempotent. Hold-expiry-vs-paid race → `neq('status','cancelled')` guard →
  `findCancelledPaidBookings` alert → manual refund (pre-existing G8).
- **Deadlock safety:** slots are locked in **sorted id order** (matches the cyclus RPC), so two carts
  with overlapping slots can't deadlock.

**Multi-slot mismatch to watch (pre-existing, not cart-specific):** if a slot's `payment_amount` row is
deleted/mutated after payment creation, the webhook's `sum(payment_amount)==paid` guard fails even though
money was correct (invariant #5 missing test). Cart increases the surface (more rows per payment) — do
**not** delete/mutate cart holds once `mollie_payment_id` is set; rely on soft-cancel (which the webhook
guard tolerates) not delete.

---

## 10. Security / Anti-Cheat Rules

**Everything a cart checkout needs is derived server-side; the client is trusted for nothing except the
list of slot ids and its own contact details.**

The client **must not be trusted** for any of:

| Value | Server-authoritative source |
|---|---|
| Price per session / extras / **total amount** | Re-read from `availability_slots` + `trainer_profiles.hourly_rate`; `computeSingleSlotPaymentAmount + sumSlotExtraCosts`. Client total ignored. |
| Which org gets paid (`trainer_id`, `academy_profile_id`, recipient type) | Read from the slot rows; `resolveSlotRecipient` (academy-first XOR). |
| Slot visibility / tier (`is_public`, priority/member windows) | Re-checked (`is_public===true` + `resolveSlotTier==='public'`) in edge **and** RPC. |
| Slot availability / capacity | Re-counted under advisory lock in the RPC. |
| `split_payment`, `allow_single_booking`, `max_participants`, `cyclus_id` | Read from the slot; drive exclusion/capacity/guards. |
| Guest identity (`guest_player_id`, `player_id`) | Created server-side via `resolveOrCreateGuestPlayer`; **never** an existing `player_id` (anti-impersonation). |
| Mollie metadata (`booking_ids`, `recipient_type`) | Built server-side from the RPC's returned ids; the webhook re-resolves the org from the slot, not from metadata. |
| Booking/invoice linkage | `metadata.booking_ids` set from RPC output; invoice minted server-side from those ids. |
| `public_token`, `mollie_payment_id`, `payment_status`, `hold_expires_at` | Server-stamped only. |

**Additional guards:**
- **Single-org enforcement** (`mixed_recipient` refusal) *is* a security control — it guarantees
  charge-org == confirm-org (invariant #6), preventing money misroute across tenants.
- **Rate limiting:** reuse the dual fail-open IP+email throttle (`throttleGuestPayment`).
- **N_MAX cap** on cart size to bound abuse and Mollie body size.
- **Idempotency-Key** on the Mollie POST (canonical sorted `booking_ids`) prevents a timeout-retry from
  minting a second payment (G2).

---

## 11. Invoice & Email Requirements

**Can `auto-create-invoice` handle arbitrary selected booking ids? Yes, already.**
`bookingIds: string[]` input; `booking_ids` is `uuid[]`; dedup via `create_invoice_deduped` (advisory
lock + `booking_ids && v_booking_ids` overlap). No change needed.

- **Will invoice line items show every session clearly?** Yes. The builder emits **per-session line
  items** with date-stamped descriptions when prices are mixed or slots aren't a single uniform cyclus
  (`auto-create-invoice/index.ts:295-344`). A cart of arbitrary/standalone slots takes the per-session
  path → one line per session. **Verified in code:** the cyclus-bundling branch requires ALL bookings to
  share one identical non-null `cyclus_id` (`auto-create-invoice/index.ts:267`); any mixed set
  (different cycli and/or standalone `cyclus_id=null` slots) falls through to one date-stamped line per
  session (`:317-334`). Keep the §16 regression test.
- **Are `booking_ids` enough?** Yes — the whole downstream path keys off the array.
- **VAT / extras correct?** Yes. VAT is computed per line item on the invoice; extras are already baked
  into `payment_amount` and skipped by `amount_includes_extras=true` (no double-count).
- **Will the player receive the correct email?** **NO — not without new work.** On the paid transition,
  `runBookingPaidSideEffects` resolves the confirmation-email recipient via
  `profiles!bookings_player_id_fkey` (`_shared/mollie-booking-paid-side-effects.ts:70-105`); for a guest
  booking (`player_id=NULL`) the guard fails silently and **no email is sent at all**, and nothing
  auto-invokes `send-invoice-email` (only `create-rebook-invoice/index.ts:117` does, in its own flow).
  Guests today get only the on-screen `/booking/:token` confirmation. This is the standing
  guest-confirmation-email P1 from the public-booking audit — and since the cart requirements mandate
  "email contains all booked sessions," **v1 must add it**: extend the shared side-effects helper with a
  guest branch that invokes `send-invoice-email` for the freshly minted invoice (recipient resolution via
  `get_invoice_recipient_identity` already handles guests; the PDF lists every session; the 2-min
  duplicate-send guard protects against webhook races). Done in the shared helper, this fixes the
  existing single-slot and cyclus guest flows for free.
  **Body caveat (accepted for v1):** the email **HTML body** shows only invoice number/date/**total**/VAT
  + a view button — it does **not** itemize sessions inline (`send-invoice-email/index.ts:352-398`);
  sessions are itemized on the attached **PDF** (`generate-invoice/index.ts:96-106` renders every
  line-item row). *Optional enhancement:* add a session list to the email body.
- **Should trainer/academy be notified?** Yes — but note the gap: the booking-branch Slack
  `payment_received` ping is **nested inside the player-email guard**
  (`mollie-booking-paid-side-effects.ts:91-137`), so it **never fires for guest bookings** today (only
  `payment_created` at mint time does, from the create-guest-* functions; the `payment_received` at
  `mollie-webhook/index.ts:527-544` is the invoice branch). When adding the guest email, hoist the Slack
  ping out of the email guard so guest cart payments ping `payment_received` too. Bookings appear on
  trainer/academy calendars once `confirmed` regardless.
- **Subject/body:** reuse the invoice email template (subject `Invoice <number> from <business>`). If a
  cart-specific confirmation is desired, keep the existing template; the differentiator is simply that
  the PDF has N lines.

---

## 12. Dashboard Visibility Requirements

Exact final states for a cart booking to appear everywhere (from the dashboard audit;
`playerBookings.ts`, `*Calendar.tsx`, `*Invoices.tsx`, `AcademyDashboard.tsx`).

**Per-booking target state after paid webhook** (`applyBookingPaymentWriteback` sets these):

| Column | Value | Notes |
|---|---|---|
| `status` | `confirmed` | Was `payment_pending` (hold). Required for trainer/academy calendars (`status IN ('confirmed','pending')`). |
| `payment_status` | `paid` | Triggers the player-dashboard payment override. |
| `payment_amount` | per-item server amount | `Σ == invoice.total == Mollie charge`. |
| `paid_at` | `now()` at webhook | Set on paid transition. |
| `hold_expires_at` | `NULL` | Cleared on commit. |
| `guest_player_id` | the guest | `player_id` stays `NULL` until account claim. |
| `mollie_payment_id` / `mollie_transaction_id` | set | routing + reconciliation. |

**Per-invoice target state** (`auto-create-invoice` when all bookings paid):

| Column | Value |
|---|---|
| `status` | `paid` (also `sent_at`, `paid_at` stamped) |
| `booking_ids` | `uuid[]` of **all** cart bookings |
| `academy_profile_id` / `trainer_id` | the single recipient org |
| `guest_player_id` | the guest (enables post-signup linking) |
| `total` | `Σ payment_amount` |

**Where it shows (given the above):**
- **Player bookings (guest, pre-claim):** not visible until the guest signs up; then
  `link_guest_data_to_profile` relinks `guest_player_id → player_id` and `get_my_linked_guest_bookings`
  surfaces them (`is_linked_guest=true`, read-only). Post-signup: upcoming tab shows future,
  non-cancelled; payment override forces `paid`/`confirmed`.
- **Player invoices:** after claim, via `get_my_paid_booking_ids` / `invoices.player_id`.
- **Trainer calendar & Academy calendar:** immediately on `confirmed` (both fetch bookings unfiltered
  and keep only `confirmed`/`pending` client-side — `AcademyCalendar.tsx:317-358`,
  `TrainerCalendar.tsx:157-189`; `guest_player_id` rows included). Needs valid `slot_id` +
  `start_time`/`end_time`.
- **Academy dashboard "recent bookings":** shows all statuses (no filter), grouped by cyclus+player.
- **Trainer/Academy invoices:** the one cart invoice in the `paid` tab; `booking_ids` joins the sessions.

**Pre-payment holds** are intentionally invisible on trainer/academy calendars (`payment_pending`
excluded) — the desired "not reserved-looking until paid" behavior.

---

## 13. Guest vs Logged-In Behavior

**Recommendation: guest-first (guest-only v1), logged-in as a fast follow.**

- **Guest identity** stored in `guest_players` (owner-scoped XOR: `academy_profile_id` or `trainer_id`),
  created by `resolveOrCreateGuestPlayer` (family rule: match by normalized name within owner scope,
  never attach to an existing `player_id`).
- **Public booking token:** one shared `public_token` across all cart bookings → login-free confirmation
  at `/booking/:token` (the page already reports `session_count`). Token auto-context via
  `get-guest-booking`.
- **Account claim/linking:** on later signup, the `link_guest_data_to_profile` trigger relinks matching
  `guest_player_id` bookings **and** invoices to the new `player_id` (by email/`linked_profile_id`).
  Cart bookings then appear in `/my-bookings` + `/my-invoices` with no cart-specific work.
- **Invoice visibility later:** identical to today's guest→player convergence (invariant #8); the cart
  invoice already carries `guest_player_id`, so the link moves it.
- **Logged-in v2:** add a cart mode to the authenticated path routed through `create-mollie-payment`
  (which validates `booking.player_id==caller`), reusing the same cart RPC with `player_id` semantics
  (`status='pending'`, no TTL hold) — but note the **logged-in cycle path lacks a per-slot capacity lock
  today (G6)**; the cart RPC would actually be *safer* than the current logged-in cycle insert. Defer to
  v2 to keep v1 blast radius small.

---

## 14. Failure Modes & Recovery

| Failure | Behavior | Recovery |
|---|---|---|
| **Abandoned checkout** | Holds sit `payment_pending` until TTL (20 min). | `release_expired_guest_slot_holds` sweeps; capacity self-heals. |
| **Failed payment** | Webhook sets all holds `payment_status='failed'`, `status='cancelled'`; no invoice/email. | Guest retries → fresh holds (or reuse if still live). |
| **Expired payment** | Same as failed; TTL already released capacity. | Retry. |
| **Duplicate webhook** | `applyBookingPaymentWriteback` transitions 0 rows → side effects skipped. | None needed (idempotent). |
| **Late webhook (after sweep cancelled holds)** | `neq('status','cancelled')` guard blocks resurrection → `findCancelledPaidBookings` Slack alert. | **Manual Mollie refund** (money landed, seats gone). Pre-existing G8. |
| **Amount mismatch** | Webhook `sum(payment_amount)==paid` (tolerance `max(0.01, n*0.01)`) fails → no write, Slack, **200 no-retry**. | Manual review/refund. |
| **One selected slot unavailable at checkout** | RPC `slot_full`/`slot_not_public` → whole cart refused, **nothing charged**. | UI prunes the item (`CartUnavailableSlotsWarning`) and retries. |
| **Invoice creation fails after payment** | Bookings stay `paid`/`confirmed`; `auto-create-invoice` error is non-fatal (Slack). | `reconcile_payments` → `booking_paid_no_invoice`; re-run `auto-create-invoice` (runbook). |
| **Email fails after payment** | Non-fatal; booking still paid. (Note: for guests the email must first exist — §11 adds it.) | Resend via `send-invoice-email` (`force=true` bypasses window/suppression). |
| **Mollie account unavailable/not ready** | Edge returns `no_mollie_account` / `missing_mollie_profile` **before** minting; holds soft-cancelled. | Academy completes Mollie onboarding. |
| **Stale cart (slot deleted/hidden since add)** | Server read drops it → `slot_unavailable` with ids; or RPC `slot_not_public`. | UI prunes + retry. |
| **Browser back / retry** | RPC live-hold idempotency returns the same set; Mollie idempotency-key + open-payment probe reuse the same checkout. | No double charge. |
| **Double-click checkout** | Same idempotency (RPC + Mollie key). **Residual (pre-existing, P1):** two clicks *while the Mollie probe is in flight* could mint two payments (advisory lock released before probe). Mitigated by the shipped idempotency-key; a true concurrency test is still a gap (invariant #1). | Disable the button on submit (client) as belt-and-suspenders. |
| **Mixed-org cart reaches server** | `mixed_recipient` refusal (client should prevent). | UI splits into per-org orders. |

---

## 15. Observability Requirements

Reuse the payment observability substrate; extend the vocabulary for cart events.

**Already covered:** `create-guest-*-payment` write `payment_audit_log`
(`success`/`error`/`blocked_no_profile`) + Slack `payment_created`; `send-invoice-email` delivery
tracking; `reconcile_payments` checks (`stale_hold`, `booking_paid_no_invoice`,
`overlapping_active_invoices`, …).

**Add for cart (recommended):**
- `payment_audit_log` rows from `create-guest-cart-payment` with `metadata={ sessions: n, cart: true }`
  on `success`/`error`/`blocked_no_profile`/`mixed_recipient`/`split_not_supported`/`slot_unavailable`.
- Slack `payment_created` with `type:'guest_cart'`, `sessions:n`, org, amount (mirror the cyclus Slack).
- Log (not just refuse) when a cart is truncated by **N_MAX** or when items are dropped as unavailable —
  silent truncation reads as "we booked everything."
- **Invariant #13 update — the webhook audit gap is CLOSED (shipped in #328, after the first draft of
  this audit):** `mollie-webhook` now writes `payment_audit_log` rows for `webhookReceived`
  (`index.ts:245`), `bookingMarkedPaid`/`duplicateWebhookIgnored` (`:799-806`), `amountMismatchBlocked`
  (`:748` booking branch, `:475` invoice branch), `paymentForCancelledBooking` (`:726`),
  `invoiceMarkedPaid` (`:524`), and refund/chargeback reversals via `detectPaymentReversal`
  (`:400-417`, `_shared/mollie-webhook-payment.ts:243-282`). Cart payments inherit full end-to-end
  webhook auditability at no extra cost — nothing to build here.
- **Remaining Slack gap that DOES affect carts:** the booking-branch `payment_received` ping never fires
  for guest bookings (nested inside the player-email guard, §11) — fix alongside the guest email.

**Reconciliation:** cart bookings are covered by the existing checks (they are just multi-`booking_ids`
invoices). Confirm `overlapping_active_invoices` and `invoice_total_booking_sum_mismatch` behave on a
large `booking_ids` set (they use array overlap / sum — should be fine; add to the test matrix).

---

## 16. Required Tests

Tests that **block** implementation are marked ⛔. Others are strongly recommended.

**Unit (client):**
- Cart reducer/Context: add/remove/dedupe; single-org enforcement (adding a different-org slot is
  blocked/swaps); indicative total; persistence round-trip.

**Unit (edge/shared, Deno):**
- ⛔ Server pricing parity: `computeSingleSlotPaymentAmount + sumSlotExtraCosts` per item == the amount
  minted; split/extras handling.
- ⛔ Single-org guard: mixed `trainer_id` or mixed `academy_profile_id` → `mixed_recipient`.
- ⛔ Split exclusion: any `split_payment=true` → `split_not_supported`.
- Mollie idempotency-key: canonical sorted `booking_ids` → stable body across retry.

**PGlite / database (mirror `guestCyclusBooking.pglite.test.ts`, `guestSlotBooking.pglite.test.ts`):**
- ⛔ **Select 3 available slots, pay once → 3 `confirmed`/`paid` bookings + 1 invoice with all 3
  `booking_ids`** (end-to-end via the writeback + auto-create-invoice libs).
- ⛔ **All-or-nothing:** one of the 3 slots full → RPC rolls back → **0 holds**, guest not charged.
  Parametrize which slot (first/middle/last) is full (G9-style).
- ⛔ **Concurrency:** two carts contending for the last seat of a shared slot → exactly one succeeds.
- ⛔ **Idempotent re-click:** re-calling the RPC with live holds returns the **same** id set (no second
  set, no second payment).
- ⛔ **`single_booking_not_allowed`:** a cyclus session with `allow_single_booking=false` in the cart is
  rejected.
- ⛔ **`slot_not_public`:** a private/tier-restricted slot in the cart is rejected.
- **Whole-slot item:** standalone `allow_single_booking=false` slot → capacity 1, full price, booked.
- **Hold expiry:** expired holds don't occupy capacity; sweep cancels only unpaid.

**Webhook (reuse `mollieWebhookWriteback.pglite.test.ts` patterns):**
- ⛔ **Duplicate webhook** on a cart payment → second delivery transitions 0 rows, no second
  invoice/email.
- ⛔ **Amount-sum** over N cart bookings (tolerance `max(0.01, n*0.01)`); mismatch blocks the commit.
- Hold-expiry-vs-paid race → no resurrection + `findCancelledPaidBookings` flags it (G8).

**Invoice/email:**
- ⛔ **Heterogeneous cart** (mixed `cyclus_id` + standalone) → invoice has one clear line per session,
  correct VAT/extras, `total == Σ payment_amount`.
- ⛔ **Guest email:** after the paid transition of a guest cart, exactly ONE email reaches the guest
  (recipient via `get_invoice_recipient_identity`), with the PDF listing all N sessions; a duplicate
  webhook does not re-send (2-min guard). (New behavior — §11/Phase 4.)
- Duplicate-send guard holds for the cart invoice email.

**Component:** cart drawer add/remove/total; `CartUnavailableSlotsWarning` renders on `slot_unavailable`;
success clears the cart.

**E2E (valuable, not blocking):** select 3 → checkout → (mocked Mollie) success → confirmation page
shows 3 sessions; a taken-before-checkout slot shows the clear error and nothing is charged.

**Anti-cheat (⛔, adversarial — extends G7):** forged client total ignored; forged `guest_player_id`
rejected; hidden/private slot rejected; cross-tenant slot rejected; `mixed_recipient` refusal.

---

## 17. Implementation Phases

1. **Phase 0 — DB:** add `book_guest_cart_for_payment` migration (clone cyclus RPC + single-slot
   capacity/guards). Ship with the PGlite RPC tests. *Deploy: migration first (no live consumer yet).*
2. **Phase 1 — Edge:** `create-guest-cart-payment` (clone cyclus fn; slot-set from client; single-org +
   split guards; server pricing; idempotency-key `gcart`). Deno unit tests. *Deploy after the migration.*
3. **Phase 2 — Client cart state:** `CartProvider` (Context + localStorage), single-org enforcement,
   add/remove on `PublicSlotRow`. Unit tests.
4. **Phase 3 — Cart UI:** `BookingCartDrawer` / `BookingCartSummary` / `CartCheckoutDialog` /
   `CartUnavailableSlotsWarning`; wire to the edge fn; success/failure states. Component tests.
5. **Phase 4 — Guest confirmation email (REQUIRED) + verification:** extend
   `_shared/mollie-booking-paid-side-effects.ts` with a guest branch (invoke `send-invoice-email` for
   the minted invoice; hoist the Slack `payment_received` ping out of the player-email guard). Also
   fixes the standing single-slot/cyclus guest-email P1. Add the duplicate-webhook, amount-sum,
   heterogeneous-invoice and guest-email tests; verify dashboards render cart bookings.
6. **Phase 5 — Observability (recommended):** cart audit-log/Slack events (`payment_created` with
   `type:'guest_cart'`, N_MAX truncation logs). The webhook `payment_audit_log` backbone already
   shipped in #328 — nothing to build there.

Deploy order matters (migrations → functions → frontend; functions/migrations don't auto-deploy). Keep
the money-path PR checklist (`EDGE_FUNCTION_DEPLOY_SAFETY.md`).

---

## 18. Open Questions

1. **N_MAX cart size?** Recommend 20 (Mollie body + abuse bound). Owner to confirm.
2. **Mixed-org UX:** hard-block adding a second org, or maintain **per-org carts** with sequential
   checkouts? Recommend hard single-org cart in v1 (simplest, safe).
3. **Email body itemization:** v1 gives the guest the invoice email (new — §11) with sessions itemized
   on the PDF only; add a session list to the email body too? (Enhancement, low effort.)
4. **Price-changed-since-add UX:** silently reprice (recommended) vs. show a "price updated, confirm"
   step?
5. **Should abandoned holds be shortened for carts** (e.g. 15 min) to free popular seats faster, or keep
   the 20-min standard? Recommend keep 20.
6. ~~Webhook audit gap (invariant #13)~~ — **RESOLVED since the first draft:** #328 shipped the webhook
   `payment_audit_log` events (received/paid/duplicate/mismatch/reversal — §15). No decision needed.

---

## 19. P0 / P1 / P2 Risks

**P0 (money/cross-tenant — all mitigated by reusing the hardened path; verify with tests):**
- Charge-org ≠ confirm-org → money misroute. **Mitigated:** single-org guard + `resolveSlotRecipient`
  parity (invariant #6). ⛔ test `mixed_recipient` + charge/confirm parity.
- Client price/total tampering. **Mitigated:** server reprices; client ignored. ⛔ anti-cheat test.
- Oversell → forced refund (the Option A risk). **Mitigated:** Option B holds (§4).
- Double-charge on retry. **Mitigated:** RPC live-hold idempotency + Mollie idempotency-key.

**P1 (stuck money/capacity, manual recovery):**
- Concurrent re-click during the Mollie probe mints two payments (pre-existing, invariant #1). Mitigated
  by idempotency-key + client button-disable; true concurrency test still a gap.
- Hold-expiry-vs-paid race → paid-on-cancelled → manual refund (pre-existing G8). Reconcilable.
- **Guests receive no post-payment email today** (`runBookingPaidSideEffects` emails via `player_id`
  only; nothing auto-invokes `send-invoice-email`) — pre-existing P1 that the cart requirement "email
  contains all booked sessions" turns into **required v1 work** (§11 / Phase 4).
- Logged-in cart deferred partly because the logged-in cycle path lacks a capacity lock (G6) — v1 avoids
  it by staying guest-only.

**P2 (observability/UX):**
- ~~Webhook writes no `payment_audit_log` (invariant #13)~~ — **CLOSED by #328**: the webhook now audits
  received/paid/duplicate/mismatch/cancelled-paid/reversal events (§15).
- Slack `payment_received` never fires for guest bookings (nested in the player-email guard) — hoist it
  when adding the guest email (§11).
- Confirmation **email body** doesn't itemize sessions (PDF does). Accepted v1; optional enhancement.
- Heterogeneous-cart invoice line-item formatting needs a test (§16) to confirm clean per-session lines.
- Silent truncation at N_MAX / dropped-unavailable items — must be `log()`ged and surfaced in UI.

---

## 20. Final Recommendation

**Build the cart as a thin new layer on the proven guest-cyclus money path.** Concretely, and
decision-complete:

- **New edge function:** `create-guest-cart-payment` (`verify_jwt=false`) — clone of
  `create-guest-cyclus-payment` with a client-supplied `slotIds[]`, a single-recipient-org guard, split
  exclusion, and per-item full-price server pricing.
- **New RPC:** `book_guest_cart_for_payment` — clone of `book_guest_cyclus_for_payment` with **single-slot**
  per-item capacity/guards (`allow_single_booking?max_participants:1`, `is_public`,
  `single_booking_not_allowed`). It is the only mutation boundary.
- **Lifecycle:** **TTL holds (Option B)**, not post-payment booking. Reject pure Option A — it creates a
  real oversell→refund risk with Mollie, and Option B already delivers "nothing confirmed/visible/billed
  until paid."
- **Unavailable slots:** all-or-nothing — the RPC rolls back and the edge fn returns the offending ids;
  nothing is charged; the UI prunes and retries.
- **Split-payment slots:** **rejected** in v1 (`split_not_supported`).
- **Carts may NOT mix trainers/academies:** single recipient org per cart (guarantees charge==confirm).
- **Mollie metadata:** `{ booking_ids: sorted(ids), guest_player_id, recipient_type }` — **no**
  `invoice_id` (booking-first); `Idempotency-Key` fingerprints the canonical body.
- **Invoice rows:** one invoice, `booking_ids = uuid[]` of all sessions, per-session line items, VAT per
  line, extras already in `payment_amount` (`amount_includes_extras=true`), `status='paid'`,
  `guest_player_id` set. **No change to `auto-create-invoice`.**
- **Dashboard states:** per booking → `status='confirmed'`, `payment_status='paid'`, `paid_at` set,
  `hold_expires_at=NULL`, `guest_player_id` set; per invoice → `status='paid'`, `booking_ids` populated.
- **Guest confirmation email (required, new):** extend the shared paid-side-effects helper so guest
  carts trigger `send-invoice-email` (PDF itemizes all sessions) and the Slack `payment_received` ping —
  today guests get neither (§11). This is the only downstream code change.
- **Blocking tests:** 3-slot pay-once→3 confirmed+1 invoice; all-or-nothing rollback (parametrized);
  concurrency (one winner); idempotent re-click; `single_booking_not_allowed`/`slot_not_public`
  rejections; duplicate webhook idempotent; amount-sum over N; heterogeneous-cart invoice lines;
  adversarial anti-cheat (price/identity/tenant/mixed-org). These block merge.

No new server-side mutation *pattern* is required — the cart adds one RPC and one edge function that
follow the existing pay-first boundary exactly, plus one small extension to the shared paid-side-effects
helper (the guest email, §11). Database support is limited to the one additive RPC migration described
in §6.1 (do not create it in this audit phase). Everything else downstream is reused unchanged.
