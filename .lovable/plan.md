

# Add Tabs and Filters to Academy Players Page

## Summary
Restructure the Players page to match the tab pattern used on the Calendar page. Add three filter dropdowns and three tabs (All Players, Create, Email Campaign).

## Changes

### 1. `src/pages/academy/AcademyPlayers.tsx` — Add tabs + filters

**Tabs structure:**
- Wrap entire page content in `<Tabs>` with values: `all-players`, `create`, `email-campaign`
- Tab bar matches Calendar style (icon + label per trigger)
- `all-players`: current player table (existing content)
- `create`: embed the `AddPlayerDialog` content inline (or keep the button-triggered dialog — simpler to just keep the existing Add/Import buttons and table as-is in this tab)
- `email-campaign`: placeholder card with "Coming soon" message

**Filter row (below tabs, above search):**
Add three `Select` dropdowns next to the existing trainer filter and search:

1. **Location** — derived from bookings → availability_slots → location_id → locations.name
   - During `fetchPlayers`, also fetch distinct location_ids from the slots that players are booked into
   - Build a location name map and attach `location_names: string[]` to each `UnifiedPlayer`
   - Filter dropdown shows all unique locations

2. **Level** — based on `skill_rating` ranges
   - Group into bands: Beginner (1-3), Intermediate (4-6), Advanced (7-9), Pro (9+), Unrated
   - Filter by selected band

3. **Has Active Cyclus** — Yes/No filter
   - During `fetchPlayers`, check if a player has any booking in a slot with a `cyclus_id` where `end_time >= now()`
   - Attach `has_active_cyclus: boolean` to `UnifiedPlayer`

**Data enrichment in `fetchPlayers`:**
- When fetching slots for bookings, also select `location_id, cyclus_id, end_time` and join `locations(name)`
- For guest players: query `bookings` by `guest_player_id` to get their slot details
- Build per-player maps for location names and active cyclus status

### 2. `UnifiedPlayer` type — extend

Add fields:
```typescript
location_names?: string[];
has_active_cyclus?: boolean;
```

### 3. Filter logic in `useEffect`

Chain existing trainer + search filters with the three new filters:
- `selectedLocation` → filter players where `location_names` includes the value
- `selectedLevel` → filter by skill_rating range
- `selectedCyclus` → filter by `has_active_cyclus === true/false`

## File summary

| File | Change |
|------|--------|
| `src/pages/academy/AcademyPlayers.tsx` | Add Tabs wrapper, filter dropdowns, extend data fetching to include location/cyclus info, add Email Campaign placeholder tab |

