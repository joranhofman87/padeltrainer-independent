

# Fix: Infinite Recursion in trainer_profiles RLS Policy

## Root Cause

Circular RLS dependency between `trainer_profiles` and `profiles`:

1. `trainer_profiles` → "Players can view profiles of their trainers" contains `SELECT profiles.id FROM profiles WHERE profiles.user_id = auth.uid()` — this triggers RLS evaluation on `profiles`
2. `profiles` → "Academy managers can view their trainers profiles" contains `FROM trainer_profiles tp JOIN ...` — this triggers RLS evaluation back on `trainer_profiles`

This loop causes the "infinite recursion detected in policy for relation trainer_profiles" error, which breaks the academy cycles page and likely other pages.

## Fix

Replace the subquery in the "Players can view profiles of their trainers" policy to avoid touching the `profiles` table. Instead, use a `SECURITY DEFINER` function to get the player's profile ID from `auth.uid()`.

### Migration SQL

```sql
-- 1. Create a helper function to get profile id from auth uid (avoids RLS on profiles)
CREATE OR REPLACE FUNCTION public.get_profile_id_for_user(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM profiles WHERE user_id = _user_id LIMIT 1
$$;

-- 2. Drop and recreate the problematic policy
DROP POLICY IF EXISTS "Players can view profiles of their trainers" ON trainer_profiles;

CREATE POLICY "Players can view profiles of their trainers"
ON trainer_profiles FOR SELECT TO authenticated
USING (
  id IN (
    SELECT DISTINCT s.trainer_id
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    WHERE b.player_id = public.get_profile_id_for_user(auth.uid())
  )
);
```

This breaks the recursion by using a `SECURITY DEFINER` function to look up the profile ID, bypassing RLS on `profiles`.

| Change | Detail |
|--------|--------|
| New DB function `get_profile_id_for_user` | Security definer function to get profile.id from auth.uid() without triggering profiles RLS |
| Recreate RLS policy on `trainer_profiles` | Replace `profiles` subquery with the new function call |

No frontend code changes needed.

