-- Allow club managers to create intake requests for their club's cycles
CREATE POLICY "Club managers can create intake requests for club cycles"
ON public.intake_requests
FOR INSERT
WITH CHECK (
  cycle_id IN (
    SELECT cycles.id
    FROM cycles
    WHERE cycles.owner_type = 'club'
      AND cycles.owner_id IN (SELECT get_user_club_ids(auth.uid()))
  )
);