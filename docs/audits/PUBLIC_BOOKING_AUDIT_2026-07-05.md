# Public booking audit (slots & cycles) — 2026-07-05

**Scope:** players booking sessions with trainers from the **academy / club / trainer public pages** — availability reads, the guest (no-login) and authed pay-first flows, single-slot and whole-cyclus, capacity/holds, the Mollie charge → webhook confirm loop, invoices/fees, and the owner's #1 invariant: **when a trainer is part of an academy, the money must go to the academy, not the trainer.**

**Method:** read-only, deeply adversarial. 74 agents across 5 phases (money-routing map + booking state machine + deploy/connect posture → per-subsystem correctness finders → 6 attacker lenses → 2 UX walkthroughs → 2 independent skeptics *per serious finding*, default-refute). 48 raw findings → 30 serious → survivors below. The **P0 and the money-routing findings were re-verified by hand** against live RLS/triggers/edge code.

**Reviewed at:** `main` @ HEAD. No code changed — audit only.

---

## Verdict

| Question | Answer |
|---|---|
| **Does the money go to the academy when the trainer is in one?** | **Yes — when the slot is stamped with the academy, and the charge & confirmation *always agree*.** The academy-vs-trainer decision is server-side off `slot.academy_profile_id`; charge (`resolveSlotRecipient`), webhook confirm, and verify all use the *identical* predicate, and academy slots **hard-refuse** any fallback to the trainer's account — so there is **no silent leak to the trainer**. The gaps are around the *stamp* and the *invoice document* (P1s below), not the charge routing itself. |
| **Does it work?** | **Mostly — but two real correctness holes on the public pages:** anonymous availability shows **full slots as bookable** (P1-1), and split-payment whole-group cycluses are **uncompletable + underpaid** via guest (P1-2). |
| **Can people abuse it?** | **One real P0:** a logged-in player can **self-insert a confirmed, "paid" booking with no payment** (free seat). Amounts themselves are **fully server-authoritative** — a client cannot set the price, underpay, change the fee, or redirect funds via input (verified). Plus a token-leak (P2) and rate-limit gaps (P3). |
| **Is it easy to use?** | **Adequate with real dead-ends:** slots with no working Mollie / no KYC still show bookable, so guests fill the whole form then hit a wall; failed payments dead-end with no retry; guests get **no confirmation email** despite the success page promising one. |

**Bottom line:** the core money-routing invariant you care about **holds** (charge = confirm, no trainer leak). Fix **P0-1 (free seat)** first — it's a DB/RLS gap, not client-side. Then the two public-page correctness bugs (P1-1/P1-2) and the invoice mis-attribution (P1-4).

---

## P0 — fix now

### P0-1 · Any logged-in player can self-INSERT a confirmed, "paid" booking with **no payment** (free seat)
`supabase/migrations/20260325214344_…sql:39` (bookings INSERT RLS) · triggers `enforce_booking_slot_tier`, `protect_booking_financial_columns_for_players`

**What.** The paid-slot "pay-first" flow is enforced **only in the React client** (`BookLesson.tsx`), not at the DB boundary. Verified by hand against live schema:
- The player INSERT policy is `WITH CHECK (player_id = get_profile_id_for_user(auth.uid()))` — it constrains **only `player_id`**. Nothing restricts `status`, `payment_status`, `paid_at`, or `payment_amount`.
- The only BEFORE INSERT trigger, `enforce_booking_slot_tier`, checks **capacity + slot tier only** — it never touches `payment_status`.
- `protect_booking_financial_columns_for_players` is **BEFORE UPDATE only** — its own comment admits *"bookings are inserted directly from the client … this BEFORE UPDATE trigger never fires"* on insert.

**Repro.** Sign up as a normal self-service player → get a Supabase JWT → find any public paid slot with a free seat → `supabase.from('bookings').insert({ player_id: <self>, slot_id: S, status: 'confirmed', payment_status: 'paid' })`. You get a real, confirmed, "paid" seat, occupying capacity, with no Mollie payment. Both refuters tried to break this end-to-end and could not.

**Impact.** Free seats (revenue loss) + capacity abuse (grief real bookings) + the booking shows as paid so it may never be chased.

**Fix.** A BEFORE INSERT trigger (or extend the financial-columns guard to INSERT) that, for a **player self-insert** (`auth.uid()` resolves to `NEW.player_id`), forces `payment_status → 'pending'` and `status → 'pending'`. The legitimate pay-first paths (`book_slot_for_payment`, `book_guest_slot_for_payment`, service-role webhook) run as SECURITY DEFINER / service role and are unaffected.

