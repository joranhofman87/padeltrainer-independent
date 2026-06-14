-- Coaching & Progress v1 — per-player session notes.
--
-- ONE unified table for BOTH directions of session-level notes:
--   * trainer/academy → a specific player  (coaching feedback; private draft or shared)
--   * a player → themselves                (self-reflection; private or shared)
-- The existing session_reports table keeps handling attendance (session_happened),
-- conflict detection, and the GROUP session summary (public_notes) — untouched.
-- This table is the NEW per-player layer.
--
-- visibility semantics (role-dependent, encoded by author_role + visibility):
--   coaching note (trainer/academy author): 'private' = author draft (academy of
--     the slot still sees it for oversight); 'shared' = the subject player sees it.
--   self-note (player author): 'private' = player only; 'shared' = trainer + academy see it.
-- "shared" therefore always means "the OTHER side of the coaching relationship can read it".
--
-- media jsonb is the forward seam for video (NULL in v1) — a future session_videos
-- table copies these four SELECT policies and the journey RPC gets one more LATERAL.

CREATE TABLE public.session_player_notes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id                  uuid NOT NULL REFERENCES public.availability_slots(id) ON DELETE CASCADE,
  author_id                uuid NOT NULL,                       -- auth.users.id of the writer
  author_role              text NOT NULL CHECK (author_role IN ('trainer','academy','player')),
  subject_profile_id       uuid REFERENCES public.profiles(id)      ON DELETE CASCADE,
  subject_guest_player_id  uuid REFERENCES public.guest_players(id) ON DELETE CASCADE,
  visibility               text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','shared')),
  body                     text NOT NULL,
  media                    jsonb,                               -- video seam; NULL in v1
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- exactly one subject identity
  CONSTRAINT spn_one_subject CHECK (
    (subject_profile_id IS NOT NULL)::int + (subject_guest_player_id IS NOT NULL)::int = 1
  ),
  -- guests can't log in: a player-authored note must be about a registered profile
  CONSTRAINT spn_player_self_is_registered CHECK (
    author_role <> 'player' OR subject_guest_player_id IS NULL
  )
);

CREATE INDEX idx_spn_slot          ON public.session_player_notes (slot_id);
CREATE INDEX idx_spn_author        ON public.session_player_notes (author_id);
CREATE INDEX idx_spn_subject_guest ON public.session_player_notes (subject_guest_player_id) WHERE subject_guest_player_id IS NOT NULL;
-- journey scan path: a player's notes, newest first
CREATE INDEX idx_spn_subject_prof_created ON public.session_player_notes (subject_profile_id, created_at DESC) WHERE subject_profile_id IS NOT NULL;

CREATE TRIGGER update_session_player_notes_updated_at
  BEFORE UPDATE ON public.session_player_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.session_player_notes ENABLE ROW LEVEL SECURITY;

-- ============================== SELECT (OR'd) ==============================

-- (a) author always reads own note (private drafts + self-notes, both roles)
CREATE POLICY spn_select_author ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (author_id = auth.uid());

-- (b) subject registered player reads a coaching note about them ONLY if shared
CREATE POLICY spn_select_subject_player ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    author_role IN ('trainer','academy')
    AND visibility = 'shared'
    AND subject_profile_id = public.get_profile_id_for_user(auth.uid())
  );

-- (c) trainer of the slot: all coaching notes on their slot; a player self-note only if shared
CREATE POLICY spn_select_trainer ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_player_notes.slot_id AND tp.user_id = auth.uid()
    )
    AND (
      author_role IN ('trainer','academy')
      OR (author_role = 'player' AND visibility = 'shared')
    )
  );

-- (d) academy manager of the slot's academy: coaching notes ALWAYS (oversight); self-notes only if shared
CREATE POLICY spn_select_academy ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = session_player_notes.slot_id
        AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
    AND (
      author_role IN ('trainer','academy')
      OR (author_role = 'player' AND visibility = 'shared')
    )
  );

-- ============================== INSERT ==============================
-- author_id = auth.uid(); subject must be booked on the slot (mirrors session_reports).

-- trainer writes a coaching note on their own slot about a booked player/guest
CREATE POLICY spn_insert_trainer ON public.session_player_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid() AND author_role = 'trainer'
    AND EXISTS (
      SELECT 1 FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = slot_id AND tp.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = session_player_notes.slot_id
        AND ((subject_profile_id IS NOT NULL AND b.player_id = subject_profile_id)
          OR (subject_guest_player_id IS NOT NULL AND b.guest_player_id = subject_guest_player_id))
        AND b.status IN ('pending','confirmed','completed')
    )
  );

-- academy manager writes a coaching note on a slot in their academy
CREATE POLICY spn_insert_academy ON public.session_player_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid() AND author_role = 'academy'
    AND EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = slot_id AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = session_player_notes.slot_id
        AND ((subject_profile_id IS NOT NULL AND b.player_id = subject_profile_id)
          OR (subject_guest_player_id IS NOT NULL AND b.guest_player_id = subject_guest_player_id))
        AND b.status IN ('pending','confirmed','completed')
    )
  );

-- player writes a self-note about themselves on a slot they're booked on
CREATE POLICY spn_insert_player ON public.session_player_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid() AND author_role = 'player'
    AND subject_guest_player_id IS NULL
    AND subject_profile_id = public.get_profile_id_for_user(auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = session_player_notes.slot_id
        AND b.player_id = subject_profile_id
        AND b.status IN ('pending','confirmed','completed')
    )
  );

-- ============================== UPDATE / DELETE ==============================
-- author-only (the visibility toggle + edits live here).
CREATE POLICY spn_update_author ON public.session_player_notes
  FOR UPDATE TO authenticated
  USING (author_id = auth.uid())
  WITH CHECK (author_id = auth.uid());

CREATE POLICY spn_delete_author ON public.session_player_notes
  FOR DELETE TO authenticated
  USING (author_id = auth.uid());

-- admin escape hatch (mirrors session_reports)
CREATE POLICY spn_admin_all ON public.session_player_notes
  FOR ALL TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

COMMENT ON TABLE public.session_player_notes IS
  'Coaching & Progress v1: per-player session notes (trainer/academy→player coaching + player self-notes). visibility shared = the other side can read. media jsonb = forward seam for video. Attendance + group summary remain in session_reports.';
