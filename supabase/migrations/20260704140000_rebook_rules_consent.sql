-- Record a player's consent to the rebooking rules, captured when they tick "I agree to the
-- rebooking rules" before keeping their spot / paying on the claim page.
--
-- Deliberately DECOUPLED from the accept/payment RPCs: the frontend calls accept_rebook_rules()
-- best-effort right before proceeding (the accept then redirects to Mollie). This keeps the
-- sensitive money-path RPCs unchanged, and means deploy order doesn't matter — the frontend
-- swallows a missing-function error until this migration is applied, so rebooking never breaks.

-- (1) Consent column ------------------------------------------------------------------------
ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS rules_accepted_at timestamptz;

COMMENT ON COLUMN public.slot_priority_claims.rules_accepted_at IS
  'When the player (or, for a group, the acting captain) agreed to the rebooking rules before keeping/paying for their spot. NULL = no rules shown / not recorded. Can be set on a not-yet-converted claim (consent precedes the accept), so read it alongside the claim status.';

-- (2) Token-gated, anon-callable best-effort stamp. Guarded to a STILL-ACTIONABLE claim (pending +
-- open window, mirroring respond_to_priority_claim) so the audit field never records "consent" on a
-- declined/expired/already-claimed claim. Idempotent — the first consent time wins. SECURITY DEFINER
-- so the unauthenticated claimant can record their own consent without a direct table grant.
CREATE OR REPLACE FUNCTION public.accept_rebook_rules(_token text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.slot_priority_claims c
     SET rules_accepted_at = COALESCE(c.rules_accepted_at, now())
   WHERE c.claim_token = _token
     AND c.status = 'pending'
     AND EXISTS (
       SELECT 1 FROM public.availability_slots s
        WHERE s.id = c.slot_id
          AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())
     );
$$;

REVOKE ALL ON FUNCTION public.accept_rebook_rules(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_rebook_rules(text) TO anon, authenticated;

-- (3) get_priority_claim_by_token — also return the cycle's rebook_rules in this SECURITY DEFINER
-- payload. The consent gate MUST NOT be driven by a separate anon cycles.settings read: that read is
-- only permitted for status='open' cycles and can return null on a transient blip, which would
-- silently drop the mandatory consent gate (fail-open). Reading the rules here (RLS bypassed, same
-- round-trip the page already makes) makes the gate reliable regardless of cycle status. This
-- reproduces the 20260626100000 definition verbatim and adds ONE field (rebook_rules).
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
    'player_name', COALESCE(p.full_name, gp.full_name),
    -- First name of the group member ("captain") who re-booked this claim on the viewer's
    -- behalf, else NULL. Drives the "X already re-booked your group" read-only state.
    'booked_by_captain_name', CASE
      WHEN c.booked_by_player_id IS NOT NULL OR c.booked_by_guest_player_id IS NOT NULL
      THEN COALESCE(NULLIF(bp.first_name, ''), NULLIF(split_part(bp.full_name, ' ', 1), ''),
                    NULLIF(bgp.first_name, ''), NULLIF(split_part(bgp.full_name, ' ', 1), ''))
      ELSE NULL
    END,
    -- The cycle's rebooking rules (rich HTML) the player must consent to before keeping/paying.
    'rebook_rules', (SELECT cy.settings->>'rebook_rules' FROM public.cycles cy WHERE cy.id = s.cyclus_id)
  )
  INTO result
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  LEFT JOIN public.profiles p ON p.id = c.player_id
  LEFT JOIN public.guest_players gp ON gp.id = c.guest_player_id
  LEFT JOIN public.profiles bp ON bp.id = c.booked_by_player_id
  LEFT JOIN public.guest_players bgp ON bgp.id = c.booked_by_guest_player_id
  WHERE c.claim_token = _token
  LIMIT 1;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_priority_claim_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_priority_claim_by_token(text) TO anon, authenticated;
