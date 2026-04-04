

# Add match quality warnings for manually assigned players

## Problem
When players are manually assigned to slots, they get `confidence_score: null`, so no quality indicators show. Three things are missing:
1. **Day/time availability warning** — player didn't say they're available on this day
2. **Rating out-of-range** — already works via `isRatingOutOfRange` on `DraggablePlayerChip`
3. **Group level spread warning** — large rating gap between players in the same slot

## What changes

### 1. Day availability warning on player chips
The `DraggablePlayerChip` currently only checks rating range. Add a check: look up the player in `allPlayers` by `intake_request_id`, check if the slot's day is in their `preferred_days`. If not, show an orange clock icon with a tooltip "Player didn't indicate availability on [day]".

### 2. Group level spread warning on slot cards
On the `DraggableSlotCard`, after occupancy info: if the slot has 2+ players with ratings, calculate the max rating gap. If it exceeds a threshold (e.g., 2.0 points), show an amber warning like "⚠ Level spread: 3.2 pts".

### 3. Compute a basic match score for manual assignments
When `confidence_score` is null (manual), compute a simple client-side score based on day match + rating fit and display it with a "manual" indicator, so you still see how well the player fits.

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | (1) Pass `allPlayers` + slot day to `DraggablePlayerChip`; add day-availability warning icon. (2) Add rating spread warning to `DraggableSlotCard`. (3) Compute display score for null-confidence assignments. |

## Detail

**Day warning on chips** (~5 lines in `DraggablePlayerChip`):
- New props: `allPlayers`, `slotDay`
- Lookup: `allPlayers?.find(p => p.id === assignment.intake_request_id)`
- Check: `player.preferred_days` doesn't include slot day → show `Clock` icon with amber color + tooltip

**Spread warning on slot card** (~10 lines in `DraggableSlotCard`):
- After occupancy row, compute `maxGap = max(ratings) - min(ratings)` from assignments
- If `maxGap > 2.0`, render amber `AlertTriangle` + "Level spread: X.X"

**Client-side score for manual assignments** (~15 lines helper):
- When `confidence_score` is null, calculate: day match (50pts) + rating-in-range (50pts)
- Show as a lighter-styled badge so it's visually distinct from algorithm-generated scores

