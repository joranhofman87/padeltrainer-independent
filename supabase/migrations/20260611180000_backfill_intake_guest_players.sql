-- Backfill: create/link player records for historical cycle-intake applicants.
--
-- addToStudentList silently failed since launch (PostgREST upsert against
-- PARTIAL unique email indexes -> 42P10, error swallowed), so authenticated
-- cycle applicants never became guest_players/club_players (fixed forward in
-- src/lib/playerResolve.ts). Anonymous applicants went through the
-- submit-guest-intake edge function which already links guest_player_id.
--
-- Per intake row (joined to its cycle's owner):
--   trainer/academy-owned: match an existing in-scope guest by linked profile
--   or email (oldest wins), else create one guest per (scope, person-key)
--   with full intake data (linked_profile_id set when known); then record the
--   link on intake_requests.guest_player_id (idempotency anchor).
--   club-owned: same against club_players (no guest_player_id column to
--   record; idempotency relies on the email match itself).
-- Person-key: lower(email) when present, else player_id, else lower(name).
-- Removed players: matching the existing (removed) row means no insert, so
-- removals are respected. The guest-link trigger fires on these inserts and
-- runs its normal linking work (guarded, idempotent). Idempotent overall:
-- re-run links/creates nothing new.

DO $$
DECLARE
  v_before integer;
  v_t_linked integer := 0; v_t_created integer := 0; v_t_linked_new integer := 0;
  v_a_linked integer := 0; v_a_created integer := 0; v_a_linked_new integer := 0;
  v_c_matched integer := 0; v_c_created integer := 0;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.intake_requests i
  JOIN public.cycles c ON c.id = i.cycle_id
  WHERE i.guest_player_id IS NULL
    AND c.owner_type IN ('trainer','academy')
    AND btrim(coalesce(i.full_name,'')) <> '';
  RAISE NOTICE 'backfill_intake_guest_players: % actionable trainer/academy intakes before', v_before;

  ------------------------------------------------------------------
  -- Pass 1: trainer-owned cycles -> guest_players (trainer scope)
  ------------------------------------------------------------------

  -- 1a. Link intakes to existing trainer guests (linked profile or email; oldest wins)
  UPDATE public.intake_requests t
  SET guest_player_id = m.gid
  FROM (
    SELECT i.id AS intake_id,
           (SELECT gp.id FROM public.guest_players gp
            WHERE gp.trainer_id = c.owner_id
              AND ((i.player_id IS NOT NULL AND gp.linked_profile_id = i.player_id)
                OR (btrim(coalesce(i.email,'')) <> ''
                    AND lower(btrim(coalesce(gp.email,''))) = lower(btrim(i.email))))
            ORDER BY gp.created_at, gp.id
            LIMIT 1) AS gid
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'trainer' AND i.guest_player_id IS NULL
  ) m
  WHERE t.id = m.intake_id AND m.gid IS NOT NULL;
  GET DIAGNOSTICS v_t_linked = ROW_COUNT;

  -- 1b. Create one guest per (trainer, person-key) from the latest intake in each group
  INSERT INTO public.guest_players
    (trainer_id, full_name, first_name, last_name, email, phone,
     skill_rating, rating_system, birth_date, linked_profile_id,
     source, has_trained)
  SELECT
    s.owner_id,
    btrim(s.full_name),
    CASE WHEN position(' ' IN btrim(s.full_name)) = 0 THEN btrim(s.full_name)
         ELSE split_part(btrim(s.full_name), ' ', 1) END,
    CASE WHEN position(' ' IN btrim(s.full_name)) = 0 THEN NULL
         ELSE btrim(substring(btrim(s.full_name) FROM position(' ' IN btrim(s.full_name)) + 1)) END,
    nullif(btrim(coalesce(s.email,'')), ''),
    nullif(btrim(coalesce(s.phone,'')), ''),
    s.rating, coalesce(nullif(s.rating_system,''), 'knltb'),
    s.birth_date::date, s.player_id,
    'cycle_registration', false
  FROM (
    SELECT DISTINCT ON (c.owner_id,
      CASE WHEN btrim(coalesce(i.email,'')) <> '' THEN 'e:' || lower(btrim(i.email))
           WHEN i.player_id IS NOT NULL THEN 'p:' || i.player_id
           ELSE 'n:' || lower(btrim(i.full_name)) END)
      c.owner_id, i.full_name, i.email, i.phone, i.rating, i.rating_system,
      i.birth_date, i.player_id
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'trainer'
      AND i.guest_player_id IS NULL
      AND btrim(coalesce(i.full_name,'')) <> ''
    ORDER BY c.owner_id,
      CASE WHEN btrim(coalesce(i.email,'')) <> '' THEN 'e:' || lower(btrim(i.email))
           WHEN i.player_id IS NOT NULL THEN 'p:' || i.player_id
           ELSE 'n:' || lower(btrim(i.full_name)) END,
      i.created_at DESC, i.id
  ) s;
  GET DIAGNOSTICS v_t_created = ROW_COUNT;

  -- 1c. Link the remaining intakes to the just-created guests (same matcher,
  --     plus name-key fallback for rows without email or player_id)
  UPDATE public.intake_requests t
  SET guest_player_id = m.gid
  FROM (
    SELECT i.id AS intake_id,
           (SELECT gp.id FROM public.guest_players gp
            WHERE gp.trainer_id = c.owner_id
              AND ((i.player_id IS NOT NULL AND gp.linked_profile_id = i.player_id)
                OR (btrim(coalesce(i.email,'')) <> ''
                    AND lower(btrim(coalesce(gp.email,''))) = lower(btrim(i.email)))
                OR (btrim(coalesce(i.email,'')) = '' AND i.player_id IS NULL
                    AND lower(btrim(gp.full_name)) = lower(btrim(i.full_name))))
            ORDER BY gp.created_at, gp.id
            LIMIT 1) AS gid
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'trainer' AND i.guest_player_id IS NULL
  ) m
  WHERE t.id = m.intake_id AND m.gid IS NOT NULL;
  GET DIAGNOSTICS v_t_linked_new = ROW_COUNT;

  RAISE NOTICE 'trainer pass: linked_existing=%, guests_created=%, linked_new=%',
    v_t_linked, v_t_created, v_t_linked_new;

  ------------------------------------------------------------------
  -- Pass 2: academy-owned cycles -> guest_players (academy scope).
  -- Existing-match also covers guests owned by the academy's active
  -- trainers (the overview counts those as members too).
  ------------------------------------------------------------------

  UPDATE public.intake_requests t
  SET guest_player_id = m.gid
  FROM (
    SELECT i.id AS intake_id,
           (SELECT gp.id FROM public.guest_players gp
            WHERE (gp.academy_profile_id = c.owner_id
                   OR gp.trainer_id IN (SELECT at.trainer_profile_id
                                        FROM public.academy_trainers at
                                        WHERE at.academy_profile_id = c.owner_id
                                          AND at.status = 'active'))
              AND ((i.player_id IS NOT NULL AND gp.linked_profile_id = i.player_id)
                OR (btrim(coalesce(i.email,'')) <> ''
                    AND lower(btrim(coalesce(gp.email,''))) = lower(btrim(i.email))))
            ORDER BY gp.created_at, gp.id
            LIMIT 1) AS gid
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'academy' AND i.guest_player_id IS NULL
  ) m
  WHERE t.id = m.intake_id AND m.gid IS NOT NULL;
  GET DIAGNOSTICS v_a_linked = ROW_COUNT;

  INSERT INTO public.guest_players
    (academy_profile_id, full_name, first_name, last_name, email, phone,
     skill_rating, rating_system, birth_date, linked_profile_id,
     source, has_trained)
  SELECT
    s.owner_id,
    btrim(s.full_name),
    CASE WHEN position(' ' IN btrim(s.full_name)) = 0 THEN btrim(s.full_name)
         ELSE split_part(btrim(s.full_name), ' ', 1) END,
    CASE WHEN position(' ' IN btrim(s.full_name)) = 0 THEN NULL
         ELSE btrim(substring(btrim(s.full_name) FROM position(' ' IN btrim(s.full_name)) + 1)) END,
    nullif(btrim(coalesce(s.email,'')), ''),
    nullif(btrim(coalesce(s.phone,'')), ''),
    s.rating, coalesce(nullif(s.rating_system,''), 'knltb'),
    s.birth_date::date, s.player_id,
    'cycle_registration', false
  FROM (
    SELECT DISTINCT ON (c.owner_id,
      CASE WHEN btrim(coalesce(i.email,'')) <> '' THEN 'e:' || lower(btrim(i.email))
           WHEN i.player_id IS NOT NULL THEN 'p:' || i.player_id
           ELSE 'n:' || lower(btrim(i.full_name)) END)
      c.owner_id, i.full_name, i.email, i.phone, i.rating, i.rating_system,
      i.birth_date, i.player_id
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'academy'
      AND i.guest_player_id IS NULL
      AND btrim(coalesce(i.full_name,'')) <> ''
    ORDER BY c.owner_id,
      CASE WHEN btrim(coalesce(i.email,'')) <> '' THEN 'e:' || lower(btrim(i.email))
           WHEN i.player_id IS NOT NULL THEN 'p:' || i.player_id
           ELSE 'n:' || lower(btrim(i.full_name)) END,
      i.created_at DESC, i.id
  ) s;
  GET DIAGNOSTICS v_a_created = ROW_COUNT;

  UPDATE public.intake_requests t
  SET guest_player_id = m.gid
  FROM (
    SELECT i.id AS intake_id,
           (SELECT gp.id FROM public.guest_players gp
            WHERE (gp.academy_profile_id = c.owner_id
                   OR gp.trainer_id IN (SELECT at.trainer_profile_id
                                        FROM public.academy_trainers at
                                        WHERE at.academy_profile_id = c.owner_id
                                          AND at.status = 'active'))
              AND ((i.player_id IS NOT NULL AND gp.linked_profile_id = i.player_id)
                OR (btrim(coalesce(i.email,'')) <> ''
                    AND lower(btrim(coalesce(gp.email,''))) = lower(btrim(i.email)))
                OR (btrim(coalesce(i.email,'')) = '' AND i.player_id IS NULL
                    AND lower(btrim(gp.full_name)) = lower(btrim(i.full_name))))
            ORDER BY gp.created_at, gp.id
            LIMIT 1) AS gid
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'academy' AND i.guest_player_id IS NULL
  ) m
  WHERE t.id = m.intake_id AND m.gid IS NOT NULL;
  GET DIAGNOSTICS v_a_linked_new = ROW_COUNT;

  RAISE NOTICE 'academy pass: linked_existing=%, guests_created=%, linked_new=%',
    v_a_linked, v_a_created, v_a_linked_new;

  ------------------------------------------------------------------
  -- Pass 3: club-owned cycles -> club_players. No intake column records the
  -- link, so idempotency relies on the email match itself.
  ------------------------------------------------------------------

  SELECT count(*) INTO v_c_matched
  FROM public.intake_requests i
  JOIN public.cycles c ON c.id = i.cycle_id
  WHERE c.owner_type = 'club'
    AND btrim(coalesce(i.email,'')) <> ''
    AND EXISTS (
      SELECT 1 FROM public.club_players cp
      WHERE cp.club_profile_id = c.owner_id
        AND lower(btrim(coalesce(cp.email,''))) = lower(btrim(i.email))
    );

  INSERT INTO public.club_players
    (club_profile_id, full_name, email, phone, skill_rating, rating_system,
     linked_profile_id, source, has_trained)
  SELECT
    s.owner_id, btrim(s.full_name), btrim(s.email),
    nullif(btrim(coalesce(s.phone,'')), ''),
    s.rating, coalesce(nullif(s.rating_system,''), 'knltb'),
    s.player_id, 'cycle_registration', false
  FROM (
    SELECT DISTINCT ON (c.owner_id, lower(btrim(i.email)))
      c.owner_id, i.full_name, i.email, i.phone, i.rating, i.rating_system, i.player_id
    FROM public.intake_requests i
    JOIN public.cycles c ON c.id = i.cycle_id
    WHERE c.owner_type = 'club'
      AND btrim(coalesce(i.email,'')) <> ''
      AND btrim(coalesce(i.full_name,'')) <> ''
      AND NOT EXISTS (
        SELECT 1 FROM public.club_players cp
        WHERE cp.club_profile_id = c.owner_id
          AND lower(btrim(coalesce(cp.email,''))) = lower(btrim(i.email))
      )
    ORDER BY c.owner_id, lower(btrim(i.email)), i.created_at DESC, i.id
  ) s;
  GET DIAGNOSTICS v_c_created = ROW_COUNT;

  RAISE NOTICE 'club pass: already_present=%, club_players_created=%', v_c_matched, v_c_created;

  SELECT count(*) INTO v_after
  FROM public.intake_requests i
  JOIN public.cycles c ON c.id = i.cycle_id
  WHERE i.guest_player_id IS NULL
    AND c.owner_type IN ('trainer','academy')
    AND btrim(coalesce(i.full_name,'')) <> '';
  RAISE NOTICE 'backfill_intake_guest_players: % actionable intakes after (was %)', v_after, v_before;
END $$;
