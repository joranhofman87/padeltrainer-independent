-- Identifying labels for a cyclus selection dropdown: per academy cyclus, the
-- earliest slot's start (for "{Day} {time}"), the distinct roster first names,
-- and the location. Aggregated server-side so a busy academy (dozens of cycles,
-- 1000s of slots/bookings) returns in one round-trip without PostgREST row caps
-- or URL-length limits. The label string is assembled client-side (nl day/time).
--
-- Read-only, manager-gated, additive (no DROP). Player names stay admin-only
-- (this is the only surface that joins them) — never written to cycles.name.

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
  -- earliest slot per cycle → day/time AND a representative location (cyclus rows
  -- don't set cycles.location_id; the venue lives on the slots).
  earliest AS (
    SELECT DISTINCT ON (cyclus_id) cyclus_id, start_time AS earliest_start, location_id
    FROM sl
    ORDER BY cyclus_id, start_time
  ),
  -- one row per (cyclus, distinct first name) from non-cancelled bookings
  roster AS (
    SELECT DISTINCT sl.cyclus_id,
      coalesce(
        nullif(split_part(coalesce(pr.full_name, ''), ' ', 1), ''),
        nullif(btrim(gp.first_name), ''),
        nullif(split_part(coalesce(gp.full_name, ''), ' ', 1), '')
      ) AS first_name
    FROM public.bookings b
    JOIN sl ON sl.slot_id = b.slot_id
    LEFT JOIN public.profiles pr      ON pr.id = b.player_id
    LEFT JOIN public.guest_players gp ON gp.id = b.guest_player_id
    WHERE b.status <> 'cancelled'
      AND (b.player_id IS NOT NULL OR b.guest_player_id IS NOT NULL)
  ),
  names AS (
    SELECT cyclus_id, array_agg(first_name ORDER BY first_name) AS first_names
    FROM roster
    WHERE first_name IS NOT NULL AND first_name <> ''
    GROUP BY cyclus_id
  )
  SELECT cyc.id, e.earliest_start, coalesce(n.first_names, '{}'::text[]), l.name
  FROM cyc
  LEFT JOIN earliest e ON e.cyclus_id = cyc.id
  LEFT JOIN names    n ON n.cyclus_id = cyc.id
  LEFT JOIN public.locations l ON l.id = coalesce(cyc.location_id, e.location_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_academy_cyclus_labels(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_labels(uuid) TO authenticated;
