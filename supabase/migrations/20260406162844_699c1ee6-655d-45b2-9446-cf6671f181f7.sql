
-- Issue 3: Fix private slot exposure
DROP POLICY IF EXISTS "Anyone can view availability slots" ON availability_slots;

CREATE POLICY "Public slots are viewable by everyone"
  ON availability_slots FOR SELECT
  USING (is_public = true);

CREATE POLICY "Owners and managers can view all their slots"
  ON availability_slots FOR SELECT
  TO authenticated
  USING (
    trainer_id IN (SELECT id FROM trainer_profiles WHERE user_id = auth.uid())
    OR academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    OR trainer_id IN (
      SELECT tl.trainer_id FROM trainer_locations tl
      JOIN club_profiles cp ON cp.location_id = tl.location_id
      WHERE cp.id IN (SELECT public.get_user_club_ids(auth.uid()))
    )
    OR public.is_admin(auth.uid())
  );

-- Issue 4: Remove anonymous INSERT on email queue/logs
DROP POLICY IF EXISTS "Service role can insert to queue" ON onboarding_email_queue;
DROP POLICY IF EXISTS "Service role can insert logs" ON onboarding_email_logs;
