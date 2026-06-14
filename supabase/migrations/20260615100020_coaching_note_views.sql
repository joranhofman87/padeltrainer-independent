-- Coaching & Progress v1 — in-app "new feedback" tracking (no email in v1).
--
-- Records which SHARED coaching notes a player has already seen, so the app can
-- show a "new feedback" badge + per-entry "New" dots and clear them on view.

CREATE TABLE public.coaching_note_views (
  profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  note_id    uuid NOT NULL REFERENCES public.session_player_notes(id) ON DELETE CASCADE,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, note_id)
);

ALTER TABLE public.coaching_note_views ENABLE ROW LEVEL SECURITY;

-- Owner-only: a player reads/writes only their own view markers.
CREATE POLICY cnv_select_own ON public.coaching_note_views
  FOR SELECT TO authenticated
  USING (profile_id = public.get_profile_id_for_user(auth.uid()));

CREATE POLICY cnv_insert_own ON public.coaching_note_views
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = public.get_profile_id_for_user(auth.uid()));

-- Count of coaching notes shared with this player that they have NOT yet seen.
CREATE OR REPLACE FUNCTION public.get_unseen_shared_feedback_count(p_profile_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_profile_id <> public.get_profile_id_for_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized for player %', p_profile_id USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int INTO v_count
  FROM public.session_player_notes n
  WHERE n.subject_profile_id = p_profile_id
    AND n.author_role IN ('trainer','academy')
    AND n.visibility = 'shared'
    AND NOT EXISTS (
      SELECT 1 FROM public.coaching_note_views v
      WHERE v.note_id = n.id AND v.profile_id = p_profile_id
    );
  RETURN coalesce(v_count, 0);
END;
$$;

COMMENT ON FUNCTION public.get_unseen_shared_feedback_count(uuid) IS
  'Coaching & Progress v1: count of trainer/academy coaching notes shared with this player that they have not yet marked seen (coaching_note_views). In-app new-feedback indicator.';
REVOKE ALL ON FUNCTION public.get_unseen_shared_feedback_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unseen_shared_feedback_count(uuid) TO authenticated;
