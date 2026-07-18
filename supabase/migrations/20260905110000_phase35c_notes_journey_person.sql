-- Phase 3.5c (part 2): person-key the PLAYER-side NOTE READ paths + the Journey.
--
-- WHY (verify round 1, P1): 3.5c makes the coaching-note SHARE toggle key on
-- person-level login — but the note is written GUEST-keyed (subject_guest_player_id,
-- the seat) while every player-side READ path was PROFILE-keyed:
--   * RLS spn_select_subject_player: subject_profile_id = my profile ONLY;
--   * get_player_journey: sessions base AND shared-notes CTE keyed b.player_id/
--     n.subject_profile_id = p_profile_id ONLY.
-- So a trainer could "share" a note with a merged login-holder who could NEVER
-- read it (silent broken promise) — and, more broadly, a merged person's
-- GUEST-SEATED sessions never appeared in their Journey at all (the missed half
-- of the Phase-3.1 player-side story).
--
-- FIX (the 3.3-attendance pattern):
--   (1) NEW DEFINER helper subject_guest_reads_as_me(_guest): the caller's
--       profile and the guest resolve to the same person (person arm) OR the
--       Phase-0c twin-precedence bridge — split-freeze-gated. GRANTed to
--       authenticated because RLS evaluates policy expressions as the session
--       user (person_links / person_merge_review are RLS-locked, so the arm MUST
--       go through a DEFINER helper). Boolean only; internally pinned to
--       auth.uid() — not an oracle.
--   (2) spn_select_subject_player gains the guest-subject arm via that helper.
--   (3) get_player_journey re-emitted VERBATIM except: a v_guest_ids ref-set is
--       resolved once (person refs, freeze-gated per guest, + twin/linked bridge
--       — mirroring get_my_linked_guest_bookings), the sessions base gains
--       `OR b.guest_player_id = ANY(v_guest_ids)`, and the shared-notes CTE
--       gains `OR n.subject_guest_player_id = ANY(v_guest_ids)`. Auth block,
--       reports, own-notes, rating laterals: unchanged.

-- ---------------------------------------------------------------------------
-- (1) subject_guest_reads_as_me
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.subject_guest_reads_as_me(_guest_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _guest_player_id IS NOT NULL
    AND NOT public.is_guest_split_frozen(_guest_player_id)
    AND EXISTS (
      SELECT 1
      FROM public.guest_players gp
      WHERE gp.id = _guest_player_id
        AND (
          -- person arm: the guest's person is MY person
          EXISTS (
            SELECT 1
            FROM public.person_links plg
            JOIN public.person_links plp ON plp.person_id = plg.person_id
            JOIN public.profiles p ON p.id = plp.profile_id
            WHERE plg.guest_player_id = gp.id AND p.user_id = auth.uid()
          )
          -- Phase-0c twin-precedence bridge (retire at Phase 4)
          OR gp.twin_of_profile_id = public.get_profile_id_for_user(auth.uid())
          OR (gp.twin_of_profile_id IS NULL
              AND gp.linked_profile_id = public.get_profile_id_for_user(auth.uid()))
        )
    );
$$;

COMMENT ON FUNCTION public.subject_guest_reads_as_me(uuid) IS
  'Phase 3.5c: does this guest subject resolve to the CALLER''s person (person arm or twin-precedence bridge), split-freeze-gated. Policy-internal boolean pinned to auth.uid(); powers the guest-subject arm of spn_select_subject_player.';

REVOKE ALL ON FUNCTION public.subject_guest_reads_as_me(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.subject_guest_reads_as_me(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.subject_guest_reads_as_me(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- (2) spn_select_subject_player — guest-subject arm
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS spn_select_subject_player ON public.session_player_notes;
CREATE POLICY spn_select_subject_player ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    author_role IN ('trainer','academy')
    AND visibility = 'shared'
    AND (
      subject_profile_id = public.get_profile_id_for_user(auth.uid())
      OR (subject_guest_player_id IS NOT NULL
          AND public.subject_guest_reads_as_me(subject_guest_player_id))
    )
  );

-- ---------------------------------------------------------------------------
-- (3) get_player_journey — guest-seated sessions + guest-keyed shared notes
-- ---------------------------------------------------------------------------
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
  v_guest_ids uuid[];
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

  -- Phase 3.5c: the profile's guest ref-set (mirrors get_my_linked_guest_bookings):
  -- person refs (freeze-gated per guest) + the twin-precedence bridge. Guest-seated
  -- sessions and guest-keyed shared notes belong in THIS person's journey.
  v_guest_ids := ARRAY(
    SELECT DISTINCT gp.id
    FROM public.guest_players gp
    WHERE NOT public.is_guest_split_frozen(gp.id)
      AND (
        EXISTS (
          SELECT 1
          FROM public.person_links plg
          JOIN public.person_links plp ON plp.person_id = plg.person_id
          WHERE plg.guest_player_id = gp.id AND plp.profile_id = p_profile_id
        )
        OR gp.twin_of_profile_id = p_profile_id
        OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = p_profile_id)
      )
  );

  RETURN QUERY
  WITH sessions AS (
    SELECT DISTINCT s.id AS slot_id, s.start_time, s.end_time,
           s.trainer_id, s.academy_profile_id, s.location_id
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE (b.player_id = p_profile_id OR b.guest_player_id = ANY(v_guest_ids))
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
  LEFT JOIN LATERAL (
    SELECT sr.slot_id, sr.session_happened, sr.public_notes
    FROM public.session_reports sr
    WHERE sr.slot_id = pg.slot_id AND sr.reporter_role = 'trainer'
    LIMIT 1
  ) tr ON true
  LEFT JOIN LATERAL (
    SELECT sr.slot_id, sr.session_happened
    FROM public.session_reports sr
    WHERE sr.slot_id = pg.slot_id AND sr.reporter_id = p_profile_id AND sr.reporter_role = 'player'
    LIMIT 1
  ) plr ON true
  -- coaching notes shared with THIS player — profile-keyed OR keyed on one of the
  -- person's guest refs (Phase 3.5c).
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', n.id, 'author_role', n.author_role, 'body', n.body,
             'media', n.media, 'created_at', n.created_at) ORDER BY n.created_at) AS notes
    FROM public.session_player_notes n
    WHERE n.slot_id = pg.slot_id
      AND (n.subject_profile_id = p_profile_id OR n.subject_guest_player_id = ANY(v_guest_ids))
      AND n.author_role IN ('trainer','academy') AND n.visibility = 'shared'
  ) cn ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', n.id, 'visibility', n.visibility, 'body', n.body,
             'created_at', n.created_at) ORDER BY n.created_at) AS notes
    FROM public.session_player_notes n
    WHERE n.slot_id = pg.slot_id AND n.subject_profile_id = p_profile_id AND n.author_role = 'player'
  ) own ON true
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
  'Player "My Journey" timeline. Phase 3.5c: the sessions base + shared-notes CTE also cover the person''s GUEST refs (person links freeze-gated + twin-precedence bridge), so a merged login-holder sees their guest-seated sessions and the notes shared with them. Auth: self, slot trainer, academy manager, admin.';

