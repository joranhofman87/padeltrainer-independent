# Mutation Boundaries — dangerous domain writes

Purpose: the canonical map of every dangerous domain mutation — where it is *allowed* to happen, where it *actually* happens today (file:line), and what still writes the DB directly from the UI.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-08-07

> Read this before touching any create/cancel/edit/delete path for bookings, slots, cycles,
> invoices, priority claims, or player identity. If you are adding a new domain write, extend the
> named facade / RPC in the "Allowed boundary" column — **do not** add a raw `supabase.from(...)`
> mutation in a page or component (the `mutationBoundary.test.ts` guard will fail).

## Enforcement layers (most durable → least)

`DB constraints / partial unique indexes → RLS policies → SECURITY DEFINER/INVOKER RPCs → edge functions → client-lib facades (src/lib/*) → UI`.

The hardening principle (ADR [`0003`](adr/0003-mutation-boundary-facades.md)): money/data integrity lives **at or below the RPC layer**, so a direct API call or a future AI edit to a page cannot break it. UI stays presentational.

## How to read this doc

- **Allowed boundary** = the layer a *new* write of this kind must go through.
- **UI writes DB directly?** = does a page/component still issue the raw mutation today (i.e. is it in the allowlist)?
- Server-side enforcement is the durable backstop that holds even if the UI is bypassed.
- Detailed evidence lives in the linked audits — this doc summarizes + points to current source; it does not repeat them.

Source audits (do not re-derive — link): [`audits/MUTATION_BOUNDARY_AUDIT.md`](audits/MUTATION_BOUNDARY_AUDIT.md) · [`audits/TSO_INVOICE_WRITES_AUDIT.md`](audits/TSO_INVOICE_WRITES_AUDIT.md) · [`audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md`](audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md) · [`audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md`](audits/FULL_AUDIT_FRESH_EYES_2026-07-02.md). ADRs: [`adr/0002`](adr/0002-slot-is-price-source-of-truth.md) (slot = price truth), [`adr/0003`](adr/0003-mutation-boundary-facades.md) (facades), [`adr/0004`](adr/0004-rebooking-priority-claims.md).

---

## The mutation table

