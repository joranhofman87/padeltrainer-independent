-- ============================================================================
-- Phase 3.3c (person-unification): person-key the BOOKING ELIGIBILITY gate
-- ============================================================================
-- can_book_member_window is the only booking-path function that still infers
-- identity from twin_of_profile_id / linked_profile_id (its guest clauses (d)/(e):
-- "is this priority guest the same human as me?"). Every booking WRITER already
-- keys seats on player_id/guest_player_id and inherits person_id from the Phase-1
-- stamp trigger, so this gate is the whole of the booking-path person-keying.
--
-- Clauses (d)/(e) gain a PERSON ARM — the guest and my profile resolve to the same
-- person via person_links (the curated truth; catches merges that carry no twin
-- stamp) — UNIONed with the existing Phase-0c twin-precedence bridge kept VERBATIM.
-- The bridge stays because linked-but-unmerged guests are still pending in the P-B
-- owner review queue; removing the twin/link reads is Phase 4 (after the queue
-- drains + the columns drop). The union is a strict SUPERSET of today's behavior —
-- no eligibility is lost, person-merged guests gain correct coverage.
--
-- SPLIT-FREEZE added: a guest under an unresolved twin_detached_needs_split /
-- merged_guest_email_moved review may describe a DIFFERENT human, so it must not
-- grant the profile eligibility — excluded from BOTH arms (same rule as every
-- 3.x reader). Everything outside (d)/(e) is re-emitted verbatim from 20260826240000.
--
-- Pure authorization gate — never affects capacity. LOCKED to service_role.
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
    -- (d) a GUEST claim in this round whose guest is the SAME PERSON as me (person_links) — or,
    --     for a linked-but-unmerged guest still pending review, twinned/linked to me (bridge).
    --     A split-frozen guest may be a different human → excluded from both arms.
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      JOIN public.guest_players gp ON gp.id = spc.guest_player_id
      WHERE s.source_cycle_id = _cycle_id
        AND NOT public.is_guest_split_frozen(gp.id)
        AND (
          EXISTS (
            SELECT 1 FROM public.person_links plg
            JOIN public.person_links plp ON plp.person_id = plg.person_id
            WHERE plg.guest_player_id = gp.id AND plp.profile_id = (SELECT id FROM me)
          )
          OR gp.twin_of_profile_id = (SELECT id FROM me)
          OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = (SELECT id FROM me))
        )
    )
    -- (e) an accountless GUEST on this round's priority list, same PERSON as me (person_links) —
    --     or twinned/linked (bridge) for the pending-review window. Split-frozen excluded.
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      JOIN public.guest_players gp
        ON NOT public.is_guest_split_frozen(gp.id)
        AND (
          EXISTS (
            SELECT 1 FROM public.person_links plg
            JOIN public.person_links plp ON plp.person_id = plg.person_id
            WHERE plg.guest_player_id = gp.id AND plp.profile_id = (SELECT id FROM me)
          )
          OR gp.twin_of_profile_id = (SELECT id FROM me)
          OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = (SELECT id FROM me))
        )
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_guests', '[]'::jsonb) ? gp.id::text
    );
$$;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'Second-bucket (member window) booking eligibility (person-unification Phase 3.3c): existing rebooker OR original cohort (registered claim) OR registered priority list OR a same-PERSON ex-guest cohort member (guest claim in the round) OR a same-PERSON guest on the priority-guest list. Guest identity resolves via person_links (curated truth) UNIONed with the Phase-0c twin-precedence bridge for linked-but-unmerged guests still pending owner review (twin_of_profile_id outranks linked_profile_id); a split-frozen guest is excluded from both arms. Pure authorization gate — never affects capacity. LOCKED to service_role; clients use can_current_user_book_member_window.';

-- restore the 20260717100000 grant state (explicit named revoke — Supabase default privileges
-- auto-grant EXECUTE to anon/authenticated on creation).
REVOKE EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO service_role;
