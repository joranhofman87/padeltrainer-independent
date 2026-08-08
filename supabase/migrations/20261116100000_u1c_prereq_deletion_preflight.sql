-- U1c PREREQUISITE 2 — the account-deletion preflight probe.
--
-- INTERIM SAFEGUARD, NOT THE END STATE. OD-08's eventual design is retain-and-scrub: deletion detaches
-- auth, keeps the stable Player UUID and its memberships, and pseudonymizes. That has to be built,
-- privacy-reviewed and verified before any U1c backfill. Until then this refuses the deletion outright,
-- because refusing is recoverable and a half-completed deletion is not.
--
-- WHY A FUNCTION RATHER THAN A DIRECT READ.
-- `academy_player_memberships` is default-deny: RLS on, zero policies, and every named role — INCLUDING
-- service_role — revoked (U1a). That is deliberate, so the edge function's service-role client cannot
-- read the table through PostgREST at all. Rather than punch a hole in that lockdown for a yes/no
-- question, this SECURITY DEFINER probe answers the question and is granted to service_role alone.
-- It reads; it never writes.
--
-- WHAT IT RESOLVES. Two paths reach a person from one account, and `deleteUserData` destroys sources on
-- both of them:
--   1. the account's own profile → its person_links row;
--   2. every guest owned by the account's trainer profile → their person_links rows. This is the
--      dangerous one: those guests are deleted roughly two-thirds of the way through the sequence,
--      long after ~40 other deletes have already committed.
-- Both are checked here, before anything is touched.
--
-- THE LIMIT OF THIS GUARD — read this before granting anything a write on memberships.
-- A preflight over ~60 independently-committed calls is inherently TOCTOU: a membership created after
-- this probe but before a later delete would still hit the RESTRICT FK, and the deletes that already
-- committed would still be gone. That window is unreachable TODAY only because NOTHING can write a
-- membership — the table is empty and revoked from every application role, service_role included.
-- The moment a writer exists (a backfill, an admin surface, a server command), this guard stops being
-- sufficient on its own and the deletion needs an atomic DB-side veto, a transactional path, or
-- OD-08 retain-and-scrub. `src/test/u1cDeletionPreflight.pglite.test.ts` asserts the no-writer premise
-- so that day fails a test rather than passing silently.

CREATE OR REPLACE FUNCTION public.account_membership_preflight(_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_person_ids uuid[];
  v_count integer;
BEGIN
  IF _user_id IS NULL THEN
    RAISE EXCEPTION 'account_membership_preflight: _user_id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT coalesce(array_agg(DISTINCT pl.person_id), '{}'::uuid[])
    INTO v_person_ids
    FROM public.person_links pl
   WHERE pl.profile_id IN (SELECT p.id FROM public.profiles p WHERE p.user_id = _user_id)
      OR pl.guest_player_id IN (
           SELECT g.id FROM public.guest_players g
            WHERE g.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = _user_id)
         );

  SELECT count(*)::int INTO v_count
    FROM public.academy_player_memberships m
   WHERE m.person_id = ANY(v_person_ids);

  RETURN jsonb_build_object(
    'user_id', _user_id,
    'person_ids', to_jsonb(v_person_ids),
    'membership_count', v_count,
    -- The single field the caller branches on. Named so a log line reads unambiguously.
    'has_memberships', v_count > 0
  );
END;
$$;

COMMENT ON FUNCTION public.account_membership_preflight(uuid) IS
  'U1c prerequisite 2 (INTERIM): read-only probe answering "does deleting this account require destroying a person that holds academy memberships?", across both the profile person and every trainer-owned guest person. Exists because academy_player_memberships is revoked from service_role by design, so the deletion edge functions cannot read it directly. Superseded once OD-08 retain-and-scrub ships.';

-- service_role ONLY: this is edge-function plumbing, never a client call. Note the probe returns person
-- ids, which is exactly the kind of identity detail an app role has no business enumerating.
REVOKE ALL ON FUNCTION public.account_membership_preflight(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_membership_preflight(uuid) TO service_role;
