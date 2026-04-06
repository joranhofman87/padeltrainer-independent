

# Convert Remaining Popups to Pages/Inline Components

## Overview

Six dialog components still use popups for complex workflows. This plan converts them to dedicated pages or inline UI, matching the pattern already established for invoices and slot detail.

## Conversions

### 1. AddSlotDialog (1,772 lines) → Dedicated Pages

The biggest popup becomes two new page routes:
- `/app/trainer/slot/new` — for standalone trainers
- `/app/academy/slot/new` — for academy (with trainer picker)

**Approach**: Extract the existing `BulkCreateContent` component (already exists inside `AddSlotDialog.tsx`) into a new shared component `SlotCreateForm.tsx`. The two page files are thin wrappers that pass the appropriate props (trainer ID vs academy ID + trainer selector). Calendar pages (`TrainerCalendar`, `AcademyCalendar`) replace the dialog open with `navigate()`, passing query params for pre-filled date/time (`?date=2026-04-07&time=09:00`).

The `ClubAddSlotDialog` and `ClubBulkCreateSheet` on the club calendar remain as-is (club side is not in scope).

### 2. CreateInvoiceDialog → Wire Up Existing Page

The page `/app/trainer/invoices/new` already exists. Simply:
- Remove `CreateInvoiceDialog` import and state from `TrainerEarnings.tsx`
- Replace the "Create Invoice" button with `navigate('/app/trainer/invoices/new')`
- Delete `CreateInvoiceDialog.tsx` once no longer imported

### 3. EditSlotDialog → Redirect to Slot Detail Page

Both calendars currently open an `EditSlotDialog` on double-click/edit action. Instead:
- Navigate to `/app/academy/slot/:id` or `/app/trainer/slot/:id` (both already exist and have edit mode)
- Remove `EditSlotDialog` usage from `AcademyCalendar` and `TrainerCalendar`
- Keep `EditSlotDialog.tsx` file temporarily (club calendar may still reference it)

### 4. BookForPlayerDialog → Inline on Slot Detail Pages

Both `AcademySlotDetail` and `TrainerSlotDetail` already render this dialog. Convert to an inline collapsible section within the Players card:
- Add an "Add Player" button that expands an inline form (player search + book button)
- Reuse the core logic from `BookForPlayerDialog` but render it inline instead of in a modal
- Calendar pages (`TrainerCalendar`, `AcademyCalendar`) that open this dialog should navigate to the slot detail page instead

### 5. EditBookingDialog → Inline on Slot Detail Pages

Similar to BookForPlayerDialog:
- When clicking a booked player row on the slot detail page, expand an inline edit section (change player, update payment status, cancel booking)
- Remove the dialog usage from slot detail pages and calendar pages
- Calendar edit-booking actions navigate to slot detail page

### 6. ImportPlayersDialog → Tab on Players Page

Both `TrainerPlayers` and `AcademyPlayers` pages already have tabs. Add an "Import" tab:
- Move the CSV upload/preview/import logic from `ImportPlayersDialog.tsx` into a new `ImportPlayersTab.tsx` component
- Add it as a tab alongside the existing "Create" tab on the players page
- Remove the dialog trigger buttons and dialog state

## Implementation Order

1. **CreateInvoiceDialog** — simplest, just rewire a button (5 min)
2. **EditSlotDialog** — replace with navigation (10 min)
3. **ImportPlayersDialog** → tab (medium complexity)
4. **EditBookingDialog** → inline on slot detail (medium)
5. **BookForPlayerDialog** → inline on slot detail (medium)
6. **AddSlotDialog** → pages (most complex, largest file)

## File Summary

| File | Change |
|------|--------|
| `src/pages/TrainerEarnings.tsx` | Remove CreateInvoiceDialog, navigate to invoices/new |
| `src/pages/TrainerCalendar.tsx` | Remove EditSlotDialog + EditBookingDialog + BookForPlayerDialog, navigate to slot detail |
| `src/pages/academy/AcademyCalendar.tsx` | Same removals, navigate to slot detail |
| `src/components/trainer/ImportPlayersTab.tsx` | New — extracted import logic as inline tab content |
| `src/pages/TrainerPlayers.tsx` | Add Import tab, remove ImportPlayersDialog |
| `src/pages/academy/AcademyPlayers.tsx` | Add Import tab, remove ImportPlayersDialog |
| `src/pages/academy/AcademySlotDetail.tsx` | Inline player booking + booking edit (replace dialogs) |
| `src/pages/trainer/TrainerSlotDetail.tsx` | Same inline treatment |
| `src/components/trainer/SlotCreateForm.tsx` | New — extracted from BulkCreateContent |
| `src/pages/trainer/TrainerCreateSlot.tsx` | New — `/app/trainer/slot/new` page |
| `src/pages/academy/AcademyCreateSlot.tsx` | New — `/app/academy/slot/new` page |
| `src/components/DomainRouter.tsx` | Add routes for slot/new pages |

