

## Add Price Per Lesson + Cyclus Price to Price Overview

### Problem
The Price Overview card only shows cyclus totals when `durationOptions` (player-selectable week choices) are configured. When only the form's `number_of_weeks` field is set (e.g. 14), no total is displayed — the card only shows "per lesson" prices.

### Solution
Update the Price Overview in `CycleForm.tsx` to fall back to the form's `number_of_weeks` value when `durationOptions` is empty. This ensures the card always shows both "per lesson" and "cyclus price" (price × weeks) columns.

### Changes

**`src/components/cycles/CycleForm.tsx`** (~line 1120):

In the "Per duration columns" section, compute the weeks to display as:
- If `durationOptions` has entries, use those (current behavior)
- Otherwise, if `form.watch('number_of_weeks')` has a value, use `[number_of_weeks]` as a single-entry array

This means the overview will always show cyclus totals when weeks are known, for both the default price column and any extra price columns (e.g. "Kids").

### Files to modify
- `src/components/cycles/CycleForm.tsx`

