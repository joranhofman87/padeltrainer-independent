

# Fix Price Overview to React to "Aantal weken" Field Changes

## Problem
The Price Overview in the CycleForm shows a hardcoded number of weeks instead of reacting to changes in the "Aantal weken" (number of weeks) field at the top of the form. This happens because:

1. When `durationOptions` (explicit week choices like 5, 10, 15) are set from saved settings, those static values are used — changing the top-level weeks field has no effect on the overview.
2. When `durationOptions` is empty, `watchedWeeks` is used as fallback — this case works correctly.

The issue is that for registrations without explicit duration options, the saved cycle data may have populated `durationOptions` with a single value (e.g. `[14]`), making the overview static.

## Solution

**File: `src/components/cycles/CycleForm.tsx`** (line ~1164)

Change the weeks source logic so that when no explicit `durationOptions` are configured by the user, the Price Overview always uses the live `watchedWeeks` value from the form field. The current fallback `(watchedWeeks ? [watchedWeeks] : [])` is correct but gets bypassed when `durationOptions` has entries.

The fix: when `durationOptions` is empty, use `watchedWeeks` (already works). When `durationOptions` has entries, still use those. The key additional change is to make sure saved cycle data does NOT auto-populate `durationOptions` from the top-level weeks field — duration options should only contain values explicitly added by the user through the "Duration Options" UI section.

Alternatively, the simpler and more useful fix: always replace the weeks multiplier in the Price Overview with `watchedWeeks` when there are no explicit duration options, ensuring the total updates in real-time as the user types.

This is a single-line change on line 1164 — the logic already works, we just need to verify why `durationOptions` is populated when the user hasn't explicitly set them, and ensure the fallback path is hit correctly.

## Files to Change
- `src/components/cycles/CycleForm.tsx` — Ensure the Price Overview weeks source reacts to form field changes when no explicit duration options are configured

