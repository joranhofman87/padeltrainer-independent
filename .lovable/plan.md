

# Add Search Input to Unplaced Players Sidebar

## Problem
The unplaced sidebar has no dedicated search. The global search bar at the top filters both the grid and sidebar, but when you just want to find someone in the unplaced list, you need a quick local filter right there.

## Change

### `src/components/cycles/ProposalScheduleGrid.tsx`

Add a small search input inside the unplaced sidebar header (between the title row and the `DroppableUnplacedPool`), around line 1595:

- Add a new `unplacedSearch` state (separate from the global `searchQuery`)
- Insert a compact `Input` with a search icon, placeholder "Search players..."
- Filter `filteredUnplaced` by both the global `searchQuery` AND the local `unplacedSearch`
- The badge count updates to reflect the filtered result
- Clear button (X) appears when text is entered

This keeps the global search for cross-grid highlighting and the local search for quick sidebar filtering — they stack (both must match).

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add local search input in unplaced sidebar header; add `unplacedSearch` state; combine with existing filter |