---

## P1 — fix soon

### P1-1 · Anonymous availability shows **FULL slots as bookable**
`src/hooks/usePublicAvailability.ts:127`

The public academy/trainer/club pages count occupying bookings with a direct `supabase.from('bookings').select('slot_id').in('status', ['pending','confirmed'])`. **`bookings` has no anonymous SELECT RLS policy**, so for a logged-out visitor the count reads **zero** — every full slot renders as available. A guest picks a full slot, fills name/email/phone, and only then hits "slot just filled" (or races into an overbook). **Fix.** Expose occupancy to anon without PII: an anon-callable SECURITY DEFINER RPC (or a postgres-owned `_public` view) returning `slot_id, count` only.

### P1-2 · Split-payment whole-group cyclus is **uncompletable + grossly underpaid** (guest path)
`supabase/migrations/20260704210000_guest_rpc_is_public_guard.sql:160`

For a `split_payment` cyclus whose slots are `allow_single_booking = false` (the common whole-group case), `book_guest_cyclus_for_payment` caps each session's effective capacity at **1**, while the charge is `total ÷ max_participants`. So only **one** guest can ever book the whole court, and they pay **1/N** of it. **Fix.** A split-payment cyclus is inherently per-seat — its effective capacity must be `max_participants` even when `allow_single_booking = false`.

### P1-3 · Mollie `charges_enabled` / `onboarding_complete` hardcoded `true` at OAuth connect (never reconciled with KYC)
`supabase/functions/mollie-callback/index.ts:197`

`mollie-callback` stamps `charges_enabled: true, onboarding_complete: true` immediately after the OAuth token exchange, for both academy and trainer — it never calls Mollie's `/onboarding/me`, and nothing ever writes `false`. A connected-but-not-KYC'd academy shows *"Ready for online payments,"* its slots show bookable, and a guest fills the whole form and pays → Mollie returns `422 method not activated` → dead-end. **Fix.** Set the flags from a real `GET /v2/onboarding/me` (and/or reconcile in `check-mollie-connect-status`).

### P1-4 · Invoice mis-attributed to the academy for a trainer's **independent** slot (charge→trainer, invoice→academy)
`supabase/functions/auto-create-invoice/index.ts:150`

The invoice's billing party is resolved by an **unfiltered** `academy_trainers` lookup (`.eq('trainer_profile_id', trainerId).eq('status','active').maybeSingle()`): if the trainer belongs to *any* active academy, the invoice is stamped to that academy — **regardless of the slot's own `academy_profile_id`**. The slot-level override only fires when exactly one slot academy is present, and an independent slot has `academy_profile_id = null`. So for an academy-trainer's *independent* slot: the **charge correctly goes to the trainer** (`resolveSlotRecipient` uses the slot's null academy), but the **invoice document** gets the academy's number sequence + business identity/IBAN. *(This is document/attribution mis-routing — the actual Mollie money is correct; refuter A initially misread it as a charge leak, refuter B confirmed the invoice-side bug.)* **Fix.** Make the invoice party track the **same key the charge uses** — the slot's `academy_profile_id` — not an unfiltered trainer→academy lookup.

### P1-5…P1-7 · Guest UX dead-ends
- **No confirmation email.** Guest bookings never receive one, but the success page promises it; no operator Slack ping either (`_shared/mollie-booking-paid-side-effects.ts:83`).
- **Failed/cancelled payment → dead-end.** The guest lands on the *success* URL with no retry path (`create-guest-slot-payment:326`).
- **No-Mollie slot still bookable.** A slot whose owner has no working Mollie account shows bookable; the guest only discovers it after entering all details (`GuestBookingDialog.tsx:166`). Same class as P1-3.
- **Split-payment quote mismatch.** The charge button shows the **full** cyclus total but Mollie only charges the per-player split (`GuestBookingDialog.tsx:117`).

---

## P2 — should fix

