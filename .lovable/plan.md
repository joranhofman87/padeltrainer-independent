

# Add End Date Override to Registration/Cyclus Form

## Problem
Currently, the end date is auto-calculated as `start_date + number_of_weeks`. If lessons run Monday–Friday and a cycle is 9 weeks starting on a Monday, the computed end date lands on a Monday — but the trainer wants to show it ending on the Friday (last lesson day of that final week).

## Solution
Add an **end date picker** next to the "Number of weeks" field. It auto-fills based on `start_date + weeks` but can be manually overridden. When the user picks a custom end date, it takes precedence over the computed one.

## Changes

### `src/components/cycles/CycleForm.tsx`

1. **Schema**: The `end_date` field already exists in the schema as optional. Make it always available for registration/cyclus types (not just events).

2. **UI**: Replace the current 2-column grid (`start_date` | `number_of_weeks`) with a 3-column layout or a 2-row layout:
   - Row 1: **Start Date** | **Number of weeks**
   - Row 2: **End Date** (calendar picker, pre-filled with computed date, editable)
   - Keep the "Ends on [date]" hint below number_of_weeks, but now it reflects the actual `end_date` field value.

3. **Auto-sync logic**: 
   - When `start_date` or `number_of_weeks` changes → auto-update `end_date` (unless user has manually set it).
   - Track a `customEndDate` flag via `useRef` to know if user manually picked an end date.
   - When user picks an end date manually, set the flag and stop auto-updating.

4. **Submit logic** (lines ~374-382): For non-event types, use `values.end_date` if set, otherwise fall back to `addWeeks(start_date, number_of_weeks)`.

### Layout sketch
```text
Start Date              Number of weeks
[May 4th, 2026  📅]     [9              ]

End Date
[July 4th, 2026 📅]     ← auto-filled, but editable
```

## Files Changed

| File | Change |
|------|--------|
| `src/components/cycles/CycleForm.tsx` | Add end date picker for registration/cyclus; auto-sync from weeks; use manual override on submit |

