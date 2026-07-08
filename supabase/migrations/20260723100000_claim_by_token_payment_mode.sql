-- ============================================================================
-- REBOOK · return rebook_payment_mode (+ split_payment) from get_priority_claim_by_token
-- ============================================================================
-- WHY: the logged-out claim page reads the cycle's payment mode via cycles_public
-- (WHERE status='open'). Once a rebook round leaves 'open' (window extended past the
-- close, or the cycle later completed), that read returns nothing and the mode falls
-- back to the 'deferred_split' default — so an UPFRONT cycle can silently confirm a
-- player WITHOUT charging them (the pay-first gate is skipped). The token RPC is anon-
-- granted and SECURITY DEFINER, so it can surface the mode regardless of cycle status.
--
-- This re-emits get_priority_claim_by_token verbatim from 20260704140000 and only ADDS
-- two keys computed from the cycle's settings: rebook_payment_mode (normalized to
-- 'upfront' | 'deferred_split') and split_payment (bool). The frontend prefers these and
-- falls back to the old cycles_public read when absent (pre-deploy), so it is safe to
-- ship the frontend before this migration.
-- ============================================================================

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
    'rebook_rules', (SELECT cy.settings->>'rebook_rules' FROM public.cycles cy WHERE cy.id = s.cyclus_id),
    -- Payment mode, status-independent (drives the pay-first gate for logged-out players even
    -- after the cycle leaves 'open'). Normalized: only explicit 'upfront' is upfront.
    'rebook_payment_mode', (
      SELECT CASE WHEN cy.settings->>'rebook_payment_mode' = 'upfront' THEN 'upfront' ELSE 'deferred_split' END
      FROM public.cycles cy WHERE cy.id = s.cyclus_id
    ),
    -- Whether the cycle splits the court price across players (so the claim card can show
    -- the per-player share instead of the full-court total).
    'split_payment', (
      SELECT COALESCE((cy.settings->>'split_payment')::boolean, false)
      FROM public.cycles cy WHERE cy.id = s.cyclus_id
    )
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
