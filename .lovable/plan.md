

# Add Global Player Search to Schedule Preview

## Problem
The current search only filters the unplaced players sidebar. When a trainer wants to find where a specific player is placed (e.g. to move them from Friday to Monday), they have to manually click through each day tab and scan all slots.

## Approach
Add a search input at the top of the schedule grid (near the day tabs). When a name is typed, two things happen:

1. **Highlight matching players** in the grid — player badges that match get a visible highlight ring (e.g. orange border), so they stand out even in full slots
2. **Auto-navigate to the correct day** — if the search matches a player who is only on one day, auto-switch to that day tab. If on multiple days, show a small indicator on each day tab (e.g. dot or count)
3. **Filter unplaced sidebar too** — the existing sidebar search merges into this single global search

## Changes

### `src/components/cycles/ProposalScheduleGrid.tsx`
- Move the search input from the unplaced sidebar to the top bar (next to day tabs and undo button)
- When `searchQuery` is non-empty:
  - Compute which days contain matching players (both placed and unplaced)
  - Add a highlight dot/badge on day tabs that have matches
  - Pass the query down to `DraggableSlotCard` so matching player badges get a highlight class (e.g. `ring-2 ring-orange-400`)
- The unplaced sidebar still uses the same `searchQuery` for filtering (as it does now)
- If matches exist on exactly one day that isn't the current tab, auto-switch to it

### Slot/Player card rendering (within same file)
- `DraggableSlotCard` / player badge rendering: accept `searchQuery` prop, apply highlight styling when `player_name.toLowerCase().includes(query)`

## Result
- Trainer types "sabine" → the Monday tab lights up, grid auto-switches to Monday, and Sabine's badge in the 18:00 slot gets an orange highlight ring
- If "sabine" appears on multiple days, both day tabs show a dot, trainer can click between them
- Single search bar serves both placed players in the grid and unplaced players in the sidebar

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Move search to top bar, pass query to slot cards for highlighting, add match indicators on day tabs, auto-switch day |

