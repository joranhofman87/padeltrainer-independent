# Core booking-domain hardening audit (scale readiness)

> Read-only audit of the slots / bookings / cycles / registrations / invoices / payments / rebooking
> domain, to answer: **is the foundation reliable and ready to scale toward ~1,000 academies, 10,000
> trainers, 100,000+ bookings?** Method: 5 independent verifiers checked 20 business invariants against
> the **actual** migrations + source (not prose), then a skeptical synthesis re-verified every P0/P1
> claim against the live code. Date: 2026-06-27. No production changes were made.

See also: [`../DOMAIN_MODEL.md`](../DOMAIN_MODEL.md) (entity map + write boundaries),
[`../EXTENDING_THE_DOMAIN.md`](../EXTENDING_THE_DOMAIN.md) (playbook + test matrix), [`../adr/`](../adr/).

## Executive summary

**The foundation is scale-ready. There is no P0 and no real multi-tenant leak.** The slots/cycles/
registrations core is durably enforced at the DB/RPC layer — not in the UI — for every dangerous path:
double-booking, paid-no-downgrade, finalize atomicity, atomic slot delete/edit, invoice/booking
idempotency, the registrations↔cycles split, and rebooking concurrency. Hot-path list/calendar queries
are bounded or paginated, backed by ~10 supporting indexes; nothing here degrades unacceptably at
100k bookings.

