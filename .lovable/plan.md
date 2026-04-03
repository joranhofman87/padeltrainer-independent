

# Add match indicators to the manual player assignment popover

## What this does
When you click the "+" button on a slot to manually add a player, the search popover will now show match indicators next to each player name, so you can quickly see if a player fits the slot based on day preference and rating level.

## Match logic (client-side, instant)
For each player in the list, compute a simple match against the target slot:

1. **Day match**: Does the player's `preferred_days` include the slot's day of week?
2. **Rating match**: Is the player's rating within the slot's `min_rating`–`max_rating` range?
3. **Visual indicator**: Show a colored dot or percentage badge:
   - Green dot + "Match" — both day and rating fit
   - Orange dot + "Partial" — one of the two fits (e.g. right day, wrong level)
   - Red dot + "Mismatch" — neither fits
   - No indicator if slot has no rating range and player has no day preferences (insufficient data)

## Where it appears
- **AddPlayerToSlotPopover** (the "+" button on each slot card in the schedule grid) — used in both Step 4 (Review & Edit) and Step 5 (Approve & Book)
- Same component is already shared between Academy and Trainer flows, so both roles get it automatically

## Changes

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Pass `slot` object to `AddPlayerToSlotPopover`; add match computation and colored indicator per player row; sort results by match quality (matches first) |

## Technical details
- `AddPlayerToSlotPopover` receives an additional `slot: SlotWithOccupancy` prop
- Day is derived from `slot.start_time` using `format(new Date(slot.start_time), 'EEEE').toLowerCase()`
- Rating check: `player.rating >= slot.min_rating && player.rating <= slot.max_rating`
- Players sorted: full match → partial → mismatch, then alphabetically within each group
- No new API calls, no new dependencies — purely computed from existing data already in memory

