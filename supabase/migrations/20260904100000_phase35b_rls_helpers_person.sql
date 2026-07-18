-- Phase 3.5b: person-key the profile-visibility RLS HELPERS.
--
-- PROBLEM (scout-confirmed, live prod):
--   (1) is_player_of_academy — gates the profiles UPDATE policy "Academy managers
--       can update booked player profiles". Its guest arm keyed ONLY on
--       guest_players.linked_profile_id (the bare-email link, doctrine: NEVER
--       identity truth). An EMAIL-MERGED person (person_links pair, no
--       linked_profile_id stamp) was missed → the academy manager was LOCKED OUT
--       of updating that player's profile. Also its booking arm accepted
--       dual-keyed seats (FAM-02: those belong to the GUEST person).
--   (2) is_player_of_trainer — gates the profiles SELECT policy "Trainers can view
--       booked player profiles" + profiles_public arm (4). Missing the FAM-02
--       pure-profile guard AND the canonical inactive-booking filter its guest
--       counterpart (guest_booked_with_trainer, 20260713110000) always had:
--       cancelled/swapped seats granted profile visibility.
--
-- FIX:
--   is_player_of_academy gains the 3.3c-pattern arms:
--     * booking arm: + FAM-02 pure-profile guard + the canonical inactive filter;
--     * bridge arm: upgraded from bare linked_profile_id to the Phase-0c
--       TWIN-PRECEDENCE bridge (twin_of_profile_id outranks; linked only when no
--       twin stamp) — kept until the P-B review queue drains (Phase 4);
--     * NEW person arm: a guest in academy scope whose person_links person equals
--       the profile's person — catches merges with no twin/link stamp;
--     * split-freeze on BOTH guest arms (a pending twin-split/email-move review
--       means the guest may be a DIFFERENT human → grants nothing).
--   is_player_of_trainer: + pure-profile guard + canonical inactive filter
--   (byte-aligned with guest_booked_with_trainer's predicate).
--
-- DORMANCY NOTE (discovered while testing this): the manager UPDATE policy that
--   is_player_of_academy gates has NO live caller (no client flow updates player
--   profiles as a manager) AND prod has no manager SELECT policy on player rows —
--   so a direct UPDATE would silently 0-row regardless (Postgres needs SELECT
--   visibility for the WHERE). This fix makes the helper CORRECT for when such a
--   surface ships; enabling it then also requires a matching SELECT policy — a
--   deliberate GDPR decision to take at feature time, not here.
--
-- DELIBERATE NON-CHANGES (documented, not omissions):
--   * profiles_public arm (6b) keeps its linked-only guest bridge: the view is a
--     9-arm GDPR-critical re-emit, no live surface depends on it for merged
--     persons (they use the person-keyed DEFINER RPCs), and re-emitting carries
--     the verbatim-re-emit risk. It is profile-seat/link-keyed until Phase 4.
--   * The cancelled-seat NARROWING of is_player_of_trainer is intentional: the
--     guest side always excluded inactive seats; the asymmetry was the bug.
--
-- Both helpers keep their signatures (CREATE OR REPLACE, no types drift; both are
-- policy-internal DEFINER helpers, not client rpc surface).

CREATE OR REPLACE FUNCTION public.is_player_of_trainer(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    JOIN trainer_profiles tp ON tp.id = s.trainer_id
    WHERE b.player_id = p_player_id
      -- FAM-02: a dual-keyed seat belongs to the GUEST person; profile visibility
      -- from such a seat flows through the guest policies, not this helper.
      AND b.guest_player_id IS NULL
      AND tp.user_id = auth.uid()
      -- Canonical inactive-booking predicate (matches guest_booked_with_trainer).
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
  );
$$;

COMMENT ON FUNCTION public.is_player_of_trainer(uuid) IS
  'Phase 3.5b: trainer→player profile visibility. Pure-profile seats only (FAM-02) + the canonical inactive-booking filter (aligned with guest_booked_with_trainer). Policy-internal DEFINER helper.';

CREATE OR REPLACE FUNCTION public.is_player_of_academy(p_player_id uuid, p_academy_profile_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  -- (1) pure-profile booking at one of the academy's active trainers.
  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    JOIN academy_trainers at ON at.trainer_profile_id = s.trainer_id
    WHERE b.player_id = p_player_id
      AND b.guest_player_id IS NULL  -- FAM-02
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      AND at.status = 'active'
      AND at.academy_profile_id = p_academy_profile_id
  )
  -- (2) a guest in academy scope tied to this profile: twin-precedence bridge OR
  --     person arm. Split-frozen guests grant nothing (identity uncertain).
  OR EXISTS (
    SELECT 1
    FROM guest_players gp
    WHERE (
        -- Phase-0c twin-precedence bridge (retire at Phase 4 after P-B drains):
        gp.twin_of_profile_id = p_player_id
        OR (gp.twin_of_profile_id IS NULL AND gp.linked_profile_id = p_player_id)
        -- Person arm (3.3c pattern): the guest's person == the profile's person.
        OR EXISTS (
          SELECT 1
          FROM person_links plg
          JOIN person_links plp ON plp.person_id = plg.person_id
          WHERE plg.guest_player_id = gp.id
            AND plp.profile_id = p_player_id
        )
      )
      AND NOT public.is_guest_split_frozen(gp.id)
      AND (
        gp.academy_profile_id = p_academy_profile_id
        OR gp.trainer_id IN (
          SELECT at.trainer_profile_id
          FROM academy_trainers at
          WHERE at.status = 'active'
            AND at.academy_profile_id = p_academy_profile_id
        )
      )
  );
$$;

COMMENT ON FUNCTION public.is_player_of_academy(uuid, uuid) IS
  'Phase 3.5b: academy-manager→player profile visibility/update gate. Pure-profile booking arm (FAM-02 + inactive filter) + guest arm with twin-precedence bridge AND person_links person arm, both split-freeze-gated. Fixes the email-merged-person manager lockout (guest arm was linked_profile_id-only). Policy-internal DEFINER helper.';
