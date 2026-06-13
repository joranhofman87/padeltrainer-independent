-- AUDIT (read-only): rebooking-cohort X-ray. Validates the (location, term-end
-- week) cohort key on real data ahead of the bulk-rebook feature.
-- Emits RAISE NOTICE counts/ids only — no player names, never mutates, never
-- fails, safe to re-run. uuids + counts are not PII.
--
-- Goal: confirm that grouping an academy's slots by (location_id, term-end
-- week) captures a real cohort that spans BOTH registration-module sessions
-- (cyclus_id -> a 'registration' cycle) AND hand-added agenda sessions
-- (null/other cyclus_id) — i.e. that cyclus_id alone would miss players.

DO $$
DECLARE
  r record;
  any_row boolean := false;
BEGIN
  RAISE NOTICE '=== rebooking cohort X-ray: clusters by (academy, location, term-end week) ===';
  RAISE NOTICE 'Each row = one (academy, location) whose slots'' latest week is the term end.';
  RAISE NOTICE 'players = distinct non-cancelled booked players; groups = distinct (trainer, weekday, time);';
  RAISE NOTICE 'reg_bk / other_bk = bookings whose slot is registration-tied vs hand-added/other.';

  FOR r IN
    WITH academy_slots AS (
      SELECT s.id, s.academy_profile_id, s.location_id, s.trainer_id, s.cyclus_id,
             date_trunc('week', s.start_time) AS wk,
             extract(dow from s.start_time)::int AS dow,
             to_char(s.start_time, 'HH24:MI') AS tod
      FROM public.availability_slots s
      WHERE s.academy_profile_id IS NOT NULL
        AND s.location_id IS NOT NULL
    ),
    term AS (
      SELECT academy_profile_id, location_id, max(wk) AS term_end_wk
      FROM academy_slots
      GROUP BY academy_profile_id, location_id
    ),
    enriched AS (
      SELECT a.*, t.term_end_wk,
             CASE
               WHEN c.id IS NOT NULL AND c.type = 'registration' THEN 'registration'
               ELSE 'other'
             END AS origin
      FROM academy_slots a
      JOIN term t ON t.academy_profile_id = a.academy_profile_id
                 AND t.location_id = a.location_id
      LEFT JOIN public.cycles c ON c.id = a.cyclus_id
    ),
    booked AS (
      SELECT e.academy_profile_id, e.location_id, e.term_end_wk, e.origin,
             e.trainer_id, e.dow, e.tod,
             coalesce(b.player_id::text, b.guest_player_id::text) AS player_key
      FROM enriched e
      JOIN public.bookings b ON b.slot_id = e.id
        AND coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      WHERE b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL
    )
    SELECT academy_profile_id, location_id, to_char(term_end_wk, 'YYYY-MM-DD') AS term_end,
           count(DISTINCT player_key) AS players,
           count(DISTINCT (trainer_id::text || ':' || dow::text || ':' || tod)) AS groups,
           count(*) FILTER (WHERE origin = 'registration') AS reg_bk,
           count(*) FILTER (WHERE origin = 'other') AS other_bk,
           count(DISTINCT player_key) FILTER (WHERE origin = 'other') AS players_only_via_other
    FROM booked
    GROUP BY academy_profile_id, location_id, term_end_wk
    HAVING count(DISTINCT player_key) >= 5
    ORDER BY count(DISTINCT player_key) DESC
    LIMIT 20
  LOOP
    any_row := true;
    RAISE NOTICE 'academy=% loc=% term_end=% | players=% groups=% reg_bk=% other_bk=% other_only_players=%',
      r.academy_profile_id, r.location_id, r.term_end,
      r.players, r.groups, r.reg_bk, r.other_bk, r.players_only_via_other;
  END LOOP;

  IF NOT any_row THEN
    RAISE NOTICE '(no academy/location cluster with >= 5 distinct booked players found)';
  END IF;

  RAISE NOTICE '=== end rebooking cohort X-ray ===';
END $$;
