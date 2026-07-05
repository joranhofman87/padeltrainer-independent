# Mutation-Boundary Backlog — direct UI writes to move behind a facade/RPC

Purpose: the ranked list of remaining spots where a page/component writes a dangerous domain table directly, with the recommended boundary and PR size. Document-only — do NOT refactor from this file.
Audience / AI-read: yes
Status: canonical (source of truth) | last updated 2026-07-02

> Companion to [`../MUTATION_BOUNDARIES.md`](../MUTATION_BOUNDARIES.md) (the map) and the shrink-only
> guardrail `src/test/mutationBoundaryAllowlist.json` (36 writes / 26 files today). Each item below is a
> current allowlist entry that *should* eventually route through a `src/lib/*` facade or RPC. Ranking is
> by money/data blast radius if the raw write diverges or is bypassed.

**No current P0.** The genuinely dangerous divergent writes (TSO invoice recalc/merge, invoice
delete/cancel, slot delete cascade, manual mark-paid) are already fixed and behind owners — see
[`../audits/TSO_INVOICE_WRITES_AUDIT.md`](../audits/TSO_INVOICE_WRITES_AUDIT.md) and
[`../audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md`](../audits/CORE_BOOKING_DOMAIN_HARDENING_AUDIT.md).

## Method before touching any item

Each of these is money- or roster-adjacent and *untested at the call site*. Follow ADR
[`0003`](../adr/0003-mutation-boundary-facades.md): **characterization-test the current behavior first
(PGlite), extract verbatim into the named owner, then wire** — never fix-as-you-go in the same PR. The
`mutationBoundary.test.ts` allowlist must only shrink.

---

## P1 — cycle-edit writes that set money on live invoices

| # | Site (file:line) | Raw write | Risk | Recommended boundary | PR size |
|---|---|---|---|---|---|
| P1-a | `src/pages/TrainerScheduleOverview.tsx` — `handleSaveCycleEdit`, the slot/booking/cycle writes around L678–L916 (2 allowlisted) | Direct slot re-schedule + settings + co-occupant `bookings.update` + split-ON invoice discovery, bundled in one handler | Largest remaining page-write cluster on the money path; the *invoice* recalc/merge already moved to `src/lib/cycleEditInvoiceSync.ts`, but the slot/booking edits remain in-page and re-implement whole-cycle-edit semantics that `applySlotEditToCycle`/`updateCyclePricing` own | A `saveCycleEdit(cyclusId, patch)` owner (or extend `cycleWrites.ts`) that composes the canonical slot-edit + settings + resync passes; keep the per-slot *absolute* reschedule as an explicit typed helper (it isn't expressible as `applySlotEditToCycle`'s relative shift — see TSO audit §PR-1) | Large (multi-commit: characterize → extract → wire); needs PGlite tests for the reschedule + co-occupant rebalance first |
| P1-b | ~~`src/pages/academy/AcademyCyclusOverview.tsx:864,871`~~ **DONE** (bulk booking-mode PR) | Targeted bulk price: `availability_slots.update({price_per_session})` (chunked 500) + `cycles.update({price_per_session})` | Wrote the price source-of-truth (ADR [`0002`](../adr/0002-slot-is-price-source-of-truth.md)) then relied on a *separate* `syncInvoicesAfterPriceChange` follow-up | **Extracted as recommended**: `setTargetedCyclePrice(slotIds, cycleIds, price)` in `src/lib/cycleBookingMode.ts` bundles both writes plus the invoice resync (characterized first — `src/test/cycleBookingMode.test.ts`); the page's allowlist entry is removed | ~~Medium~~ shipped |

## P2 — lower-risk create / toggle / housekeeping writes

