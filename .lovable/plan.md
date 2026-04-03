

# Support Multiple Sessions Per Week in Proposal Generation

## Problem
Players can request 2+ sessions per week (`sessions_per_week` field), but the algorithm only assigns each player to **one** slot. The `sessions_per_week` value is currently just a scoring factor — it doesn't actually place the player in multiple time slots.

## Approach
After a player's first (best) slot assignment, loop and assign them to additional slots up to their requested `sessions_per_week` count. Each additional placement must be on a **different day** to avoid double-booking. The player appears multiple times in the schedule grid (once per assigned day).

## Changes

### `supabase/functions/generate-proposals/index.ts`
**Core logic change** — after the best slot is picked and assigned (line 998-1024), wrap in a loop:

1. After assigning a player to their best slot, check if `request.sessions_per_week > 1`
2. If yes, loop for remaining sessions needed (up to `sessions_per_week`):
   - Filter `scoredSlots` to exclude slots on the same day as already-assigned slots
   - Also exclude full slots (re-check capacity with updated `slotAssignments`)
   - Pick the next best-scoring slot from the remaining options
   - Insert another `proposed_assignment` row for the same `intake_request_id` but different `slot_id`
   - Track all assigned days to prevent same-day duplicates
3. If not enough different-day slots are available, assign as many as possible (partial fulfillment)

### `src/components/cycles/ProposalScheduleGrid.tsx`
- The grid already renders assignments from `proposed_assignments` — a player with 2 assignments will naturally appear in 2 slots on 2 different days
- Add a small visual indicator (e.g. "2×/wk" badge) on player chips when the source request has `sessions_per_week > 1`, so it's clear this player trains multiple times
- In the unplaced sidebar: show players as "partially placed" if they have fewer assignments than their requested sessions (e.g. wanted 2×, only placed 1×)

### `src/components/cycles/ProposalScheduleGrid.tsx` — Search & drag
- When searching, a multi-session player may appear on multiple days — the existing search highlight + day dot system handles this naturally
- Dragging a player chip moves that specific assignment, not all of them

## Edge Cases
- **Linked groups with multi-session**: Each group member gets the same multi-session treatment. If a group of 4 wants 2×/week, the group is placed as a unit on 2 different days
- **Not enough days available**: Player gets as many sessions as possible; remainder is surfaced as a note in rationale
- **Same slot scored highest for both sessions**: Day-exclusion filter prevents this

## Result
- Player requests "2× per week" → appears in 2 slots on 2 different days
- Partially placed players (1 of 2 sessions assigned) are flagged in the sidebar
- Trainer can manually drag additional sessions if the algorithm couldn't find enough slots

## Files

| File | Change |
|------|--------|
| `supabase/functions/generate-proposals/index.ts` | Loop assignment up to `sessions_per_week`, exclude same-day slots |
| `src/components/cycles/ProposalScheduleGrid.tsx` | Show multi-session badge, handle partial placement in sidebar |

