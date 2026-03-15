

# Prevent Slot Overlap on Drag-and-Drop

## Problem

When dragging a slot onto a cell already occupied by another slot, the move proceeds without any check. The dragged slot's time/trainer is updated in the database to overlap with the existing slot. The existing slot isn't deleted from the DB, but it becomes hidden in the grid (since only one slot renders per cell). This effectively "loses" the existing slot.

## Fix

Add an **overlap detection check** in `handleDragEnd` before calling `onMoveSlot`. If the dragged slot's new time range would overlap any other slot for the same trainer on the same day, **reject the drop** and show a toast warning.

### Changes

**`src/components/cycles/ProposalScheduleGrid.tsx`** — In `handleDragEnd`, after computing `newStart`/`newEnd` and `newTrainerId`:
1. Check all `daySlots` for the target trainer (excluding the dragged slot itself)
2. If any existing slot's time range overlaps with the new `[newStart, newEnd)` range, abort the drop
3. Show a toast notification: "Cannot move here — overlaps with an existing slot"
4. Return early without calling `onMoveSlot`

This is a ~15-line addition inside the existing `handleDragEnd` function. No other files need changes.

