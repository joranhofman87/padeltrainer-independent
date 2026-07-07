-- ============================================================================
-- REBOOK · Member-window access for a GUEST who completed their account (R06)
-- ============================================================================
-- A guest (no login) whose seat frees up gets the "sessions have opened" email, but
-- the link dead-ended: can_book_member_window only recognised registered profiles, so
-- even after the guest created an account they couldn't book the member window.
--
-- link_guest_data_to_profile (20260530190000) already links a guest to a new profile by
-- matching email at signup — it sets guest_players.linked_profile_id and re-keys the
-- guest's bookings/invoices. It does NOT re-key slot_priority_claims (they keep
-- guest_player_id), so this adds clause (d): grant the member window when a GUEST claim
-- in the round belongs to a guest now linked to the caller's profile. Mirrors clause (b)
-- (registered cohort) — any claim status counts (the person was in the cohort).
--
-- Trust model is unchanged: linked_profile_id is only set on an email match (the guest
-- proved inbox ownership by signing up with that email) or an explicit staff link — the
-- same basis link_guest_data_to_profile already uses to re-key bookings + invoices.
--
-- CREATE OR REPLACE preserves the existing grants (anon, authenticated — the client
-- filterVisibleSlotIds calls this) and flows to the trigger + book_slot_for_payment via
-- can_book_slot (20260715100000), so no trigger change is needed.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.can_book_member_window(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1)
  SELECT
    -- (a) existing rebooker
    public.is_cycle_member(_user_id, _cycle_id)
    -- (b) original cohort: any priority claim on a slot in this round
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      WHERE s.source_cycle_id = _cycle_id
        AND spc.player_id = (SELECT id FROM me)
    )
    -- (c) registered priority list stored on the cycle's settings
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_people', '[]'::jsonb) ? (SELECT id::text FROM me)
    )
    -- (d) NEW: a GUEST claim in this round whose guest is now linked to the caller's
    --     profile (an ex-guest who completed their account by email).
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      JOIN public.guest_players gp ON gp.id = spc.guest_player_id
      WHERE s.source_cycle_id = _cycle_id
        AND gp.linked_profile_id = (SELECT id FROM me)
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'Second-bucket (member window) booking eligibility: existing rebooker OR original cohort (registered claim in the round) OR registered priority list OR a linked ex-guest (a guest claim in the round whose guest_players.linked_profile_id = caller). Pure authorization gate — never affects capacity.';
