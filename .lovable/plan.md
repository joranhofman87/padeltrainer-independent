

# Fix: Optimistic Changes Lost After Background Refetch

## Problem
The schedule slots query has `staleTime: 60_000` (60 seconds). After 60s of editing, TanStack Query marks the data as stale and refetches from the database in the background. This background refetch **overwrites the optimistic cache** with whatever is in the DB at that moment.

If a DB write is still in-flight or if the user made rapid changes, the refetch returns stale data and wipes all pending optimistic updates -- making it look like "all my work is gone."

## Fix

### 1. Disable background refetch while actively editing (`useScheduleSlotsQuery`)
Set `staleTime: Infinity` and `refetchOnWindowFocus: false` on the slots query. The data is already being kept up-to-date via optimistic `setQueryData` calls, so background refetching is not needed and actively harmful.

Only manually invalidate (via `invalidateSlots`) when we explicitly want fresh data (e.g. after generating proposals or resetting).

### 2. Track in-flight mutations to prevent refetch clobbering (`AcademyCycleDetail.tsx`)
Add a `pendingMutations` ref that increments before each DB write and decrements after. When `pendingMutations > 0`, skip any incoming query data updates by using a `select` function or guarding `setQueryData`.

### 3. Deep-copy `prev` snapshots for rollback
Current rollback uses `[...scheduleSlots]` which is a shallow copy -- the `current_assignments` arrays inside each slot are still shared references. Use a proper deep clone so rollback restores the exact previous state.

## Changes

### `src/hooks/useProposalData.ts`
- Change `useScheduleSlotsQuery` to use `staleTime: Infinity` and `refetchOnWindowFocus: false` so the query never auto-refetches while the grid is mounted

### `src/pages/academy/AcademyCycleDetail.tsx`
- Add a `pendingMutationsRef` (useRef counter) that tracks in-flight DB writes
- In each handler: increment before the `await`, decrement in `finally`
- Deep-clone `prev` snapshots: `JSON.parse(JSON.stringify(scheduleSlots))` instead of spread
- After successful writes, only call `invalidateSlots` when `pendingMutationsRef.current === 0` (last mutation) to avoid mid-batch refetches overwriting other pending optimistic updates

## Result
- Users can make many rapid changes without losing work
- Background refetch never silently overwrites the cache
- Failed writes still roll back correctly with deep-cloned snapshots
- Fresh data is only fetched when explicitly requested

## Files

| File | Change |
|------|--------|
| `src/hooks/useProposalData.ts` | Set `staleTime: Infinity`, `refetchOnWindowFocus: false` on slots query |
| `src/pages/academy/AcademyCycleDetail.tsx` | Add pending mutation counter; deep-clone prev snapshots; guard invalidation |

