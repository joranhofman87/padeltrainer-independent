

# Fix: Player Sees "Coach Trainer" Instead of Actual Trainer Name

## Root Cause

The `trainer_profiles` table has RLS policies that only grant SELECT to:
- The trainer themselves
- Academy managers
- Club managers
- Admins

**Players have no SELECT access to `trainer_profiles`**. When `PlayerBookings.tsx` queries `trainer_profiles` to get the `user_id` (line 99-102), the query returns empty for a player, so the fallback `'Trainer'` is used.

## Fix

Two options — I recommend **Option A** for simplicity:

### Option A: Add an RLS policy for players who have bookings with the trainer

Add a SELECT policy on `trainer_profiles` that allows players to see trainer profiles if they have a booking with that trainer. This uses the existing `is_player_of_trainer` pattern but in reverse.

```sql
CREATE POLICY "Players can view profiles of their trainers"
  ON public.trainer_profiles FOR SELECT
  TO authenticated
  USING (
    id IN (
      SELECT DISTINCT s.trainer_id 
      FROM bookings b
      JOIN availability_slots s ON s.id = b.slot_id
      WHERE b.player_id IN (
        SELECT id FROM profiles WHERE user_id = auth.uid()
      )
    )
  );
```

Alternatively, also allow viewing **public** trainer profiles (since those are shown on public pages anyway):

```sql
CREATE POLICY "Anyone can view public trainer profiles data"
  ON public.trainer_profiles FOR SELECT
  TO authenticated
  USING (is_public = true);
```

### Recommendation

Add **both** policies — one for public trainers (consistent with other public views) and one for booked trainers (so even non-public trainers show names to their players).

| Change | Detail |
|--------|--------|
| Migration SQL | Add 2 RLS policies on `trainer_profiles` for SELECT access |

No code changes needed — the existing query in `PlayerBookings.tsx` will start working once RLS allows the read.

