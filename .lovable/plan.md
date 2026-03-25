

# Fix Schedule Overview Tabs: Classify Cycles, Not Sessions

## Problem
The current tab filter applies per-slot, splitting a single cycle across tabs. A 10-session cycle might show 6 sessions under "Current" and 4 under "Future", making session counts and details confusing.

## New behavior
Tabs classify **entire cycles** based on first/last session dates:
- **Current** — first session has started AND last session hasn't ended yet
- **Past** — last session is in the past (cycle fully completed)
- **Future** — first session is still in the future (hasn't started yet)

All tabs always show the **full cycle details** (total sessions, all players, total price, etc.).

## Changes

### `src/pages/TrainerScheduleOverview.tsx`

**Tab filtering logic (~lines 254-307)**:
- Move the tab filter from per-slot to per-group level
- For each cycle group, determine `firstStart` (earliest slot) and `lastEnd` (latest slot)
- Classify:
  - `past`: `lastEnd` is in the past
  - `future`: `firstStart` is in the future  
  - `current`: everything else (started but not finished)
- Keep day/location/time/search filters working per-slot within the group, but always include **all slots** from matching cycles in the display
- The per-slot filters (day, location, time) narrow which cycles appear (if any slot matches, show the full cycle), but don't hide individual sessions within a cycle

**Display**: No changes needed to the cycle cards themselves — they already show totals when all slots are included.

