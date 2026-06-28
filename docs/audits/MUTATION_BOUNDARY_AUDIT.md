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
| **invoices** | delete + update(status=cancelled) | TrainerInvoices, AcademyInvoices, InvoiceList, Trainer/AcademyEditInvoice | UI status-gate (`delete` only `status==='draft'`, else `cancel`) — **duplicated in 5 files** | **P1** | **move** | `src/lib/invoices.ts` (new) — one `deleteOrCancelInvoices()` enforcing "never DELETE a non-draft" |
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

**P1 — the one real move (do next, its own PR, characterization-tested):**
`src/lib/invoices.ts` with `deleteOrCancelInvoices(invoices)` (and `cancelInvoice`,
`deleteDraftInvoice`). It encapsulates the draft-vs-non-draft rule **once** and makes
"hard-delete a non-draft/paid invoice" *unrepresentable* (the function refuses). Then
route the 5 duplicated sites (TrainerInvoices, AcademyInvoices, InvoiceList,
TrainerEditInvoice, AcademyEditInvoice) through it and shrink the allowlist. This is a
money-path refactor, so it needs a characterization test asserting the emitted
delete/cancel partition is unchanged **before** wiring the sites. Not done here to avoid
an untested money-path rewrite under the "smallest safe fix" rule.

**P2 — opportunistic (when touching those files):** fold invoice send/create/due-date
into `invoices.ts`; prefer `bookings.ts` helpers for new booking writes; consider a
`book_cycle_slots` RPC if the player-side cycle inserts ever need service-role paths.

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
- ✅ Direct writes are explicitly **allowlisted** (the baseline) or flagged to **move**
  (the invoice P1).
- ✅ New tests/guardrails prevent accidental reintroduction (`mutationBoundary.test.ts`).
- ✅ No broad behavior rewrite without tests (the invoice facade is specified, not
  rushed).
