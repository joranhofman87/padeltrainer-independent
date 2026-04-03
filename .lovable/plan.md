

# Fix: Midnight (00:00) Time Window Handling

## Problem
Two bugs caused by `00:00` in trainer availability windows:

1. **Edge function bug**: When a trainer sets a window like `17:00 – 00:00` (meaning "until midnight"), the code calculates `windowEndMinutes = 0`. Since `0 < 1020` (17:00), the slot generation loop never runs — those windows are silently skipped. No slots are created for that trainer/day.

2. **Midnight slot bug**: If `00:00` is accidentally selected as a **start** time, the function creates slots at midnight (00:00–01:00), which is what you're seeing on Thursday and Friday.

## Changes

### `supabase/functions/generate-proposals/index.ts`
- After calculating `windowEndMinutes` (line 569), add: if `windowEndMinutes === 0` (i.e., end is `00:00`), treat it as `1440` (24:00 = end of day). This is the standard midnight-wrap fix.
- This ensures windows like `17:00–00:00` correctly generate slots from 17:00 to 23:00.

### `src/components/cycles/GenerateProposalsWizard.tsx`
- Split `TIME_OPTIONS` into separate start and end lists:
  - **Start options**: `06:00` to `23:30` (no `00:00` — you can't start a training at midnight)
  - **End options**: `06:30` to `23:30` + `00:00` (midnight as "end of day" is valid)
- Use the appropriate list for each dropdown

## Result
- Windows ending at midnight correctly generate slots until 23:00
- Trainers can't accidentally create midnight start times
- Existing localStorage drafts with `00:00` as end time will work correctly after the edge function fix

## Files

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Treat `windowEndMinutes === 0` as 1440 (midnight wrap) |
| `src/components/cycles/GenerateProposalsWizard.tsx` | Separate start/end time option lists; exclude `00:00` from start |

