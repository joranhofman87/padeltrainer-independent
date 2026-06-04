-- Player app security audit: session_reports RLS, trainer_followers hardening,
-- notification_preferences UPDATE WITH CHECK.

-- ---------------------------------------------------------------------------
-- session_reports: enable RLS and scope access by booking / slot ownership
-- ---------------------------------------------------------------------------
ALTER TABLE public.session_reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Players can view session reports for their bookings" ON public.session_reports;
CREATE POLICY "Players can view session reports for their bookings"
  ON public.session_reports
  FOR SELECT
  TO authenticated
  USING (
    public.get_profile_id_for_user(auth.uid()) IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.slot_id = session_reports.slot_id
        AND b.player_id = public.get_profile_id_for_user(auth.uid())
    )
    AND (
      session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
      OR session_reports.reporter_role = 'trainer'
    )
  );

DROP POLICY IF EXISTS "Players can insert their own session reports" ON public.session_reports;
CREATE POLICY "Players can insert their own session reports"
  ON public.session_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.slot_id = session_reports.slot_id
        AND b.player_id = public.get_profile_id_for_user(auth.uid())
    )
  );

DROP POLICY IF EXISTS "Players can update their own session reports" ON public.session_reports;
CREATE POLICY "Players can update their own session reports"
  ON public.session_reports
  FOR UPDATE
  TO authenticated
  USING (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.slot_id = session_reports.slot_id
        AND b.player_id = public.get_profile_id_for_user(auth.uid())
    )
  )
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'player'
    AND EXISTS (
      SELECT 1
      FROM public.bookings b
      WHERE b.slot_id = session_reports.slot_id
        AND b.player_id = public.get_profile_id_for_user(auth.uid())
    )
  );

DROP POLICY IF EXISTS "Trainers can view session reports on their slots" ON public.session_reports;
CREATE POLICY "Trainers can view session reports on their slots"
  ON public.session_reports
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_reports.slot_id
        AND tp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Trainers can insert session reports on their slots" ON public.session_reports;
CREATE POLICY "Trainers can insert session reports on their slots"
  ON public.session_reports
  FOR INSERT
  TO authenticated
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'trainer'
    AND EXISTS (
      SELECT 1
      FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_reports.slot_id
        AND tp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Trainers can update session reports on their slots" ON public.session_reports;
CREATE POLICY "Trainers can update session reports on their slots"
  ON public.session_reports
  FOR UPDATE
  TO authenticated
  USING (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'trainer'
    AND EXISTS (
      SELECT 1
      FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_reports.slot_id
        AND tp.user_id = auth.uid()
    )
  )
  WITH CHECK (
    session_reports.reporter_id = public.get_profile_id_for_user(auth.uid())
    AND session_reports.reporter_role = 'trainer'
    AND EXISTS (
      SELECT 1
      FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_reports.slot_id
        AND tp.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Academy managers can view session reports on academy slots" ON public.session_reports;
CREATE POLICY "Academy managers can view session reports on academy slots"
  ON public.session_reports
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.availability_slots s
      WHERE s.id = session_reports.slot_id
        AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Admins can manage all session reports" ON public.session_reports;
CREATE POLICY "Admins can manage all session reports"
  ON public.session_reports
  FOR ALL
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- ---------------------------------------------------------------------------
-- trainer_followers: align player policies with get_profile_id_for_user
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Players can view their own follows" ON public.trainer_followers;
CREATE POLICY "Players can view their own follows"
  ON public.trainer_followers
  FOR SELECT
  TO authenticated
  USING (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can create follows" ON public.trainer_followers;
CREATE POLICY "Players can create follows"
  ON public.trainer_followers
  FOR INSERT
  TO authenticated
  WITH CHECK (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can delete their own follows" ON public.trainer_followers;
CREATE POLICY "Players can delete their own follows"
  ON public.trainer_followers
  FOR DELETE
  TO authenticated
  USING (player_id = public.get_profile_id_for_user(auth.uid()));

DROP POLICY IF EXISTS "Players can update their own follows" ON public.trainer_followers;
CREATE POLICY "Players can update their own follows"
  ON public.trainer_followers
  FOR UPDATE
  TO authenticated
  USING (player_id = public.get_profile_id_for_user(auth.uid()))
  WITH CHECK (player_id = public.get_profile_id_for_user(auth.uid()));

-- Trainers can view their followers (unchanged semantics)
DROP POLICY IF EXISTS "Trainers can view their followers" ON public.trainer_followers;
CREATE POLICY "Trainers can view their followers"
  ON public.trainer_followers
  FOR SELECT
  TO authenticated
  USING (
    trainer_id IN (
      SELECT id FROM public.trainer_profiles WHERE user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- notification_preferences: prevent user_id reassignment on UPDATE
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can update their own preferences" ON public.notification_preferences;
CREATE POLICY "Users can update their own preferences"
  ON public.notification_preferences
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
