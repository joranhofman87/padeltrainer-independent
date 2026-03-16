
Goal: Fix the schedule grid so a proposed slot visually fills its full time range and all assigned player names are visible.

1) Root cause to address
- In `ProposalScheduleGrid`, each multi-row slot is rendered once with `rowSpan`, but the code also renders extra “occupied” cells for the rows underneath it.
- Those occupied cells are layered on top later in DOM order and visually cover the lower part of the slot card, which hides player chips (2nd/3rd names) and makes the block look truncated.

2) Implementation approach
- Update `src/components/cycles/ProposalScheduleGrid.tsx` in the “occupied cell” branch:
  - Stop rendering visual wrappers for covered rows (remove the overlapping `bg-background` cell content).
  - Keep only the main spanning slot cell as the visible element.
- Ensure the spanning slot container fills its full grid area:
  - Apply full-height behavior to the slot cell wrapper (`DroppableCell` when `hasSlot=true`) and slot cards so the card consistently covers the intended duration area.
- Keep drag/drop behavior intact:
  - Use the main spanning slot droppable region for the full slot area (no visual overlay cells needed for covered sub-rows).

3) Technical details
- File: `src/components/cycles/ProposalScheduleGrid.tsx`
- Sections to update:
  - Grid body loop around `occupiedCells` handling (`if (occupyingSlotId) { ... }`)
  - `DroppableCell` class logic to differentiate empty cells vs slot cells (`min-h` for empty, `h-full` for slot containers)
  - `DraggableSlotCard` / `BlockedSlotCard` height classes to align with full slot span rendering
- No backend/database changes required.

4) Validation checklist
- Open Step 3 schedule view with a slot containing 2–4 assigned players.
- Confirm the card spans the full time block (e.g., 11:00–12:00) without visual cutoff.
- Confirm all player chips are visible (including 2nd/3rd names).
- Confirm drag-and-drop still works when dropping onto lower half of a multi-row slot.
- Confirm blocked slots still render correctly and remain non-interactive.
