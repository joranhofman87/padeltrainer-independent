
-- 1. Create a SECURITY DEFINER helper to check if current user has booked a specific trainer
CREATE OR REPLACE FUNCTION public.has_user_booked_trainer(_trainer_profile_id uuid)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    WHERE b.player_id = public.get_profile_id_for_user(auth.uid())
      AND s.trainer_id = _trainer_profile_id
  );
$$;

REVOKE EXECUTE ON FUNCTION public.has_user_booked_trainer FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_user_booked_trainer TO authenticated;

-- 2. Replace trainer_profiles player policy to use the SECURITY DEFINER function
DROP POLICY IF EXISTS "Players can view profiles of their trainers" ON trainer_profiles;

CREATE POLICY "Players can view profiles of their trainers"
ON trainer_profiles FOR SELECT
TO authenticated
USING (public.has_user_booked_trainer(id));

-- 3. Harden bookings player policies to use get_profile_id_for_user instead of profiles subqueries
DROP POLICY IF EXISTS "Players can view their own bookings" ON bookings;
CREATE POLICY "Players can view their own bookings"
ON bookings FOR SELECT
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can create bookings" ON bookings;
CREATE POLICY "Players can create bookings"
ON bookings FOR INSERT
TO authenticated
WITH CHECK (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can update their own bookings" ON bookings;
CREATE POLICY "Players can update their own bookings"
ON bookings FOR UPDATE
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can delete their own bookings" ON bookings;
CREATE POLICY "Players can delete their own bookings"
ON bookings FOR DELETE
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()));
