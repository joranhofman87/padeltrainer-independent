-- U2 — the command is the only way to make a Player, enforced by the database.
--
-- Everything before this migration made the application code go through one create command. That is
-- necessary and it is not sufficient: `guest_players` still accepted a direct INSERT from any
-- trainer or academy manager holding the anon key, because the RLS policies written in 2026-01 and
-- 2026-02 say so. A row inserted that way still mints a canonical person — the trigger sees to that
-- — but it has no `player_create_commands` record, so it is not idempotent, nobody proposed the
-- duplicate it may be, and the audit trail simply has a hole in it where a Player appeared.
--
-- An invariant that lives only in the callers is a convention. This makes it a rule.
--
-- WHAT STAYS. UPDATE and DELETE are untouched: editing a player's details, marking them as trained,
-- correcting an address are all ordinary work, and none of them create anybody. The service key
-- bypasses RLS entirely, so the SECURITY DEFINER mechanism and every backfill still write normally.
-- What is removed is the direct client INSERT, which no application code performs any more.

-- All three INSERT policies, by their exact live names. The REVOKE below is what actually closes
-- the door (with no INSERT privilege the policies are never consulted); the drops keep the
-- catalogue honest, so nobody reads a policy and believes the path still exists.
DROP POLICY IF EXISTS "Trainers can create their own guest players" ON public.guest_players;
DROP POLICY IF EXISTS "Academy managers can create guest players for their trainers" ON public.guest_players;
DROP POLICY IF EXISTS "Players can register as guest players for trainer cycles" ON public.guest_players;

REVOKE INSERT ON public.guest_players FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.guest_players IS
  'Player records without a login. Since U2 (owner 2026-08-09) rows are created ONLY by player_create_execute, reached through player_create_command or a token-authorized wrapper: creation is idempotent on the caller''s creation_request_id, and a create that looks like an existing Player files a possible_duplicate_player proposal. Clients may update and delete, never insert.';

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The twin stamp is an identity assertion, so it is not an ordinary column edit
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `mint_person_for_guest` and `relink_person_on_twin_change` both treat `twin_of_profile_id` as the
-- explicit assertion that authorizes joining a guest to an account holder's person (rule B1). The
-- create command authorizes that assertion — the account must be one the scope already speaks for.
-- The UPDATE policy did not: a manager could stamp any existing in-scope guest with any profile
-- uuid they could name, and the relink trigger would collapse the two people. That is the same
-- capability the command refuses, reachable by editing a row instead of creating one.
--
-- A trigger rather than a column privilege, because the rule is about the TRANSITION: a CLIENT may
-- not introduce or change an assertion, while several authorized paths must.
--
-- The discriminator is `current_user`, and getting this wrong broke a real flow. The first version
-- keyed on `auth.role()` — but JWT claims are request-local and a SECURITY DEFINER function does not
-- clear them, which this repo documents elsewhere in as many words. So the guard also fired inside
-- `merge_guest_players`, whose survivor hygiene carries a source twin stamp onto an unstamped
-- target: an operator merging two players in the UI got a rolled-back transaction and no
-- explanation. `current_user` is the EFFECTIVE role, so it is `authenticated` for a PostgREST write
-- and the function owner inside any definer path — which is exactly the distinction being drawn.
-- SECURITY INVOKER, and that is load-bearing rather than incidental: inside a DEFINER function
-- `current_user` is the function's OWNER whoever called it, so a definer guard would read
-- `postgres` for a client write and never fire at all. It needs no privileges of its own — it reads
-- NEW and OLD and raises — so running as the caller costs nothing and is the only way it can see
-- who the caller is.
CREATE OR REPLACE FUNCTION public.guard_guest_twin_assertion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- `current_user`, never `auth.role()`: the claim survives into a definer function and would make
  -- this fire inside the merge command, which legitimately carries a stamp onto the survivor.
  IF NEW.twin_of_profile_id IS DISTINCT FROM OLD.twin_of_profile_id
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'guest_twin_assertion_not_yours'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'A twin stamp says this Player IS that account holder, and it authorizes a merge. It is made by the create command or the claim RPC, both of which check that the scope may speak for that account.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_guest_twin_assertion ON public.guest_players;
CREATE TRIGGER trg_guard_guest_twin_assertion
  BEFORE UPDATE OF twin_of_profile_id ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_guest_twin_assertion();

REVOKE ALL ON FUNCTION public.guard_guest_twin_assertion() FROM PUBLIC, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- The claim RPC has no caller left, and it is not a primitive to leave lying about
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
--
-- `claim_guest_twin_for_academy` stamps an EXISTING guest with a profile uuid. Its only check is
-- that the caller manages the academy; it does not ask whether the academy has any relationship
-- with the account being asserted. It existed to serve the roster bridge's attribute-matched claim,
-- which U2 removed — so what remains is a PostgREST-reachable way for any academy manager to
-- perform exactly the merge the create command now refuses.
--
-- The function stays (its behaviour is still what an authorized operator flow would want, and the
-- rehearsal suite exercises it directly as the owner role); the GRANT does not.
REVOKE EXECUTE ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid, uuid) IS
  'Stamps an existing guest as a profile''s twin. EXECUTE granted to nobody since U2: the roster bridge that called it decided its candidate by matching an address and a name, and the stamp authorizes a merge. A future operator-driven flow must re-grant it deliberately, with a check that the scope may speak for the account.';
