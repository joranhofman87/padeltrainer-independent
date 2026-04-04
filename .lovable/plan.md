

# Fix: Proposal generation only creates slots for the first week

## Root cause

In `supabase/functions/generate-proposals/index.ts`, lines 576-636, the code finds the first occurrence of each weekday after `effectiveStartDate` but **never loops to the next week**. The `cycleEndDate` variable is computed at line 558 but never used as a loop boundary.

Current flow:
1. Find first Monday after start date → generate slots for that Monday only
2. Move to next availability window

Missing: after generating all time slots for one date, advance `current` by 7 days and repeat until `current > cycleEndDate`.

## Fix

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Wrap the slot generation block (lines 581-635) in a `while (current <= cycleEndDate)` loop, advancing `current` by 7 days after each iteration. |

## Code change (conceptual)

```text
// Line 580, after finding the first matching weekday:

while (current <= cycleEndDate) {   // ← NEW: repeat for every week
  // ... existing slot generation logic (lines 581-635) stays the same ...

  current.setDate(current.getDate() + 7);  // ← NEW: advance to next week
}
```

This is a single structural change: adding 2 lines around the existing block. No data model changes, no frontend changes. The proposal assignment logic downstream already handles multiple slots per trainer — it just never received more than one week's worth.

## Impact
- Slots will now be generated for every week from `effectiveStartDate` to `cycle.end_date`
- Existing cycles won't be affected until proposals are regenerated
- The `finalize-proposals` function already books per-assignment, so it will correctly create bookings for all weeks

