
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