Two of the scariest raised findings did **not** survive verification against the current code (both were
stale paraphrases of long-superseded migrations — see *Debunked* below). What is genuinely left is **one
P1 money-integrity gap** (a manual "mark paid" that doesn't reconcile the invoice) plus a handful of P2
cleanups. None of it is architectural.

## Architecture map (where each concern lives)

```
registrations (form) ──source_cycle_id──▶ cycles(type='cyclus') ──cyclus_id──▶ availability_slots ──slot_id──▶ bookings
   │                                          │                                                                  │
   │ intake_requests.registration_id          │ intake_requests.cycle_id (proposals)                             │ booking_ids[] (no FK)
   ▼                                          ▼                                                                  ▼
 submit-guest-intake → intake_requests → generate-proposals → proposed_assignments → finalize_cycle_proposals → invoices
 (public)              (RLS academy-scoped)  (edge)            (draft)                (atomic RPC → bookings)     (auto-create-invoice)

 payments:  create-mollie-payment / create-invoice-payment ──▶ Mollie ──webhook──▶ mollie-webhook (atomic claim + paid writeback)
 rebooking: bulk-rebook-cycle (draft cycle + slot_priority_claims) ──accept──▶ create-rebook-invoice / rebook_group_apply
```

Enforcement layers, by durability (most durable first): **DB constraints / partial unique indexes →
RLS policies → SECURITY DEFINER/INVOKER RPCs → edge functions → client-lib facades (`src/lib/*`) →
UI**. The hardening principle is that money/data integrity lives at or below the RPC layer, so a direct
API call or a future AI edit to a page cannot break it.

## Invariant table (20)

| # | Invariant | Enforcement layer | Tested | Status | Risk |
|---|---|---|---|---|---|
| 1 | No double-booking | DB partial unique index `uniq_active_booking_per_slot_{player,guest}` + RLS | yes | **solid** | ok |
| 2 | Booking in correct academy/trainer/player context | RLS + edge gatekeeper | implicit | **solid** | ok |
| 3 | Player can't mutate financial booking cols | BEFORE-UPDATE trigger (`20260624120000`) | yes | **solid** | ok |
| 4 | Paid booking never downgraded by stale webhook | unconditional `payment_status != 'paid'` guard | yes | **solid** | ok |
| 5 | Payment webhooks idempotent | atomic claim UPDATE gates side-effects | yes | **solid** | ok |
| 6 | Invoice creation idempotent | partial unique `uniq_invoice_active_{player,guest}_bookings` | structural | **solid** | ok |
| 7 | Coherent cycle start/end model | lib + `is_always_open` NULLifies dates | — | **solid** | ok |
| 8 | Cycle edit can't corrupt slots/bookings | atomic RPCs (`apply_slot_edit_to_cycle`, `update_cycle_pricing`) | rehearsals | **solid** | ok |
| 9 | Registration ≠ bookable slot | FK + unique index + dual-read map | rehearsal | **solid** | ok |
| 10 | Registration conversion correct/atomic | `finalize_cycle_proposals` (single-statement RPC) | rehearsal | **solid** | ok |
| 11 | Rebook dry-run has no side effects | read-only edge-fn branch | manual | **solid** | ok |
| 12 | Rebook execution can't double-run | partial unique index + draft cleanup + already-exists guard | logic | **solid** | ok |
| 13 | Invitation/reminder send idempotent | **atomic `invited_at` claim-before-send** | manual | **solid** | ok |
| 14 | Slot delete atomic + role-safe | SECURITY INVOKER RPC, `FOR UPDATE` locks | rehearsal | **solid** | ok |
| 15 | Academy can't access another academy's data | RLS scoped via `get_user_academy_ids` | — | **solid** | ok |
| 16 | Trainer can't access another trainer's private data | RLS (`trainer_id = self`) | — | **solid** | ok |
| 17 | Club can't access academy-private data; club read-only | RLS + no club write surfaces | — | **solid** | ok |
| 18 | Public token flows expose only minimal data | trimmed token RPCs (`get_priority_claim_by_token`, …) | — | **solid** | ok |
| 19 | High-volume queries bounded/paginated | `get_*_paginated` RPCs + time-scope + range | yes | **solid** | ok |
| 20 | Indexes on academy/date/status hot paths | ~10 verified indexes | — | **solid** | ok |

**Outliers (not in the 20, found during the sweep):**

| key | Issue | Layer | Status | Risk |
|---|---|---|---|---|
| E-005/E-010 | manual "mark booking paid" doesn't reconcile its invoice | client-lib | **gap** | **P1** |
| D-20d | `getCyclesWithCounts` unbounded intake read (RPC exists, unwired) | client-lib | partial | P2 |
| E-007/8/13/14 | slot-dialog cleanup catches only the first failure → orphan empty cycle | client-lib | partial | P2 (cosmetic; FK is `SET NULL`) |
| E-009/E-010 | invoice delete/cancel lack a "can't delete a paid invoice" guard | client-lib | partial | P2 |
| C-4 | trainer bookings UPDATE scoped by `trainer_id`, not academy | RLS | partial | P2 (only matters if trainers shared across competing academies) |
| C-11 | `rebook_group_apply` doesn't re-assert slot academy in the loop | RPC | defense-in-depth | P2 (not exploitable) |

## Debunked (raised but stale — do NOT re-do)

- **`availability_slots` global `USING(true)` SELECT leak (raised as P0).** The `USING(true)` policy was
  **dropped** in `supabase/migrations/20260406162844_*.sql:3` and replaced with three scoped policies:
  public-only (`is_public = true`), owner/manager-scoped, and booked-player (`player_has_active_booking_on_slot`).
  No later migration reintroduces it. The claim cited the original 2026-01-15 definition without checking
  the drop. **No tenant leak.**
- **`send-priority-claim-invitation` double-send (raised as P1).** Already an atomic claim-before-send:
  `.update({ invited_at: now }).is('invited_at', null)` (`:385-387`), candidate filter `!c.invited_at`
  (`:202`), rollback-to-null on send failure (`:412`) so failures stay retryable. **Closed.**
- **`intake_requests` academy RLS missing (raised).** Academy-manager policies exist (`20260310151105`). **Closed.**
- **Academy bulk price writes raw to slots+cycles (raised as P1).** Intentional, documented contract —
  the slot is the price source of truth, the cycle field is a cache, and `syncInvoicesAfterPriceChange` is
  the explicit follow-up (`AcademyCyclusOverview.tsx:761,784-791`). Not a gap. See [ADR 0002](../adr/0002-slot-is-price-source-of-truth.md).

## Concurrency / idempotency findings

All durable: the paid transition (booking + invoice) is an atomic claim; finalize is one transaction;
slot delete/edit lock `FOR UPDATE`; invite send claims `invited_at` before sending; rebook execution is
guarded by a unique index + draft cleanup. The one non-reconciled write is E-005 (below).

## Performance / index risks

Hot paths are paginated/time-bounded (cyclus overview, trainer schedule, player bookings, invoice lists)
with supporting indexes. The single unbounded outlier is `getCyclesWithCounts` (D-20d), which the
`count_cycles_intakes` RPC already solves but isn't wired to — harmless until an academy has thousands of
cycles. One optional composite index `bookings(player_id, created_at DESC)` is a pure optimization.

## Prioritized fix plan

**P0 — must fix before inviting more academies:** _none._

**P1 — before broader launch:**
- **E-005 / E-010 — reconcile the manual "mark booking paid" to its invoice.** `handleTogglePayment`
  (`src/pages/TrainerScheduleOverview.tsx:913`) and `InlineEditBooking.handleSave`
  (`src/components/trainer/InlineEditBooking.tsx:128`) write `payment_status='paid'` / `paid_externally`
  directly and stop — the linked invoice stays unpaid → booking↔invoice divergence. **Fix:** a
  `setBookingPaymentAndReconcile` facade in `src/lib/bookings.ts` (mirroring `cancelBookingsAndSync`) that
  sets the booking payment fields, then flips an invoice to paid **only when all its non-cancelled
  bookings are paid** (reconcile-when-fully-covered), and reverts a `paid` invoice to `sent` when an
  un-mark breaks full coverage. Route both call-sites through it. PGlite-tested.

**P2 — cleanup / defense-in-depth (none block scale):**
- Wire `count_cycles_intakes` into `getCyclesWithCounts` with graceful fallback (D-20d).
- Make the slot-dialog cleanup idempotent (track inserted slots; clean up on any later failure) (E-007/8/13/14).
- Add `deleteInvoice`/`cancelInvoice` facades with a "can't delete a paid invoice" guard (E-009/E-010).
- Tighten the trainer bookings UPDATE RLS to academy scope (C-4) — only if trainers are ever shared
  across competing academies.
- Belt-and-suspenders academy assertion inside `rebook_group_apply` (C-11).

## Verdict

The slots/cycles/registrations foundation is **durably enforced and scale-ready**. The recent robustness
wave closed the genuinely dangerous money/data paths; this audit confirms there is no hidden P0 and no
multi-tenant leak. The remaining work is one money-reconcile facade (P1) and a small P2 cleanup sweep —
hardening, not re-architecture.
