-- Phase 3.5d: person-key the two remaining small READERS that produced wrong
-- results for merged persons. Signatures unchanged (CREATE OR REPLACE, no types
-- drift). Dashboard head-counts (academy/trainer analytics, admin_stats_summary)
-- are DELIBERATELY deferred to 3.6: analytics-only double-counting, and both are
-- large re-emits — risk outweighs a chart being off by a handful for ~46 merged
-- pairs.
--
-- (1) get_academy_cyclus_labels — the roster first-name chips:
--     * FAM-02 precedence was INVERTED: on a dual-keyed booking the PROFILE name
--       won over the guest who owns the row (every other label surface resolves
--       persons since 3.1/3.2).
--     * NO person dedup: a merged person seated under both keys appeared twice
--       whenever the two first-name strings differ.
--     Fix: names resolve person-first (persons.full_name via the stamp), then
--     guest-first old-world fallback; dedup is per PERSON KEY (stamped person id,
--     else the seat ref). A split-frozen guest keys as its own person and shows
--     its own guest name (link suspended).
--
-- (2) get_player_locations — the detail-page clubs union:
--     The signature takes ONE (profile, guest) pair, but a merged person can hold
--     2+ guest refs; clubs contributed by the person's OTHER refs were silently
--     dropped. Fix: expand the passed pair to the person's FULL ref-set via
--     person_links inside the fn (frozen guests excluded from the expansion; the
--     PASSED refs always count — the caller explicitly asked about them. A frozen
--     PASSED guest suppresses only the GUEST-side person resolution; when a linked
--     profile is also passed, the profile branch still expands).
--     Every ref predicate becomes = ANY(ref array), including the dismissed-minus
--     logic (a dismissal under ANY of the person's refs hides the club).

-- ---------------------------------------------------------------------------
-- (1) get_academy_cyclus_labels
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_academy_cyclus_labels(p_academy_profile_id uuid)
RETURNS TABLE (cycle_id uuid, earliest_start timestamptz, first_names text[], location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH cyc AS (
    SELECT c.id, c.location_id
    FROM public.cycles c
    WHERE c.owner_type = 'academy' AND c.owner_id = p_academy_profile_id AND c.type = 'cyclus'
  ),
  sl AS (
    SELECT s.id AS slot_id, s.cyclus_id, s.start_time, s.location_id
    FROM public.availability_slots s
    JOIN cyc ON cyc.id = s.cyclus_id
  ),
  earliest AS (
    SELECT DISTINCT ON (cyclus_id) cyclus_id, start_time AS earliest_start, location_id
    FROM sl
    ORDER BY cyclus_id, start_time
  ),
  -- one row per (cyclus, PERSON) from non-cancelled bookings. Person-first name
  -- (the stamp), guest-first fallback (FAM-02: a dual-keyed row belongs to the
  -- guest), profile last. A split-frozen guest keys as its own person with its
  -- own guest name (link suspended while the review is pending).
  seats AS (
    SELECT sl.cyclus_id,
      CASE
        WHEN b.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(b.guest_player_id)
          THEN 'g:' || b.guest_player_id::text
        ELSE coalesce(b.person_id::text, 'p:' || b.player_id::text, 'g:' || b.guest_player_id::text)
      END AS person_key,
      CASE
        WHEN b.guest_player_id IS NOT NULL AND public.is_guest_split_frozen(b.guest_player_id)
          THEN coalesce(
            nullif(btrim(gp.first_name), ''),
            nullif(split_part(coalesce(gp.full_name, ''), ' ', 1), ''))
        ELSE coalesce(
          nullif(split_part(coalesce(pe.full_name, ''), ' ', 1), ''),
          nullif(btrim(gp.first_name), ''),
          nullif(split_part(coalesce(gp.full_name, ''), ' ', 1), ''),
          nullif(split_part(coalesce(pr.full_name, ''), ' ', 1), ''))
      END AS first_name
    FROM public.bookings b
    JOIN sl ON sl.slot_id = b.slot_id
    LEFT JOIN public.persons pe       ON pe.id = b.person_id
    LEFT JOIN public.profiles pr      ON pr.id = b.player_id
    LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
    WHERE b.status <> 'cancelled'
      AND (b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL)
  ),
  roster AS (
    -- one name per (cyclus, person): a merged human appears ONCE.
    SELECT DISTINCT ON (cyclus_id, person_key) cyclus_id, first_name
    FROM seats
    WHERE first_name IS NOT NULL AND first_name <> ''
    ORDER BY cyclus_id, person_key, first_name
  ),
  names AS (
    SELECT cyclus_id, array_agg(DISTINCT first_name ORDER BY first_name) AS first_names
    FROM roster
    GROUP BY cyclus_id
  )
  SELECT cyc.id, e.earliest_start, coalesce(n.first_names, '{}'::text[]), l.name
  FROM cyc
  LEFT JOIN earliest e ON e.cyclus_id = cyc.id
  LEFT JOIN names n    ON n.cyclus_id = cyc.id
  LEFT JOIN public.locations l ON l.id = coalesce(cyc.location_id, e.location_id);
END;
$$;

COMMENT ON FUNCTION public.get_academy_cyclus_labels(uuid) IS
  'Phase 3.5d: cyclus dropdown labels. First names resolve PERSON-first (stamp) with guest-first old-world fallback (FAM-02) and dedup per person — a merged human appears once; a split-frozen guest keys as its own person. Manager-gated, read-only.';

-- ---------------------------------------------------------------------------
-- (2) get_player_locations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_player_locations(
  p_academy_profile_id uuid,
  p_profile_id uuid,
  p_guest_player_id uuid
)
RETURNS TABLE (location_id uuid, location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_person uuid;
  v_profile_ids uuid[];
  v_guest_ids uuid[];
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  -- Phase 3.5d: expand the passed pair to the person's FULL ref-set. Guest-first
  -- resolution; a FROZEN passed guest does not resolve (degrades to the old
  -- single-pair behavior); frozen OTHER guests are excluded from the expansion.
  IF p_guest_player_id IS NOT NULL AND NOT public.is_guest_split_frozen(p_guest_player_id) THEN
    SELECT pl.person_id INTO v_person FROM public.person_links pl
    WHERE pl.guest_player_id = p_guest_player_id;
  END IF;
  IF v_person IS NULL AND p_profile_id IS NOT NULL THEN
    SELECT pl.person_id INTO v_person FROM public.person_links pl
    WHERE pl.profile_id = p_profile_id;
  END IF;

  -- TENANT SCOPE on the expansion (verify r2 P1): person_links merges are
  -- cross-tenant by design, and three union arms below have no academy filter —
  -- an unscoped expansion would surface ANOTHER tenant's location associations
  -- (their guest's bookings/preferred/intake at a shared club) on THIS academy's
  -- detail page. Expanded guest refs are therefore limited to guests IN THIS
  -- ACADEMY'S SCOPE (the get_players_overview guests-CTE predicate: owned by the
  -- academy, or owned by one of its active trainers). The PASSED refs keep the
  -- original behavior untouched.
  v_profile_ids := ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[p_profile_id] || COALESCE(ARRAY(
      SELECT pl.profile_id FROM public.person_links pl
      WHERE v_person IS NOT NULL AND pl.person_id = v_person AND pl.profile_id IS NOT NULL
    ), '{}'::uuid[])) AS x WHERE x IS NOT NULL);
  v_guest_ids := ARRAY(
    SELECT DISTINCT x FROM unnest(ARRAY[p_guest_player_id] || COALESCE(ARRAY(
      SELECT pl.guest_player_id FROM public.person_links pl
      JOIN public.guest_players g ON g.id = pl.guest_player_id
      WHERE v_person IS NOT NULL AND pl.person_id = v_person AND pl.guest_player_id IS NOT NULL
        AND NOT public.is_guest_split_frozen(pl.guest_player_id)
        AND (g.academy_profile_id = p_academy_profile_id
          OR g.trainer_id IN (
            SELECT at.trainer_profile_id FROM public.academy_trainers at
            WHERE at.status = 'active' AND at.academy_profile_id = p_academy_profile_id))
    ), '{}'::uuid[])) AS x WHERE x IS NOT NULL);

  RETURN QUERY
  SELECT l.id, l.name
  FROM (
    SELECT coalesce(lm.merged_into, cand.loc) AS loc_id,
           bool_and(cand.requires_active) AS req_active
    FROM (
      SELECT s.location_id AS loc, true AS requires_active
        FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
       WHERE b.status IN ('confirmed','completed') AND s.location_id IS NOT NULL
         AND (b.guest_player_id = ANY(v_guest_ids)
           OR (b.player_id = ANY(v_profile_ids) AND b.guest_player_id IS NULL))  -- FAM-02
      UNION ALL
      SELECT g.preferred_location_id, false
        FROM public.guest_players g
       WHERE g.id = ANY(v_guest_ids) AND g.preferred_location_id IS NOT NULL
      UNION ALL
      SELECT m.preferred_location_id, false
        FROM public.academy_player_metadata m
       WHERE m.academy_profile_id = p_academy_profile_id AND m.preferred_location_id IS NOT NULL
         AND (m.guest_player_id = ANY(v_guest_ids) OR m.profile_id = ANY(v_profile_ids))
      UNION ALL
      SELECT ir.location_id, false
        FROM public.intake_requests ir
       WHERE ir.location_id IS NOT NULL
         AND (ir.guest_player_id = ANY(v_guest_ids)
           OR (ir.player_id = ANY(v_profile_ids) AND ir.guest_player_id IS NULL))  -- FAM-02
      UNION ALL
      SELECT apl.location_id, false
        FROM public.academy_player_locations apl
       WHERE apl.academy_profile_id = p_academy_profile_id AND apl.dismissed = false
         AND (apl.guest_player_id = ANY(v_guest_ids) OR apl.profile_id = ANY(v_profile_ids))
    ) cand
    LEFT JOIN public.locations lm ON lm.id = cand.loc
    GROUP BY coalesce(lm.merged_into, cand.loc)
  ) d
  JOIN public.locations l ON l.id = d.loc_id
  WHERE EXISTS (SELECT 1 FROM public.academy_locations al
                WHERE al.academy_profile_id = p_academy_profile_id
                  AND al.location_id = d.loc_id
                  AND (al.is_active OR NOT d.req_active))
    AND NOT EXISTS (SELECT 1 FROM public.academy_player_locations apl
                    LEFT JOIN public.locations lm2 ON lm2.id = apl.location_id
                    WHERE apl.academy_profile_id = p_academy_profile_id AND apl.dismissed = true
                      AND coalesce(lm2.merged_into, apl.location_id) = d.loc_id
                      AND (apl.guest_player_id = ANY(v_guest_ids) OR apl.profile_id = ANY(v_profile_ids)))
  ORDER BY l.name;
END;
$$;

COMMENT ON FUNCTION public.get_player_locations(uuid, uuid, uuid) IS
  'Phase 3.5d: a player''s displayed clubs (academy scope), person-keyed — the passed (profile, guest) pair is expanded to the person''s full ref-set via person_links (expansion limited to IN-SCOPE, non-frozen guests; a frozen passed guest suppresses only the guest-side resolution). Same union as the players table (trained∪preferred∪intake∪manual − dismissed, dismissals under any ref).';

-- Grants unchanged in effect; re-asserted for the re-emits.
REVOKE ALL ON FUNCTION public.get_academy_cyclus_labels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_labels(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_player_locations(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_locations(uuid, uuid, uuid) TO authenticated;
