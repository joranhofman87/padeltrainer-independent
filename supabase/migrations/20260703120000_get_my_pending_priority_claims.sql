-- Rebook go-live (Workstream B, B1): linked-guest VISIBILITY for the dashboard rebook card.
--
-- The player dashboard's "you can rebook" card reads slot_priority_claims keyed ONLY on
-- player_id (getMyPendingPriorityClaims). But when an academy or a group captain rebooks on
-- behalf of a player, the claim is keyed by guest_player_id — so an account-holder whose guest
-- record is LINKED to their profile (guest_players.linked_profile_id) never sees the invite,
-- even though it is theirs. Players cannot SELECT guest-keyed slot_priority_claims under RLS,
-- and must never gain a guest_players SELECT policy (PII), so we expose a narrow SECURITY
-- DEFINER reader scoped strictly to the caller's own identity.
--
-- Scope = player_id = my profile  OR  guest_player_id ∈ { guests linked to my profile }.
-- Keyed on the EXPLICIT linked_profile_id link ONLY — never email — so this never widens
-- visibility beyond what the signup linker (link_guest_data_to_profile, 20260530190000)
-- already decided. Returns claim_token so the account-holder can accept/decline straight from
-- the dashboard via the existing respond_to_priority_claim token RPC. Pending claims only (the
-- card's existing filter); the client still collapses weekly claims per rebook group and
-- resolves each cycle's payment mode. No new write surface, no PII (names/emails not returned).

CREATE OR REPLACE FUNCTION public.get_my_pending_priority_claims()
RETURNS TABLE (
  id uuid,
  claim_token text,
  slot_id uuid,
  rebook_group_id uuid,
  start_time timestamptz,
  end_time timestamptz,
  cyclus_id uuid,
  cyclus_name text,
  price_per_session numeric,
  priority_window_ends_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;  -- not a known player → no rows
  END IF;

  RETURN QUERY
  SELECT
    c.id,
    c.claim_token,
    c.slot_id,
    c.rebook_group_id,
    s.start_time,
    s.end_time,
    s.cyclus_id,
    s.cyclus_name,
    s.price_per_session,
    s.priority_window_ends_at
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  WHERE c.status = 'pending'
    AND (
      c.player_id = v_profile
      OR c.guest_player_id IN (
        SELECT gp.id
        FROM public.guest_players gp
        WHERE gp.linked_profile_id = v_profile
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_pending_priority_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_pending_priority_claims() TO authenticated;
