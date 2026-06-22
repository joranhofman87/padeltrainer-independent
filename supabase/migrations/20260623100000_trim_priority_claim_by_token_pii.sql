-- Trim the anon-readable claim-by-token RPC to the fields the /claim/:token page
-- actually uses. Previously it returned to_jsonb(c.*) (the WHOLE claim row, incl.
-- internal ids) AND the player's email to any holder of the (un-guessable but
-- forwardable) claim link. The page only renders the player's NAME + the slot, so
-- the email + raw claim columns were needless PII exposure. Now: claim id/status/
-- token + the curated slot object + player_name only.
--
-- Additive (CREATE OR REPLACE, same signature) — no DROP, no destructive warning.
-- Still granted to anon: the claim page is opened by logged-out players via email.

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
