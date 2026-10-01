-- PTF export: First training date (owner-approved, 2026-10-01). Forward-only, on top of the APPLIED
-- 20261208120000 (production ledger 622): ONE object changes, public.get_players_overview_export, replaced
-- with the SAME signature, return type (total bigint, rows jsonb), SECURITY DEFINER, STABLE, config
-- (search_path, plan_cache_mode), 20,000-row bound and ACL. No table, column, index, backfill or data change;
-- the private filter authority, the list entry and the location semantics are untouched.
--
-- The function below is 20261208120000's definition byte-for-byte except for exactly two additions:
--   hist: h_first = min(h_start) FILTER (WHERE h_end < now())  -- beside h_last's max(...) on the same rows
--   rows: 'first_training_date' = to_char((h_first AT TIME ZONE v_tz)::date, 'YYYY-MM-DD')
--
-- first_training_date  'YYYY-MM-DD' | null. The EARLIEST academy-owned session that has ENDED (end_time <
--                      now()) on which the person holds a confirmed/completed booking: booked-session history,
--                      not attendance and not registration. It uses exactly last_training_date's semantics
--                      (the same `booked` rows: status, A1 tenant scope, REF-SET person keying, a person's
--                      sides on one session counted once, the academy timezone) and emits the academy-local
--                      date of that session's START, like last_training_date. Null iff last_training_date is
--                      null; never after it.
--
-- Every other key and rule is unchanged; see 20261208120000's header for them.

