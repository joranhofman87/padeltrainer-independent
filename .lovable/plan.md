

# Redesign Registration Detail Sheet Actions

## Problem
1. Actions (Edit, Confirm, Waitlist, Reject, Delete) are at the bottom of the sheet — easy to miss and requires scrolling
2. The "Delete" button deletes the **registration** (intake request), not the proposal — this is confusing and dangerous in the proposal review context
3. Missing proposal-specific actions: no way to delete a proposal (move player back to unplaced) or reassign from within this sheet

## Changes

### `src/components/cycles/IntakeRequestDetailSheet.tsx`

**Move actions to top**: Place a compact action bar right below the `SheetHeader` (before the contact info card). This keeps actions always visible without scrolling.

**Remove the registration Delete button**: It's confusing and risky in this context. Registration management (including deletion) should happen in the registrations step, not while reviewing proposals.

**Add proposal-specific actions** (shown only when a proposal exists):
- **Delete proposal** — calls `updateProposedAssignmentStatus(proposal.id, 'rejected')` or deletes the proposed_assignment row, effectively moving the player back to "unplaced". Label: "Remove proposal" with an Undo/X icon
- **Change proposal** — opens the existing `ReassignPlayerDialog` (already used in `ProposalCard`). Label: "Reassign" with an Edit icon

**Keep existing actions** (Edit registration, Confirm, Waitlist, Reject) in the top bar — these are still useful for managing the registration status.

### Layout
```text
┌─ Sheet Header ─────────────────────────┐
│ Registration Detail                     │
│ Applied Mar 15, 2026                   │
├─ Actions Bar ──────────────────────────┤
│ [Edit] [Confirm] [Waitlist] [Reject]   │
│ ── Proposal: [Remove Proposal] [Reassign] │
├─────────────────────────────────────────┤
│ Contact Info card                       │
│ Preferences card                        │
│ ...                                     │
│ Proposal card                           │
└─────────────────────────────────────────┘
```

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Move actions div from bottom (line 639-710) to right after SheetHeader; remove Delete registration button; add "Remove proposal" and "Reassign" buttons when proposal exists |

