

# Redesign ProposalScheduleGrid: Column-per-Trainer with Drag & Drop

## Current State
- Grid groups slots by **day** (tabs), then by **trainer** (collapsible sections) with slot cards in a responsive grid
- `onMovePlayer` exists as a prop but only shows a small arrow icon on hover — no actual move UI/logic is wired up
- No drag-and-drop, no slot time editing, no cross-trainer moves

## Proposed Layout: Trainer Columns

Switch from "rows per trainer" to a **column-per-trainer** layout within each day tab:

```text
┌─ Monday ─────────────────────────────────────────────┐
│  Trainer A          │  Trainer B          │          │
│  ┌──────────────┐   │  ┌──────────────┐   │          │
│  │ 09:00-10:00  │   │  │ 09:00-10:30  │   │          │
│  │ 🟢 Jan, Piet │   │  │ 🟡 Karel     │   │          │
│  └──────────────┘   │  └──────────────┘   │          │
│  ┌──────────────┐   │  ┌──────────────┐   │          │
│  │ 10:00-11:00  │   │  │ 10:30-12:00  │   │          │
│  │ 🔴 empty     │   │  │ 🟢 Maria, .. │   │          │
│  └──────────────┘   │  └──────────────┘   │          │
└──────────────────────────────────────────────────────┘
```

Each column shows the trainer's avatar/name at the top, with their time slots stacked vertically in chronological order. This makes gaps between trainers immediately visible.

## Interactions to Add

### 1. Drag & Drop Players Between Slots
- Use HTML5 drag (or a lightweight library like `@dnd-kit`) to let users drag a player chip from one slot card and drop it onto another slot card (same or different trainer column)
- On drop: call a new function `movePlayerAssignment(assignmentId, newSlotId)` that updates the `proposed_assignments` row's `slot_id`
- Validate: target slot not full, same day (for now)

### 2. Edit Slot Time (inline)
- Click on a slot's time header to open a small popover/dialog with start/end time pickers
- On save: update the `availability_slots` row and refresh

### 3. Move Entire Slot Between Trainers
- Drag the slot card header (not a player chip) to a different trainer column
- On drop: update `availability_slots.trainer_id` and refresh

## Files to Change

1. **`src/components/cycles/ProposalScheduleGrid.tsx`** — Major rewrite:
   - Replace row-based trainer sections with column layout (`flex` or CSS grid with 1 column per trainer)
   - Add drag-and-drop for player chips (using `@dnd-kit/core` + `@dnd-kit/sortable`)
   - Add slot time edit popover
   - Add slot drag between trainer columns

2. **`src/lib/cycles.ts`** — Add helper functions:
   - `movePlayerAssignment(assignmentId: string, newSlotId: string)` — updates `proposed_assignments.slot_id`
   - `updateSlotTime(slotId: string, startTime: string, endTime: string)` — updates `availability_slots`
   - `moveSlotToTrainer(slotId: string, newTrainerId: string)` — updates `availability_slots.trainer_id`

3. **`package.json`** — Add `@dnd-kit/core` and `@dnd-kit/utilities` dependencies

4. **Parent pages** (`AcademyIntakeRequests.tsx`, `TrainerIntakeRequests.tsx`) — Wire up the new callbacks and refresh data after moves

## Implementation Priority
Given complexity, I'd suggest phasing:
- **Phase 1**: Column layout + drag-drop players between slots (highest value)
- **Phase 2**: Slot time editing via popover
- **Phase 3**: Drag entire slots between trainers

Shall I implement Phase 1 first (column layout + player drag-and-drop)?

