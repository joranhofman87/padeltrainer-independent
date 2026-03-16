

# Slot Edit Popover: Time Editing, Deletion, and Player Details

## What to build

A click-to-edit popover on each slot card in the schedule grid that serves three purposes:
1. **Edit start/end time** via dropdowns (30-min increments)
2. **Delete the slot** (with confirmation)
3. **Show richer player info** (name, rating, confidence score, preferred times)

## Changes

### 1. Backend: Add `deleteSlot` function (`src/lib/cycles.ts`)
- New function that deletes an `availability_slots` row by ID
- Before deleting, reassign any `proposal_assignments` on the slot back to status `new` (or simply delete them — players return to unassigned pool)
- Simple `supabase.from('availability_slots').delete().eq('id', slotId)`

### 2. New component: `SlotEditPopover` (inline in `ProposalScheduleGrid.tsx`)
A `Popover` anchored to the slot card containing:

**Time section:**
- Two `Select` dropdowns: start time and end time (30-min steps, bounded by trainer availability window for that day)
- Validation: end > start, no overlap with adjacent slots on same trainer
- "Apply" button calls existing `onMoveSlot(slotId, sameTrainerId, newStart, newEnd)`

**Player details section:**
- List of assigned players with: name, rating (with rating system label), confidence score with color coding
- Each player row is clickable (triggers existing `onPlayerClick`)

**Delete section:**
- "Delete slot" button (destructive variant) with inline confirmation ("Are you sure?")
- Calls new `onDeleteSlot` callback

### 3. Wire into `DraggableSlotCard`
- Make the time range label clickable to open the `SlotEditPopover`
- Add a subtle pencil/edit icon on hover next to the time
- Pass through: `onMoveSlot`, `onDeleteSlot`, `trainerAvailabilityWindows`, `selectedDay`, `daySlots` (for overlap checking)

### 4. Update `ProposalScheduleGrid` props
- Add `onDeleteSlot?: (slotId: string) => void` prop
- Thread it from parent pages alongside existing `onMoveSlot`

### 5. Update parent pages (`AcademyIntakeRequests.tsx`, `TrainerIntakeRequests.tsx`)
- Add `onDeleteSlot` handler that calls `deleteSlot()` from cycles lib, then refreshes schedule slots
- Push to undo stack before deletion

## Files to create/modify
- **Modify**: `src/lib/cycles.ts` — add `deleteSlot` function
- **Modify**: `src/components/cycles/ProposalScheduleGrid.tsx` — add `SlotEditPopover`, wire into `DraggableSlotCard`, add `onDeleteSlot` prop
- **Modify**: `src/pages/academy/AcademyIntakeRequests.tsx` — pass `onDeleteSlot` handler
- **Modify**: `src/pages/TrainerIntakeRequests.tsx` — pass `onDeleteSlot` handler

