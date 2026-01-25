-- Club managers can delete intake requests for their cycles
CREATE POLICY "Club managers can delete intake requests for club cycles"
ON public.intake_requests
FOR DELETE
USING (
  cycle_id IN (
    SELECT cycles.id
    FROM cycles
    WHERE cycles.owner_type = 'club'
      AND cycles.owner_id IN (SELECT get_user_club_ids(auth.uid()))
  )
);

-- Trainers can delete intake requests for their cycles
CREATE POLICY "Trainers can delete intake requests for their cycles"
ON public.intake_requests
FOR DELETE
USING (
  cycle_id IN (
    SELECT cycles.id
    FROM cycles
    WHERE cycles.owner_type = 'trainer'
      AND cycles.owner_id IN (
        SELECT trainer_profiles.id
        FROM trainer_profiles
        WHERE trainer_profiles.user_id = auth.uid()
      )
  )
);