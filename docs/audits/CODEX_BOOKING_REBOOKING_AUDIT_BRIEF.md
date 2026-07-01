# Codex audit brief — public booking + rebooking of slots

**Audience:** an independent second reviewer (Codex) auditing the **booking and rebooking of slots on the public landing pages**.
**Written:** 2026-07-01, after PRs #281–#302 landed. **Scope:** correctness, money-path safety, tenant isolation, and UX of the public availability → booking → payment → confirmation flow, plus the rebooking (priority-claim) flow it sits next to.

This is a *starting map*, not a set of conclusions — verify everything against the current source.

---

## 1. Where the code lives (get the latest first)

- **Repo:** `github.com/joranhofman87/padeltrainer-independent` (working dir `/Users/tom/Cursor/padeltrainer`).
- **Branch:** everything is merged to **`main`**. Get the latest:
  ```
  git checkout main
  git fetch origin
  git pull --ff-only
  ```
- **The PRs that built this** (newest first): #302 (edge `Deno.serve`), #301 (location/club calendar), #300 (green heatmap), #299 (trainer page parity), #298 (**whole-slot capacity**), #297 (limit 50→500), #296 (Mollie error surfacing), #295 (row cleanup), #294 (phone mandatory + server guards), #293/#292/#291 (guest dialog + two-pane calendar), #287 (month calendar), #286 (flag on), #285/#283/#281 (guest pay-first). `git log --oneline | grep -iE "book|slot|cyclus|guest|whole"`.

### Deploy reality (so "the code" ≠ "what's live" without care)
- **Frontend auto-deploys** to Vercel on merge to `main`.
- **DB migrations do NOT auto-deploy** — the owner applies them manually (`supabase db push` / SQL editor). CI only *validates* (`supabase db reset`).
- **Edge functions do NOT auto-deploy** — `supabase functions deploy <name>`. CI only validates.
- As of this brief, migration `20260704190000` is applied, and edge fns `create-guest-slot-payment`, `create-guest-cyclus-payment`, `submit-guest-intake`, `get-guest-booking`, `mollie-webhook` are deployed.

---

## 2. The two flows and what they SHOULD do

### Flow A — Guest "pay-first" booking (the public landing pages)  ← primary
A logged-out visitor on a **public landing page** sees availability, books, pays upfront, and is only booked once payment confirms.

- **Landing pages (all render the SAME shared component):**
  - Academy: `/academies/:slug` → `AcademyPublicProfile`
  - Trainer: `/trainer/:trainerId` → `TrainerProfile`
  - Location / club / venue: `/locations/:slug` → `LocationDetail`
  - All three render `PublicAvailabilitySection` (owner = `{academy|trainer|location}`).
- **What it should do, step by step:**
  1. Show a **month calendar** (green = day has bookable sessions, muted = none). Detail on the side when a day is clicked. No per-spot counts on the cell.
  2. Clicking a session opens `GuestBookingDialog`. The visitor can book **one session** or the **whole cyclus** (defaults to whole cyclus). Name (first+last), **email + phone are mandatory**.
  3. On submit, an edge fn computes the price **server-side**, holds the seat(s) with a short TTL, mints a Mollie payment, and redirects to Mollie checkout.
  4. The **webhook** confirms the booking(s) only when Mollie reports paid; the visitor lands on a login-free confirmation page `/booking/:token`.
