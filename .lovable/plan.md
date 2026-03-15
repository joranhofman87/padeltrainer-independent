

# Fill Empty Trainer Time Rows with Droppable Placeholder Slots

## Problem
The grid only renders time rows and trainer columns where actual slots exist. If Trainer B has no slot at 10:00 but Trainer A does, there's no droppable cell for Trainer B at 10:00 — making it impossible to drag a slot there.

## Solution

Two-part approach:

### 1. Store trainer availability config on the cycle (persist wizard data)

When proposals are generated, save the `trainerAvailability` windows to `cycle.settings` so the grid knows each trainer's available hours even when no slots exist yet.

- Add `trainer_availability_windows` to `CycleSettings` interface in `src/lib/cycles.ts`
- Save it during `generateProposals` call — update cycle settings before/after generation
- In the parent pages (`AcademyIntakeRequests.tsx`, `TrainerIntakeRequests.tsx`), pass the stored config through to the grid

### 2. Expand the grid to show all trainers × all available time rows

In `ProposalScheduleGrid.tsx`:

- Accept a new optional prop: `trainerAvailabilityWindows` — the saved per-trainer day/time windows from the wizard
- When computing `trainers` and `timeRows`, also include trainers that have availability windows for the selected day (even if they have zero slots)
- When computing `timeRows`, union the time boundaries from actual slots AND from availability windows for that day
- Empty cells at valid trainer×time intersections become droppable targets — already handled by the existing `DroppableCell` rendering

This means if Trainer A is available Monday 09:00-17:00 and Trainer B is available Monday 10:00-14:00, the grid shows rows 09:00–17:00 with both trainers as columns, and all empty cells are droppable.

### Files to change

1. **`src/lib/cycles.ts`** — Add `trainer_availability_windows` to `CycleSettings`, save it when generating proposals
2. **`src/components/cycles/ProposalScheduleGrid.tsx`** — Accept availability windows prop, expand trainer list and time rows from windows, show all trainers with availability on selected day
3. **`src/pages/academy/AcademyIntakeRequests.tsx`** — Pass stored availability windows from cycle settings to the grid
4. **`src/pages/TrainerIntakeRequests.tsx`** — Same as above

