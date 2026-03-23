

# Cycle Edit: Extra Costs, Start Date, and Number of Repeats

## Summary
Expand the cycle edit dialog with three new fields: extra costs editor, start date picker, and number of repeats (weeks). All changes apply in bulk to slots sharing the same `cyclus_id`.

## Concerns & How We Handle Them

**Start date change**: Shifts all slots by the same time delta (new start minus old start). Slots with existing bookings are moved too — the bookings stay attached. This is safe because bookings reference slot IDs, not times.

**Number of repeats (increasing)**: Creates new slots at the end of the cycle, copying the same day/time pattern, price, location, etc.

**Number of repeats (decreasing)**: Removes slots from the end. Slots with active bookings will be protected — we only delete empty trailing slots. If not enough empty slots exist, we show a warning.

**Extra costs**: Stored as JSON on each slot. Bulk-updated across all slots in the cycle.

## Changes

### 1. `src/pages/TrainerScheduleOverview.tsx`

**Expand `CycleEditData` type** to include:
- `extraCosts: { description: string; price: number }[]`
- `startDate: Date | undefined` (first slot's start date)
- `repeatCount: string` (number of slots = weeks)

**Expand `SlotWithBookings` type** to include `extra_costs`.

**Update query** to fetch `extra_costs` from slots.

**Update `openEditDialog`**: Pre-fill new fields from first slot's `extra_costs`, derive start date from earliest slot, count total slots for repeat count.

**Update `handleSaveCycleEdit`**:
- Always bulk-update `extra_costs` on all slots
- If start date changed: calculate time delta, shift all slot `start_time` and `end_time` by that delta
- If repeat count increased: insert new slots copying the weekly pattern from the last existing slot
- If repeat count decreased: delete trailing slots that have no active bookings; warn if slots with bookings would be affected

**Extra costs UI**: Inline list of description + price rows with add/remove buttons (same pattern as CycleForm).

**Start date UI**: Date picker (Popover + Calendar).

**Repeat count UI**: Number input showing current count, editable.

### 2. Translation keys (`en/trainer.json`, `nl/trainer.json`)

Add under `scheduleOverview`:
- `extraCosts` / `Extra costs` / `Extra kosten`
- `addCost` / `Add cost` / `Kosten toevoegen`
- `costDescription` / `Description` / `Omschrijving`
- `costPrice` / `Price per session` / `Prijs per sessie`
- `startDate` / `Start date` / `Startdatum`
- `repeatCount` / `Number of weeks` / `Aantal weken`
- `cannotRemoveBookedSlots` / `Cannot remove slots with active bookings` / `Kan sessies met actieve boekingen niet verwijderen`

## Files
- `src/pages/TrainerScheduleOverview.tsx` — Expand edit dialog with extra costs, start date, repeat count
- `src/i18n/locales/en/trainer.json` — Add translation keys
- `src/i18n/locales/nl/trainer.json` — Add translation keys

