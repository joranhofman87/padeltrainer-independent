

# Fix Slot Drag-and-Drop Bugs + Full Trainer Agenda

## Problems Identified

1. **Slot jumps to wrong trainer**: The cell ID format `cell-{trainerId}-{rowMinute}` is parsed by splitting on `-`, but trainer IDs are UUIDs containing dashes (e.g., `cell-1c5dc2d1-2ba3-47fd-8a35-04abe17cb861-600`). The parsing logic (`parts.slice(0, -1).join('-')`) works correctly for the ID extraction, BUT the real issue is dnd-kit's collision detection. When dragging a multi-row slot, the original occupied cells return `null` (no droppable rendered), so dnd-kit's default `rectIntersection` algorithm picks the nearest visible droppable — which can be in an adjacent trainer's column.

2. **Can't freely change times**: Time rows only exist where slots or availability windows already are. Need a full day grid.

3. **No full agenda**: Availability windows may not be saved/loaded properly, or they don't cover enough hours.

## Changes

### 1. `ProposalScheduleGrid.tsx` — Fix drag bugs + full grid

**Fix collision detection:**
- Use a **custom collision strategy** or `closestCenter` with a constraint: when a slot is being dragged, prefer droppables in the same column (trainer) unless the pointer clearly moves to another column. Simpler approach: use `pointerWithin` collision detection from dnd-kit which only activates droppables under the pointer (not nearest rectangle).

**Fix cell ID parsing:**
- Change delimiter from `-` to `__` so cell IDs become `cell__${trainerId}__${rowMinute}` — eliminates UUID dash ambiguity entirely.

**Render occupied cells as droppables too:**
- Instead of returning `null` for cells occupied by multi-row slots, render an invisible droppable so dnd-kit has valid targets everywhere. This prevents the "nearest wrong column" issue.

**Full time grid:**
- When availability windows exist, ensure every 30-min row from the earliest to latest availability time is rendered, giving a complete agenda view for all trainers.

### 2. `src/lib/cycles.ts` — Verify `moveSlot` and availability persistence

- Ensure `trainer_availability_windows` are properly saved to cycle settings during generation and loaded when displaying the grid.

### Files
1. **`src/components/cycles/ProposalScheduleGrid.tsx`** — Change collision detection to `pointerWithin`, fix cell ID delimiter to `__`, render invisible droppables for occupied cells
2. **`src/lib/cycles.ts`** — Verify availability window persistence (if needed)

