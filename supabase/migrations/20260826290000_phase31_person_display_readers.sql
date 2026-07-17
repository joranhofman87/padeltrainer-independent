-- ============================================================================
-- Person unification — PHASE 3.1: roster/display readers keyed on person_id
-- ============================================================================
-- First reader cluster (plan §5 Phase 3 step 1). Display-only: one human shows ONCE regardless of
-- which old key their rows carry. Old columns stay dual-written; every person arm keeps the
-- pre-existing old-key arm as a fallback/bridge, so this is fully revertible and NULL-stamp rows
-- (none exist today — Phase 2 verified zero — but belt) are never dropped.
--
--   1. get_my_person_id() — THE "who am I in the new world" choke point (SECURITY DEFINER over
--      the RLS-locked person_links; auth.uid()-bound; no arbitrary-user argument).
--   2. get_cycle_roster_names gains a PERSON-keyed arm (names for bookings.person_id ids) so the
--      cycle-detail roster can resolve merged people by their person id. Old arms + the
--      authorization block + grants are byte-identical.
--   3. The three player-side DISPLAY readers go person-first: `person_id = get_my_person_id()`
--      catches everything the identity map knows (including merges with no twin/linked stamp —
--      invisible today), while the Phase-0c twin-precedence guest bridge is kept VERBATIM for the
--      linked-but-unmerged guests still pending owner review (P-B).
--   NOT here: can_book_member_window (an authorization gate on the booking path — cluster 3.3),
--   get_players_overview / cyclus-groups list keys (cluster 3.2), any write-path predicate.

-- ---------------------------------------------------------------------------
-- 1) get_my_person_id
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_person_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT pl.person_id
  FROM public.person_links pl
  JOIN public.profiles p ON p.id = pl.profile_id
  WHERE p.user_id = auth.uid()
$$;

REVOKE ALL ON FUNCTION public.get_my_person_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_person_id() TO authenticated;

-- ---------------------------------------------------------------------------
-- 2) get_cycle_roster_names — person-keyed arm added (old arms + auth block verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_cycle_roster_names(_cycle_id uuid)
RETURNS TABLE (id uuid, full_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owner_type text;
  v_owner_id uuid;
BEGIN
  SELECT c.owner_type, c.owner_id INTO v_owner_type, v_owner_id
  FROM public.cycles c WHERE c.id = _cycle_id;

  -- Authorize: mirror who can already read this cycle's bookings (bookings/slots RLS) + admin.
  IF NOT (
    public.is_admin(auth.uid())
    OR (v_owner_type = 'club' AND v_owner_id IN (SELECT public.get_user_club_ids(auth.uid())))
    OR EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.cyclus_id = _cycle_id AND (
        (s.academy_profile_id IS NOT NULL
          AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
        OR s.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      )
    )
  ) THEN
    RAISE EXCEPTION 'not_authorized_for_cycle' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  -- One row per id with an EXPLICIT winner (verification finding: an account holder's profile id
  -- and person id coincide, and the UNION's row order is unspecified — the client's last-write
  -- lookup would flip names whenever persons/profiles names momentarily drift). The person arm
  -- (rank 1) outranks the old arms.
  SELECT DISTINCT ON (u.id) u.id, u.full_name
  FROM (
    -- Phase 3.1: PERSONS, keyed by person id — the merged-human name (profile-wins via rederive).
    -- Deterministic ids do NOT make the arms below sufficient: a merged guest's person id is the
    -- PROFILE's id, which the profile arm only emits when the person has a player_id booking.
    SELECT per.id, per.full_name, 1 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.persons per ON per.id = b.person_id
    WHERE s.cyclus_id = _cycle_id AND b.person_id IS NOT NULL AND per.full_name IS NOT NULL
    UNION
    -- Registered players, keyed by profile id (the ids RLS blocks the manager from naming client-side).
    SELECT p.id, p.full_name, 2 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.profiles p ON p.id = b.player_id
    WHERE s.cyclus_id = _cycle_id AND b.player_id IS NOT NULL AND p.full_name IS NOT NULL
    UNION
    -- Guests, keyed by guest id.
    SELECT g.id, g.full_name, 2 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.guest_players g ON g.id = b.guest_player_id
    WHERE s.cyclus_id = _cycle_id AND b.guest_player_id IS NOT NULL AND g.full_name IS NOT NULL
  ) u
  ORDER BY u.id, u.rank;
END;
$$;

REVOKE ALL ON FUNCTION public.get_cycle_roster_names(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cycle_roster_names(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3a) get_my_linked_guest_bookings — person-first + the twin-precedence bridge (verbatim)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_linked_guest_bookings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_person uuid;
  v_result jsonb;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN '[]'::jsonb;  -- not a known player → no rows
  END IF;
  v_person := public.get_my_person_id();

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', b.id,
      'slot_id', b.slot_id,
      'status', b.status,
      'payment_status', b.payment_status,
      'paid_externally', b.paid_externally,
      'notes', b.notes,
      'created_at', b.created_at,
      'availability_slots', CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object(
        'start_time', s.start_time,
        'end_time', s.end_time,
        'trainer_id', s.trainer_id,
        'max_participants', s.max_participants,
        'price_per_session', s.price_per_session,
        'cyclus_name', s.cyclus_name,
        'location_id', s.location_id,
        'locations', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('name', l.name) END
      ) END
    )
  ), '[]'::jsonb)
  INTO v_result
  FROM public.bookings b
  LEFT JOIN public.availability_slots s ON s.id = b.slot_id
  LEFT JOIN public.locations l ON l.id = s.location_id
  WHERE b.guest_player_id IS NOT NULL
    -- ^ the dedup partition vs the client's direct player_id read (re-audit round 3): the direct
    -- path and the player RLS policies are now PURE-PROFILE (player_id = me AND guest IS NULL —
    -- FAM-02: a dual-keyed row belongs to the GUEST person), so every guest-carrying row of mine,
    -- including historical BOTH-KEYED rows, reaches me only through this frozen reader.
    -- split-pending freeze OUTSIDE the arms (external re-audit round 2): a repurposed guest's
    -- rows may describe a DIFFERENT human until the owner resolves the split — they must not
    -- reach the profile holder via ANY arm. The linked-profile bridge below is exactly how the
    -- merged_guest_email_moved shape (no twin, link still set) would otherwise leak through.
    AND NOT EXISTS (SELECT 1 FROM public.person_merge_review r
                    WHERE r.guest_player_id = b.guest_player_id AND r.status = 'pending'
                      AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved'))
    AND (
      -- Phase 3.1: the identity map is the primary key — covers every merge, including the ones
      -- with no twin/linked stamp at all (invisible to the bridge below).
      (v_person IS NOT NULL AND b.person_id = v_person)
      -- Phase 0c twin-precedence bridge (verbatim): linked-but-unmerged guests pending P-B review.
      OR b.guest_player_id IN (
        SELECT gp.id FROM public.guest_players gp
        WHERE gp.twin_of_profile_id = v_profile
           OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = v_profile)
      )
    );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_linked_guest_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_linked_guest_bookings() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3b) get_my_paid_booking_ids — person-first + bridge (verbatim); the player_id arm stays
