
## Fix Cyclus Booking Grouping on Trainer Dashboard

### Problem

The "Recent Bookings" table shows individual sessions instead of grouped cyclus rows (e.g., "Cyclus Monday 09:00 (1 session)" repeated 4 times instead of one row showing "(4 sessions)"). The grouping logic exists but fails because `player_id` and `guest_player_id` are not included in the select query -- they are only used as join keys for the `profiles` and `guest_players` relations, so PostgREST does not return them as standalone fields.

### Changes

**`src/pages/TrainerDashboard.tsx`**

- Add `player_id, guest_player_id` to the bookings select query (line 114) so the grouping key `cyclusName::playerId` resolves correctly
- Also increase the query limit from 10 to 50 to ensure all sessions of a cyclus are fetched before grouping, then slice the grouped result to 10

### Before
```
id, status, payment_status, created_at,
```

### After
```
id, status, payment_status, created_at, player_id, guest_player_id,
```

Query limit: `.limit(10)` changes to `.limit(50)`, and after grouping: `groupedBookings.slice(0, 10)` is set on the state.

### Files to modify
- `src/pages/TrainerDashboard.tsx` (2 small edits)
