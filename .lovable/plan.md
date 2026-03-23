

# Fix `has_trained` Status + Smarter Player Categorization

## Problem
1. **Bug**: When a player is added to a cycle (via schedule overview or calendar), `has_trained` on `guest_players` is never set to `true`. It stays as the default `false` ("prospect") forever.
2. **Feature gap**: The current binary (prospect/active) doesn't help trainers quickly find players who could fill open spots.

## Proposed Approach

### 1. Fix: Update `has_trained` when booking a player

In `handleAddPlayerToCycle` (TrainerScheduleOverview.tsx) and wherever bookings are created for guest players (BookForPlayerDialog, BulkCreateSheet), add:

```sql
UPDATE guest_players SET has_trained = true WHERE id = <guestPlayerId>
```

This ensures the flag flips to `true` as soon as a player gets their first booking.

### 2. Smarter player status categories

Replace the simple `has_trained` boolean display with a computed status based on actual booking data:

| Status | Meaning | Badge |
|--------|---------|-------|
| **Waiting list** | Player has an active waiting list entry | Amber outline |
| **Active** | Player has bookings in a current/future cycle | Green/default |
| **Available** | Player has trained before but has NO current/future cycle bookings | Blue outline |
| **Prospect** | Never booked (`has_trained = false`) | Grey outline |

The "Available" status is the key addition — these are players a trainer can quickly identify to fill spots.

### 3. Implementation

**Query enhancement** (TrainerPlayers.tsx, TrainerDashboard.tsx):
- When loading players, also check if each guest player has any bookings in current/future cycles (join `bookings` → `availability_slots` where `start_time >= now()` and status not cancelled)
- Check waiting list entries for each player
- Compute status client-side from these flags

**Display changes:**
- Update the status badge logic in TrainerPlayers.tsx, TrainerDashboard.tsx, AcademyPlayers.tsx, AcademyDashboard.tsx
- Add filter tabs or a status filter dropdown so trainers can quickly filter by "Available" players

### Files
- `src/pages/TrainerScheduleOverview.tsx` — Add `has_trained = true` update in `handleAddPlayerToCycle`
- `src/pages/TrainerPlayers.tsx` — Enhanced status computation + filter
- `src/pages/TrainerDashboard.tsx` — Updated badge logic
- `src/pages/academy/AcademyPlayers.tsx` — Same status updates
- `src/pages/academy/AcademyDashboard.tsx` — Same status updates
- `src/components/trainer/AddSlotDialog.tsx` — Update `has_trained` when booking via BulkCreateSheet
- `src/i18n/locales/en/trainer.json` — Add "available", "waitingList" status labels
- `src/i18n/locales/nl/trainer.json` — Dutch translations

