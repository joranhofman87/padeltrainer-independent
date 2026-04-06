

# Bring Trainer Side to Feature Parity with Academy

## Overview

The academy side has received significant upgrades (dedicated pages for invoices, slot detail, cycles overview with search/filters, attendance, mobile optimization). The trainer side still uses the older patterns — dialogs instead of pages, a simpler schedule overview, and no dedicated invoicing pages. This plan brings the trainer up to par while keeping the architecture ready for shared changes in the future.

## Key Differences to Account For

- **Academy** = multi-trainer (uses `useAcademyContext`, filters by trainer). **Trainer** = single trainer (uses `useAuth` + `trainer_profiles` lookup).
- Routes: `/app/trainer/...` vs `/app/academy/...`
- Context: `activeAcademy.id` vs `trainerId` (from trainer_profiles)

## Changes by Area

### 1. Invoices — Dedicated Pages (replace dialog)

**Current state:** TrainerEarnings.tsx uses a `CreateInvoiceDialog` popup. No edit page exists.

**New:**
- **`/app/trainer/invoices`** — New page mirroring `AcademyInvoices.tsx` (table + mobile cards, filters by status, search, sort by amount/date/status, settings tab)
- **`/app/trainer/invoices/new`** — New page mirroring `AcademyCreateInvoice.tsx` (full-page form with line items, VAT, customer details, responsive mobile layout)
- **`/app/trainer/invoices/:invoiceId/edit`** — New page mirroring `AcademyEditInvoice.tsx` (edit + PDF download + payment link + mark paid)
- Remove `CreateInvoiceDialog` usage from TrainerEarnings; link to `/app/trainer/invoices` instead
- Move the "Invoices" tab from TrainerEarnings into its own top-level nav item

### 2. Slot Detail Page

**Current state:** Trainer calendar opens inline edit or small dialogs for slots. No dedicated slot page.

**New:**
- **`/app/trainer/slot/:slotId`** — New page mirroring `AcademySlotDetail.tsx` (auto-edit mode, player list with ages/ratings, warnings, invoices card, attendance card)
- Simplified version: no trainer dropdown (it's always the logged-in trainer), no academy context
- Calendar slot clicks navigate to this page instead of opening a dialog

### 3. Cycles/Schedule Overview Enhancement

**Current state:** `TrainerScheduleOverview.tsx` (1865 lines) has an edit dialog for cycles. `TrainerCyclus.tsx` is a separate legacy page.

**New:**
- Replace the inline edit dialog in `TrainerScheduleOverview.tsx` with navigation to the cycle edit page (`/app/trainer/cycles/:cycleId/edit`)
- Add the Cycles tab from `AcademyCyclusOverview.tsx` as a component in the trainer calendar (search by player name, mobile card view, bulk visibility/pricing updates)
- Keep `TrainerScheduleOverview` but remove the large inline edit dialog

### 4. Attendance Integration

**Current state:** Attendance components (`TrainerAttendanceForm`, `SlotAttendanceCard`) were created but the trainer slot detail page doesn't exist yet.

**New:**
- The new trainer slot detail page includes the attendance card (same as academy slot detail)
- `TrainerScheduleOverview` already has attendance form integration — keep it

### 5. Route Changes

Add to DomainRouter.tsx under trainer routes:
```
/app/trainer/invoices          → TrainerInvoices
/app/trainer/invoices/new      → TrainerCreateInvoice
/app/trainer/invoices/:id/edit → TrainerEditInvoice
/app/trainer/slot/:slotId      → TrainerSlotDetail
```

### 6. Shared Component Strategy (Future-proofing)

To avoid divergence, extract shared logic where possible:
- **`InvoiceForm` component** — shared between academy and trainer create/edit pages, receiving `ownerId` + `ownerType` props
- **`SlotDetailContent` component** — shared layout receiving slot data, with academy-specific extras (trainer dropdown) conditionally rendered
- This refactoring can happen incrementally — start by creating trainer-specific pages that mirror the academy ones, then consolidate shared code in a follow-up

## Implementation Order

1. Trainer Invoices page (list) — highest value, replaces dialog
2. Trainer Create Invoice page
3. Trainer Edit Invoice page
4. Trainer Slot Detail page
5. Route registration + navigation updates
6. Remove old dialog-based invoice creation from TrainerEarnings
7. Localization keys for new trainer pages

## File Summary

| File | Change |
|------|--------|
| `src/pages/trainer/TrainerInvoices.tsx` | New — invoice list page mirroring AcademyInvoices |
| `src/pages/trainer/TrainerCreateInvoice.tsx` | New — full-page invoice creation form |
| `src/pages/trainer/TrainerEditInvoice.tsx` | New — invoice edit/view page |
| `src/pages/trainer/TrainerSlotDetail.tsx` | New — slot detail page with players, invoices, attendance |
| `src/components/DomainRouter.tsx` | Add 4 new trainer routes |
| `src/pages/TrainerEarnings.tsx` | Remove CreateInvoiceDialog, link to invoices page |
| `src/pages/TrainerCalendar.tsx` | Navigate to slot detail page on click |
| `src/pages/TrainerScheduleOverview.tsx` | Replace edit dialog with navigation to edit page |
| `src/i18n/locales/*/trainer.json` | Add translation keys for new pages |

