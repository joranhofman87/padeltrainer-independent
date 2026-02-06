

# Fix: Trainer Can't See Player Names + Players Missing from "Mijn Spelers"

## Root Cause

Two separate issues:

### Issue 1: Player names show as "Unknown" in the calendar
The trainer's calendar queries try to join `profiles:player_id(full_name, ...)` to get player names. However, **Row-Level Security (RLS) on the `profiles` table blocks trainers from reading other users' profiles**. The only SELECT policies allow: own profile, admin, or public trainer profiles. A trainer viewing a player's profile doesn't match any of these, so the join returns null and the name shows as "Unknown".

### Issue 2: Booked players don't appear in "Mijn Spelers"
The "Mijn Spelers" page only queries the `guest_players` table (manually added players). Players who book through the public booking flow are stored as `bookings.player_id` referencing the `profiles` table -- they are never added to `guest_players`, so they never appear in the trainer's player list.

## Solution

### 1. Add RLS policy: Trainers can view profiles of their booked players

Add a new SELECT policy on `profiles` that allows a trainer to read the profile of any player who has a booking on one of their slots. This is the least-privilege approach -- trainers only see players they have a relationship with.

```sql
CREATE POLICY "Trainers can view booked player profiles"
  ON public.profiles FOR SELECT
  USING (
    id IN (
      SELECT DISTINCT b.player_id
      FROM bookings b
      JOIN availability_slots s ON s.id = b.slot_id
      JOIN trainer_profiles tp ON tp.id = s.trainer_id
      WHERE tp.user_id = auth.uid()
    )
  );
```

This immediately fixes the "Unknown" name issue in both `TrainerCalendar.tsx` and `TrainerDashboard.tsx` without any code changes -- the existing PostgREST joins will start returning data.

### 2. Show registered players in "Mijn Spelers" alongside guest players

Update `TrainerPlayers.tsx` to also fetch registered players (from `bookings` + `profiles`) who have booked with this trainer. Display them alongside the existing guest players, with a visual distinction (e.g., a "Registered" badge vs "Guest" badge).

**Changes to `src/pages/TrainerPlayers.tsx`:**
- After fetching `guest_players`, also query distinct `profiles` for players who have bookings on this trainer's slots
- Merge both lists into a unified player list
- Add a badge to distinguish registered vs guest players
- Registered players are read-only (can't be edited/deleted from this page since they manage their own profile)

## Files to Change

1. **Database migration** -- Add RLS policy for trainer-to-player profile visibility
2. **`src/pages/TrainerPlayers.tsx`** -- Fetch and display registered booked players alongside guest players

## Technical Details

- The RLS policy uses a subquery joining `bookings -> availability_slots -> trainer_profiles` to verify the trainer-player relationship
- The "Mijn Spelers" query for registered players will be: fetch distinct `player_id` from `bookings` where slot's `trainer_id` matches, then fetch their `profiles` data
- Registered players will show name, email (from profiles), skill rating, and last booking date
- The existing guest player CRUD (add, edit, delete, import) remains unchanged
