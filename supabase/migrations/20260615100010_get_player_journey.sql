-- Coaching & Progress v1 — the player "My Journey" timeline RPC.
--
-- One row per PAST session the player was booked on (newest first), enriched with:
--   - attendance / double-control (trainer + player session_reports)
--   - the group session summary (session_reports.public_notes)
--   - the trainer/academy coaching notes SHARED with this player
--   - the player's OWN notes (private + shared — they authored them)
--   - the rating snapshot in effect at the session (for the per-session trend anchor)
--
-- Mirrors get_players_overview: SECURITY DEFINER + explicit authorize, clamped
-- limit, count(*) OVER() AS total_count, deterministic order, page-then-enrich
-- (the LATERALs only run for the v_limit page rows — never an unbounded select).

CREATE OR REPLACE FUNCTION public.get_player_journey(
  p_profile_id uuid,
  p_limit  integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  slot_id               uuid,
  start_time            timestamptz,
  end_time              timestamptz,
  trainer_id            uuid,
  trainer_name          text,
  academy_profile_id    uuid,
  location_name         text,
  session_happened      boolean,   -- trainer report if present, else this player's report
  trainer_confirmed     boolean,   -- a trainer report exists for the slot
  player_confirmed      boolean,   -- this player filed their own report
  group_summary         text,      -- trainer session_reports.public_notes
  shared_coaching_notes jsonb,     -- [{id, author_role, body, media, created_at}] shared to this player
  own_notes             jsonb,     -- [{id, visibility, body, created_at}] authored by this player
  rating_at_session     numeric,   -- nearest player_rating_history snapshot <= session end
  rating_system         text,
  total_count           bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- ---- authorization (explicit; the function bypasses RLS below) ----
  IF NOT (
       p_profile_id = public.get_profile_id_for_user(auth.uid())
    OR EXISTS (SELECT 1 FROM public.bookings b
               JOIN public.availability_slots s ON s.id = b.slot_id
               JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
               WHERE b.player_id = p_profile_id AND tp.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.bookings b
               JOIN public.availability_slots s ON s.id = b.slot_id
               WHERE b.player_id = p_profile_id
                 AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
    OR public.is_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'not authorized for player %', p_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH sessions AS (
    SELECT DISTINCT s.id AS slot_id, s.start_time, s.end_time,
           s.trainer_id, s.academy_profile_id, s.location_id
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE b.player_id = p_profile_id
      AND b.status IN ('confirmed','completed')
      AND s.end_time < now()
  ),
  page AS (
    SELECT se.*, count(*) OVER () AS f_total_count
    FROM sessions se
    ORDER BY se.start_time DESC, se.slot_id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT
    pg.slot_id, pg.start_time, pg.end_time, pg.trainer_id,
    coalesce(nullif(btrim(tp.business_name), ''), pr.full_name),
    pg.academy_profile_id, loc.name,
    coalesce(tr.session_happened, plr.session_happened),
    (tr.slot_id IS NOT NULL),
    (plr.slot_id IS NOT NULL),
    tr.public_notes,
    coalesce(cn.notes, '[]'::jsonb),
    coalesce(own.notes, '[]'::jsonb),
    rh.rating, rh.rating_system,
    pg.f_total_count
  FROM page pg
  LEFT JOIN public.trainer_profiles tp ON tp.id = pg.trainer_id
  LEFT JOIN public.profiles pr ON pr.user_id = tp.user_id
  LEFT JOIN public.locations loc ON loc.id = pg.location_id
  -- trainer report: double-control + group summary
  LEFT JOIN LATERAL (
    SELECT sr.slot_id, sr.session_happened, sr.public_notes
    FROM public.session_reports sr
    WHERE sr.slot_id = pg.slot_id AND sr.reporter_role = 'trainer'
    LIMIT 1
  ) tr ON true
  -- this player's own report (the player half of the double-control)
  LEFT JOIN LATERAL (
    SELECT sr.slot_id, sr.session_happened
    FROM public.session_reports sr
    WHERE sr.slot_id = pg.slot_id AND sr.reporter_id = p_profile_id AND sr.reporter_role = 'player'
    LIMIT 1
  ) plr ON true
  -- coaching notes shared with THIS player
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', n.id, 'author_role', n.author_role, 'body', n.body,
             'media', n.media, 'created_at', n.created_at) ORDER BY n.created_at) AS notes
    FROM public.session_player_notes n
    WHERE n.slot_id = pg.slot_id AND n.subject_profile_id = p_profile_id
      AND n.author_role IN ('trainer','academy') AND n.visibility = 'shared'
  ) cn ON true
  -- the player's own notes (all visibilities — they authored them)
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', n.id, 'visibility', n.visibility, 'body', n.body,
             'created_at', n.created_at) ORDER BY n.created_at) AS notes
    FROM public.session_player_notes n
    WHERE n.slot_id = pg.slot_id AND n.subject_profile_id = p_profile_id AND n.author_role = 'player'
  ) own ON true
  -- rating snapshot anchored to the session
  LEFT JOIN LATERAL (
    SELECT h.rating, h.rating_system
    FROM public.player_rating_history h
    WHERE h.profile_id = p_profile_id AND h.scraped_at <= pg.end_time
    ORDER BY h.scraped_at DESC LIMIT 1
  ) rh ON true
  ORDER BY pg.start_time DESC, pg.slot_id DESC;
END;
$$;

COMMENT ON FUNCTION public.get_player_journey(uuid, integer, integer) IS
  'Coaching & Progress v1: paginated player "My Journey" timeline (past sessions + attendance + group summary + shared coaching notes + own notes + per-session rating). SECURITY DEFINER, authorized for the player / their trainer / their academy manager / admin.';
REVOKE ALL ON FUNCTION public.get_player_journey(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_player_journey(uuid, integer, integer) TO authenticated;
