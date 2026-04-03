

# Consolidate Proposal Info in Drawer

## Problem
The drawer shows proposal-related content in two separate places — a "Decline proposal" button at the top and a full Proposal Card (with its own Approve/Reject/Reassign buttons) at the bottom. This is confusing and redundant.

## Approach
Merge everything into **one place**: keep the Proposal Card at the bottom as the single source of proposal info and actions. Remove the "Decline proposal" button from the top action bar.

The ProposalCard already has Approve, Reject (which declines), and Reassign — it's the complete set. We just need to make "Reject" clearer by relabeling it to "Decline proposal" so the intent is obvious.

## Changes

### `src/components/cycles/IntakeRequestDetailSheet.tsx`
- **Remove** the `proposal && proposal.status === 'proposed'` branch (lines 273-284) from the top action bar — no more "Decline proposal" button at the top
- The top action bar will always show the registration-level actions (Edit, Confirm, Waitlist, Reject) regardless of whether a proposal exists — these are about the registration, not the proposal
- The bottom ProposalCard handles all proposal-specific actions

### `src/components/cycles/ProposalCard.tsx`
- Rename the Reject button label from the X icon to "Decline proposal" text so it's clear what it does
- Keep Approve and Reassign as they are

## Result
- **Top of drawer**: Edit + registration status actions (always the same)
- **Bottom of drawer**: Proposal Card with Approve / Reassign / Decline proposal — one clear place for all proposal actions
- No more duplication or confusion

## Files

| File | Change |
|------|--------|
| `src/components/cycles/IntakeRequestDetailSheet.tsx` | Remove "Decline proposal" from top action bar; always show registration actions |
| `src/components/cycles/ProposalCard.tsx` | Rename Reject button to "Decline proposal" for clarity |