| # | Site (file:line) | Raw write | Risk | Recommended boundary | PR size |
|---|---|---|---|---|---|
| P2-a | `src/pages/trainer/TrainerCreateInvoice.tsx:187`, `src/pages/academy/AcademyCreateInvoice.tsx:196`, `src/components/invoices/CreateCustomInvoiceDialog.tsx:201` (1 each) | `invoices.insert(...)` with client-built line items | Create path is lower-risk (server-trusted pricing helper + RLS + dedup index), but line-item/total math is duplicated per screen and can diverge from `invoiceCalc.ts` | A `createInvoice(input)` facade in `src/lib/invoices.ts` reusing `invoiceCalc.buildCycleLineItems`/`calculateVatTotals` and the `create_invoice_deduped` RPC | Medium; one facade, 3 call-sites, characterize totals first |
| P2-b | `src/components/player/PlayerInvoicesTab.tsx:78,133` (1 allowlisted) | Invoice write from the player surface | Player-facing invoice mutation; RLS-scoped but should not be a raw write | Route through `src/lib/invoices.ts` (extend the existing status/delete facades) | Small |
| P2-c | `src/pages/TrainerCalendar.tsx:321` | `availability_slots.update({is_public}).eq('cyclus_id', …).gte('start_time', now)` (future-only cyclus toggle) | Excluded from `setSlotVisibility` by design (different selector: cyclus-id + future-only, not id-list) → the only clean `is_public` write not yet behind the facade | Add a `setCyclusFutureVisibility(cyclusId, isPublic)` variant to `src/lib/slots.ts` | Small |
| P2-d | `src/pages/academy/AcademySlotDetail.tsx`, `src/pages/trainer/TrainerSlotDetail.tsx`, `src/pages/academy/AcademyCalendar.tsx` (1 each) | Residual slot writes (visibility/detail follow-ons) | Low — RLS-scoped; mostly already-migrated surfaces with one straggler write each | Route remaining `is_public`/detail writes through `setSlotVisibility` | Small (sweep) |
| P2-e | `src/components/booking/{BookForPlayerDialog,InlineBookPlayer,InlineEditBooking}.tsx`, `src/components/trainer/EditBookingDialog.tsx`, `src/pages/TrainerBookings.tsx` (1 each) | Residual `bookings.update` (co-occupant rebalance / non-insert edits) | Low — `protect_booking_financial_columns_for_players` trigger blocks players touching payment cols; these are the non-insert residuals after all inserts were routed | Prefer `setBookingPaymentAndReconcile` / `cancelBookingsAndSync` for new code; fold the rebalance update into a `bookings.ts` helper opportunistically | Small (opportunistic) |
| P2-f | `src/components/slots/{BulkCreateContent,ClubAddSlotDialog}.tsx`, `src/components/trainer/onboarding/OnboardingStep3Schedule.tsx`, `src/components/trainer/DuplicateCyclusDialog.tsx` (1–2 each) | Slot-create + orphan-cycle `cycles.delete` rollback cleanup | Low — creates are RLS-guarded; the `cycles.delete` is a harmless compensating cleanup of a just-created empty cycle (FK is `SET NULL`) | Slot creates → `insertAvailabilitySlots` (`src/lib/slots.ts`); leave the compensating delete as-is (allowed) | Small |
| P2-g | `src/pages/TrainerEarnings.tsx:206,353` (1 allowlisted) | `bookings` write from the earnings surface | Low — reporting-adjacent booking edit | Route through `bookings.ts` if it mutates payment/status; else document as allowed | Small |

## Allowed / frozen (do NOT move — documented intent)

- `src/components/players/EmailCampaignTab.tsx:312,340,424,451,472,512` (5) — `email_campaign_recipients` delete+re-insert is **draft housekeeping** (replace recipients on edit). Not a domain-integrity write. Keep.
- All `src/lib/**` writes — that is the domain layer, intentionally unscanned.
- The orphan-cycle rollback `cycles.delete` compensating cleanups (see P2-f) — harmless; FK `SET NULL`.
- `AcademyCyclusOverview` targeted bulk price (P1-b) is deliberate today; it is listed as P1 only because bundling the resync into one facade would remove the "forgot the sync" foot-gun — not because the current code is wrong.

## Guardrail reminder

Before any move: `npm test` must keep `mutationBoundary.test.ts` green and the allowlist count must **only
decrease**. Regenerate the baseline only after a write is behind its owner. Do not add a raw
`supabase.from(<high-risk table>).insert/update/delete/upsert` in `src/pages` or `src/components`.