- **P2-1 · Charged-but-stuck payment.** A trainer leaving/deactivating in an academy *between* charge and confirm strands a legitimately-charged academy payment — the webhook can't resolve the token and refuses (no wrong-party leak, but the money/booking is stuck pending + a Slack alert). `mollie-webhook:190`.
- **P2-2 · Token leak.** The `already_booked` response returns the victim's booking **`public_token`** to anyone who knows their email + name + venue — that token is the capability to view/pay their booking. `create-guest-slot-payment:222`.
- **P2-3 · Authed vs guest capacity diverge** for the same whole-slot cyclus (authed can enroll N, guest capped at 1). `20260704190000_whole_slot_capacity.sql:44`.
- **P2-4 · Per-spot single-slot price mis-quote.** The guest dialog quotes the full `price_per_session` but the server charges `price ÷ max_participants`. `GuestBookingDialog.tsx:116`.
- **P2-5 · Phantom availability.** Public `spots_left` ignores live guest holds + `pending_approval`. `usePublicAvailability.ts:131`.
- **P2-6 · Timezone.** The club (venue) public page hardcodes `Europe/Amsterdam` — wrong for non-CET venues. `LocationDetail.tsx:536`.
- **P2-7 · No T&C on the guest pay-first flow** (unlike the logged-in flow). `GuestBookingDialog.tsx:133`.

---

## P3 — minor / hardening (13 findings, summarized)

Abuse/hardening: guest pay-first rate-limit is non-atomic read-modify-write + fail-open, guest_player mint unbounded; `update-public-invoice-details` is an unauthenticated unthrottled write into the player's `profiles` row; `get-public-invoice` returns full recipient PII to any token holder; webhook amount guard skipped when `expectedSum === 0` (currently unreachable for guest paths); guest already-paid guard can double-charge across two identities/holds edge; enforce_booking_slot_tier caps at raw `max_participants` (whole-slot over-enroll via authed direct insert) and resolves to `public` tier when no windows set (doesn't block authed booking of `is_public=false` slots); client-side visibility filter can leak priority-window slots to anon (slot_priority_claims not anon-readable). Full detail in the workflow output.

---

## What held up under adversarial testing (reassurances)

- **Money-routing is sound where it counts.** `resolveSlotRecipient` (charge) and the webhook/verify resolvers (confirm) use the **identical** academy-first-XOR-trainer predicate off `slot.academy_profile_id`, with the multi-academy disambiguation present in all four — so **charge-org always equals confirm-org**, and academy slots **hard-refuse** the trainer fallback. No caller can redirect funds via input. *(Explicit finding: "guest and authed charge paths agree and route academy-first-XOR; no caller can redirect funds" — CONFIRMED SAFE.)*
- **Amounts are fully server-authoritative.** The guest slot/cyclus/invoice payment amounts are computed server-side from the slot; the client **cannot** set the price, underpay, or change the fee. The webhook independently re-checks Mollie-paid vs the stored sum.
- **Invoice pay-link routing** (`/pay/:token`) routes strictly on `invoice.academy_profile_id` XOR `invoice.trainer_id` with **no** trainer fallback, and the webhook confirm matches.

## The linchpin fragility (not a bug, but the thing to harden)

The whole invariant rests on `slot.academy_profile_id` being stamped correctly, and that value is **frontend-set at slot creation** (from `getTrainerAcademy`, a `.maybeSingle()` over the trainer's *single* active academy) with **no DB trigger/constraint** backfilling or validating it. Consequences: a trainer active in **2+ academies** collapses to `null` (slot routes to the *trainer*); a trainer picking **"Independent"** routes to the trainer. For a genuinely independent slot that's arguably correct — but it's un-enforced and silent. Consider a DB-side backfill/validation of `academy_profile_id` from `academy_trainers` at slot insert.

---

## Remediation backlog (prioritized)

1. **P0-1** — BEFORE INSERT trigger forcing player self-inserts to `pending`/`pending`. *(free seat; DB fix)*
2. **P1-1** — anon occupancy RPC/`_public` view so full slots don't show bookable.
3. **P1-2** — split-payment cyclus effective capacity = `max_participants`.
4. **P1-4** — invoice party tracks the slot's `academy_profile_id` (match the charge).
5. **P1-3 / P1-6** — gate bookability on real Mollie readiness (KYC); reconcile `charges_enabled`.
6. **P1-5 / P1-7 / P2** — guest confirmation email, failed-payment retry, token-leak, quote mismatches, T&C.
7. **Harden the linchpin** — DB-side `academy_profile_id` stamping/validation.

---

*Audit only — no code changed. Severity ranked after adversarial refutation; P0 + money-routing re-verified by hand against live RLS/triggers/edge code. Companion to `REBOOKING_AUDIT_2026-07-05.md`.*
