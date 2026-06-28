# Mutation-Boundary Audit

Codex foundation-verification **Finding 3**. Goal: dangerous domain writes should
live in tested domain owners (`src/lib/*`, `SECURITY DEFINER` RPCs, edge functions),
not scattered across pages/components where a future AI/dev can patch one surface and
miss a sibling, drop a status-gate, or hard-delete a paid invoice.

**Principle (per Codex):** do *not* blindly remove all direct writes — many are
admin-only, low-risk, or already enforced by DB triggers/RLS/constraints. Instead:
classify, **move the genuinely dangerous + duplicated flows**, **allowlist the rest**,
and **freeze the set** so it can only shrink.

## Scope of the inventory
A machine scan (`src/test/mutationBoundary.test.ts`) finds direct `.insert/.update/
.delete/.upsert` on the high-risk tables — **bookings, availability_slots, cycles,
registrations, invoices, slot_priority_claims, email_campaign_recipients** — in
`src/pages` + `src/components`. Current baseline: **92 writes across 34 files**, frozen
in `src/test/fixtures/mutationBoundaryAllowlist.json` (the authoritative complete list).
`src/lib/**` is the domain layer and is intentionally **not** scanned — that's where
these writes belong (e.g. `bookings.ts`, `cycles.ts`, `registrations.ts`,
`invoiceSync.ts`, `priorityClaims.ts`).

## Classification (by cluster)

