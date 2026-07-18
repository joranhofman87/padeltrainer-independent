# Public, embeddable, pay-first booking widget — audit + plan

**Status:** plan (not started). Audited 2026-07-01 via a 7-agent read-only audit.

> ⚠️ **RE-BASE REQUIRED before execution** (noted 2026-07-18). The guest-identity design in this
> plan — resolve-or-create `guest_players`, the email+name family rule, and everything downstream
> of it — uses the **old-world identity keys** and predates **person unification**: `persons` +
> `person_links` are now the identity truth (see
> [PERSON_UNIFICATION_PLAN.md](PERSON_UNIFICATION_PLAN.md)). Re-design the identity/dedup pieces
> against `persons`/`person_links` first; do not build from this plan as written.
**Goal:** a visual, mobile-first, ideally **embeddable** availability + booking widget so a
non-tech-savvy person can, on any academy/trainer/club page (or an academy's own external site),
**see when they can book a training and with whom**, pick a single slot or a whole cyclus, **pay
directly**, and only then be booked — then get a confirmation and a nudge to finish their player
account.

---

## 1. What exists today (audit findings)

**Display — a flat list, no picker.** Public availability is rendered as a flat, day-grouped
**list** (`src/components/academy/AcademyPublicOpenSlots.tsx`) on the academy/trainer/club public
pages. There is **no** appointment/Calendly-style date→time picker anywhere in the codebase.

**Two booking flows exist; only one is true seat pay-first.**
- **(A) Authenticated player, pay-first** — `BookLesson.tsx` → `create-mollie-payment` →
  `mollie-webhook` → `BookingSuccess.tsx`. For a **single slot** the page inserts nothing; the edge
  fn owns a capacity-locked insert via the **`book_slot_for_payment`** RPC (advisory lock + recount
  of `CAPACITY_OCCUPYING_STATUSES`), creates a `pending` (capacity-holding) booking, mints the Mollie
  payment, redirects; the seat is **committed to paid only by the webhook**. A **whole cyclus** is
  the inverse: all per-session bookings are inserted `pending` first (so split-payment headcount is
  right), then paid, with a soft-cancel rollback if checkout creation fails.
  → **But `create-mollie-payment` + `book_slot_for_payment` hard-require an authenticated user/
  profile — there is no guest seat path.** `BookingSummary` literally walls guests to `/app/signup/
  player` instead of letting them pay.
- **(B) Guest/anonymous, pay-LATER** — `CycleApplicationForm` → `submit-guest-intake` (truly anon,
  `verify_jwt=false`, rate-limited) → mints a tokenized **invoice** → paid anonymously via
  `/pay/:token` (`PublicInvoicePay` → `create-invoice-payment`). It resolves "this email already has
  an account" via an **email + normalized-name family rule**, but it never commits an
  `availability_slots` seat at pay time — it's an intake/registration, not pick-this-slot-and-pay.

**Pricing is server-authoritative on both paths** (`_shared/booking-pricing.ts`), and the webhook
re-verifies that `sum(payment_amount) == paid`.

**Embedding is hard-blocked today** by a global `X-Frame-Options: DENY` in `vercel.json`
(`source: /(.*)`). No `/embed` route, no `frame-ancestors` allowlist, no postMessage handshake.

**Timezone:** slots are written owner-anchored (`localWallTimeToUtc`, Europe/Amsterdam) but rendered
**browser-local** — wrong for a cross-site/cross-timezone embed; a read-side zoned formatter is
missing.

## 2. What we reuse (most of the hard parts already exist)

- **Money/booking backbone:** `book_slot_for_payment` RPC (capacity lock + recount), `create-mollie-
  payment`, `mollie-webhook` (handles both `booking_ids` and `invoice_id` metadata branches),
  `_shared/booking-pricing.ts` (single vs cyclus, split divisor, amount match), `cyclePayment.ts`
  (orphan-safe rollback).
- **Anonymous payment + confirmation stack:** `create-invoice-payment` + `get-public-invoice` +
  `PublicInvoicePay` (`/pay/:token`, branded, no-referrer, "claim your account" CTA),
  `mintEventRegistrationInvoice` / `buildPayUrl` (guest invoice mint for `player_id` OR
  `guest_player_id`).
- **Guest identity:** `submit-guest-intake`'s resolve-or-create `guest_players` + email+name family
  rule (lift into a shared helper).
- **Forms + selection UI:** `CycleApplicationForm` personal-info block (RHF+zod, phone schema,
  `TermsAcceptance`, online/cash radios), `BookingSummary` / `SlotList` / `CycleBundleList`,
  `BookingConfirmation`, `BrandedCycleRegistration` owner branding + `PoweredByBadge`.
- **Visibility + visuals:** `filterVisibleSlotIds` / `computeReleasedSlotIds` (anon-safe tier
  visibility — MANDATORY so embargoed/priority slots never leak), `agendaTokens` (trainer hues +
  fill states), `AgendaMonth` grid math, `ui/calendar` (react-day-picker), `ui/sheet` bottom-sheet.

## 3. What's missing (to build)

1. **`usePublicAvailability` hook** — one shared anon fetch (slots + cycles + trainer names + prices)
   covering trainer/academy/club owners, applying `filterVisibleSlotIds`, group-by-day, single-vs-
   cyclus, spots-left. (Lift the duplicated fetch out of `AcademyPublicOpenSlots`/`BookLesson`.)
2. **`AvailabilityPicker`** — the visual mobile-first picker: date (month/week) → time-grid → slot/
   cyclus detail card (price, trainer "with whom", spots-left, single vs cyclus), bottom-sheet on
   mobile, **owner-timezone read-side formatter**.
3. **Guest pay-first seat path** — extend `book_slot_for_payment` with an optional `_guest_player_id`
   (commit a guest seat under the SAME lock) + a NEW **anon** guest-booking edge fn (`verify_jwt=
   false`, rate-limited, server-priced) that resolves/creates the guest, commits the seat, mints
   Mollie, returns `checkoutUrl`. Plus an **abandonment/hold-expiry** sweep so abandoned guest
   checkouts don't permanently lock capacity.
4. **Tokenized guest confirmation page** — login-free success/verify (poll a guest booking by a
   one-time token, run the verify write-back) + "finish your player account" nudge.
5. **Email-already-account UX branch** — detect at email entry, offer log-in vs continue-as-guest.
6. **Embeddable shell** — chromeless `/embed/book/:ownerSlug` route, a **scoped** `X-Frame-Options`
   exemption (drop DENY for `/embed/*`, set CSP `frame-ancestors` allowlist), postMessage
   height/redirect handshake, CORS origin allowlist (extend `submit-guest-intake`'s pattern), embed
   snippet + docs.

## 4. Phased build (each = focused PR, tests + adversarial review for money-path)

- **Phase 0 — foundation (no visual change):** `usePublicAvailability` hook (owner-agnostic;
  refactor `AcademyPublicOpenSlots` onto it) + read-side **owner-timezone** formatter. Pure
  refactor + helper, behind green tests.
- **Phase 1 — the visual picker:** `AvailabilityPicker` (mobile-first, appointment-style) replaces
  the flat list on the academy/trainer/club public pages, **still routing to today's booking flow**
  (logged-in) — a visible win with **no money-path change**.
- **Phase 2 — guest pay-first backend (money-path; owner deploys migration + edge fns; adversarial
  review each):**
  - **2a — single slot:** extend `book_slot_for_payment` with an optional `_guest_player_id` (commit
    a guest seat under the SAME advisory lock), a NEW anon guest-booking edge fn (`verify_jwt=false`,
    rate-limited, server-priced) → **TTL `pending` hold** + Mollie checkout, a **hold-expiry sweep**
    (cron, like the rebook hold release) so abandoned checkouts auto-release capacity, and a
    tokenized login-free confirmation/verify.
  - **2b — whole cyclus:** guest cyclus pay-upfront (multi-row commit + split-payment headcount
    re-sync with already-paid players). Bigger money build; ships after 2a.
- **Phase 3 — guest booking UX:** the details step (name/email/phone) + the **email-already-account
  branch** (detect → offer one-click login, allow continue-as-guest); wire the picker → guest
  pay-first → confirmation + **finish-your-player-account** nudge.
- **Phase 4 — embeddable shell (iframe):** chromeless `/embed/book/:ownerSlug` route, a **scoped**
  `X-Frame-Options` exemption (drop DENY for `/embed/*`, set CSP `frame-ancestors` allowlist),
  postMessage height/redirect handshake, CORS origin allowlist (extend `submit-guest-intake`'s
  pattern), a paste-able `<script>`/iframe snippet + `PoweredByBadge` + docs.

## 5. Decisions — LOCKED 2026-07-01

1. **Seat-hold:** ✅ **Hold while paying** — a short-TTL `pending` hold reserves the seat at
   checkout start (appointment feel), auto-released by a sweep if abandoned. (Matches today's
   single-slot pay-first; needs the abandonment sweeper.)
2. **v1 scope:** ✅ **Both single-slot AND whole-cyclus** pay-upfront (Phase 2a then 2b).
3. **Email-already-account:** ✅ **Detect → offer one-click login**, but allow continue-as-guest and
   claim later. (Avoids account-takeover via the name-collision family rule; keeps friction low.)
4. **Embed:** ✅ **iframe + paste-a-snippet** (CSS-isolated; scoped frame exemption + postMessage +
   CORS allowlist).

**Secondary defaults (confirm or override during build):** support **all three owner types**
(academy/trainer/club) on their public pages, but ship the pay recipient resolution by reusing
`create-mollie-payment`'s logic (trainer's own Mollie vs academy Mollie + platform fee) — likely
**academy + trainer first**, club after; **online pay-first** with a graceful "no online payment →
registration/intake" fallback when an owner has no Mollie; **phone optional**; **owner timezone**
(`academy_profiles.timezone`) authoritative for display; **per-owner branding** (logo/banner) like
`PublicInvoicePay`.

## 6. Hard constraints (carry through every phase)

- **One mutation boundary** for the seat (the prior single-slot double-insert was a P0) — exactly
  the locked RPC inserts; never the client.
- **Server-authoritative pricing** (`booking-pricing.ts`) — a client amount that mismatches makes the
  webhook refuse to mark paid and strands the seat with money taken.
- **`filterVisibleSlotIds` always** — never leak priority/member-window slots publicly.
- **Scoped** frame exemption only (a global relaxation would clickjack the authenticated app).
- **Abandonment safety** — `pending` occupies capacity; guest holds need a TTL sweep.
