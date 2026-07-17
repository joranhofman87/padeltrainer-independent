-- ============================================================================
-- Phase 3.3d (person-unification): the player DETAIL page type badge tells LOGINS
-- ============================================================================
-- Owner-reported after the 3.3 deploy: opening a MERGED account holder (e.g. Adri
-- Govers) via their guest-side link shows a 'Guest' badge on the contact page,
-- because the badge keys on the clicked seat (parsed.kind = g_/p_), not on whether
-- the PERSON has a login. Same class as the cycle-roster badge fixed in 3.3a. The
-- players-LIST 'type' column is already correct (get_players_overview returns
-- player_type='registered'); this is only the detail page.
--
-- get_person_refs_for_scope gains a person-level has_login boolean (persons.user_id
-- of the resolved person) so the detail page can drive the badge off it. RETURNS
-- changes → DROP + CREATE. Everything else is re-emitted verbatim from 20260829100000
-- (refs-only, IDOR-guarded, split-freeze aware, no PII — has_login is a boolean).
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_person_refs_for_scope(text, uuid, uuid, uuid);

CREATE FUNCTION public.get_person_refs_for_scope(
  p_scope text,          -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_guest_id uuid DEFAULT NULL,   -- the clicked g_<id> (XOR p_profile_id)
  p_profile_id uuid DEFAULT NULL  -- the clicked p_<id>
)
RETURNS TABLE (
  -- REFS ONLY, and only refs the caller can already see. person_id is deliberately NOT returned:
  -- for an account holder persons.id equals the profile id, so echoing it would disclose a gated
  -- profile's uuid even when profile_id is (correctly) withheld — a bare-uuid the client never uses
  -- anyway. The detail page unions on guest_ids + profile_id only.
  guest_ids uuid[],
  profile_id uuid,
  -- person-level: does this HUMAN have a login (persons.user_id)? Drives the detail-page type
  -- badge so a merged account holder clicked via their guest side reads 'Registered', not 'Guest'
  -- (consistent with the get_cycle_roster_names has_login). A boolean, not PII. A split-frozen
  -- clicked guest resolves to its own accountless person → false.
  has_login boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trainer_ids uuid[];
  v_person uuid;
  v_click_frozen boolean := false;
  v_in_scope boolean := false;
BEGIN
  -- ---- authorization: mirror get_players_overview exactly ----
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
    SELECT coalesce(array_agg(at.trainer_profile_id), '{}'::uuid[])
      INTO v_trainer_ids
      FROM public.academy_trainers at
     WHERE at.academy_profile_id = p_scope_id AND at.status = 'active';
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
    v_trainer_ids := ARRAY[p_scope_id];
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  IF (p_guest_id IS NULL) = (p_profile_id IS NULL) THEN
    RAISE EXCEPTION 'exactly one of p_guest_id / p_profile_id is required';
  END IF;

  -- ---- IDOR guard: the clicked ref must itself be in-scope (what the overview makes clickable) ----
  IF p_guest_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.guest_players g
      WHERE g.id = p_guest_id
        AND ((p_scope = 'academy'
                AND (g.academy_profile_id = p_scope_id OR g.trainer_id = ANY (v_trainer_ids)))
          OR (p_scope = 'trainer' AND g.trainer_id = p_scope_id))
    ) INTO v_in_scope;
  ELSE
    SELECT EXISTS (
      SELECT 1 FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE b.player_id = p_profile_id AND b.status IN ('confirmed','completed')
        AND s.trainer_id = ANY (v_trainer_ids)
    ) INTO v_in_scope;
  END IF;
  IF NOT v_in_scope THEN
    RAISE EXCEPTION 'ref not in scope' USING ERRCODE = '42501';
  END IF;

  -- ---- resolve the clicked ref → person (freeze-aware) ----
  IF p_guest_id IS NOT NULL THEN
    v_click_frozen := public.is_guest_split_frozen(p_guest_id);
    IF NOT v_click_frozen THEN
      SELECT pl.person_id INTO v_person
      FROM public.person_links pl WHERE pl.guest_player_id = p_guest_id;
    END IF;
    v_person := coalesce(v_person, p_guest_id); -- frozen / unlinked → its own person
  ELSE
    SELECT pl.person_id INTO v_person
    FROM public.person_links pl WHERE pl.profile_id = p_profile_id;
    v_person := coalesce(v_person, p_profile_id);
  END IF;

  RETURN QUERY
  WITH scoped_guests AS (
    -- the person's guests, restricted to what THIS scope can see, never a split-frozen sibling
    SELECT g.id
    FROM public.person_links pl
    JOIN public.guest_players g ON g.id = pl.guest_player_id
    WHERE pl.person_id = v_person
      AND NOT public.is_guest_split_frozen(g.id)
      AND ((p_scope = 'academy'
              AND (g.academy_profile_id = p_scope_id OR g.trainer_id = ANY (v_trainer_ids)))
        OR (p_scope = 'trainer' AND g.trainer_id = p_scope_id))
  ),
  -- a frozen clicked guest is JUST itself; otherwise the (validated in-scope) clicked guest
  -- UNION the person's other in-scope non-frozen guests.
  eff_guests AS (
    SELECT CASE
      WHEN v_click_frozen THEN ARRAY[p_guest_id]
      ELSE (
        SELECT coalesce(array_agg(DISTINCT id), '{}'::uuid[])
        FROM (
          SELECT p_guest_id AS id WHERE p_guest_id IS NOT NULL
          UNION
          SELECT id FROM scoped_guests
        ) u
      )
    END AS ids
  ),
  -- the profile id, ONLY when the caller can already see it: a clicked profile (validated
  -- in-scope above), or the person's linked profile that has an in-scope booking OR invoice
  -- (the exact rows the caller already reads). Never an out-of-scope profile ref.
  eff_profile AS (
    SELECT CASE
      WHEN v_click_frozen THEN NULL::uuid
      WHEN p_profile_id IS NOT NULL THEN p_profile_id
      ELSE (
        SELECT pl.profile_id
        FROM public.person_links pl
        WHERE pl.person_id = v_person AND pl.profile_id IS NOT NULL
          AND (
            EXISTS (SELECT 1 FROM public.bookings b JOIN public.availability_slots s ON s.id = b.slot_id
                    WHERE b.player_id = pl.profile_id AND b.status IN ('confirmed','completed')
                      AND s.trainer_id = ANY (v_trainer_ids))
            OR EXISTS (SELECT 1 FROM public.invoices i
                    WHERE i.player_id = pl.profile_id
                      AND ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
                        OR (p_scope = 'trainer' AND i.trainer_id = p_scope_id)))
          )
        LIMIT 1
      )
    END AS pid
  )
  SELECT eg.ids, ep.pid,
         coalesce((SELECT pe.user_id IS NOT NULL FROM public.persons pe WHERE pe.id = v_person), false)
  FROM eff_guests eg CROSS JOIN eff_profile ep;
END;
$$;

COMMENT ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) IS
  'Resolve a clicked g_/p_ player ref to the person''s IN-SCOPE ref set (guest_ids + profile_id) + a person-level has_login boolean, for the player detail page (person-unification Phase 3.3b/3.3d). REFS + a boolean only — no identity/PII. SECURITY DEFINER (person_links is RLS-locked); authorized like get_players_overview; the clicked ref is validated in-scope (IDOR guard); guest ids in-scope + non-frozen; profile_id only when the caller can already see it; has_login = the resolved person has an account (a split-frozen clicked guest → its own accountless person → false); split-freeze aware.';

REVOKE ALL ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) TO authenticated;