- **Pricing/capacity model it should enforce (post #298):**
  - `allow_single_booking = false` → the slot is booked **as a whole**: capacity **1**, **full** price. One booking takes the session; nobody else can book it.
  - `allow_single_booking = true` → per-spot (capacity = `max_participants`, price ÷ N). This is a *future* mode; RL's live slots are all `false`.
- **Payment recipient:** derived **server-side from `slot.trainer_id`** — an academy-trainer's charge routes to the **academy's** Mollie; an independent trainer to their own. The *initiating page* (academy vs trainer vs location) must never change the recipient or amount.

### Flow B — Rebooking (priority claims)
Academy re-invites existing players to a **new round** of a cycle; invited players **claim** their spot and pay before it's released to the public.

- **Player-facing page:** `/claim/:token` → `PriorityClaim`.
- **Admin side:** `/app/academy/cycles/rebook` + `/app/academy/cycles/:cycleId/rebook`.
- **Edge fns:** `bulk-rebook-cycle`, `send-priority-claim-invitation`, `send-rebook-reminder`, `create-rebook-invoice`, `create-group-rebook-invoice`, `send-rebook-group-confirmation`, `finalize-proposals`, `generate-proposals`.
- **What it should do:** hold the priority window (only invited players can claim), take payment (or invoice), then release unclaimed spots. A group captain can rebook + pay for the whole group with one invoice.

---

## 3. Code map

### Frontend (`src/`)
- **Shared booking section:** `components/booking/PublicAvailabilitySection.tsx` (owner-agnostic wrapper).
- **Calendar:** `components/booking/AvailabilityCalendar.tsx` (two-pane) → `components/agenda/AgendaMonth.tsx` (month grid, `availabilityOnly` green mode) → `components/booking/PublicSlotRow.tsx` (side-panel row).
- **Dialog:** `components/booking/GuestBookingDialog.tsx` (single vs cyclus, contact fields, invokes the edge fns).
- **Data hook:** `hooks/usePublicAvailability.ts` (owner→filter, capacity, tier-visibility) → pure shaping in `lib/publicAvailability.ts` (`mapAndGroupPublicSlots`, `bookingCapacity`).
- **Confirmation page:** `pages/GuestBookingSuccess.tsx` (`/booking/:token`, polls while pending).
- **Landing pages:** `pages/AcademyPublicProfile.tsx`, `pages/TrainerProfile.tsx`, `pages/LocationDetail.tsx`.
- **Feature flag:** `lib/bookingFlags.ts` (`GUEST_PAYFIRST_ENABLED`, currently true).
- **Rebooking:** `pages/PriorityClaim.tsx`, `lib/priorityClaims.ts`, `lib/slotVisibility.ts` (tier windows — `filterVisibleSlotIds` is MANDATORY on every public read).

### Edge functions (`supabase/functions/`)
- **Booking:** `create-guest-slot-payment/`, `create-guest-cyclus-payment/`, `get-guest-booking/`, `submit-guest-intake/` (public registration), plus shared `_shared/guest-payment.ts`, `_shared/booking-pricing.ts`, `_shared/guest-players.ts`, `_shared/slot-tier.ts`.
- **Payment core:** `create-mollie-payment/` (authenticated), `mollie-webhook/` (the confirm boundary), `verify-mollie-payment/`, `mollie-callback/`, `_shared/mollie-webhook-payment.ts`.
- **Rebooking:** the fns listed in Flow B.

### DB (`supabase/migrations/`)
- **The 3 seat-holding RPCs** (the *only* place a public/guest seat is inserted): `book_slot_for_payment` (auth), `book_guest_slot_for_payment` (guest single), `book_guest_cyclus_for_payment` (guest cyclus). Latest defs in `20260704190000_whole_slot_capacity.sql` (also `..150000`, `..170000`, `20260703140000`).
- **Whole-slot capacity:** `20260704190000_whole_slot_capacity.sql` — `v_max = allow_single_booking ? max_participants : 1`.
- **Confirmation token:** `20260704160000` / `20260704180000` (`bookings.public_token` + `get_guest_booking_by_token`).
- **Hold sweep + capacity allowlist:** `release_expired_guest_slot_holds` cron, `20260702140000_capacity_count_allowlist.sql`, `20260703140000_rebook_strict_hold_capacity.sql`.
- **Rebooking:** `20260703140000/150000/160000`, `20260704130000/140000`.

---

## 4. Invariants the audit should hold the code to

1. **Server-authoritative pricing** — the client sends only `{slotId|cyclusId, name, email, phone}`; the amount is recomputed in the edge fn (`_shared/booking-pricing.ts`). The client can never dictate the price.
2. **One mutation boundary** — a public seat is inserted **only** by the 3 locked RPCs (advisory lock `hashtextextended(slot_id,0)` + capacity count *inside* the lock). No page/edge fn inserts a booking directly on the public path.
3. **Charge org == confirm org** — `resolveSlotRecipient` (edge) and `mollie-webhook.resolveAccessToken` must resolve the recipient identically from `slot.trainer_id`. Divergence = paid-but-uncommitted stranding.
4. **Amount minted == stored `payment_amount`** — the webhook's `sum(payment_amount) == paid` guard must not be defeatable (esp. the cyclus re-split path).
5. **Whole-slot capacity is consistent** — pricing (full when `allow_single=false`), server capacity (1), and read-side capacity (`bookingCapacity`) must agree; otherwise full price + multi-seat = oversell.
6. **Tier-visibility on every public read** — `filterVisibleSlotIds` (priority/member windows) must gate anon reads so a private/priority slot never shows publicly.
7. **Tenant isolation** — a guest booking on one academy/trainer/location must never touch another tenant's slots/bookings/Mollie.
8. **Idempotency** — re-clicking "book" must not double-charge (the M-15 probe: reuse open / refuse paid / delete-on-drift).
9. **Holds occupy capacity + are swept** — a `payment_pending` hold counts toward capacity while live and is released by the TTL sweep if abandoned.

---

## 5. Known constraints / deferred items (please don't re-litigate these — they're intentional)

- **Overbooking race at commit (deferred, owner decision):** if a hold's TTL expires *during* a slow payment (SEPA/bank transfer) and the seat is retaken, the webhook confirms without re-checking capacity → possible 5/4. Mitigation in place: **only fast methods (iDEAL/cards) are to be enabled**, so the hold never expires before payment. The fix (a `confirm_bookings_with_capacity` RPC that recounts under lock at commit) is deferred until slow methods are enabled. *Flag it if you find a way it bites with fast methods.*
- **Whole-slot is enforced on the public pay-first path only** — `enforce_booking_slot_tier` / direct-insert roster & staff enrollment intentionally keep `max_participants` (so an academy can hand-enroll a group cyclus). Documented in `20260704190000`'s header.
- **Public timezone defaults to Europe/Amsterdam for anon** — `academy_profiles_public` has no `timezone` column, so all public pages fall back to Amsterdam for visitors (correct for the current Dutch academies). A pre-existing gap, not new.
- **Read-side capacity ignores in-flight holds (P3)** — a briefly-held slot can show as available for the ~20-min hold window; the RPC is the authoritative gate, so it's cosmetic, not an overbook.
- **Per-spot pricing display** — for `allow_single_booking=true` slots the dialog shows full price but the server would charge ÷N. Dormant (all live slots are `false`); to be fixed when the per-spot feature is built for real.

**A genuinely useful audit finds NEW money/tenant/capacity bugs, or refutes an invariant above with a concrete interleaving — not a re-statement of these.**

---

## 6. How to verify

- **Gates:** `npm run typecheck:baseline`, `npm run lint`, `npm test` (vitest, incl. PGlite money-path), `npm run test:edge` (deno), `supabase db reset` (real migration gate). `bun scripts/check-i18n-parity.ts`.
- **Live prod (read-only) via the anon publishable key** (`VITE_SUPABASE_PUBLISHABLE_KEY` in `.env`, project `ficwbdrzefmblkbkomzw`): e.g. `availability_slots?location_id=eq.<id>&is_public=eq.true&start_time=gt.<now>`. Great for confirming what a visitor actually sees.
- **Reference tenant:** RL Padel Performance (academy `rl-padel-performance`, trainer `yari-de-jong`, venue `tc-boemerang-kaatsheuvel`) — 116 public whole-slot sessions, €76.50 each, all `allow_single_booking=false`, academy-linked.

## 7. Suggested audit focus (highest value)
1. **Money path end-to-end:** client → edge fn pricing → RPC hold → Mollie mint → webhook confirm → `payment_amount` sum. Look for any way the amount, recipient, or seat count diverges.
2. **Capacity/whole-slot** across the 3 RPCs + the read-side + the webhook commit (the deferred race is the known soft spot).
3. **Anon tenant isolation + tier-visibility** on the public reads (is a private/priority/other-tenant slot ever reachable?).
4. **Rebooking priority window:** can a non-invited player claim? can the group-captain path double-pay or strand? (`bulk-rebook-cycle`, `create-group-rebook-invoice`, the webhook's group flip).
5. **Idempotency & abandonment:** double-click, back-button, abandoned checkout, late webhook — no double-charge, no stuck capacity.
