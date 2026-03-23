

# Cycle Details Editing in Schedule Overview + Day Name Fix

## What
1. Add inline editing capabilities to cycle groups in the overview: rename cycle, toggle payment status per booking, view/manage players
2. Fix Dutch day abbreviation from "maa" to "ma" by using `EEEEEE` format token instead of `EEE`

## Changes

### 1. `src/pages/TrainerScheduleOverview.tsx`

**Day name fix (line 290)**
- Change `format(startDate, "EEE d MMM", ...)` to `format(startDate, "EEEEEE d MMM", ...)` — this gives 2-letter abbreviations ("Ma", "Di", "Wo" in Dutch)

**Cycle header editing**
- Add a pencil icon next to cycle group names that opens an inline edit (or small dialog) to rename the `cyclus_name` on all slots in that group
- On save, update `availability_slots.cyclus_name` for all slots with that `cyclus_id`
- Invalidate query to refresh

**Payment status toggle per player**
- In the expanded player list, make the paid/unpaid badge clickable
- Clicking toggles `bookings.payment_status` between "paid" and "pending"
- Update `paid_at` and `paid_externally` fields accordingly
- Show a small loading spinner during the update

**Player management per slot**
- In expanded view, add a remove button (X) per player to cancel a booking
- Show confirmation before cancelling

### 2. New imports needed
- `useQueryClient` from react-query for invalidation
- Dialog/Popover components for cycle rename
- `useToast` for feedback

### 3. Translation keys (`en/trainer.json`, `nl/trainer.json`)
- `scheduleOverview.renameCycle` / `scheduleOverview.renameCycleTitle`
- `scheduleOverview.markAsPaid` / `scheduleOverview.markAsUnpaid`
- `scheduleOverview.removePlayer` / `scheduleOverview.removePlayerConfirm`
- `scheduleOverview.cycleSaved`

## Files
- `src/pages/TrainerScheduleOverview.tsx` — Add editing features + fix day format
- `src/i18n/locales/en/trainer.json` — Add translation keys
- `src/i18n/locales/nl/trainer.json` — Add translation keys