--     (prod has both-keyed invoices whose person derives guest-side — the profile arm is not
--     redundant with the person arm)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_paid_booking_ids()
RETURNS TABLE (booking_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_person uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;  -- not a known player → no rows
  END IF;
  v_person := public.get_my_person_id();

  RETURN QUERY
  SELECT DISTINCT bid
  FROM public.invoices i
  CROSS JOIN LATERAL unnest(coalesce(i.booking_ids, '{}'::uuid[])) AS bid
  WHERE i.status = 'paid'
    -- split-pending freeze OUTSIDE the arms (see get_my_linked_guest_bookings). Applies to the
    -- player arm too: a both-keyed invoice's player_id was added by the email linker (inference),
    -- so while its guest is split-pending the whole row is withheld.
    AND (i.guest_player_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.person_merge_review r
      WHERE r.guest_player_id = i.guest_player_id AND r.status = 'pending'
        AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')))
    AND (
      i.player_id = v_profile
      OR (v_person IS NOT NULL AND i.person_id = v_person)
      OR i.guest_player_id IN (
        SELECT gp.id FROM public.guest_players gp
        WHERE gp.twin_of_profile_id = v_profile
           OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = v_profile)
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_paid_booking_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_paid_booking_ids() TO authenticated;

-- ---------------------------------------------------------------------------
-- 3c) get_my_pending_priority_claims — person-first + bridge (verbatim)
-- ---------------------------------------------------------------------------
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
  v_person uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;  -- not a known player → no rows
  END IF;
  v_person := public.get_my_person_id();

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
    -- split-pending freeze OUTSIDE the arms (see get_my_linked_guest_bookings)
    AND (c.guest_player_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.person_merge_review r
      WHERE r.guest_player_id = c.guest_player_id AND r.status = 'pending'
        AND r.kind IN ('twin_detached_needs_split', 'merged_guest_email_moved')))
    AND (
      c.player_id = v_profile
      OR (v_person IS NOT NULL AND c.person_id = v_person)
      OR c.guest_player_id IN (
        SELECT gp.id
        FROM public.guest_players gp
        WHERE gp.twin_of_profile_id = v_profile
           OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = v_profile)
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_pending_priority_claims() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_pending_priority_claims() TO authenticated;


-- ---------------------------------------------------------------------------
-- 4) FAM-02 made enforceable on the DIRECT player path (external re-audit round 3): the signup
--    linker created both-keyed bookings (guest seat + inferred player_id), and the player RLS
--    policies accepted `player_id = me` alone — so a split-pending guest's rows bypassed the
--    frozen readers above and showed as normal CANCELLABLE rows in the player app. A dual-keyed
--    row belongs to the GUEST person (personIdentity.ts doctrine): the player policies become
--    pure-profile, and guest-side rows (merged or bridged) flow ONLY through the frozen RPC.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Players can view their own bookings" ON public.bookings;
CREATE POLICY "Players can view their own bookings"
ON public.bookings FOR SELECT
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()) AND guest_player_id IS NULL);

DROP POLICY IF EXISTS "Players can create bookings" ON public.bookings;
CREATE POLICY "Players can create bookings"
ON public.bookings FOR INSERT
TO authenticated
WITH CHECK (player_id = public.get_profile_id_for_user(auth.uid()) AND guest_player_id IS NULL);

DROP POLICY IF EXISTS "Players can update their own bookings" ON public.bookings;
CREATE POLICY "Players can update their own bookings"
ON public.bookings FOR UPDATE
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()) AND guest_player_id IS NULL);

DROP POLICY IF EXISTS "Players can delete their own bookings" ON public.bookings;
CREATE POLICY "Players can delete their own bookings"
ON public.bookings FOR DELETE
TO authenticated
USING (player_id = public.get_profile_id_for_user(auth.uid()) AND guest_player_id IS NULL);
