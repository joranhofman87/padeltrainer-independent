

# Investigation: Marieke Cycle "Disappeared" After Edit

## What happened
The cycle "Maandag 18:00 - Marieke Zuidema" (cyclus_id `55e5a69e...`) **still exists** in the database with 4 slots. It is not deleted. However:

1. **All 4 slots are in the past** (Feb 16 – Mar 9). The schedule overview defaults to the "future" tab, so they are hidden. The date shift during the edit likely moved dates backward or failed to shift them forward as intended.

2. **Times are corrupted**: The slots show `00:00 UTC` (= 01:00 CET) instead of the expected `17:00 UTC` (= 18:00 CET). This is a timezone bug in the `setHours` logic.

## Root cause: timezone bug in date/time shift logic
In `handleSaveCycleEdit` (TrainerScheduleOverview.tsx, lines 430-452):

```typescript
const oldStart = new Date(cs.start_time);  // parses UTC ISO string
// ... apply delta ...
newStart.setHours(startH, startM, 0, 0);   // sets LOCAL time — correct
```

The `setHours` approach works for the **time** part, but the **date shift** (`deltaMs`) can interact badly when DST transitions occur between the original and new dates, causing off-by-one-hour errors. More critically, if the user's browser timezone offset differs from what's expected, the delta calculation produces wrong results.

The likely scenario: the date picker returned a date at midnight local time, and the delta between the original start (which was at 18:00 CET = 17:00 UTC) and the new start (midnight CET) was a large negative offset, shifting all slots backward.

## Fix plan

### 1. Fix date shift to be day-based, not millisecond-based
**File: `src/pages/TrainerScheduleOverview.tsx`** (~lines 430-458)

Instead of computing `deltaMs` between two Date objects (which is timezone-fragile), compute the **day difference** and shift each slot by that many days. Then apply the time separately.

**Before:**
```typescript
const deltaMs = cycleEditData.startDate!.getTime() - cycleEditData.originalStartDate!.getTime();
newStart = new Date(newStart.getTime() + deltaMs);
```

**After:**
```typescript
// Use date-fns differenceInCalendarDays for timezone-safe day delta
const dayDelta = differenceInCalendarDays(cycleEditData.startDate!, cycleEditData.originalStartDate!);
newStart = addDays(newStart, dayDelta);
newEnd = addDays(newEnd, dayDelta);
```

Then apply `setHours` for time changes as before. This avoids DST/timezone issues in the delta.

### 2. Immediate data fix for the Marieke cycle
The 4 slots need their dates corrected. This would require knowing what the intended new start date and week count were. You may want to re-edit the cycle from the "past" tab to fix the dates.

## Files
- `src/pages/TrainerScheduleOverview.tsx` — Fix date shift logic to use calendar day delta instead of millisecond delta

