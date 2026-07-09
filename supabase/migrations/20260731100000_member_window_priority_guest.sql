-- ============================================================================
-- REBOOK · Member-window access for an accountless GUEST on the PRIORITY LIST
-- ============================================================================
-- The academy can now add accountless GUEST players (guest_players, no login) to a round's
-- priority list — stored on the cycle as settings.rebook_priority_guests (an array of
-- guest_players.id). They receive the same "sessions have opened" email as guest cohort members
-- (a pre-filled "create account & book" CTA). link_guest_data_to_profile (20260530190000) links
-- their guest row to the new profile by email at signup.
--
-- This adds clause (e): grant the member window when the caller's profile is the linked_profile_id
-- of a guest whose guest_players.id is on this cycle's rebook_priority_guests. Mirrors clause (d)
-- (a linked ex-guest with a CLAIM) but keys on the priority-guest list instead of a claim, since a
-- priority-list guest is NOT part of the cohort and has no claim in the round.
--
-- Trust model is unchanged: linked_profile_id is only set on an email match (the guest proved inbox
-- ownership by signing up with that email) or an explicit staff link — the same basis clause (d),
-- link_guest_data_to_profile, and the invoice/booking re-key already use.
--
-- CREATE OR REPLACE preserves the existing grants (anon, authenticated) and flows to the trigger +
-- book_slot_for_payment via can_book_slot, so no trigger change is needed.
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
    -- (d) a GUEST claim in this round whose guest is now linked to the caller's profile
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      JOIN public.guest_players gp ON gp.id = spc.guest_player_id
      WHERE s.source_cycle_id = _cycle_id
        AND gp.linked_profile_id = (SELECT id FROM me)
    )
    -- (e) NEW: an accountless GUEST on this round's priority list, now linked to the caller's
    --     profile (an ex-guest who completed their account by email).
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      JOIN public.guest_players gp ON gp.linked_profile_id = (SELECT id FROM me)
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_guests', '[]'::jsonb) ? gp.id::text
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'Second-bucket (member window) booking eligibility: existing rebooker OR original cohort (registered claim) OR registered priority list OR a linked ex-guest cohort member (guest claim in the round) OR a linked ex-guest on the priority-guest list (settings.rebook_priority_guests). Pure authorization gate — never affects capacity.';

-- ----------------------------------------------------------------------------
-- Service-role-callable validation of a rebook priority list.
-- ----------------------------------------------------------------------------
-- bulk-rebook-cycle (a service-role edge fn) previously validated the priority list with
-- get_players_overview — but that function is SECURITY DEFINER gated on is_academy_manager(auth.uid())
-- and granted to `authenticated` only, so the service-role call ALWAYS failed (permission denied /
-- not authorized) and the code silently dropped EVERY priority person (registered AND guest). This
-- purpose-built function keeps only ids that genuinely belong to _academy_profile_id, callable by
-- service_role (no auth.uid() gate — the edge fn has already authorized that its user manages the
-- academy via the academy_managers gate). Membership mirrors the UI's players-overview sources:
--   registered → an academy_player_metadata / academy_player_locations row, OR a booking on one of
--                the academy's slots; guest → guest_players owned by the academy.
CREATE OR REPLACE FUNCTION public.filter_academy_priority_ids(
  _academy_profile_id uuid,
  _profile_ids uuid[],
  _guest_ids uuid[]
)
RETURNS TABLE (profile_id uuid, guest_player_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p AS profile_id, NULL::uuid AS guest_player_id
  FROM unnest(COALESCE(_profile_ids, ARRAY[]::uuid[])) AS p
  WHERE EXISTS (SELECT 1 FROM public.academy_player_metadata m WHERE m.academy_profile_id = _academy_profile_id AND m.profile_id = p)
     OR EXISTS (SELECT 1 FROM public.academy_player_locations l WHERE l.academy_profile_id = _academy_profile_id AND l.profile_id = p)
     OR EXISTS (
          SELECT 1 FROM public.bookings b
          JOIN public.availability_slots s ON s.id = b.slot_id
          WHERE s.academy_profile_id = _academy_profile_id AND b.player_id = p
        )
  UNION ALL
  SELECT NULL::uuid AS profile_id, g AS guest_player_id
  FROM unnest(COALESCE(_guest_ids, ARRAY[]::uuid[])) AS g
  WHERE EXISTS (SELECT 1 FROM public.guest_players gp WHERE gp.academy_profile_id = _academy_profile_id AND gp.id = g);
$$;

-- service_role only: the sole caller is the bulk-rebook-cycle edge fn (which has already authorized
-- the manager). Not granted to authenticated/anon — it takes an academy id with no auth.uid() gate,
-- so a broader grant would let any caller probe academy membership.
REVOKE ALL ON FUNCTION public.filter_academy_priority_ids(uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.filter_academy_priority_ids(uuid, uuid[], uuid[]) TO service_role;
