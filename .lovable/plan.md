

## Unify Slot and Cyclus Creation Entry Points

### Problem
Currently there are two different experiences depending on how you create a cyclus or slot:
- **Clicking the calendar grid**: Opens a choice dialog, then either `AddSlotDialog` (single slot) or `BulkCreateSheet` (cyclus with recurring slots)
- **Clicking the button above the calendar**: On the academy page, "Cyclus Aanmaken" opens a completely different form (`CycleForm` -- the registration cycle form), and "Slot Toevoegen" opens the choice dialog without pre-filled time

The goal is to make both entry points open the **same dialog**, with the only difference being that the calendar click pre-fills the date and time.

### Changes

**1. Trainer Dashboard (`src/pages/TrainerDashboard.tsx`)**

- **"Add Slot" button**: Currently opens `AddSlotDialog` directly (no date/time). Keep this behavior but route it through `SlotTypeChoiceDialog` like the calendar click does, so the user always gets the choice between single slot and cyclus.
- **"Create Cyclus" button**: Currently opens `BulkCreateSheet` directly. Instead, route through `SlotTypeChoiceDialog` (same as calendar click), just without pre-filled date/time.
- **Remove the separate "Add Slot" and "Create Cyclus" buttons**. Replace them with a single "Add" / "New" button that opens `SlotTypeChoiceDialog` (without pre-filled date/time). This makes both entry points consistent.
- **Calendar cell click**: Keep as-is -- opens `SlotTypeChoiceDialog` with pre-filled date/time.

**2. Academy Calendar (`src/pages/academy/AcademyCalendar.tsx`)**

- **"Slot Toevoegen" button**: Currently opens `SlotTypeChoiceDialog` with a hardcoded default time of "09:00". Change to open it without pre-filled date/time (use `undefined`), so it behaves the same as the button on the trainer dashboard.
- **"Cyclus Aanmaken" button**: Currently opens `CycleForm` (the registration form). Change this to also route through `SlotTypeChoiceDialog`, matching the trainer dashboard behavior. The `CycleForm` should be accessible from a different place (e.g., the Registrations page), not mixed with calendar slot creation.
- **Calendar cell click**: Keep as-is -- opens `SlotTypeChoiceDialog` with pre-filled date/time.
- Merge the "Slot Toevoegen" and "Cyclus Aanmaken" buttons into a single button that opens `SlotTypeChoiceDialog`.

**3. Resulting consistent flow (both dashboards)**

```text
  Button above calendar          Calendar cell click
  (no pre-filled time)           (pre-filled date+time)
          |                              |
          +-------> SlotTypeChoiceDialog <+
                    /              \
           Single Slot        Training Cycle
               |                    |
         AddSlotDialog        BulkCreateSheet
```

### Technical Details

**File: `src/pages/TrainerDashboard.tsx`**
- Replace the two separate buttons ("Add Slot" + "Create Cyclus") with a single button that calls:
  ```
  setDefaultSlotDate(undefined);
  setDefaultSlotTime(undefined);
  setSlotTypeChoiceOpen(true);
  ```
- Keep the "Duplicate Cyclus" button as a separate action since it serves a different purpose.

**File: `src/pages/academy/AcademyCalendar.tsx`**
- Replace "Slot Toevoegen" and "Cyclus Aanmaken" buttons with a single "New" button that opens `SlotTypeChoiceDialog` without pre-filled date/time.
- Remove the `showCreateCycleDialog` state and the `CycleForm` dialog from this page (the CycleForm for registrations belongs on the Registrations page, not the calendar).
- Keep the "Duplicate Cyclus" button.

**No changes needed:**
- `SlotTypeChoiceDialog` -- already works correctly
- `AddSlotDialog` / `BulkCreateSheet` -- already accept optional `defaultDate` and `defaultTime` props

