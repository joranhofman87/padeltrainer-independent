

# Show End Date Below Weeks Input in Cyclus Creation

## What
Add a calculated end date label below the "Repeat for X weeks" input in both the Trainer/Academy and Club BulkCreateSheet components. The end date is already calculated in the summary text at the bottom — this just surfaces it more prominently next to the weeks input.

## Changes

### 1. `src/components/trainer/AddSlotDialog.tsx` (line ~961, after the weeks span)

After the weeks `<span>`, add a small text showing the calculated end date:

```tsx
<p className="text-xs text-muted-foreground mt-1">
  → {format(addWeeks(slot.startDate, slot.recurrenceWeeks - 1), "MMM d, yyyy")}
</p>
```

This goes inside the recurrence `<div className="space-y-1">` block, right after the flex row with the input and "weeks" label (line 961).

### 2. `src/components/club/ClubAddSlotDialog.tsx` (line ~600, same position)

Same change — add the end date text after the weeks input.

Both files already import `addWeeks` and `format` from date-fns, so no new imports needed.

## Files
- `src/components/trainer/AddSlotDialog.tsx` — 1 line addition
- `src/components/club/ClubAddSlotDialog.tsx` — 1 line addition