| Table | Ops | Representative sites | Guard today | Risk | Keep/Move | Target owner |
|---|---|---|---|---|---|---|
| **invoices** | delete + update(status=cancelled) | TrainerInvoices, AcademyInvoices, InvoiceList, Trainer/AcademyEditInvoice | ✅ **moved (#195)** — all 6 handlers route through `src/lib/invoices.ts` `deleteOrCancelInvoices()`, which makes "DELETE a non-draft" unrepresentable | ~~P1~~ done | ✅ moved | `src/lib/invoices.ts` `deleteOrCancelInvoices()` |
| **invoices** | update(sent_at/status=sent), update(due_date) | TrainerInvoices, AcademyInvoices | UI + edge fn does the real send | P2 | allowlist | (later) fold into `invoices.ts` |
| **invoices** | insert | Trainer/AcademyCreateInvoice, CreateCustomInvoiceDialog | server-trusted pricing helper + RLS | P2 | allowlist | create path is lower-risk; document |
| **bookings** | insert (cycle / approval / manual branches) | BookLesson, TrainerScheduleOverview, BookForPlayerDialog, InlineBookPlayer | **player-authed → `enforce_booking_slot_tier` trigger checks capacity**; service-role paths already use `book_slot_for_payment` RPC | P2 | allowlist | trigger-guarded; the unsafe service-role single-slot path was the P0, fixed in #183 |
| **bookings** | update | InlineEditBooking, EditBookingDialog, TrainerBookings | `protect_booking_financial_columns_for_players` trigger (players can't touch payment fields) + partly via `bookings.ts` | P2 | allowlist | prefer `setBookingPaymentAndReconcile`/`cancelBookingsAndSync` for new code |
| **availability_slots** | insert (slot create) | AddSlotDialog, ClubAddSlotDialog, TrainerScheduleOverview | RLS (owner) | P2 | allowlist | create is low-risk; whole-cycle edits already use the canonical RPCs |
| **availability_slots** | update (is_public toggle, price) | TrainerCalendar, TrainerSlotDetail, AcademyCyclusOverview | RLS; whole-cycle edit/delete/price already routed through `applySlotEditToCycle`/`applySlotDeleteToCycle`/`updateCyclePricing` | P2 | allowlist | the AcademyCyclusOverview targeted bulk-price is a **deliberate** non-RPC write (groups by cyclus+trainer; syncs invoices after) — documented, keep |
| **cycles** | delete (rollback cleanup) | ClubAddSlotDialog, AddSlotDialog, DuplicateCyclusDialog, OnboardingStep3Schedule | best-effort cleanup of a just-created empty cycle on abort | P2 / Allowed | allowlist | harmless compensating delete |
| **cycles** | update (settings/price) | TrainerScheduleOverview, AcademyCyclusOverview | invoice sync after price | P2 | allowlist | money-adjacent but guarded by sync; consider a dedicated RPC later |
| **email_campaign_recipients** | delete (replace recipients on edit) | EmailCampaignTab | campaign-draft management; recipients re-inserted | Allowed | allowlist | draft housekeeping |
| **slot_priority_claims** | insert | `src/lib/priorityClaims.ts` | already in the domain layer | Allowed | keep | not scanned (lib) |

## Prioritized move plan

**P1 — the one real move — ✅ DONE (PR #195):**
`src/lib/invoices.ts` `deleteOrCancelInvoices(invoices)` encapsulates the draft-vs-non-draft
rule **once** and makes "hard-delete a non-draft/paid invoice" *unrepresentable* (a non-draft
is always routed to the cancel UPDATE, never the DELETE). The **6** duplicated handlers across
**5** files — TrainerInvoices + AcademyInvoices bulk, InvoiceList (handleDelete +
handleVoidInvoice), TrainerEditInvoice, AcademyEditInvoice — now route through it; callers keep
their own toasts / counts / cancel-reason annotation. A characterization + invariant test
(`src/test/invoices.test.ts`, written **before** wiring) pins the delete/cancel partition and
proves a paid invoice is never deleted. The allowlist shrank accordingly (the 5 files dropped
12 direct invoice writes; the guard now fails if anyone re-adds a raw invoice delete/cancel).

**P2 — opportunistic (when touching those files):** prefer `bookings.ts`/`slots.ts`/`invoices.ts`
helpers for new writes; consider a `book_cycle_slots` RPC if the player-side cycle inserts ever
need service-role paths. **`TrainerScheduleOverview` residuals (3, kept with reason):** the
per-slot *absolute* reschedule (`dayDelta` + absolute `setHours` + midnight-cross, bundled with the
same-statement bulk `updates`) is not expressible via `applySlotEditToCycle`'s *relative*
`start_shift_minutes`; the combined no-reschedule bulk-settings write is one atomic statement whose
split across `applySlotEditToCycle` + `updateCyclePricing` would change atomicity/ordering vs the
downstream invoice resync. Two **invoice** writes need NEW tested owners before moving (genuine
P2, each needs a PGlite characterization test first): the additive `booking_ids` merge into unpaid
invoices (currently *uncounted* — a comment interrupts the `from('invoices')`→`.update` chain — so
un-hide + route together, never transiently regress the guard) → a `mergeBookingIdsIntoCycleInvoices`
owner reusing `invoiceSync`'s optimistic-retry; and the extra-cost + totals recalc (sets the invoice
total) → a `syncExtraCostsForCycle` owner, reproduced bit-for-bit.

**Allowed / frozen:** everything else — trigger-guarded booking inserts, RLS-guarded
slot creates/toggles, rollback-cleanup deletes, campaign-recipient housekeeping, and all
`src/lib/**` writes.

## The guardrail (prevents reintroduction)
`src/test/mutationBoundary.test.ts` is a **shrink-only allowlist** (same model as the
eslint suppression baseline). A new direct high-risk write in `pages/`/`components/` —
or more than the allowlisted count in an existing file — fails the test, with a message
pointing the author to a `src/lib/*` owner or to update the baseline + this doc. As
writes move behind owners, regenerate the baseline so it only shrinks.

## Acceptance criteria (Codex Finding 3)
- ✅ Documented mutation boundary (this file).
- ✅ Direct writes are explicitly **allowlisted** (the baseline); the one P1 move (the invoice
  delete/cancel facade) is **DONE** (#195) and the allowlist shrank.
- ✅ New tests/guardrails prevent accidental reintroduction (`mutationBoundary.test.ts`).
- ✅ No broad behavior rewrite without tests (the invoice facade was characterization-tested
  before wiring — `src/test/invoices.test.ts`).

## Subsequent facade moves (P2 follow-through; boundary continuing to shrink)
All behaviour-frozen, characterization-tested before wiring, adversarially reviewed:
- **Invoice status** — `markInvoicesSent` / `revertInvoicesToDraft` / `setInvoicesDueDate`
  (`src/lib/invoices.ts`); TrainerInvoices + AcademyInvoices + BulkInvoiceEmailDialog → **0**.
  `revertInvoicesToDraft` owns the never-reset-a-paid-invoice rule.
- **Slot creation** — `expandWeeklySessions` + `insertAvailabilitySlots` (`src/lib/slots.ts`);
  AddSlotDialog → 2, ClubAddSlotDialog → 1, OnboardingStep3Schedule → 1 (residual =
  orphan-cycle `cycles.delete` cleanup). `src/test/slots.test.ts`.
- **Slot visibility** — `setSlotVisibility(slotIds, isPublic, client?)` in `src/lib/slots.ts`
  (the `{ is_public }`-only toggle, single-id OR array; `.in('id', ids)`, no-op on empty). Routed
  `OpenSlots` → **0** (all 3 toggles) + `TrainerScheduleOverview` 1. `src/test/slots.test.ts`.
  ~6 more slot-detail surfaces are a clean follow-on dedup; deliberately NOT in scope for that
  slice. EXCLUDED by design: the priority-claims `is_public` write (co-writes priority-window /
  release columns — domain-atomic, stays in its own owner) and the cyclus-id/future-only toggle
  (different selector).
- **Booking creation** — `insertBookings` (array) + `insertBookingSingle` (the
  `.insert(obj).select().single()` shape) in `src/lib/bookings.ts`. **All booking inserts in
  `pages/`+`components/` are now routed → ZERO remain:** QuickBookDialog, BookForPlayerDialog ×2,
  InlineBookPlayer ×2, BookLesson ×3 (cycle + the 2 single-row sites), AddSlotDialog's
  booking-bundling insert, DuplicateCyclusDialog, TrainerScheduleOverview ×2. The residual
  allowlist counts on those files are NON-insert writes (co-occupant rebalance `bookings.update`,
  slot/cycle writes, `cycles.delete` cleanup). Still raw by design: `lessons.ts createBooking`
  (already a lib-level domain helper; its typed `{data,error}` return would ripple to callers if
  folded). `src/lib/bookings.test.ts`.
