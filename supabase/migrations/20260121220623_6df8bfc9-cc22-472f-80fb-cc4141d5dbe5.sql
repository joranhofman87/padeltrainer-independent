-- Add RLS policies for club managers to manage availability_slots for their trainers

-- INSERT policy for availability_slots
CREATE POLICY "Club managers can create slots for their trainers"
  ON public.availability_slots
  FOR INSERT
  TO authenticated
  WITH CHECK (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- UPDATE policy for availability_slots
CREATE POLICY "Club managers can update slots for their trainers"
  ON public.availability_slots
  FOR UPDATE
  TO authenticated
  USING (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- DELETE policy for availability_slots
CREATE POLICY "Club managers can delete slots for their trainers"
  ON public.availability_slots
  FOR DELETE
  TO authenticated
  USING (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- Add RLS policies for club managers to manage lessons for their trainers

-- INSERT policy for lessons
CREATE POLICY "Club managers can create lessons for their trainers"
  ON public.lessons
  FOR INSERT
  TO authenticated
  WITH CHECK (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- UPDATE policy for lessons
CREATE POLICY "Club managers can update lessons for their trainers"
  ON public.lessons
  FOR UPDATE
  TO authenticated
  USING (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- DELETE policy for lessons
CREATE POLICY "Club managers can delete lessons for their trainers"
  ON public.lessons
  FOR DELETE
  TO authenticated
  USING (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );

-- SELECT policy for lessons (club managers can view all lessons for their trainers)
CREATE POLICY "Club managers can view lessons for their trainers"
  ON public.lessons
  FOR SELECT
  TO authenticated
  USING (
    trainer_id IN (
      SELECT tl.trainer_id 
      FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT get_user_club_ids(auth.uid()))
        AND tl.relationship_type IN ('club', 'club_trainer')
    )
  );