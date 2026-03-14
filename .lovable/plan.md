

# Fix Schedule View & Make It the Default Proposal View

## Bug Analysis

The schedule/grid view shows "No proposals" despite data existing (676 slots, 5 proposed assignments). Two issues:

1. **Query is too broad**: `getAvailableSlotsForCycle` queries ALL `availability_slots` by trainer ID + date range instead of filtering by `cyclus_id`. This returns 676+ rows including non-cycle slots, and potentially hits errors silently caught by `.catch(() => setScheduleSlots([]))`.

2. **Silent error swallowing**: The `.catch(() => setScheduleSlots([]))` hides any failures, making debugging impossible.

## Changes

### 1. Fix `getAvailableSlotsForCycle` in `src/lib/cycles.ts`
- Add `.eq('cyclus_id', cycleId)` filter to the `availability_slots` query (line 987) — only fetch slots generated for THIS cycle, not all trainer slots
- Remove the broad date-range filter since `cyclus_id` is more precise
- This reduces 676 results to just the relevant cycle slots (~20)

### 2. Better error handling in `AcademyIntakeRequests.tsx` + `TrainerIntakeRequests.tsx`
- Replace `.catch(() => setScheduleSlots([]))` with proper error logging so issues are visible
- Add console error output before setting empty state

### 3. Auto-switch to schedule view for "proposed" tab
- When user selects the "Voorgesteld/Proposed" status filter and proposals exist, automatically switch `viewMode` to `'schedule'` to show the trainer-centric grid by default
- This makes the trainer/slot perspective the primary way to review proposals
- Users can still toggle back to list view

### Files
- `src/lib/cycles.ts` — fix query filter (~2 lines)
- `src/pages/academy/AcademyIntakeRequests.tsx` — error handling + auto-switch logic (~5 lines)
- `src/pages/TrainerIntakeRequests.tsx` — same changes

