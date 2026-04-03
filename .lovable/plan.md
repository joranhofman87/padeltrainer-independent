

# Enable Swapping Populated Slots

## Problem
Currently, dragging a slot onto another slot only allows a swap if the target slot is **empty** (line 1268: `overlappingSlot.current_assignments.length === 0`). When both slots have players, the "Cannot move here — overlaps with an existing slot" error appears. The user wants to swap two full groups between time slots.

## Fix
Remove the empty-slot restriction. Allow swapping any two slots (with players) as long as:
- Neither is blocked
- Durations match
- Both target positions are within trainer availability windows

The existing `onSwapSlots` handler already updates both slots' times in the database — it doesn't care about player counts.

## Change

### `src/components/cycles/ProposalScheduleGrid.tsx`

In the `handleDragEnd` slot-drag section (~line 1261-1302):

1. Remove the `if (overlappingSlot.current_assignments.length === 0 && onSwapSlots)` condition — change it to just `if (onSwapSlots)`
2. Remove the `else` branch that shows the overlap error (line 1299-1301)
3. Keep all existing validations: blocked check, duration mismatch check, availability window check

This means any two non-blocked, same-duration slots can be swapped by drag and drop.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Remove empty-slot requirement for swap; allow swapping populated slots |

