
## Restore CycleForm Popup for "Training Cycle" Option

### Problem
When clicking "Training Cycle" in the choice dialog, it currently opens the `BulkCreateSheet` -- a sidebar drawer that only creates recurring time slots. You expected it to open the `CycleForm` popup, which includes the trainer selector, KNLTB level/rating selector, and all the registration settings you recently added.

### Solution
Change the "Training Cycle" option in `SlotTypeChoiceDialog` to open `CycleForm` (the popup dialog) instead of `BulkCreateSheet` on both the Trainer Dashboard and Academy Calendar.

### Changes

**1. Trainer Dashboard (`src/pages/TrainerDashboard.tsx`)**
- Add `CycleForm` import and state (`showCreateCycleDialog`)
- Change `handleChooseCyclus` to open `CycleForm` instead of `BulkCreateSheet`
- Add the `CycleForm` dialog component to the page
- Keep `BulkCreateSheet` available for the "Duplicate Cyclus" flow (if it uses it)

**2. Academy Calendar (`src/pages/academy/AcademyCalendar.tsx`)**
- Re-add `CycleForm` import and `showCreateCycleDialog` state
- Change the `onChooseCyclus` callback from `setBulkCreateOpen(true)` to `setShowCreateCycleDialog(true)`
- Add the `CycleForm` dialog back, passing trainers, locations, and trainerLocationMap props

**3. Trainer Calendar (`src/pages/TrainerCalendar.tsx`)**
- Same change: `handleChooseCyclus` opens `CycleForm` instead of `BulkCreateSheet`

### What stays the same
- `SlotTypeChoiceDialog` component itself -- no changes needed
- `AddSlotDialog` for single slots -- unchanged
- `BulkCreateSheet` remains in the codebase for the "Duplicate Cyclus" button functionality
- The `CycleForm` popup with all its fields (trainer selector, rating system, min/max level, group sizes, etc.) -- unchanged
