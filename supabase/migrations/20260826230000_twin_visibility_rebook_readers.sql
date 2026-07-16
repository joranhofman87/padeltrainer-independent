-- Phase 0c hardening follow-through (verification finding): the M4 fix (20260826210000) extended
-- only 2 of the 4 player-side readers keyed on linked_profile_id. The other two still matched the
-- inferred link ONLY, so exactly the population the twin bridge creates — shared-email family
-- members, whose twin the link trigger never auto-links — could SEE their twin bookings in-app but
-- got no rebook invite on the dashboard and was DENIED member-window self-booking:
--   * get_my_pending_priority_claims (20260703120000) — the dashboard "you can rebook" card;
--   * can_book_member_window clauses (d)/(e) (20260731100000) — the member-window auth gate.
-- Extend both with the same `OR gp.twin_of_profile_id = <me>` the booking/invoice readers gained.
-- twin_of_profile_id is a manager-made person assertion (STRONGER than the email-inferred link);
-- the write surface is no wider than the pre-existing manager/trainer RLS UPDATE scope. Bodies are
-- otherwise byte-identical to their previous definitions.

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
        WHERE gp.linked_profile_id = v_profile OR gp.twin_of_profile_id = v_profile
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_pending_priority_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_pending_priority_claims() TO authenticated;

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
    -- (d) a GUEST claim in this round whose guest is now linked OR twinned to the caller's profile
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      JOIN public.guest_players gp ON gp.id = spc.guest_player_id
      WHERE s.source_cycle_id = _cycle_id
        AND (gp.linked_profile_id = (SELECT id FROM me) OR gp.twin_of_profile_id = (SELECT id FROM me))
    )
    -- (e) an accountless GUEST on this round's priority list, now linked OR twinned to the
    --     caller's profile (an ex-guest who completed their account by email, or a family twin).
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      JOIN public.guest_players gp
        ON (gp.linked_profile_id = (SELECT id FROM me) OR gp.twin_of_profile_id = (SELECT id FROM me))
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_guests', '[]'::jsonb) ? gp.id::text
    );
$$;

GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'Second-bucket (member window) booking eligibility: existing rebooker OR original cohort (registered claim) OR registered priority list OR a linked/twinned ex-guest cohort member (guest claim in the round) OR a linked/twinned guest on the priority-guest list (settings.rebook_priority_guests). Pure authorization gate — never affects capacity.';
