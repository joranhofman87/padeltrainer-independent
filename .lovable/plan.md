

# Simplify Proposal Drawer Actions

## Problem
1. The drawer shows too many confusing buttons: Edit, Confirm, Waitlist, Reject (registration-level) AND Remove proposal, Reassign (proposal-level) — users don't understand the distinction
2. "Remove proposal" sets status to `rejected` in the DB but the schedule grid's local state doesn't update immediately, causing inconsistent display until refresh
3. Console shows 500 errors / timeouts when fetching proposals, adding to confusion

## Approach
When viewing the drawer **during the proposal review step** (Step 4 — when `proposal` exists), simplify to a single clear action:

**"Decline proposal"** — removes the player from their assigned slot and moves them to the Unplaced sidebar.

Keep the Edit button (it's useful for correcting player data). Remove Confirm, Waitlist, Reject, and Reassign from this context — those are registration-level actions that don't belong in the scheduling review phase. Reassign can be done by drag-and-drop or via the "+" button on slots.

## Changes

### `src/components/cycles/IntakeRequestDetailSheet.tsx`

1. **When a proposal exists**: Show only:
   - "Edit" button (to edit player details)
   - "Decline proposal" button (destructive style) — calls `handleRemoveProposal` which already sets `status = 'rejected'` and calls `onStatusChange`
   
2. **When no proposal exists** (viewing from Registrations tab): Keep existing buttons as-is (Edit, Confirm, Waitlist, Reject)

3. **Remove the separate "Proposal-specific actions" section** (lines 309-332) — merge into the main action bar logic

4. **Remove the Reassign button** from the drawer — users can reassign via drag-and-drop in the grid

### Translation updates
- Add `declineProposal` key: "Decline proposal" / "Voorstel afwijzen"

## Result
- Drawer in proposal review shows just Edit + "Decline proposal"
- Declining moves player to Unplaced sidebar via `onStatusChange` callback
- No more confusion between registration actions and proposal actions

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Condense action bar: show only Edit + "Decline proposal" when proposal exists; hide Confirm/Waitlist/Reject/Reassign |
| `src/i18n/locales/en/cycles.json` | Add `declineProposal` translation |
| `src/i18n/locales/nl/cycles.json` | Add `declineProposal` translation |
| `src/i18n/locales/de/cycles.json` | Add `declineProposal` translation |

