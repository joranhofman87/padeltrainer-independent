
## Fix: "Training Cycle" on Calendar Should Create Slots, Not Registrations

### The Problem
When clicking "Training Cycle" from the calendar's slot type chooser, it opens `CycleForm` which creates a record in the `cycles` table (a registration). Instead, it should create `availability_slots` directly on the calendar -- exactly what `BulkCreateSheet` already does.

`BulkCreateSheet` already handles recurring slot creation: it picks a day, time, duration, number of weeks, lesson type, location, and generates all the `availability_slots` with a shared `cyclus_id` and `cyclus_name`. This is the correct behavior for a "Training Cycle" on the calendar.

### The Fix

**1. Wire "Training Cycle" to open BulkCreateSheet instead of CycleForm**

In both `TrainerCalendar.tsx` and `AcademyCalendar.tsx`:
- Change `handleChooseCyclus` / `onChooseCyclus` to open `BulkCreateSheet` instead of `CycleForm`
- Remove the `CycleForm` import and usage from both calendar pages (it no longer belongs here)
- Remove the `showCreateCycleDialog` state and related `trainerHourlyRate` fetching that was only needed for CycleForm

**2. Files to change**

`src/pages/TrainerCalendar.tsx`:
- Change `handleChooseCyclus` from `setShowCreateCycleDialog(true)` to `setBulkCreateOpen(true)`
- Remove the `CycleForm` component at the bottom
- Remove `showCreateCycleDialog` state, `trainerHourlyRate` state, and CycleForm import
- Keep `trainerHourlyRate` fetch only if used elsewhere (it's not -- can be removed)

`src/pages/academy/AcademyCalendar.tsx`:
- Change `onChooseCyclus` callback from `setShowCreateCycleDialog(true)` to `setBulkCreateOpen(true)`
- Remove the `CycleForm` component at the bottom
- Remove `showCreateCycleDialog` state and CycleForm import

**3. What stays the same**
- `CycleForm` continues to exist and is used on the Registrations pages (`TrainerCycles.tsx`, `AcademyCycles.tsx`) for creating registration-type cycles
- `BulkCreateSheet` already handles all the cyclus functionality: day, time, duration, weeks, lesson, location, players, court type
- `AddSlotDialog` stays for single slot creation
- The `SlotTypeChoiceDialog` stays -- "Single Slot" opens `AddSlotDialog`, "Training Cycle" opens `BulkCreateSheet`
