-- Per-player displayed clubs (academy scope) — the SAME union the players table shows,
-- for one player, so the profile UI matches the table and can drive attach/detach.
-- trained (active academy club) ∪ preferred ∪ intake ∪ manual-attach, minus dismissed;
-- merged locations resolved to canonical. Manager-gated.
CREATE OR REPLACE FUNCTION public.get_player_locations(
  p_academy_profile_id uuid,
  p_profile_id uuid,
  p_guest_player_id uuid
)
RETURNS TABLE (location_id uuid, location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT l.id, l.name
  FROM (
    SELECT coalesce(lm.merged_into, cand.loc) AS loc_id,
           bool_and(cand.requires_active) AS req_active
    FROM (
      SELECT s.location_id AS loc, true AS requires_active
        FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
       WHERE b.status IN ('confirmed','completed') AND s.location_id IS NOT NULL
         AND ((p_guest_player_id IS NOT NULL AND b.guest_player_id = p_guest_player_id)
           OR (p_profile_id IS NOT NULL AND b.player_id = p_profile_id))
      UNION ALL
      SELECT g.preferred_location_id, false
        FROM public.guest_players g WHERE g.id = p_guest_player_id AND g.preferred_location_id IS NOT NULL
      UNION ALL
      SELECT m.preferred_location_id, false
        FROM public.academy_player_metadata m
       WHERE m.academy_profile_id = p_academy_profile_id AND m.preferred_location_id IS NOT NULL
         AND ((p_guest_player_id IS NOT NULL AND m.guest_player_id = p_guest_player_id)
           OR (p_profile_id IS NOT NULL AND m.profile_id = p_profile_id))
      UNION ALL
      SELECT ir.location_id, false
        FROM public.intake_requests ir
       WHERE ir.location_id IS NOT NULL
         AND ((p_guest_player_id IS NOT NULL AND ir.guest_player_id = p_guest_player_id)
           OR (p_profile_id IS NOT NULL AND ir.player_id = p_profile_id))
      UNION ALL
      SELECT apl.location_id, false
        FROM public.academy_player_locations apl
       WHERE apl.academy_profile_id = p_academy_profile_id AND apl.dismissed = false
         AND ((p_guest_player_id IS NOT NULL AND apl.guest_player_id = p_guest_player_id)
           OR (p_profile_id IS NOT NULL AND apl.profile_id = p_profile_id))
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
                      AND ((p_guest_player_id IS NOT NULL AND apl.guest_player_id = p_guest_player_id)
                        OR (p_profile_id IS NOT NULL AND apl.profile_id = p_profile_id)))
  ORDER BY l.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_player_locations(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_player_locations(uuid, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.get_player_locations(uuid, uuid, uuid) IS
  'A single player''s displayed clubs (academy scope) — same union as the players table (trained∪preferred∪intake∪manual − dismissed), so the profile UI matches the table.';