| # | Dangerous mutation | Allowed boundary | Current implementation (file:line) | UI writes DB directly? | Server-side enforcement | Tests | Remaining risk |
|---|---|---|---|---|---|---|---|
| 1 | **Create booking** | lib facade (`insertBookings` / `insertBookingSingle`) or RPC `book_slot_for_payment` | `src/lib/bookings.ts:236,258`; guests via `src/lib/slotBookingWrite.ts:141` (`insertGuestsIntoSlots`); pay-first path RPC `book_slot_for_payment` | No — all page/component inserts routed to lib | Partial-unique `uniq_active_booking_per_slot_{player,guest}` (no double-book) + `enforce_booking_slot_tier` capacity trigger + RLS | `src/lib/bookings.test.ts`, `slotBookingWrite`/`bookForPlayerBooking.test.ts`; PGlite rehearsals | Low. Trigger-guarded; the old service-role single-slot double-insert was the P0, fixed #183. |
| 2 | **Cancel booking** | lib facade `cancelBookingsAndSync` / `cancelPlayerBookingsInCycle` | `src/lib/bookings.ts:41,91` (soft cancel + invoice reconcile) | No | `protect_booking_financial_columns_for_players` trigger; reconcile flips invoice only when coverage changes | `src/lib/bookings.test.ts` | Low. Facade owns "cancel → reconcile invoice" so billing can't go stale. |
| 3 | **Edit slot (single / whole-cycle)** | RPC `apply_slot_edit_to_cycle` via `applySlotEditToCycle`; visibility via `setSlotVisibility` | `src/lib/cycleWrites.ts:32` (`applySlotEditToCycle`); `src/lib/slots.ts:81` (`setSlotVisibility`) | Partial — see backlog P2. Bulk academy price is a **deliberate** slot+cycle write (ADR 0002) at `src/pages/academy/AcademyCyclusOverview.tsx:864,871`; per-slot absolute reschedule residuals in TSO | RPC locks `FOR UPDATE`; RLS owner scope | PGlite rehearsals; `src/test/slots.test.ts` | Low–med. Residual raw `is_public`/reschedule/price writes documented in backlog (P2). |
| 4 | **Delete slot** | RPC `apply_slot_delete_to_cycle` via `applySlotDeleteToCycle` | `src/lib/slotDeleteGuard.ts` → called from `src/components/slots/DeleteSlotDialog.tsx:303,385` | No — dialog delegates to the guard RPC (its 3 allowlisted writes are non-delete reads/co-occupant) | SECURITY INVOKER RPC, `FOR UPDATE` locks; protects booked slots from `ON DELETE CASCADE` booking loss | PGlite rehearsal | Low. TOCTOU cascade-destroy (the ADR-0003 bug) is closed by the atomic RPC. |
| 5 | **Create cycle** | lib facade `createCycle` (+ registration RPCs for the form path) | `src/lib/cycleWrites.ts:85` (`createCycle`); registrations via `create_registration_with_cycle` RPC (`src/lib/registrations.ts`) | Low — orphan-cycle rollback `cycles.delete` cleanup is the residual (allowed, compensating) | FK `cyclus_id → cycles` NOT VALID + `SET NULL`; RLS owner | `src/test/registration-write` rehearsal | Low. |
| 6 | **Edit cycle dates** | lib facade `applyCycleEndDate` / `extendCycleToEndDate` (+ `updateCycleSettings`) | `src/lib/cycleExtension.ts:269,225`; `src/lib/cycleWrites.ts:77` (`updateCycleSettings`); UI: `src/components/cycles/CycleEndDateFields.tsx`, `EditCycleEndDateDialog.tsx` | No for the CycleDetailView/dialog path. TSO's edit dialog still writes slots/cycle rows directly (see backlog) | `is_always_open` NULLifies dates; invoice resync after (`syncInvoicesAfterCycleEdit`) | `cycleExtension` unit tests | Med. TSO `handleSaveCycleEdit` is the largest residual page-write cluster (backlog P1/P2). |
| 7 | **Rebook cycle** | edge fn `bulk-rebook-cycle` (draft cycle + `slot_priority_claims`) | `supabase/functions/bulk-rebook-cycle/index.ts` (auth `requireUser` L119; academy-member check L205-210) | No — UI invokes the edge fn | verify_jwt=false + `_shared/auth.ts requireUser` (real `auth.getUser`, not decode); partial-unique index + draft cleanup guard double-run | manual + logic (audit inv. 11/12) | Low. Dry-run has no side effects; execution can't double-run. |
| 8 | **Accept priority claim** | lib `acceptClaimWithToken` / `acceptClaimAndStartPayment` → edge `create-rebook-invoice(-public)` / `rebook_group_apply` | `src/lib/priorityClaims.ts:632,872`; group `applyRebookGroup:703` | No — token RPCs + edge fns | Token-scoped RPC (`get_priority_claim_by_token`); atomic claim; `mollie-webhook` flips all group invoice `booking_ids` on pay | `src/lib/priorityClaims` tests; audit inv. 13/18 | Low–med. Whole-group payment linchpin is the webhook; covered. |
| 9 | **Decline priority claim** | lib `declineClaimAsManager` / `declineClaimWithToken` | `src/lib/priorityClaims.ts:551,602` | No | Token/RLS-scoped; `invited_at` atomic-claim send model | logic | Low. |
| 10 | **Create invoice** | edge fn (`auto-create-invoice`, `create-registration-invoice`, `create-rebook-invoice`) with server pricing; dedup RPC `create_invoice_deduped` | `supabase/functions/auto-create-invoice/*`; custom via `src/components/invoices/CreateCustomInvoiceDialog.tsx` (allowlisted insert) | Partial — custom-invoice + create pages insert directly (server-trusted pricing helper + RLS) | Partial-unique `uniq_invoice_active_{player,guest}_bookings` + `create_invoice_deduped` — person-keyed guest-first via `person_links`, split-freeze-aware, advisory-locked per (trainer, person), service_role-only (P1-6 + Phase 3.4, migration `20260902100000`; amount-neutral, dedup only) | `invoiceCalc.test.ts`, `invoiceSync.test.ts`, `src/test/createInvoiceDeduped.pglite.test.ts` | Low–med. Create path is lower-risk; direct inserts documented (backlog P2). |
| 11 | **Mark invoice paid** | `mollie-webhook` (atomic claim + paid writeback); manual booking-paid via `setBookingPaymentAndReconcile` | `supabase/functions/mollie-webhook/*`; `src/lib/bookings.ts:194` (`setBookingPaymentAndReconcile`, reconciles invoice when fully covered) | No — the P1 E-005 gap (raw `payment_status='paid'` that skipped invoice reconcile) is **closed**: both call-sites route through the facade | Unconditional `payment_status != 'paid'` guard (no stale-webhook downgrade); webhook idempotent | `src/lib/bookings.test.ts`; audit inv. 4/5 | Low. Open (documented elsewhere): Mollie idempotency-key on retry (payment-reliability G2). |
| 12 | **Cancel invoice** | lib facade `deleteOrCancelInvoices` (draft→DELETE, non-draft→cancel UPDATE) | `src/lib/invoices.ts:44` | No — 6 handlers across 5 files routed (#195); "hard-delete a paid invoice" is unrepresentable | Facade partitions delete vs cancel; RLS | `src/test/invoices.test.ts` (invariant: paid never deleted) | Low. |
| 13 | **Send invoice email** | edge fn `send-invoice-email` (auth'd) | `supabase/functions/send-invoice-email/index.ts:33-56` (validates caller JWT via `auth.getUser`) | No — UI invokes edge fn; status/`sent_at` UI writes routed via `markInvoicesSent` (`src/lib/invoices.ts:77`) | Edge validates Authorization; does the real send | — (send is manual/integration) | Low. `forward-invoice` double-fire w/ webhook is a known observability item, not a mutation-boundary gap. |
| 14 | **Send rebooking invitation** | edge fn `send-priority-claim-invitation` (atomic invited_at claim) | `supabase/functions/send-priority-claim-invitation/index.ts` (`.update({invited_at}).is('invited_at',null)`) | No | Atomic claim-before-send + rollback-to-null on failure → no double-send | manual (audit inv. 13 "Closed") | Low. |
| 15 | **Update player identity / contact** | lib `mergePlayers` → RPC `merge_guest_players` (twin-aware, migration `20260826220000`); email remediation → edge `academy-update-player-email` | `src/lib/mergePlayers.ts` (pure merge logic; RPC invoked from `src/components/players/MergePlayersDialog.tsx:154`); `supabase/functions/academy-update-player-email/index.ts` (caller-gated via `is_academy_manager` RPC, never touches admin accounts, writes audit row) | No for merge + email-remediation | RPC runs as caller (`auth.uid()`); refuses when source+target reference two distinct persons (`twin_of_profile_id` outranks `linked_profile_id` per row — the email inference is never identity truth), repoints the money rows (bookings/invoices/intakes/claims + captain markers) and the CASCADE children (notes/locations/metadata) with dedup-then-repoint, carries the twin stamp to the target; the `stamp_person_id_*` triggers re-derive `person_id` on repoint; edge gate blocks admin targets, auto-confirms only never-logged-in players; P1-3 merge data-loss fixed | `src/test/mergeGuestPlayers.pglite.test.ts` (CASCADE-child repoint/dedup/captain markers), `src/test/personsExpand.pglite.test.ts` (repointed guest key re-derives the person stamp), `src/lib/mergePlayers.test.ts` | Low. Ordinary profile/metadata edits are RLS-scoped academy contact data. |

---

## What changed since the source audits (current state, 2026-07-18)

- **Boundary shrank from 92 writes / 34 files → 34 writes / 25 files frozen (live scan 29 / 21, 2026-08-07)** (`src/test/fixtures/mutationBoundaryAllowlist.json`). Since the June audits, invoice status/delete, slot create/visibility, and booking create/cancel are fully behind lib facades.
- **P1 E-005 closed**: `setBookingPaymentAndReconcile` (`src/lib/bookings.ts:194`) now reconciles the manual "mark booking paid" to its invoice; both call-sites route through it.
- **TSO bespoke invoice writes moved**: `mergeNewBookingIdsIntoCycleInvoices` + `syncInvoicesAfterCycleEdit` live in `src/lib/cycleEditInvoiceSync.ts` and are called from `TrainerScheduleOverview.tsx:631,694` (was two untested in-page money writes — see TSO audit; the P0/P1 billing bugs it found are fixed via canonical delegation).
- **Fresh-eyes P0 (forged-JWT service-role bypass) fixed + deployed**: `isServiceRoleRequest` now `timingSafeEqual`s the bearer/apikey against the real service-role key (`supabase/functions/_shared/service-role-auth.ts:84-96`) instead of trusting a decodable JWT claim. This is the durable backstop for every `requireUser`-gated edge fn in the table.
- **Person layer landed under rows 10/15** (person unification, [`PERSON_UNIFICATION_PLAN.md`](PERSON_UNIFICATION_PLAN.md)): `merge_guest_players` is twin-aware (`20260826220000` — two-persons guard, twin-stamp carry, money-row + CASCADE-child repoint; the `stamp_person_id_*` triggers re-derive `person_id` on every repoint), and `create_invoice_deduped` is person-keyed + service_role-only (`20260902100000`) so one person can no longer be double-billed across their profile/guest keys. Identity truth is `person_links`, never `player_id`/`guest_player_id`/`linked_profile_id` alone.

## Player booking cutoff (minimum notice)

Academies and trainers can require a minimum notice before a player books
(`academy_profiles.player_booking_min_notice_minutes`,
`trainer_profiles.player_booking_min_notice_minutes`, both `NOT NULL DEFAULT 0`, CHECK 0..10080).

**Precedence: the STRICTER of the two wins** — `greatest(academy, trainer)`, NULLs treated as 0.
A trainer can therefore *tighten* their academy's rule but never loosen it, and a trainer's 0
contributes nothing rather than zeroing the academy's setting. This is deliberately a `max` and
not an override: under override semantics a trainer's 0 would be indistinguishable from "unset"
and would silently disable the academy default. An independent trainer's slot has no academy, so
it uses the trainer's own value. Default 0 everywhere means the feature is inert until somebody
sets one — including for sessions that have already started.

**Staff are exempt.** The rule applies to player/public SELF-booking only; a trainer or academy
manager adding someone is unaffected, so last-minute admin keeps working.

**Where it is enforced** (see `20260925100000_player_booking_min_notice.sql`):

| Path | Boundary |
| --- | --- |
| Authenticated player self-insert | `trg_enforce_booking_slot_tier` → `can_book_slot` → `'booking_cutoff'` |
| Registered pay-first | `create-mollie-payment` pre-check, then `book_slot_for_payment` → `can_book_slot` |
| Guest/public checkout | `book_guest_{slot,cyclus,cart}_for_payment` — the ONLY guest enforcement point |
| Staff booking for a player | exempt (the trigger returns early when `NEW.player_id` is not the caller's) |

The cutoff is a **new reason token on `can_book_slot`**, not a second trigger: that function was
already the single source of truth for "may this player self-book", and the existing trigger
already isolates the self-booking case — re-deriving that staff test in a new trigger would be a
second copy that can drift.

Three properties worth preserving if this is ever changed:

1. **It gates booking CREATION, not payment completion.** The guest RPC guard sits *below* the
   live-hold reuse branches, so a guest who began checkout outside the cutoff can still return
   from Mollie and finish paying. Guarding at the top of those functions silently made the rule
   block payment continuation too, which is a different policy.
2. **Tier is checked before the cutoff**, so a hidden slot still reports `slot_not_released`
   rather than revealing it exists but is merely late.
3. **The client is advisory.** `src/lib/bookingCutoff.ts` mirrors the SQL so the booking page can
   disable slots a player cannot book, but the database clock decides. A closed slot shows a
   *named* reason ("Booking closed 48 hours before start") rather than a generic grey card,
   because "closed" and "full" are different situations with different remedies.

Both SQL helpers are `service_role` only. This project auto-grants EXECUTE on new functions to
`anon`/`authenticated` via `ALTER DEFAULT PRIVILEGES`, and a bare `REVOKE FROM PUBLIC` does not
undo it — so the revoke names the roles, and a test pins it.

## The guardrail

`src/test/mutationBoundary.test.ts` is a **shrink-only allowlist** (same model as the eslint suppression baseline). A new direct high-risk write on `bookings / availability_slots / cycles / registrations / invoices / slot_priority_claims / email_campaign_recipients` in `src/pages` or `src/components`, or more than the allowlisted count in an existing file, **fails the test** and points the author to a `src/lib/*` owner. `src/lib/**` is the domain layer and is intentionally not scanned. Regenerate the baseline only when a write *moves behind* an owner (it may only shrink).

## Remaining direct-write backlog

The still-direct dangerous writes are ranked in [`technical-debt/MUTATION_BOUNDARY_BACKLOG.md`](technical-debt/MUTATION_BOUNDARY_BACKLOG.md). None is a current P0; the cluster is TSO/AcademyCyclusOverview cycle-edit writes (P1/P2) plus low-risk create/cleanup inserts (P2).
