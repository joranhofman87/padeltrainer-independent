

## Unplaced Players Sidebar for Proposal Schedule Grid

### Problem
When 100+ registrants exist, the auto-generation can't place everyone. Trainers need to see who's unplaced and manually drag them into slots. Currently there's no visibility into unplaced players from the schedule view.

### Approach
Add a collapsible sticky sidebar to the right of the proposal grid that shows all intake requests that have status `'new'` (with or without `skip_reason`) for the selected cycle — these are people not yet assigned to any slot. Players can be:
- **Dragged from sidebar → into a slot** (creates a new `proposed_assignment`)
- **Dragged from a slot → back to sidebar** (deletes the `proposed_assignment`, sets request back to `'new'`)

The sidebar includes a search bar at the top to filter by name.

### Architecture

**Data flow:** The parent pages (`AcademyIntakeRequests` / `TrainerIntakeRequests`) already have `requests` (all `IntakeRequestWithProposal[]`) and `scheduleSlots`. We compute unplaced players as requests where `status === 'new'` for the selected cycle. Pass these into the grid.

**New props on `ProposalScheduleGrid`:**
- `unplacedPlayers: IntakeRequest[]` — the pool of unassigned registrants
- `onAssignPlayer?: (intakeRequestId: string, slotId: string) => void` — create new assignment
- `onUnassignPlayer?: (assignmentId: string) => void` — remove assignment, return to pool

**New backend functions in `src/lib/cycles.ts`:**
- `assignPlayerToSlot(intakeRequestId: string, slotId: string)` — inserts a `proposed_assignment` row and updates intake request status to `'proposed'`
- `unassignPlayer(assignmentId: string)` — deletes the `proposed_assignment` row and sets the intake request back to `'new'`

**UI in `ProposalScheduleGrid`:**
- Right sidebar panel (~280px wide), sticky, scrollable, inside the DndContext
- Search input at top (filters by name, case-insensitive)
- Each player card is draggable (type: `'unplaced-player'`)  with name, rating, preferred days/times, lesson type as small badges
- The sidebar itself is a droppable zone (id: `'unplaced-pool'`) — dropping an assigned player here triggers `onUnassignPlayer`
- Player count badge in sidebar header
- Collapsible on mobile via a toggle button

**DnD changes:**
- `handleDragEnd`: handle new drag type `'unplaced-player'` dropping onto a cell → calls `onAssignPlayer`
- Handle existing `'player'` type dropping onto `'unplaced-pool'` droppable → calls `onUnassignPlayer`
- DragOverlay already handles player type, reuse for unplaced players

### Files to modify
- `src/lib/cycles.ts` — add `assignPlayerToSlot` and `unassignPlayer` functions
- `src/components/cycles/ProposalScheduleGrid.tsx` — add sidebar UI, new draggable/droppable elements, updated drag handlers
- `src/pages/academy/AcademyIntakeRequests.tsx` — compute unplaced players, pass new props and handlers
- `src/pages/TrainerIntakeRequests.tsx` — same as above
- `src/i18n/locales/en/cycles.json` — sidebar translation keys
- `src/i18n/locales/nl/cycles.json` — sidebar translation keys (NL)

