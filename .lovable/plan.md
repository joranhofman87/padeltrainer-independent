

# Drag-and-Drop Slots: Change Trainer & Time via Grid

## Concept

Transform the grid into a **time-based row layout** where rows represent time slots and columns represent trainers. Slots sit at the intersection. Dragging a slot card horizontally moves it to a different trainer; dragging vertically changes its time. This makes the grid feel like a visual calendar/planner.

```text
              │  Trainer A       │  Trainer B       │  Trainer C
──────────────┼──────────────────┼──────────────────┼──────────────
 09:00-10:00  │  [Slot card]     │                  │  [Slot card]
──────────────┼──────────────────┼──────────────────┼──────────────
 10:00-11:00  │                  │  [Slot card]     │
──────────────┼──────────────────┼──────────────────┼──────────────
 11:00-12:00  │  [Slot card]     │  [Slot card]     │
──────────────┼──────────────────┼──────────────────┼──────────────
```

Dropping a slot into an empty cell updates its trainer and/or time.

## Changes

### 1. `ProposalScheduleGrid.tsx` — Major restructure

- **Two drag types**: Distinguish between dragging a *player chip* (existing) and dragging an *entire slot card*. Use different `id` prefixes (`player-` vs `slot-drag-`).
- **Time-row grid**: Compute unique time rows from all slots on the selected day (e.g., 30-min or 60-min increments based on existing slot boundaries). Render a CSS grid with trainer columns and time rows.
- **Droppable cells**: Each empty cell (trainer × time-row intersection) becomes a droppable target with id `cell-{trainerId}-{timeRow}`.
- **Slot cards become draggable**: Add a drag handle to each slot card header. When dragged, the `DragOverlay` shows the full slot card.
- **On drop**: 
  - If dropped on a different trainer column → call `onMoveSlot(slotId, newTrainerId, newStartTime, newEndTime)`
  - If dropped on a different time row → compute new start/end time preserving duration, call the same callback
  - If both changed → update both in one call
- **New props**: Add `onMoveSlot?: (slotId: string, newTrainerId: string, newStartTime: string, newEndTime: string) => void`

### 2. `src/lib/cycles.ts` — Add combined move function

- Add `moveSlot(slotId, newTrainerId, newStartTime, newEndTime)` that updates both `trainer_id` and `start_time`/`end_time` in a single update call to `availability_slots`.

### 3. Parent pages (`AcademyIntakeRequests.tsx`, `TrainerIntakeRequests.tsx`)

- Wire up the new `onMoveSlot` callback similar to the existing `onMovePlayer` — call the backend function, then silently refresh `scheduleSlots` without resetting the full page state.

## Technical Details

- Time rows are derived from the actual slot start/end times on that day, snapped to 30-minute boundaries (e.g., if slots are 09:00-10:00 and 09:30-10:30, rows would be 09:00, 09:30, 10:00, 10:30)
- A slot spanning multiple time rows will span multiple grid rows using `gridRow` CSS
- Player chip drag and slot drag coexist in the same `DndContext` — differentiated by the `active.id` prefix in `handleDragEnd`
- Slot cards get a drag handle at the top (the time header area becomes the grab zone) while player chips keep their existing grip handle

