-- Phase 0c hardening (external audit, findings H2/H3/M4): the EXPLICIT twin bridge.
--
-- The registered-player twin flow (person-unification Phase 0) resolved twins by email+name
-- heuristics only. That left three holes:
--   H2: select-then-insert with NO DB backstop (the guest email unique indexes were deliberately
--       dropped in 20260611220000 — families share addresses) → two concurrent adds of the same
--       registered player could mint TWO twins → duplicate seats + double invoices.
--   H3: with several same-email SAME-NAME rows, the client picked the first — a guess.
--   M4: a shared-email family's twin never gets linked_profile_id (the link trigger requires a
--       SINGLE unlinked email match), so the registered player couldn't see those bookings in
--       their own app.
--
-- Fix: guest_players.twin_of_profile_id — an EXPLICIT, manager-initiated person assertion,
-- deliberately SEPARATE from linked_profile_id (which is an email-INFERRED trigger link with no
-- name guard and must never drive identity decisions — see docs/PERSON_UNIFICATION_PLAN.md).
--   * repeat adds resolve by profile id — deterministic, no name heuristics, works emailless;
--   * a partial UNIQUE index turns twin-mint races into a 23505 the client recovers from;
--   * claims are compare-and-set inside a SECURITY DEFINER RPC — a single atomic CAS (a client-side
--     read-then-update under RLS could not distinguish "already claimed" from a lost race), scoped
--     no wider than the pre-existing manager/trainer RLS UPDATE surface;
--   * the player-visibility readers accept the twin link, closing M4 (this migration covers the
--     booking/invoice readers; 20260826230000 extends the rebook-claims + member-window readers);
--   * a rename of a stamped row DETACHES the stamp (trigger below) so a row repurposed to a
--     different human can never keep asserting it is the original person.
-- Phase 2 (persons backfill) consumes twin_of_profile_id as ground truth ONLY where the guest's
-- email matches the profile's (defense against a malicious/mistaken manager stamp — managers can
-- row-level UPDATE their own guests, same as the pre-existing linked_profile_id surface).

ALTER TABLE public.guest_players
  ADD COLUMN IF NOT EXISTS twin_of_profile_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- One twin per (academy, profile): a concurrent double-mint hits 23505 and the loser re-reads the
-- winner. Trainer-owned rows (academy_profile_id NULL) sit outside the index — a claimed
-- trainer-owned row plus a later academy-owned mint is a benign, Phase-2-mergeable duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_guest_twin_per_academy
  ON public.guest_players (academy_profile_id, twin_of_profile_id)
  WHERE academy_profile_id IS NOT NULL AND twin_of_profile_id IS NOT NULL;

-- Supports the twin lookup and the player-visibility subqueries.
CREATE INDEX IF NOT EXISTS idx_guest_players_twin_of_profile
  ON public.guest_players (twin_of_profile_id)
  WHERE twin_of_profile_id IS NOT NULL;

