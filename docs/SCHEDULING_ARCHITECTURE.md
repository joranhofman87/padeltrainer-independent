# Scheduling architecture: academy-first

## Strategy

1. **Academy scheduling** is the reference UX—finish and stabilize it first.
2. **Trainer parity** is a later audit; do not block academy delivery on trainer layout work.
3. **Shared business logic** is extracted to `src/lib` (and shared domain components) as soon as it appears in academy work.

## Classification checklist

| Question | If yes → |
|----------|----------|
| Is it layout, navigation, tabs, tables, or academy-only settings? | Academy-specific UI (`src/pages/academy`, `src/components/academy`) |
| Is it a calculation, validation, DB query policy, or invoice/booking rule? | `src/lib` (or shared hook), both surfaces import later |
| Is it a full flow UI (add player, book for player) but driven by lib helpers? | Shared component + lib; academy/trainer pages compose it |

## Shared logic inventory (current)

| Area | Location |
|------|----------|
| Slot booking pricing & split | `src/lib/bookingPricing.ts` |
| Book-for-player row builders | `src/lib/bookForPlayerBooking.ts` |
| Add-player invoice sync | `src/lib/invoiceAfterAddPlayer.ts`, `addPlayerInvoiceFlow.ts` |
| Affected invoice classification | `src/lib/affectedInvoices.ts` |
| Admin invoice update choice | `src/lib/invoiceUpdateChoice.ts`, `applyAffectedInvoiceUpdates.ts` |
| Invoice recalc (draft/sent policy) | `src/lib/invoiceSync.ts` (call via apply helpers for new flows) |
| Cyclus paid aggregation / filters | `src/lib/cyclusGroupPayment.ts`, `academyCalendarTab.ts` |
| Invoice confirmation dialog | `src/components/invoices/UpdateAffectedInvoicesDialog.tsx` |
| Add-player UI (domain flow) | `src/components/trainer/InlineBookPlayer.tsx`, `BookForPlayerDialog.tsx` |

## Academy-specific UX (current examples)

| Area | Location |
|------|----------|
| Calendar tabs (Week/Day/Month/List) | `src/pages/academy/AcademyCalendar.tsx` |
| Cyclus list overview & paid column | `src/components/academy/AcademyCyclusOverview.tsx` |
| Academy slot detail page chrome | `src/pages/academy/AcademySlotDetail.tsx` |

## Later: trainer parity audit

- Map trainer calendar/slot flows to academy reference.
- Reuse `src/lib` helpers; adapt layout only where needed.
- Record remaining UX gaps in a short audit doc.
