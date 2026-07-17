-- ============================================================================
-- Phase 3.3b (person-unification): the player DETAIL page reaches the whole PERSON
-- ============================================================================
-- The players list links a merged human to a single old-world ref (g_<guest> —
-- guest-preferred, per Phase 3.2). The detail page then read bookings + invoices
-- under ONLY that ref, so a merged person's self-booked (player_id) sessions and
-- profile-addressed invoices vanished from their own history. This RPC resolves a
-- clicked g_/p_ ref to the person's IN-SCOPE REF SET so the client can union the
-- reads (bookings/invoices under the caller's own slots/scope are already
-- RLS-readable across refs — only the person mapping is RLS-locked, hence this
-- SECURITY DEFINER resolver).
--
--   get_person_refs_for_scope(p_scope, p_scope_id, p_guest_id, p_profile_id)
--     → RETURNS (person_id, guest_ids[], profile_id) — REFS ONLY, no identity/PII.
--
--   Security (the whole RPC is a scope gate; adversarial verify found the first cut
--   leaked cross-tenant PII, so this cut returns nothing but uuids the caller can
--   already relate to their scope):
--     • authorizes the caller exactly like get_players_overview (academy manager /
--       trainer owner);
--     • VALIDATES the clicked ref is IN-SCOPE before resolving (IDOR guard): a
--       clicked guest must be one of the scope's guests; a clicked profile must
--       have an in-scope confirmed/completed booking — i.e. it must be something
--       get_players_overview would actually make clickable in this scope. An
--       out-of-scope ref is rejected (42501), so the function is not an
--       arbitrary-uuid → identity oracle;
--     • returns ONLY guest ids that are in-scope AND non-split-frozen (a frozen
--       sibling is a different human), plus the profile id ONLY when that profile
--       is itself visible to the caller (an in-scope booking OR invoice — the same
--       rows the caller can already read). It never surfaces a ref, or any
--       contact/identity field, the caller could not already see;
--     • split-freeze aware: a frozen clicked guest is its OWN person (returns just
--       itself, no profile), matching every other 3.x reader.
--
--   Identity for the detail header stays sourced by the page as before (unchanged
--   this phase) — this RPC deliberately carries NO name/email/phone/skill so it can
--   never become a cross-tenant identity oracle (persons.* aggregates system-wide;
--   get_players_overview avoids those fields for the same reason).
--
-- Non-goal: rating history stays untouched — player_rating_history has only a
-- self-view RLS policy, so it is dormant on the manager/trainer detail page today
-- regardless of person-keying (a separate concern, not a unification gap).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_person_refs_for_scope(
  p_scope text,          -- 'academy' | 'trainer'
  p_scope_id uuid,
  p_guest_id uuid DEFAULT NULL,   -- the clicked g_<id> (XOR p_profile_id)
  p_profile_id uuid DEFAULT NULL  -- the clicked p_<id>
)
RETURNS TABLE (
  person_id uuid,
  guest_ids uuid[],
  profile_id uuid
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
  SELECT v_person, eg.ids, ep.pid
  FROM eff_guests eg CROSS JOIN eff_profile ep;
END;
$$;

COMMENT ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) IS
  'Resolve a clicked g_/p_ player ref to the person''s IN-SCOPE ref set (guest_ids + profile_id) for the detail page (person-unification Phase 3.3b). REFS ONLY — no identity/PII, so it can never be a cross-tenant identity oracle. SECURITY DEFINER (person_links is RLS-locked); authorized like get_players_overview; the clicked ref is validated in-scope (IDOR guard); guest ids are in-scope + non-frozen; profile_id is returned only when the caller can already see it (in-scope booking/invoice); split-freeze aware.';

REVOKE ALL ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) TO authenticated;
