

# Step 4: Read-Only Overview + Approve & Book

## Problem
- Step 3 currently has an "Approve all" button that doesn't belong there -- Step 3 is for editing/reviewing.
- There is no Step 4 view: users cannot see a final read-only summary before confirming.
- Users need a clear "last check" before committing proposals into the agenda.

## Changes

### 1. Remove "Approve all" from Step 3 (`ProposalWorkflowSteps.tsx`)
- Step 3 action keeps only the **Reset** button (for going back to regenerate).
- Add a **"Continue to overview"** button that triggers a new callback `onShowOverview`.

### 2. Add "Approve all" to Step 4 (`ProposalWorkflowSteps.tsx`)
- Step 4 action shows the **"Approve all"** button only when it's active and there are proposed items.
- Also add a "View overview" button to open the overview panel.

### 3. New component: `ProposalOverviewPanel.tsx`
A read-only summary dialog/sheet that shows:
- **Summary stats**: total slots created, total players assigned, unassigned players.
- **Per-trainer breakdown**: trainer name, number of slots, list of days/times with assigned player names.
- Uses the existing `scheduleSlots` (`SlotWithOccupancy[]`) data -- no new API calls needed.
- Grouped by trainer, then by day, showing time + player names in a simple table/list.
- No drag-and-drop, no editing, no interactivity beyond scrolling and closing.
- A prominent **"Approve & Book all"** button at the bottom of the overview.
- A **"Back to editing"** button to return to Step 3.

### 4. Wire into parent pages (`AcademyIntakeRequests.tsx` + `TrainerIntakeRequests.tsx`)
- Add `showOverview` state.
- Pass `onShowOverview` to `ProposalWorkflowSteps`.
- Render `ProposalOverviewPanel` when `showOverview` is true, passing `scheduleSlots` and `onApproveAll`.
- The `onApproveAll` handler still needs to be implemented (currently a no-op `() => {}`), but that's a separate task -- the overview panel will call it.

### 5. Update step status logic
- When `proposedCount > 0`: steps 1-2 completed, step 3 active, step 4 upcoming.
- When user clicks "Continue to overview": step 3 completed, step 4 active (controlled by parent state `showOverview`).

## Files to create/modify
- **Create**: `src/components/cycles/ProposalOverviewPanel.tsx`
- **Modify**: `src/components/cycles/ProposalWorkflowSteps.tsx` -- move approve to step 4, add overview trigger
- **Modify**: `src/pages/academy/AcademyIntakeRequests.tsx` -- wire overview state
- **Modify**: `src/pages/TrainerIntakeRequests.tsx` -- wire overview state

