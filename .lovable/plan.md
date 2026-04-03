
## Problem
Yes — the current page is still reloading when you leave and come back because the proposal screens keep all of their state only in local component state. When the route unmounts, that state is lost, and on return the page fetches everything again.

I found two separate causes:

1. **Route remounting**
   - `TrainerIntakeRequests`, `AcademyIntakeRequests`, and `AcademyCycleDetail` store `requests`, `scheduleSlots`, `viewMode`, filters, and selected item in `useState`
   - when you navigate to another screen, these pages unmount
   - when you come back, they mount fresh and run their load effects again

2. **Schedule reload tied to request refreshes**
   - all three pages reload slots whenever `requests` changes:
   - `AcademyCycleDetail`: `useEffect(..., [viewMode, activeStep, cycleId, requests])`
   - `TrainerIntakeRequests`: `useEffect(..., [viewMode, selectedCycleId, requests])`
   - `AcademyIntakeRequests`: `useEffect(..., [viewMode, selectedCycleId, requests])`
   - so even a silent request refresh can retrigger slot loading and create that “page reload” feeling

## Plan

### 1. Decouple schedule loading from request refreshes
Update the slot-loading `useEffect` dependencies so they no longer depend on `requests`.

Use only the things that actually change which schedule should be shown:
- `viewMode`
- `activeStep` where relevant
- `cycleId` / `selectedCycleId`

This prevents slot reloads every time the request list updates.

### 2. Persist proposal screen UI state in the URL
Store the high-value screen state in search params so returning to the page restores the same context:
- `view` (`list` / `schedule`)
- `status`
- selected cycle where applicable
- current workflow step (already done in `AcademyCycleDetail`)
- optionally selected request id if useful

That way, when a trainer checks another screen and comes back, they return to the same mode instead of a reset default.

### 3. Move data fetching to TanStack Query for caching
Replace manual `useState + useEffect + fetchData` loading in these proposal pages with cached queries:
- cycle detail query
- requests query
- slots query
- player links query

Use stable query keys like:
- `['academy-cycle-detail', cycleId]`
- `['academy-cycle-requests', academyId, cycleId]`
- `['proposal-slots', cycleId]`
- `['trainer-intake-requests', trainerId]`

This gives:
- cached data when revisiting
- no full skeleton every time you return
- targeted invalidation instead of page-wide reloads

### 4. Keep optimistic schedule state layered on top of cached data
Retain the current optimistic drag/drop behavior, but initialize local editable slot state from the cached slots query instead of always refetching from scratch.

Pattern:
- query provides last known server snapshot
- local `scheduleSlots` mirrors it while editing
- mutations update local state immediately
- background success updates query cache
- failure rolls back

### 5. Stop using full-page loading after first visit
For these pages, only show the full skeleton on the **first ever load** when there is no cached data yet.
After that:
- keep previous data visible
- show lightweight pending states only on specific controls if needed

### 6. Apply consistently across all proposal screens
Implement the same pattern in:
- `src/pages/academy/AcademyCycleDetail.tsx`
- `src/pages/TrainerIntakeRequests.tsx`
- `src/pages/academy/AcademyIntakeRequests.tsx`

This avoids one proposal screen feeling persistent while another still reloads.

## Expected result
After this change:
- if you go to another screen and come back, the proposal page should reopen in the same mode and cycle
- the schedule should appear from cache immediately instead of flashing/reloading
- moving players should stay smooth
- background refreshes won’t keep reloading the slot grid

## Technical details
Files involved:
- `src/pages/academy/AcademyCycleDetail.tsx`
- `src/pages/TrainerIntakeRequests.tsx`
- `src/pages/academy/AcademyIntakeRequests.tsx`

Main fixes:
- remove `requests` from schedule-loading effect dependencies
- persist view/filter state in search params
- migrate page data to TanStack Query
- use cached query data plus optimistic local slot state