REVOKE ALL ON FUNCTION public.get_player_journey(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_journey(uuid, integer, integer) TO authenticated;

-- ---------------------------------------------------------------------------
-- (4) get_unseen_shared_feedback_count — the guest-subject arm (Codex P2: the
--     Journey now SHOWS guest-keyed shared notes, so the new-feedback badge must
--     COUNT them too, or it stays at zero while feedback is visible). Same
--     v_guest_ids resolution as the journey; the seen-marker join stays keyed on
--     the reader's profile (coaching_note_views.profile_id — how the player marks
--     any note seen, regardless of the note's subject key).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unseen_shared_feedback_count(p_profile_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_count integer;
  v_guest_ids uuid[];
BEGIN
  IF p_profile_id <> public.get_profile_id_for_user(auth.uid()) AND NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'not authorized for player %', p_profile_id USING ERRCODE = '42501';
  END IF;

  -- Phase 3.5c: the profile's guest ref-set (identical to get_player_journey).
  v_guest_ids := ARRAY(
    SELECT DISTINCT gp.id
    FROM public.guest_players gp
    WHERE NOT public.is_guest_split_frozen(gp.id)
      AND (
        EXISTS (
          SELECT 1
          FROM public.person_links plg
          JOIN public.person_links plp ON plp.person_id = plg.person_id
          WHERE plg.guest_player_id = gp.id AND plp.profile_id = p_profile_id
        )
        OR gp.twin_of_profile_id = p_profile_id
        OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = p_profile_id)
      )
  );

  SELECT count(*)::int INTO v_count
  FROM public.session_player_notes n
  WHERE (n.subject_profile_id = p_profile_id OR n.subject_guest_player_id = ANY(v_guest_ids))
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
  'Unseen shared coaching notes for the player — profile-keyed OR keyed on one of the person''s guest refs (Phase 3.5c, matches get_player_journey). Seen-markers stay profile-keyed (the reader''s own profile).';
REVOKE ALL ON FUNCTION public.get_unseen_shared_feedback_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unseen_shared_feedback_count(uuid) TO authenticated;
