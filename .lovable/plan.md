

## Add "My Clubs" Card to Player Dashboard

### What
Replace the current Waiting List card (4th position in the activity grid) with a "My Clubs" table, and move the Waiting List into a 5th card. The "My Clubs" table shows clubs the player follows (from the `club_followers` table), with each row linking to the club's location page.

### Layout Change

The activity grid goes from 2x2 to 2x3:

```text
| Upcoming Bookings        | Followed Trainers       |
| Open Slots               | My Clubs (NEW)          |
| Waiting List             |                         |
```

### Changes

**File: `src/pages/PlayerDashboard.tsx`**

1. **New interface** `PlayerClub` with fields: `id`, `clubProfileId`, `locationName`, `locationSlug`, `logoUrl`.

2. **New state**: `playerClubs` and `clubsLoading`.

3. **New fetch function** `fetchPlayerClubs`:
   - Query `club_followers` where `player_id = profile.id`
   - Join to `club_profiles(id, location_id, logo_url)` via `club_profile_id`
   - Join to `locations(name, slug)` via `club_profiles.location_id`
   - Map results into `PlayerClub[]`

4. **Call** `fetchPlayerClubs()` in the existing `useEffect` alongside the other fetches.

5. **New "My Clubs" Card** in the activity grid (4th position, before Waiting List):
   - Header with `Building2` icon and title "My Clubs"
   - "All clubs" button linking to the marketing locations page
   - Table rows showing club logo (Avatar), location name, and arrow link to `/locations/{slug}`
   - Empty state: "Not a member of any club yet"

6. **Add imports**: `Building2` from lucide-react.

7. **Move Waiting List** to 5th position in the grid (no changes to the component itself).
