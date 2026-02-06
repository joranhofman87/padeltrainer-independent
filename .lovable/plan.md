
# Fix: Infinite Recursion in Database Policies

## Problem

The player bookings page returns 500 errors because of **infinite recursion** between two database security policies:

1. **`profiles` table** has a policy "Trainers can view booked player profiles" that queries the `bookings` table
2. **`bookings` table** has a policy "Players can view their own bookings" that queries the `profiles` table

When a player loads their bookings, the database enters an infinite loop checking these policies against each other.

## Solution

Replace the problematic policy on `profiles` with one that avoids querying `bookings`. Instead of joining through `bookings` -> `availability_slots` -> `trainer_profiles`, we use a simpler approach:

- Drop the current "Trainers can view booked player profiles" policy
- Create a new policy that uses `auth.uid()` directly against `trainer_profiles` and checks bookings through `availability_slots` **without** triggering the `bookings` RLS (by using a security-definer function)

Specifically, we will create a small `SECURITY DEFINER` SQL function that checks if a given profile ID has any booking on any slot owned by the current trainer. Because `SECURITY DEFINER` functions bypass RLS, this breaks the recursion cycle.

## Changes

| File | Change |
|------|--------|
| **Database migration** | Drop recursive policy, create helper function, create new non-recursive policy |

## Technical Details

**New helper function** (runs as `SECURITY DEFINER` to bypass RLS):

```text
CREATE FUNCTION public.is_player_of_trainer(p_player_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    JOIN trainer_profiles tp ON tp.id = s.trainer_id
    WHERE b.player_id = p_player_id
      AND tp.user_id = auth.uid()
  );
$$;
```

**New policy on `profiles`:**

```text
CREATE POLICY "Trainers can view booked player profiles"
  ON profiles FOR SELECT
  USING (public.is_player_of_trainer(id));
```

This keeps the same access rules but eliminates the circular dependency that causes the 500 errors.
