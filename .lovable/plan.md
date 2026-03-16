

# Fix UX: Cycle Selector as Step 1 + Scoped Tab Counts

## Problem 1: Cycle selector feels disconnected
The dropdown sits alone above the workflow steps. It should be **part of the workflow** — selecting a registration is the first thing a user does.

**Fix**: Remove the standalone `Select` from the controls area. Instead, make the cycle selector **Step 0** in the `ProposalWorkflowSteps` component — always visible, even before a cycle is selected. The three existing steps (Generate → Review → Approve) shift to steps 2-4. This also removes the need for the separate "select cycle" hint alert.

## Problem 2: Tab counts are cross-cycle
Line 250: `{t('intakeRequests.filters.all')} ({requests.length})` uses the **unfiltered** `requests` array (all cycles). The other tabs use `filteredRequests` which respects the selected cycle. So "All (5)" shows 5 even when a specific cycle only has 2 requests.

**Fix**: All tab counts should use `filteredRequests` (already filtered by `selectedCycleId`). Change:
- `requests.length` → `filteredRequests.length` for the "All" tab
- Counts for new/proposed/confirmed/waitlist should also derive from `filteredRequests` (they already do via `newCount`, `proposedCount`, etc. — but those are computed from `filteredRequests` which is correct). Actually looking again, `newCount` etc. are computed from `filteredRequests` on lines 170-173, so those are already correct. Only the "All" tab count on line 250 is wrong.

## Files to change

### 1. `src/components/cycles/ProposalWorkflowSteps.tsx`
- Add a new **Step 1: "Select Registration"** with the cycle dropdown embedded inside it
- Add props: `cycles`, `selectedCycleId`, `onCycleChange`
- Shift existing steps to 2, 3, 4
- Step 1 is "completed" once a cycle is selected, "active" otherwise

### 2. `src/pages/academy/AcademyIntakeRequests.tsx`
- Remove the standalone `Select` dropdown and the "select cycle hint" alert
- Always render `ProposalWorkflowSteps` (not just when `selectedCycleId !== 'all'`)
- Pass `cycles`, `selectedCycleId`, `onCycleChange` to the workflow component
- Fix line 250: `requests.length` → `filteredRequests.length`

### 3. `src/pages/TrainerIntakeRequests.tsx`
- Same changes as above (if it has the same pattern)

