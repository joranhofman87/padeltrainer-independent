

# Fix: Step 5 "0 confirmed" + unplaced visibility + tab counts

## Root cause
The `finalize-proposals` edge function sets intake request status to `'booked'`, but the UI only counts `status === 'confirmed'`. This mismatch means:
- Step 5 always shows "0 confirmed"
- The workflow never progresses to "completed" state
- The "Bevestigd" tab shows nothing

## Changes

### 1. Count booked requests as confirmed (`AcademyCycleDetail.tsx`)
- Change `confirmedCount` to count both `'confirmed'` and `'booked'` statuses: `requests.filter(r => r.status === 'confirmed' || r.status === 'booked').length`
- This makes step 5 show the correct number and the workflow progresses properly

### 2. Update workflow step logic (`ProposalWorkflowSteps.tsx`)
- Add `bookedCount` prop (or combine into `confirmedCount`)
- Update `allConfirmed` check to account for booked status: when `confirmedCount > 0` (now including booked), mark steps as completed

### 3. Add "Bevestigd" tab count + "Booked" filter (`AcademyCycleDetail.tsx`)
- Show count on the "Bevestigd" tab: `({confirmedCount})`
- When filtering by `'confirmed'`, also include `'booked'` status requests
- Add a "Booked" tab or merge booked into the confirmed tab

### 4. Show unplaced players at Step 1 registrations
- Add a filter tab for unplaced/unassigned players — those with `status === 'new'` or `status === 'proposed'` but no assignments
- This gives visibility into who hasn't been placed yet

### 5. Refresh tab counts after actions
- After assigning/confirming players, call `refreshData()` to update the counts in the status tabs

## Files

| File | Change |
|------|--------|
| `src/pages/academy/AcademyCycleDetail.tsx` | Update `confirmedCount` to include `'booked'` status; add count to Bevestigd tab; include booked in confirmed filter; refresh counts after mutations |
| `src/components/cycles/ProposalWorkflowSteps.tsx` | Update `allConfirmed` logic to work with combined confirmed+booked count |

## Summary
Two files, ~10 lines changed. The core fix is a single filter change from `=== 'confirmed'` to including `'booked'`.

