

# Fix: Slots Disappearing / Resetting to Empty

## Problem
The schedule slots are stored in **local component state** and loaded via a `useEffect` that depends on `viewMode`, `activeStep`, and `cycleId`. This causes two issues:

1. **Clearing to empty**: The `else` branch explicitly calls `setScheduleSlots([])` whenever the step/view changes, causing a visible flash
2. **Overwriting optimistic state**: After assign/unassign actions, the code re-fetches all slots from DB (`getAvailableSlotsForCycle`) and replaces local state — if this fetch races with another operation or returns stale data, players vanish from slots
3. **No caching**: Navigating away and back triggers a full re-fetch starting from empty

## Fix

### Move schedule slots to TanStack Query with optimistic overlay

Instead of local state loaded by a `useEffect`, use the existing `useScheduleSlotsQuery` hook (already defined in `useProposalData.ts`) as the **source of truth**, with a local `optimisticOverrides` map layered on top for instant UI updates.

**How it works:**
- Use `useScheduleSlotsQuery(cycleId, shouldLoad)` — this caches data, keeps previous results during refetch, and doesn't flash empty
- Remove the `useEffect` that loads/clears slots (lines 192-201)
- Remove `scheduleSlots` local state (line 175)
- Derive displayed slots from query data, applying any pending optimistic changes
- After mutations, invalidate the query key instead of manually re-fetching and replacing state
- Set `placeholderData: keepPreviousData` on the query so it never shows empty during refetch

### Specific changes

**`src/hooks/useProposalData.ts`**:
- Add `placeholderData: keepPreviousData` to `useScheduleSlotsQuery` to prevent empty flash during refetch

**`src/pages/academy/AcademyCycleDetail.tsx`**:
- Replace `useState<SlotWithOccupancy[]>([])` + `useEffect` with `useScheduleSlotsQuery`
- Remove the effect that clears slots on step change
- In handlers (`onMovePlayer`, `onAssignPlayer`, etc.): use `queryClient.setQueryData` for optimistic updates instead of `setScheduleSlots`, with rollback via `queryClient.setQueryData(key, prev)` on error
- Remove the `getAvailableSlotsForCycle` re-fetch in `onAssignPlayer` — just invalidate the query after the DB write succeeds
- `onDeleteSlot`, `onUnassignPlayer`: same pattern — optimistic update via `setQueryData`, invalidate on success

## Result
- Switching tabs/steps no longer clears the grid — cached data stays visible
- Optimistic updates work the same way but through the query cache, so they survive step changes
- No more "everything went to 0" flash — `keepPreviousData` ensures old data stays visible until new data arrives
- Navigating away and back shows cached data instantly

## Files

| File | Change |
|------|--------|
| `src/hooks/useProposalData.ts` | Add `placeholderData: keepPreviousData` to `useScheduleSlotsQuery` |
| `src/pages/academy/AcademyCycleDetail.tsx` | Replace local slots state + useEffect with `useScheduleSlotsQuery`; use `queryClient.setQueryData` for optimistic updates |