-- Deterministic twin lookup within the academy's dedup scope (own rows + active trainers' rows —
-- the same visibility as find_guest_players_by_email_for_academy, trainer set derived, never
-- caller-supplied). Scalar return: the twin's guest_players.id, or NULL.
CREATE OR REPLACE FUNCTION public.find_guest_twin_for_academy(
  _academy_profile_id uuid,
  _profile_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT gp.id
  FROM public.guest_players gp
  WHERE _profile_id IS NOT NULL
    AND gp.twin_of_profile_id = _profile_id
    AND _academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    AND (
      gp.academy_profile_id = _academy_profile_id
      OR gp.trainer_id IN (
        SELECT at.trainer_profile_id
        FROM public.academy_trainers at
        WHERE at.academy_profile_id = _academy_profile_id
          AND at.status = 'active'
      )
    )
  ORDER BY gp.created_at
  LIMIT 1
$$;

-- Compare-and-set claim of an existing guest row as _profile_id's twin. Returns the row's
-- EFFECTIVE twin owner after the attempt:
--   _profile_id      → claimed by us now, or already ours;
--   another uuid     → the row is someone ELSE's twin — caller must NOT reuse it;
--   NULL             → row not visible in this academy's scope, or claiming it would violate
--                      uniq_guest_twin_per_academy (this profile's twin already exists elsewhere) —
--                      caller re-runs find_guest_twin_for_academy and converges.
CREATE OR REPLACE FUNCTION public.claim_guest_twin_for_academy(
  _academy_profile_id uuid,
  _guest_player_id uuid,
  _profile_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_twin uuid;
BEGIN
  IF _academy_profile_id IS NULL OR _guest_player_id IS NULL OR _profile_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF _academy_profile_id NOT IN (SELECT public.get_user_academy_ids(auth.uid())) THEN
    RETURN NULL;
  END IF;

  BEGIN
    UPDATE public.guest_players gp
    SET twin_of_profile_id = _profile_id
    WHERE gp.id = _guest_player_id
      AND gp.twin_of_profile_id IS NULL
      AND (
        gp.academy_profile_id = _academy_profile_id
        OR gp.trainer_id IN (
          SELECT at.trainer_profile_id
          FROM public.academy_trainers at
          WHERE at.academy_profile_id = _academy_profile_id
            AND at.status = 'active'
        )
      )
    RETURNING gp.twin_of_profile_id INTO v_twin;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL;
  END;

  IF v_twin IS NULL THEN
    -- CAS did not fire: already claimed (report the current owner) or not visible (stays NULL).
    SELECT gp.twin_of_profile_id INTO v_twin
    FROM public.guest_players gp
    WHERE gp.id = _guest_player_id
      AND (
        gp.academy_profile_id = _academy_profile_id
        OR gp.trainer_id IN (
          SELECT at.trainer_profile_id
          FROM public.academy_trainers at
          WHERE at.academy_profile_id = _academy_profile_id
            AND at.status = 'active'
        )
      );
  END IF;
  RETURN v_twin;
END;
$$;

REVOKE ALL ON FUNCTION public.find_guest_twin_for_academy(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.find_guest_twin_for_academy(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid, uuid) TO authenticated;

-- A twin stamp asserts "this guest row IS that registered person". The guest-edit surfaces write
-- name fields only, so a manager REPURPOSING a stamped row to a different human (rename) would
-- otherwise leave the stamp silently redirecting every future add of the original person onto the
-- other human's row — the wrong-person failure this bridge exists to prevent (and one the Phase-2
-- email trust rule cannot catch, since a rename keeps the email). Clear the stamp whenever a name
-- field changes without the stamp being rewritten in the same statement. Self-healing either way:
-- a same-person typo fix re-claims the row on the next add via the email+exact-name path (same
-- stamp, same row); a repurpose correctly detaches the twin (the next add mints a fresh row).
CREATE OR REPLACE FUNCTION public.clear_guest_twin_on_rename()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.twin_of_profile_id IS NOT NULL
     AND NEW.twin_of_profile_id IS NOT DISTINCT FROM OLD.twin_of_profile_id
     AND (NEW.full_name IS DISTINCT FROM OLD.full_name
          OR NEW.first_name IS DISTINCT FROM OLD.first_name
          OR NEW.last_name IS DISTINCT FROM OLD.last_name) THEN
    NEW.twin_of_profile_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_clear_guest_twin_on_rename ON public.guest_players;
CREATE TRIGGER trg_clear_guest_twin_on_rename
  BEFORE UPDATE ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.clear_guest_twin_on_rename();

-- M4: the player-visibility readers (20260703130000) matched linked-guest rows on
-- linked_profile_id ONLY, so a shared-email family member's twin (which the link trigger leaves
-- unlinked) was invisible in the player's own app — undercutting the point of seating them.
-- twin_of_profile_id is a manager-made person assertion (STRONGER than the email-inferred link),
-- so both readers now accept either link. Bodies otherwise byte-identical to 20260703130000.
CREATE OR REPLACE FUNCTION public.get_my_linked_guest_bookings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_result jsonb;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN '[]'::jsonb;  -- not a known player → no rows
  END IF;

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
  WHERE b.player_id IS NULL
    AND b.guest_player_id IN (
      SELECT gp.id FROM public.guest_players gp
      WHERE gp.linked_profile_id = v_profile OR gp.twin_of_profile_id = v_profile
    );

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_paid_booking_ids()
RETURNS TABLE (booking_id uuid)
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
  SELECT DISTINCT bid
  FROM public.invoices i
  CROSS JOIN LATERAL unnest(coalesce(i.booking_ids, '{}'::uuid[])) AS bid
  WHERE i.status = 'paid'
    AND (
      i.player_id = v_profile
      OR i.guest_player_id IN (
        SELECT gp.id FROM public.guest_players gp
        WHERE gp.linked_profile_id = v_profile OR gp.twin_of_profile_id = v_profile
      )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_linked_guest_bookings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_linked_guest_bookings() TO authenticated;
REVOKE ALL ON FUNCTION public.get_my_paid_booking_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_paid_booking_ids() TO authenticated;