CREATE OR REPLACE FUNCTION public.get_players_overview_export(
  p_academy uuid,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'name',         -- as get_players_overview
  p_sort_dir text DEFAULT 'asc'
)
RETURNS TABLE (
  total bigint,
  rows jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  c_max CONSTANT integer := 20000;
  v_total bigint;
  v_base jsonb;
  v_rows jsonb;
  v_tz text;
  -- The authority reads keys with ->>, so a non-object p_filters (JSON null, an array, a scalar) applies no
  -- filter. Both authority calls get the SAME normalized object, so the training subset can never drift
  -- from the export rows (`||` on a non-object would build an array, not set current_training).
  v_filters jsonb := CASE WHEN jsonb_typeof(p_filters) = 'object' THEN p_filters ELSE '{}'::jsonb END;
BEGIN
  -- ---- authorization at this public entry (the authority re-checks it) ----
  IF NOT public.is_academy_manager(auth.uid(), p_academy) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(ap.timezone, 'Europe/Amsterdam') INTO v_tz
    FROM public.academy_profiles ap WHERE ap.id = p_academy;
  v_tz := coalesce(v_tz, 'Europe/Amsterdam');

  -- ONE evaluation of the authority yields the total and the rows (as before); the bound is checked on
  -- it before any training / history / location work. total_count is the window count of EVERY match,
  -- so at most c_max rows are materialized.
  SELECT coalesce(max(r.total_count), 0),
         coalesce(jsonb_agg(jsonb_build_object(
                    'person_id', r.person_id, 'full_name', r.full_name, 'email', r.email,
                    'phone', r.phone, 'birth_date', r.birth_date)
                  ORDER BY r.sort_ord), '[]'::jsonb)
    INTO v_total, v_base
    FROM players_private.players_overview_rows(
           'academy', p_academy, p_search, v_filters, p_sort, p_sort_dir, c_max, 0, false) r;

  IF v_total > c_max THEN
    RAISE EXCEPTION 'player export too large: % players match, at most % can be exported', v_total, c_max
      USING ERRCODE = '54000', DETAIL = format('total=%s max=%s', v_total, c_max);
  END IF;

  WITH ex AS (
    SELECT x.person_id, x.full_name, x.email, x.phone, x.birth_date, x.ord AS sort_ord
      FROM ROWS FROM (jsonb_to_recordset(v_base)
             AS (person_id uuid, full_name text, email text, phone text, birth_date date)) WITH ORDINALITY
           AS x(person_id, full_name, email, phone, birth_date, ord)
  ),
  training AS (
    -- the canonical current-training predicate, evaluated by the authority on the same search + filters
    SELECT t.person_id
      FROM players_private.players_overview_rows(
             'academy', p_academy, p_search,
             v_filters || jsonb_build_object('current_training', true),
             p_sort, p_sort_dir, c_max, 0, false) t
  ),
  -- the academy's own sessions with a qualifying booking (scanned once)
  slot_bookings AS (
    SELECT b.guest_player_id AS sb_guest_id, b.player_id AS sb_player_id,
           s.id AS sb_slot_id, s.start_time AS sb_start, s.end_time AS sb_end, s.location_id AS sb_location_id
      FROM public.availability_slots s
      JOIN public.bookings b ON b.slot_id = s.id
     WHERE s.academy_profile_id = p_academy
       AND b.status IN ('confirmed','completed')
       AND (b.guest_player_id IS NOT NULL OR b.player_id IS NOT NULL)
  ),
  -- the persons' ADMITTED guest sides (A1: academy-owned, booked on an academy session, or linked by an
  -- academy metadata row), each keyed ONCE exactly as the authority keys a guest side
  guest_sides AS (
    SELECT CASE WHEN pl.person_id IS NOT NULL AND NOT public.is_guest_split_frozen(gr.gid)
                THEN pl.person_id ELSE gr.gid END AS sd_person_id,
           gr.gid AS sd_guest_id
      FROM (SELECT g.id AS gid FROM public.guest_players g WHERE g.academy_profile_id = p_academy
            UNION
            SELECT sb.sb_guest_id FROM slot_bookings sb WHERE sb.sb_guest_id IS NOT NULL
            UNION
            SELECT m.guest_player_id FROM public.academy_player_metadata m
             WHERE m.academy_profile_id = p_academy AND m.guest_player_id IS NOT NULL) gr
      LEFT JOIN public.person_links pl ON pl.guest_player_id = gr.gid
  ),
  profile_sides AS (
    SELECT DISTINCT coalesce(pl.person_id, pr.pid) AS sd_person_id, pr.pid AS sd_profile_id
      FROM (SELECT DISTINCT sb.sb_player_id AS pid FROM slot_bookings sb WHERE sb.sb_player_id IS NOT NULL) pr
      LEFT JOIN public.person_links pl ON pl.profile_id = pr.pid
  ),
  -- each qualifying booking keyed to its person by the REF-SET rule: a guest seat (dual-keyed included)
  -- is the guest side's person; a pure-profile booking is the profile side's person
  booked AS (
    SELECT coalesce(gs.sd_person_id, ps.sd_person_id) AS h_person_id,
           sb.sb_slot_id AS h_slot_id, sb.sb_start AS h_start, sb.sb_end AS h_end, sb.sb_location_id AS h_location_id
      FROM slot_bookings sb
      LEFT JOIN guest_sides gs ON gs.sd_guest_id = sb.sb_guest_id
      LEFT JOIN profile_sides ps ON sb.sb_guest_id IS NULL AND ps.sd_profile_id = sb.sb_player_id
  ),
  -- candidate clubs per person: the chip rule's sources (requires_active only for trained clubs)
  loc_cand AS (
    SELECT bk.h_person_id AS lc_person_id, bk.h_location_id AS lc_location_id, true AS lc_requires_active
      FROM booked bk WHERE bk.h_location_id IS NOT NULL
    UNION ALL
    SELECT gs.sd_person_id, g.preferred_location_id, false
      FROM guest_sides gs JOIN public.guest_players g ON g.id = gs.sd_guest_id
     WHERE g.preferred_location_id IS NOT NULL
    UNION ALL
    SELECT gs.sd_person_id, m.preferred_location_id, false
      FROM guest_sides gs JOIN public.academy_player_metadata m
        ON m.academy_profile_id = p_academy AND m.guest_player_id = gs.sd_guest_id
     WHERE m.preferred_location_id IS NOT NULL
    UNION ALL
    SELECT ps.sd_person_id, m.preferred_location_id, false
      FROM profile_sides ps JOIN public.academy_player_metadata m
        ON m.academy_profile_id = p_academy AND m.profile_id = ps.sd_profile_id
     WHERE m.preferred_location_id IS NOT NULL
    UNION ALL
    SELECT gs.sd_person_id, ir.location_id, false
      FROM guest_sides gs JOIN public.intake_requests ir ON ir.guest_player_id = gs.sd_guest_id
     WHERE ir.location_id IS NOT NULL
    UNION ALL
    SELECT ps.sd_person_id, ir.location_id, false
      FROM profile_sides ps JOIN public.intake_requests ir
        ON ir.player_id = ps.sd_profile_id AND ir.guest_player_id IS NULL
     WHERE ir.location_id IS NOT NULL
    UNION ALL
    SELECT gs.sd_person_id, apl.location_id, false
      FROM guest_sides gs JOIN public.academy_player_locations apl
        ON apl.academy_profile_id = p_academy AND apl.dismissed = false AND apl.guest_player_id = gs.sd_guest_id
    UNION ALL
    SELECT ps.sd_person_id, apl.location_id, false
      FROM profile_sides ps JOIN public.academy_player_locations apl
        ON apl.academy_profile_id = p_academy AND apl.dismissed = false AND apl.profile_id = ps.sd_profile_id
  ),
  loc_dismissed AS (
    SELECT gs.sd_person_id AS ld_person_id, coalesce(lm.merged_into, apl.location_id) AS ld_location_id
      FROM guest_sides gs JOIN public.academy_player_locations apl
        ON apl.academy_profile_id = p_academy AND apl.dismissed = true AND apl.guest_player_id = gs.sd_guest_id
      LEFT JOIN public.locations lm ON lm.id = apl.location_id
    UNION
    SELECT ps.sd_person_id, coalesce(lm.merged_into, apl.location_id)
      FROM profile_sides ps JOIN public.academy_player_locations apl
        ON apl.academy_profile_id = p_academy AND apl.dismissed = true AND apl.profile_id = ps.sd_profile_id
      LEFT JOIN public.locations lm ON lm.id = apl.location_id
  ),
  locs AS (
    SELECT d.lc_person_id AS l_person_id,
           array_agg(DISTINCT l.name ORDER BY l.name) FILTER (WHERE l.name IS NOT NULL) AS l_names
      FROM (SELECT c.lc_person_id, coalesce(lm.merged_into, c.lc_location_id) AS lc_canon,
                   bool_and(c.lc_requires_active) AS lc_req_active
              FROM loc_cand c
              LEFT JOIN public.locations lm ON lm.id = c.lc_location_id
             WHERE c.lc_person_id IN (SELECT e.person_id FROM ex e)
             GROUP BY c.lc_person_id, coalesce(lm.merged_into, c.lc_location_id)) d
      JOIN public.locations l ON l.id = d.lc_canon
     WHERE EXISTS (SELECT 1 FROM public.academy_locations al
                    WHERE al.academy_profile_id = p_academy AND al.location_id = d.lc_canon
                      AND (al.is_active OR NOT d.lc_req_active))
       AND NOT EXISTS (SELECT 1 FROM loc_dismissed x
                        WHERE x.ld_person_id = d.lc_person_id AND x.ld_location_id = d.lc_canon)
     GROUP BY d.lc_person_id
  ),
  hist AS (
    SELECT h.h_person_id,
           min(h.h_start) FILTER (WHERE h.h_end <  now())          AS h_first,
           max(h.h_start) FILTER (WHERE h.h_end <  now())          AS h_last,
           min(h.h_start) FILTER (WHERE h.h_end >= now())          AS h_next,
           count(DISTINCT h.h_slot_id) FILTER (WHERE h.h_end < now()) AS h_past
      FROM booked h
     WHERE h.h_person_id IN (SELECT e.person_id FROM ex e)
     GROUP BY h.h_person_id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'person_id',           e.person_id,
                    'full_name',           e.full_name,
                    'email',               e.email,
                    'phone',               e.phone,
                    'currently_training',  e.person_id IN (SELECT t.person_id FROM training t),
                    'first_training_date', to_char((h.h_first AT TIME ZONE v_tz)::date, 'YYYY-MM-DD'),
                    'last_training_date',  to_char((h.h_last AT TIME ZONE v_tz)::date, 'YYYY-MM-DD'),
                    'next_training_date',  to_char((h.h_next AT TIME ZONE v_tz)::date, 'YYYY-MM-DD'),
                    'past_bookings_count', coalesce(h.h_past, 0),
                    'birth_date',          to_char(e.birth_date, 'YYYY-MM-DD'),
                    'location_names',      to_jsonb(coalesce(lo.l_names, '{}'::text[])))
                  ORDER BY e.sort_ord), '[]'::jsonb)
    INTO v_rows
    FROM ex e
    LEFT JOIN hist h ON h.h_person_id = e.person_id
    LEFT JOIN locs lo ON lo.l_person_id = e.person_id;

  RETURN QUERY SELECT v_total, v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) TO authenticated;
