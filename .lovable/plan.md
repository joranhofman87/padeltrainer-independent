

## Add Manual Override: Move Players Between Proposal Groups

### Problem
Academy owners can't manually adjust the auto-generated proposals. If they want to move a player from one slot/group to another, they have no way to do so.

### Approach: "Reassign Player" Dialog

When viewing a proposed player (either from the schedule grid block click or from the detail sheet), the academy owner can reassign them to a different slot+trainer combination. This leverages the existing `updateProposedAssignment` function which already supports changing `slot_id` and `trainer_id`.

### UX Flow

1. On the **ProposalCard** (inside the detail sheet) and on the **schedule grid block click**, add a **"Move to different slot"** button
2. Clicking it opens a **ReassignPlayerDialog** that shows:
   - Current assignment (day, time, trainer, group mates)
   - A list of all other occupied slots for this cycle, showing: day, time, trainer name, current group members + ratings, and available capacity
   - An option to pick any available trainer slot (even empty ones)
3. On confirm, the `proposed_assignment` row is updated with the new `slot_id` and `trainer_id`, confidence score is cleared/set to manual, and data refreshes

```text
┌─────────────────────────────────────────┐
│  Move "Lisa" to a different slot        │
├─────────────────────────────────────────┤
│  Current: Mon 09:30 · Coach Maria       │
│  Group: Anna (4.0), Mark (4.0)          │
│                                         │
│  Available slots:                       │
│  ┌─────────────────────────────────┐    │
│  │ ○ Mon 09:30 · Coach Alex        │    │
│  │   Tom (3.5), Sara (3.0), Jan    │    │
│  │   2/4 spots remaining           │    │
│  ├─────────────────────────────────┤    │
│  │ ○ Tue 10:00 · Coach Alex        │    │
│  │   Empty slot                    │    │
│  │   4/4 spots remaining           │    │
│  └─────────────────────────────────┘    │
│                                         │
│  [Cancel]              [Move Player]    │
└─────────────────────────────────────────┘
```

### Technical Details

**New component: `src/components/cycles/ReassignPlayerDialog.tsx`**
- Accepts: `requestId`, `currentSlotId`, `cycleId`, `open`, `onOpenChange`, `onReassigned`
- Fetches all `availability_slots` for the cycle's trainers within the cycle date range
- Fetches all current `proposed_assignments` for those slots to show occupancy
- Resolves trainer names via `profiles` table (two-step query pattern)
- On confirm: calls `updateProposedAssignment(assignmentId, { slot_id, trainer_id })` with the new slot
- Sets `confidence_score` to `null` and adds a rationale entry `{ type: 'manual_override', score: 0, detail: 'Manually reassigned by manager' }`

**Edit: `src/components/cycles/ProposalCard.tsx`**
- Enable the currently disabled "Edit" button (pencil icon, line 161-167)
- Wire it to open `ReassignPlayerDialog`

**Edit: `src/components/cycles/IntakeRequestDetailSheet.tsx`**
- Pass the `proposedAssignment.id` and cycle context to `ProposalCard` so it can trigger reassignment
- After reassignment, refresh proposal data

**Edit: `src/lib/cycles.ts`**
- Add helper `getAvailableSlotsForCycle(cycleId)` that fetches all trainer slots within the cycle date range, with current assignment counts
- Extend `updateProposedAssignment` to also accept `confidence_score` and `rationale` updates

**No database migration needed** -- the existing `proposed_assignments` table already has `slot_id`, `trainer_id`, `confidence_score`, and `rationale` columns, and the `updateProposedAssignment` function supports partial updates.

### Files to Create/Edit
- **Create**: `src/components/cycles/ReassignPlayerDialog.tsx`
- **Edit**: `src/components/cycles/ProposalCard.tsx` -- enable edit button, wire dialog
- **Edit**: `src/components/cycles/IntakeRequestDetailSheet.tsx` -- pass cycle context
- **Edit**: `src/lib/cycles.ts` -- add `getAvailableSlotsForCycle`, extend update function

