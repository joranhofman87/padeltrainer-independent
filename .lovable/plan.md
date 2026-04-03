

# Add "Add Player" to Slot — Pick from All Registrations

## Problem
When a trainer wants to place someone a second time (e.g. for 2×/week decided via email, not in the form), there's no way to do it. The unplaced sidebar only shows players without any assignment. The trainer needs access to the full player list from within a slot.

## Approach
Add a small, subtle "+" button at the bottom of each slot card. Clicking it opens a compact popover/dialog with a searchable list of **all** registered players (not just unplaced). Selecting a player calls the existing `onAssignPlayer` handler. This keeps the feature discoverable but not distracting.

## Changes

### `src/components/cycles/ProposalScheduleGrid.tsx`

1. **New prop**: `allPlayers?: UnplacedPlayer[]` — the full list of registered players (placed + unplaced), passed from the parent
2. **"+" button on slot cards**: Add a small `UserPlus` icon button below the player chips in `DraggableSlotCard`. Only shown when `onAssignPlayer` and `allPlayers` are provided. Styled as a ghost button, subtle and compact.
3. **Add Player Popover**: Clicking "+" opens a `Popover` with:
   - A search input
   - A scrollable list of all players (filtered by search), showing name + rating
   - Players already in *this* slot are greyed out / disabled
   - Clicking a player triggers `onAssignPlayer(player.id, slot.id)` and closes the popover
4. Pass `allPlayers` and `onAssignPlayer` down to `DraggableSlotCard`

### Parent pages (pass `allPlayers`)

- `src/pages/academy/AcademyCycleDetail.tsx`: Create `allPlayers` from the full `requests` array (same shape as `unplacedPlayers` but without the status filter), pass as `allPlayers` prop
- `src/pages/TrainerIntakeRequests.tsx`: Same
- `src/pages/academy/AcademyIntakeRequests.tsx`: Same

## Result
- Small "+" button at the bottom of each slot — easy to miss if you don't need it, but there when you do
- Opens a searchable player picker showing everyone
- Already-assigned players in that slot are disabled to prevent accidental duplicates within the same slot
- Works with the existing `onAssignPlayer` handler — no new backend changes needed

## Files

| File | Change |
|------|--------|
| `src/components/cycles/ProposalScheduleGrid.tsx` | Add `allPlayers` prop, "+" button on slots, Add Player Popover |
| `src/pages/academy/AcademyCycleDetail.tsx` | Build and pass `allPlayers` from full `requests` list |
| `src/pages/TrainerIntakeRequests.tsx` | Same |
| `src/pages/academy/AcademyIntakeRequests.tsx` | Same |

