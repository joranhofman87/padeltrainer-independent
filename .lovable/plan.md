

# Pre-fill Date & Time When Clicking Calendar Cells

## Problem

When a trainer clicks on a calendar cell (e.g., Feb 10 at 10:00), the clicked date and time are passed as props to the slot/cyclus dialogs. However, both `AddSlotDialog` and `BulkCreateSheet` only use these values during initial mount (`useState` initial value), so reopening the dialog with different cell coordinates doesn't update the form fields.

## Solution

Add `useEffect` hooks that sync the form state whenever the dialog opens with new `defaultDate`/`defaultTime` values. This applies to both the single slot dialog and the bulk create (cyclus) sheet, in both `TrainerDashboard` and `TrainerCalendar` pages.

## Changes

| File | Change |
|------|--------|
| `src/components/trainer/AddSlotDialog.tsx` (AddSlotDialog) | Add a `useEffect` that resets `slotDate` and `slotTime` when `open` becomes true with new default values |
| `src/components/trainer/AddSlotDialog.tsx` (BulkCreateSheet) | Fix the existing `useEffect` to also reset `bulkSlots` when `defaultDate`/`defaultTime` change (not just when slots are empty), so clicking a different cell updates the pre-filled values |

## Technical Details

**AddSlotDialog** -- add after line 103:

```text
useEffect(() => {
  if (open) {
    if (defaultDate) setSlotDate(defaultDate);
    if (defaultTime) setSlotTime(defaultTime);
  }
}, [open, defaultDate, defaultTime]);
```

**BulkCreateSheet** -- update the existing `useEffect` (line 402) to reset slots when `open` transitions to true (not just when `bulkSlots` is empty). Change the condition from `bulkSlots.length === 0` to always reset when opening, since the user is clicking a new cell:

```text
useEffect(() => {
  if (open && defaultDate) {
    const newStartDate = getInitialStartDate();
    const newStartTime = getInitialStartTime();
    setBulkSlots([{
      startDate: newStartDate,
      startTime: newStartTime,
      ...defaults
    }]);
  }
  if (!open) {
    setBulkSlots([]);  // Clear on close so next open starts fresh
  }
}, [open, defaultDate, defaultTime]);
```

No database changes needed. Only the single file `src/components/trainer/AddSlotDialog.tsx` is modified.
