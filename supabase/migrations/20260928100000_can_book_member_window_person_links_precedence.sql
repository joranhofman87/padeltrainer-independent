-- ============================================================================
-- can_book_member_window: curated person_links SUPPRESSES the twin/linked bridge
-- ============================================================================
-- Phase 3.3c (20260830100000) authorized a guest's booking eligibility as
--   person_links(me) OR twin_of_profile_id=me OR (twin IS NULL AND linked_profile_id=me)
-- — a UNION, so if person_links resolves the guest to account A but a STALE twin/link points to a
-- DIFFERENT account B, BOTH A and B could book. The notification identity resolver
-- (guest_verified_account_profile, PR 10d) gives curated person_links PRECEDENCE and delivers to A;
-- this aligns authorization with it: when a curated person_links account exists for the guest, the
-- twin/linked BRIDGE arms are suppressed (a stale twin/link cannot grant a different account access).
--
-- Owner-approved as the intended security correction. Pre-deploy read-only audit: 0 guests in prod
-- have a person_links account conflicting with twin/linked (0 with active claims, 0 on priority
-- lists) — so this loses NO current booking access; it hardens against a future stale bridge.
--
-- FAM-02 (Codex round-4 #2): this migration ALSO makes clauses (a) and (b) guest-safe — Codex
-- reproduced that both still keyed the RAW player_id, granting the PARENT of a dual-key row. Clause
-- (a) now matches a pure-profile booking (guest_player_id IS NULL AND player_id = me) or a guest
-- booking only via the guest's VERIFIED account; clause (b) is guarded with guest_player_id IS NULL
-- (a dual-key claim belongs to the guest, handled guest-safely by (d)). Split-freeze, the person arm,
-- and clause (c) are unchanged. Signature unchanged → no types drift.
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
    -- (a) existing rebooker — a booking in this cycle owned by ME as a PERSON (FAM-02). A pure-profile
    --     booking (guest_player_id IS NULL) matches player_id = me; a GUEST booking matches only when
    --     the guest's VERIFIED account (person_links → twin → linked, split-freeze) is me. The raw
    --     player_id on a dual-key booking is NOT identity proof (the shared is_cycle_member primitive —
    --     which matches raw player_id and is used by capacity/tier — is redefined + locked down in the
    --     dedicated auth-hardening PR; here we inline the guest-safe check for the member window only).
    EXISTS (
      SELECT 1
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.cyclus_id = _cycle_id
        AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
        AND (
          (b.guest_player_id IS NULL AND b.player_id = (SELECT id FROM me))
          OR (b.guest_player_id IS NOT NULL AND public.guest_verified_account_profile(b.guest_player_id) = (SELECT id FROM me))
        )
    )
    -- (b) original cohort: a PURE-PROFILE priority claim on a slot in this round. A dual-key claim
    --     belongs to the GUEST (guest_player_id set) and is handled guest-safely by (d) — so guard it
    --     here with guest_player_id IS NULL, else the raw parent player_id would grant the parent.
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      WHERE s.source_cycle_id = _cycle_id
        AND spc.player_id = (SELECT id FROM me)
        AND spc.guest_player_id IS NULL
    )
    -- (c) registered priority list stored on the cycle's settings
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_people', '[]'::jsonb) ? (SELECT id::text FROM me)
    )
    -- (d) a GUEST claim in this round whose guest is the SAME PERSON as me. Curated person_links is
    --     the truth; the twin/linked bridge applies ONLY when the guest has NO person_links account
    --     (so a stale twin/link cannot grant a different account than the curated one).
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
          OR (
            NOT EXISTS (
              SELECT 1 FROM public.person_links plg2
              JOIN public.person_links plp2 ON plp2.person_id = plg2.person_id
              WHERE plg2.guest_player_id = gp.id AND plp2.profile_id IS NOT NULL
            )
            AND (
              gp.twin_of_profile_id = (SELECT id FROM me)
              OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = (SELECT id FROM me))
            )
          )
        )
    )
    -- (e) an accountless GUEST on this round's priority list, same PERSON as me. Same precedence:
    --     person_links suppresses the twin/linked bridge.
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
          OR (
            NOT EXISTS (
              SELECT 1 FROM public.person_links plg2
              JOIN public.person_links plp2 ON plp2.person_id = plg2.person_id
              WHERE plg2.guest_player_id = gp.id AND plp2.profile_id IS NOT NULL
            )
            AND (
              gp.twin_of_profile_id = (SELECT id FROM me)
              OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = (SELECT id FROM me))
            )
          )
        )
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_guests', '[]'::jsonb) ? gp.id::text
    );
$$;

REVOKE EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_book_member_window(uuid, uuid) TO service_role;
