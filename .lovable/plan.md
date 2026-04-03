

# Show Full Player Names on Desktop

## Problem
Player names in slot cards are truncated with `max-w-[90px]` (line 208) and `truncate` class, cutting off names like "Wendy Brouw..." even on desktop where there's plenty of space.

## Change

### `src/components/cycles/ProposalScheduleGrid.tsx`

**Line 208** — the player name in `PlayerAssignmentChip` (used inside slot cards):
- Change `truncate max-w-[90px]` to `truncate max-w-[90px] sm:max-w-none` so on desktop the name isn't width-constrained and shows in full. On mobile/tablet it stays truncated.

**Line 422** — player name in the expanded assignment list (detail view):
- Already uses just `truncate` without a max-width, so the parent container controls it. Verify no extra constraint needed.

**Line 553** — player name in the Add Player popover:
- Same — just `truncate`, fine as-is.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Line 208: add `sm:max-w-none` to remove desktop truncation |

