

# Fix: Stop Full Page Reload on Every Schedule Change

## Problem
Every time you move a player, swap slots, or assign someone, the app makes **multiple full database round-trips** that cause the entire grid to re-render with a loading state:

1. `movePlayerAssignment()` / `assignPlayerToSlot()` — writes to DB
2. `getAvailableSlotsForCycle()` — re-fetches ALL slots from DB
3. `refreshData()` — re-fetches the cycle AND all requests

This triple hit causes the visible "reload" flicker after every drag-and-drop.

## Approach
Apply **optimistic local state updates** for move/assign/swap actions. Update `scheduleSlots` in memory immediately, then sync to DB in the background. Only do a full refetch if the DB write fails (to rollback).

### For `onMovePlayer` (drag player between slots)
- Move the assignment from source slot to target slot in `scheduleSlots` state immediately
- Call `movePlayerAssignment()` in background
- On error: rollback to previous state

### For `onAssignPlayer` (assign from unplaced)
- Add player to the target slot's `current_assignments` locally
- Call `assignPlayerToSlot()` in background
- Call `refreshData()` only on success (to update unplaced list), but **don't** re-fetch slots

### For `onUnassignPlayer` (remove from slot)
- Remove from slot's `current_assignments` locally
- Call `unassignPlayer()` in background
- Call `refreshData()` only on success

### For `onMoveSlot` / `onSwapSlots`
- Already handled well by the grid's drag logic — just stop calling `getAvailableSlotsForCycle` after the write. Update the slot times/positions locally instead.

### For `onDeleteSlot`
- Remove slot from local state immediately
- Call `deleteSlot()` in background

The key pattern: save previous state → update locally → write to DB → on error, restore previous state and show error toast.

## Result
- Drag-and-drop feels instant — no loading spinner, no grid flash
- DB writes happen silently in the background
- Errors rollback the UI and show a toast
- `refreshData()` is only called when the unplaced player list needs updating (assign/unassign)

## Files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCycleDetail.tsx` | Replace refetch-after-write pattern with optimistic local state updates for all schedule handlers |

