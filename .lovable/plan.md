

# Add Player Management to Cycle Edit Dialog

## Summary
Add a "Players" section to the existing cycle edit dialog in Schedule Overview, allowing trainers to add/remove players across all sessions in a cycle without leaving the page.

## Current State
- The edit cycle dialog manages name, price, location, extra costs, privacy, dates, and repeat count
- Players can only be removed per-session (expand slot → X button) or added via the calendar's BookForPlayerDialog
- The trainer's guest_players list is already fetched in other components (BookForPlayerDialog, AddSlotDialog)

## Changes

### `src/pages/TrainerScheduleOverview.tsx`

1. **Add state for player management in edit dialog:**
   - `editCyclePlayers`: list of unique players currently booked across cycle slots (id, name, booking count)
   - `availableGuestPlayers`: trainer's guest_players list for the dropdown
   - `addingPlayer` / `removingPlayer` loading states

2. **Extend `openEditDialog`:**
   - Collect unique players from all bookings across cycle slots
   - Fetch trainer's guest_players list for the "add player" dropdown

3. **Add "Players" section in the edit dialog UI (before the location field):**
   - List current players with their booking count (e.g., "3/14 sessions") and a remove (X) button
   - "Add player" dropdown/select from the trainer's guest_players (filtered to exclude already-enrolled players)
   - When adding: create bookings for all future cycle slots
   - When removing: cancel all bookings for that player across cycle slots (with confirmation)

4. **Add/Remove player handlers:**
   - `handleAddPlayerToCycle`: Insert bookings for the selected guest_player across all future slots in the cycle
   - `handleRemovePlayerFromCycle`: Cancel all bookings for that player across all cycle slots (show confirmation first)

### Translation keys
- `scheduleOverview.players`: "Players"
- `scheduleOverview.addPlayerToCycle`: "Add player"
- `scheduleOverview.removeFromCycle`: "Remove from all sessions"
- `scheduleOverview.noPlayersInCycle`: "No players in this cycle"
- `scheduleOverview.addedToCycle`: "Player added to cycle"
- `scheduleOverview.removedFromCycle`: "Player removed from cycle"

## Files
- `src/pages/TrainerScheduleOverview.tsx` — Add player section to edit dialog + handlers
- `src/i18n/locales/en/trainer.json` — Translation keys
- `src/i18n/locales/nl/trainer.json` — Translation keys

