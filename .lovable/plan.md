

# Add "Create Slot" to Proposal Schedule Grid

## Problem
When a trainer deletes a slot (to unassign players), the slot itself is also removed. There's currently no way to add a new empty slot back to the grid from within the schedule view.

## Approach
Add a **"+ Add slot"** button that appears in empty grid cells, allowing the trainer to create a new empty availability slot for a specific trainer at a specific time. This is the natural interaction — click an empty cell to place a new slot there.

### How it works
1. When hovering over an empty cell in the grid, show a subtle "+" button
2. Clicking it creates a new `availability_slots` row with the cell's trainer and time, linked to the current cycle
3. The slot appears instantly (optimistic) and syncs to DB in background

### Backend
Add a `createProposalSlot()` function in `src/lib/cycles.ts` that inserts into `availability_slots` with:
- `trainer_id` from the column
- `start_time` / `end_time` based on clicked row (default duration: 60 min, matching cycle settings)
- `cyclus_id` = current cycle ID
- `max_participants` from cycle settings
- `location_id` from cycle
- `is_public: false`, `is_recurring: false`

### Grid UI
In `ProposalScheduleGrid.tsx`, update empty `DroppableCell` to show a clickable "+" on hover. When clicked, call a new `onCreateSlot` callback.

### Parent pages
Wire up `onCreateSlot` in `AcademyCycleDetail.tsx` and `TrainerIntakeRequests.tsx` — optimistically add the new slot to local state, then persist via `createProposalSlot()`.

## Files

| File | Change |
|------|--------|
| `src/lib/cycles.ts` | Add `createProposalSlot(cycleId, trainerId, startTime, endTime)` function |
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add `onCreateSlot` prop; show "+" button on empty cells on hover |
| `src/pages/academy/AcademyCycleDetail.tsx` | Wire `onCreateSlot` with optimistic update |
| `src/pages/TrainerIntakeRequests.tsx` | Wire `onCreateSlot` with optimistic update |

