-- M4 (rebook go-live audit): the /claim/:token page showed only a per-session price,
-- so a player committing to a full multi-week term never saw the total they were
-- agreeing to. Add `sessions` to the anon-readable claim payload: the number of weekly
-- sessions in THIS player's rebook series (one claim per week within their group), so
-- the page can render "price_per_session x sessions" as the term total.
--
-- Additive (CREATE OR REPLACE, same signature) — no DROP. Still anon+authenticated:
-- the claim page is opened by logged-out players from the invitation email.
--
-- Session count = claims sharing this claim's rebook_group_id for the SAME player
-- (rebook_group_id identifies one weekly series across all weeks AND all co-occupants,
-- so it must be narrowed to the player). GREATEST(1, ...) covers the legacy single-slot
-- case where rebook_group_id is NULL (no group rows match → would be 0).

CREATE OR REPLACE FUNCTION public.get_priority_claim_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'claim', jsonb_build_object(
      'id', c.id,
      'status', c.status,
      'claim_token', c.claim_token
    ),
    'slot', jsonb_build_object(
      'id', s.id,
      'start_time', s.start_time,
      'end_time', s.end_time,
      'cyclus_id', s.cyclus_id,
      'cyclus_name', s.cyclus_name,
      'location_id', s.location_id,
      'price_per_session', s.price_per_session,
      'total_price', s.total_price,
      'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id,
      'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*)
      FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    'player_name', COALESCE(p.full_name, gp.full_name)
  )
  INTO result
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  LEFT JOIN public.profiles p ON p.id = c.player_id
  LEFT JOIN public.guest_players gp ON gp.id = c.guest_player_id
  WHERE c.claim_token = _token
  LIMIT 1;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_priority_claim_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_priority_claim_by_token(text) TO anon, authenticated;
