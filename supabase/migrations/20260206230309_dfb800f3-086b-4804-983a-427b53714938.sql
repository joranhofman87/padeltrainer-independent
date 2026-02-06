
-- Drop the recursive policy
DROP POLICY IF EXISTS "Trainers can view booked player profiles" ON public.profiles;

-- Create a SECURITY DEFINER helper to break the recursion
CREATE OR REPLACE FUNCTION public.is_player_of_trainer(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
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

-- Re-create the policy using the helper function
CREATE POLICY "Trainers can view booked player profiles"
  ON public.profiles
  FOR SELECT
  USING (public.is_player_of_trainer(id));
