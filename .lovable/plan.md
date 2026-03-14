

# Fix Calendar View & Add Workflow Steps

## Bug Fix
The schedule/calendar view shows "No proposals" because of a **viewMode mismatch**:
- The toggle button sets `viewMode` to `'schedule'` (line 271)
- The data-fetching `useEffect` checks for `viewMode === 'grid'` (line 88)
- They never match, so slots are never loaded

**Fix**: Change the condition on line 88 from `'grid'` to `'schedule'`.

## Workflow Steps
Replace the scattered action buttons with a clear step-by-step workflow indicator at the top of the page, showing progress through the proposal lifecycle:

```text
① Generate  →  ② Review & Edit  →  ③ Approve  →  ④ Book to Agenda
```

- Each step shows its status (completed/active/upcoming) based on the data state
- Steps are rendered as a horizontal stepper with numbered circles and connecting lines
- Active step is highlighted; completed steps show a checkmark
- Each step has a brief description and the relevant action button inline

**Step logic:**
1. **Generate** — active when there are `new` requests; button opens the wizard
2. **Review & Edit** — active when there are `proposed` requests; shows the list/grid toggle
3. **Approve** — active when reviewing; shows "Approve All" button
4. **Book to Agenda** — active when there are `confirmed` requests; button to finalize booking

This replaces the current row of buttons with a more guided, contextual flow.

## Files
- `src/pages/academy/AcademyIntakeRequests.tsx` — fix viewMode bug + add workflow stepper component
- `src/pages/TrainerIntakeRequests.tsx` — same viewMode bug fix (if present)
- New: `src/components/cycles/ProposalWorkflowSteps.tsx` — reusable stepper component

