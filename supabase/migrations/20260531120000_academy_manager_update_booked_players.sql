-- Allow academy managers to update profiles of players booked through their academy's trainers.
-- Mirrors is_player_of_trainer but scoped to academy_profile_id and get_user_academy_ids.

CREATE OR REPLACE FUNCTION public.is_player_of_academy(p_player_id uuid, p_academy_profile_id uuid)
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
    JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
    WHERE b.player_id = p_player_id
      AND at.status = 'active'
      AND at.academy_profile_id = p_academy_profile_id
  )
  OR EXISTS (
    SELECT 1
    FROM guest_players gp
    WHERE gp.linked_profile_id = p_player_id
      AND (
        gp.academy_profile_id = p_academy_profile_id
        OR gp.trainer_id IN (
          SELECT at.trainer_profile_id
          FROM academy_trainers at
          WHERE at.status = 'active'
            AND at.academy_profile_id = p_academy_profile_id
        )
      )
  );
$$;

DROP POLICY IF EXISTS "Academy managers can update booked player profiles" ON public.profiles;

CREATE POLICY "Academy managers can update booked player profiles"
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.get_user_academy_ids(auth.uid()) AS aid
      WHERE public.is_player_of_academy(id, aid)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.get_user_academy_ids(auth.uid()) AS aid
      WHERE public.is_player_of_academy(id, aid)
    )
  );
