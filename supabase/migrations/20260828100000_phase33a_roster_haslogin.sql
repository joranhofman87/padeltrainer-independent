-- ============================================================================
-- Phase 3.3a (person-unification): the cycle-roster badge tells LOGINS, not seats
-- ============================================================================
-- Owner-reported after 3.2 shipped: a merged human shows as 'registered' on the
-- Players page but still wears the "Guest" badge inside a cycle — the badge keys
-- on "this seat has a guest ref" (old world) instead of "this human has a login"
-- (person world). A merged person's seats are guest-keyed BY DESIGN (FAM-02), so
-- the old condition can never be right for them.
--
-- 1. `get_cycle_roster_names` gains a `has_login` boolean per row, computed at
--    the source each arm actually trusts:
--      person arm  → persons.user_id IS NOT NULL (the program's definition of
--                    "has a login");
--      profile arm → profiles.user_id IS NOT NULL;
--      guest arm   → the guest's person has a profile link, through person_links
--                    ONLY (never linked_profile_id) and suspended while the
--                    guest is split-frozen — a frozen guest reads as its OWN
--                    (accountless) person, mirroring every other 3.x reader.
--    The DISTINCT ON rank keeps the person arm's verdict when ids coincide.
--    Return type changes → DROP + CREATE, grants re-applied.
--
-- 2. Hardening (audit note from 3.2 prod verification): get_academy_cyclus_groups
--    was executable by anon (function default EXECUTE TO PUBLIC; its auth gate
--    rejects anon anyway). Locked to authenticated explicitly.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_cycle_roster_names(uuid);

CREATE FUNCTION public.get_cycle_roster_names(_cycle_id uuid)
RETURNS TABLE (id uuid, full_name text, has_login boolean)
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
  SELECT DISTINCT ON (u.id) u.id, u.full_name, u.has_login
  FROM (
    -- Phase 3.1: PERSONS, keyed by person id — the merged-human name (profile-wins via rederive).
    -- Deterministic ids do NOT make the arms below sufficient: a merged guest's person id is the
    -- PROFILE's id, which the profile arm only emits when the person has a player_id booking.
    SELECT per.id, per.full_name, (per.user_id IS NOT NULL) AS has_login, 1 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.persons per ON per.id = b.person_id
    WHERE s.cyclus_id = _cycle_id AND b.person_id IS NOT NULL AND per.full_name IS NOT NULL
    UNION
    -- Registered players, keyed by profile id (the ids RLS blocks the manager from naming client-side).
    SELECT p.id, p.full_name, (p.user_id IS NOT NULL) AS has_login, 2 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.profiles p ON p.id = b.player_id
    WHERE s.cyclus_id = _cycle_id AND b.player_id IS NOT NULL AND p.full_name IS NOT NULL
    UNION
    -- Guests, keyed by guest id. has_login = the guest's PERSON has a profile side — resolved
    -- through person_links only (doctrine: never linked_profile_id) and suspended while the
    -- guest is split-frozen (a frozen guest reads as its own accountless person).
    SELECT g.id, g.full_name,
           (NOT public.is_guest_split_frozen(g.id) AND EXISTS (
              SELECT 1
              FROM public.person_links plg
              JOIN public.person_links plp
                ON plp.person_id = plg.person_id AND plp.profile_id IS NOT NULL
              WHERE plg.guest_player_id = g.id
           )) AS has_login,
           2 AS rank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.guest_players g ON g.id = b.guest_player_id
    WHERE s.cyclus_id = _cycle_id AND b.guest_player_id IS NOT NULL AND g.full_name IS NOT NULL
  ) u
  ORDER BY u.id, u.rank;
END;
$$;

COMMENT ON FUNCTION public.get_cycle_roster_names(uuid) IS
  'Names + has_login for everyone booked on a cycle (SECURITY DEFINER; authorized to whoever can read the cycle''s bookings). Person arm outranks profile/guest arms per id. has_login = the PERSON has an account (persons.user_id / person_links profile side; guest links suspended while split-frozen) — drives the roster''s Guest badge since Phase 3.3a.';

REVOKE ALL ON FUNCTION public.get_cycle_roster_names(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cycle_roster_names(uuid) TO authenticated;

-- 2) hardening: the groups RPC was PUBLIC-executable by default (auth gate rejects anon anyway)
REVOKE ALL ON FUNCTION public.get_academy_cyclus_groups(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_academy_cyclus_groups(uuid) TO authenticated;
