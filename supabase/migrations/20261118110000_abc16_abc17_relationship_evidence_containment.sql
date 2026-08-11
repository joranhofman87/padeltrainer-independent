-- ============================================================================
-- ABC-16 + ABC-17 — relationship-evidence containment.
-- ============================================================================
--
-- Full model and rationale: docs/ABC16_RELATIONSHIP_EVIDENCE.md
--
-- THE DEFECT, IN ONE SENTENCE: a signal the caller can author was treated as proof of the
-- relationship that authorizes the caller. It was found three times, in three places, and
-- each isolated patch was followed by another instance — so this migration is written from
-- the signal taxonomy rather than as a third patch.
--
--   Class A — caller-authored. `academy_player_metadata` and `academy_player_locations`: the
--             caller chooses the subject, so the row proves only that the caller wrote it.
--             Minting one exposed a guest's full personal data through the `guest_players`
--             SELECT policy, and made a nascent account's login email rewritable through
--             `get_player_email_edit_capability` -> `academy-update-player-email`.
--
--   Class B — server-owned. `guest_players.academy_profile_id` / `.trainer_id`: the write
--             policies require the row to ALREADY be the caller's, so a caller cannot claim
--             somebody else's guest. Admissible.
--
--   Class C — untrusted. `bookings.player_id` / `bookings.guest_player_id`: creating a booking
--             on the academy's own slot is a real transaction, but nothing constrains the
--             SUBJECT. The academy policy (20260704120000) and the trainer policy
--             (20260115210247) both gate on the SLOT and never mention the subject columns.
--             `public.bookings` does carry triggers (updated_at, slot-tier enforcement,
--             auto-follow, person-stamp — 20260115210247, 20260610220000, 20260613130000,
--             20260325212340, 20260826260000); none of them constrains the subject. An earlier
--             draft of this header wrongly said the table had no triggers at all.
--
--             The trainer INSERT policy (20260116200114) also admits a dual-key row —
--             an owned `guest_player_id` alongside an arbitrary `player_id` — so the subject is
--             forgeable at INSERT, not only at UPDATE. Bookings are therefore treated as
--             ACTIVITY, never as evidence about a person, and historical and privileged-writer
--             bookings stay untrusted.
--
--   Class D — untrusted legacy bridge. `guest_players.linked_profile_id` /
--             `.twin_of_profile_id`, and any guest→person→profile equality derived from them.
--             The guest write policies validate only who owns the GUEST row, so a caller can
--             name an arbitrary registered profile. `person_links` carries no provenance column
--             (20260826260000:67) and `collapse_guest_person_into` repoints `person_id` IN
--             PLACE, so a row keeps no trace of the decision that set it — historical links
--             cannot be re-trusted, only frozen going forward.
--
-- The actor barrier is low in the repository model: any authenticated user can create an
-- academy and become its owner-manager (create-academy-profile inserts `academy_profiles`
-- with a fresh uuid and makes the caller its owner). Production exploitability is NOT
-- inspected — every claim here is about the repository model.
--
-- WHAT THIS MIGRATION DOES
--
--   1-3. No Class-A or Class-C signal remains in any authorization predicate.
--   4-6. Clients cannot write the overlays at all — policy AND grant, because a policy cannot
--        withhold a privilege and a grant cannot enforce a row predicate.
--   7.   `service_role` loses direct overlay access it does not need: both tables are reached
--        through the SECURITY DEFINER `backup_export_table`, which holds EXECUTE. This is the
--        ABC-14 precedent applied to the tables it was originally reasoned about.
--   8.   ABC-17: a booking's SUBJECT becomes immutable to client roles, so the booking-derived
--        VISIBILITY that necessarily remains (`get_players_overview`, the academy's own roster)
--        stops being forgeable. Removing that admission instead would empty every academy's
--        player list — an outage, not a containment.
--
-- NO DML. Only policies, privileges, function bodies and one trigger. No row is quarantined,
-- repaired, deleted, moved, merged or re-stamped; disposition waits on the read-only inventory
-- (scripts/db/abc16-metadata-authority-inventory.mjs) and an owner decision.
--
-- NOT REPAIRED HERE, DELIBERATELY: `academy_player_locations.academy_profile_id` references
-- `profiles(id)`, not `academy_profiles(id)`. Correcting the target would rewrite or orphan
-- existing rows. The inventory reports it as `wrong_target_academy_fk`.
--
-- ROLLBACK IS FORWARD-ONLY. Restoring overlay-derived authority, booking-derived authority,
-- direct overlay DML, or academy Auth-email rewriting is not an acceptable rollback.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. guest_belongs_to_user_academy — only the academy's OWN guests.
-- ─────────────────────────────────────────────────────────────────────────────
-- Arm (a) survives: `guest_players.academy_profile_id` is Class B. To make it name the
-- caller's academy the caller must already own the row (the guest write policies check the
-- EXISTING row), so it cannot be used to claim someone else's guest.
--
-- Arm (b) (a booking on one of the caller's slots) and arm (c) (a metadata link) are both
-- removed. Neither is narrowed, because there is no filter that makes a caller-authored
-- subject trustworthy.
--
-- The removed arms are described in this header rather than as comments inside the function
-- body: assertion 9e greps `prosrc` to prove the references are gone, and pg_proc keeps
-- in-body comments, so naming the tables there would defeat the guard.
--
-- CREATE OR REPLACE preserves the grants established by 20260706130100.
CREATE OR REPLACE FUNCTION public.guest_belongs_to_user_academy(
  _guest_id uuid,
  _user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    -- (a) guest owned directly by one of the caller's academies
    SELECT 1
    FROM public.guest_players gp
    WHERE gp.id = _guest_id
      AND gp.academy_profile_id IN (SELECT public.get_user_academy_ids(_user_id))
  )
$$;

COMMENT ON FUNCTION public.guest_belongs_to_user_academy(uuid, uuid) IS
  'Academy-scope predicate for guest_players SELECT. Server-owned evidence ONLY: the academy owns the guest row. ABC-16 removed the overlay arm and ABC-17 removed the booking arm — a booking''s subject was freely reassignable by the slot owner, so it proved nothing about the person.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The trainer booked-guest visibility policy is withdrawn entirely.
-- ─────────────────────────────────────────────────────────────────────────────
-- `guest_booked_with_trainer` (20260713110000) is booking-derived end to end: it asks whether
-- the guest has a non-cancelled booking on one of the trainer's own slots. With the subject
-- reassignable by that same trainer, it authorized reading any guest in the database.
--
-- Trainers keep "Trainers can view their own guest players" (20260116200114), which is
-- ownership-based. The cost is real and is accepted: a trainer no longer sees a guest who
-- merely booked their slot. That visibility returns when membership is canonical, not before.
DROP POLICY IF EXISTS "Trainers can view guests booked into their slots" ON public.guest_players;

-- The function is left defined (other lanes may reference it in tests or docs) but is no
-- longer client-callable, so it cannot be used as a standalone relationship oracle.
REVOKE ALL ON FUNCTION public.guest_booked_with_trainer(uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.guest_booked_with_trainer(uuid, uuid) IS
  'RETIRED by ABC-17 and no longer client-callable. Its predicate was booking-derived, and a booking''s subject was reassignable by the slot owner, so it authorized reading an arbitrary guest.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. get_player_email_edit_capability — `direct` is retired.
-- ─────────────────────────────────────────────────────────────────────────────
-- The capability's ownership predicate had no trustworthy source: a Class-A metadata row was
-- the ONLY evidence that "this academy actively owns the player" (20260615110050:38-41). Rather
-- than substitute another heuristic, the outcome is removed. An academy never rewrites an
-- accepted user's Auth login identity; the player changes their own email, and invoicing uses
-- the billing override (itself read-only under this containment).
--
-- The authorization gate is KEPT and still raises 42501, so an unauthorized caller stays
-- distinguishable from an authorized one. Signature, volatility, language and return type are
-- unchanged, so no caller and no generated type drifts.
CREATE OR REPLACE FUNCTION public.get_player_email_edit_capability(
  _profile_id uuid,
  _academy_profile_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.is_academy_manager(auth.uid(), _academy_profile_id) OR public.is_admin(auth.uid())) THEN
    RAISE EXCEPTION 'not authorized for academy %', _academy_profile_id USING ERRCODE = '42501';
  END IF;

  -- ABC-16: 'direct' is unreachable. Every authorized outcome is the safe one. Guests were
  -- already 'override' here — they are edited inline on guest_players, whose write policies
  -- are ownership-based.
  RETURN 'override';
END;
$$;

COMMENT ON FUNCTION public.get_player_email_edit_capability(uuid, uuid) IS
  'Returns ''override'' for every authorized caller; raises 42501 for an unauthorized one. ABC-16 retired the ''direct'' outcome: its ownership predicate was satisfiable by a caller-authored overlay row, which made a service-role login-email replacement reachable for a nascent account.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. filter_academy_priority_ids — server-owned evidence only.
-- ─────────────────────────────────────────────────────────────────────────────
-- Guests: the academy owns the row (Class B). Retained.
--
-- Registered profiles: EVERY route that could admit one was Class A (a metadata or location
-- row) or Class C (a booking whose subject the academy could reassign). All are removed, so no
-- profile is admitted at all. That is a real functional loss — registered players can no longer
-- be put on a rebooking priority list — and it is the correct fail-closed answer. The
-- replacement is U2's canonical membership, not another heuristic invented here. Widening this
-- to `academy_trainers`-derived rosters would be a new authority model (ABC-10 is an open owner
-- decision), not containment.
CREATE OR REPLACE FUNCTION public.filter_academy_priority_ids(
  _academy_profile_id uuid,
  _profile_ids uuid[],
  _guest_ids uuid[]
)
RETURNS TABLE (profile_id uuid, guest_player_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT NULL::uuid AS profile_id, g AS guest_player_id
  FROM unnest(COALESCE(_guest_ids, ARRAY[]::uuid[])) AS g
  WHERE EXISTS (
    SELECT 1 FROM public.guest_players gp
    WHERE gp.academy_profile_id = _academy_profile_id AND gp.id = g
  );
$$;

COMMENT ON FUNCTION public.filter_academy_priority_ids(uuid, uuid[], uuid[]) IS
  'Keeps only priority ids backed by server-owned evidence: guests the academy owns. ABC-16 removed the overlay arms and ABC-17 removed the booking arm, so NO registered profile is admitted — every available route was caller-authored. Canonical membership (U2) is the replacement. service_role only.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Overlay policies become READ-ONLY.
-- ─────────────────────────────────────────────────────────────────────────────
-- Each FOR ALL policy is replaced by a FOR SELECT policy with the IDENTICAL USING predicate,
-- so every read that worked before still works and no row disappears from any surface. Only
-- the write half is withdrawn. Policies are permissive and OR together, so replacing both
-- metadata policies keeps the academy-owned and trainer-owned read scopes exactly as they were.
-- Each block drops BOTH the old name and the new one before creating, so the migration is
-- rerunnable: `CREATE POLICY` has no OR REPLACE and a second run would fail on "already exists".
DROP POLICY IF EXISTS "Academy managers manage player metadata" ON public.academy_player_metadata;
DROP POLICY IF EXISTS "Academy managers read player metadata" ON public.academy_player_metadata;
CREATE POLICY "Academy managers read player metadata"
ON public.academy_player_metadata
FOR SELECT
TO authenticated
USING (public.is_academy_manager(auth.uid(), academy_profile_id));

DROP POLICY IF EXISTS "Trainers manage their player metadata" ON public.academy_player_metadata;
DROP POLICY IF EXISTS "Trainers read their player metadata" ON public.academy_player_metadata;
CREATE POLICY "Trainers read their player metadata"
ON public.academy_player_metadata
FOR SELECT
TO authenticated
USING (trainer_profile_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM public.trainer_profiles tp
  WHERE tp.id = trainer_profile_id AND tp.user_id = auth.uid()
));

DROP POLICY IF EXISTS apl_manager_all ON public.academy_player_locations;
DROP POLICY IF EXISTS apl_manager_select ON public.academy_player_locations;
CREATE POLICY apl_manager_select ON public.academy_player_locations
  FOR SELECT TO authenticated
  USING (public.is_academy_manager(auth.uid(), academy_profile_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Overlay privileges: SELECT for clients, nothing for service_role.
-- ─────────────────────────────────────────────────────────────────────────────
-- A policy governs which ROWS a privilege reaches; it cannot withhold the privilege.
-- `academy_player_locations` carries an explicit GRANT to authenticated (20260615110100) and
-- `academy_player_metadata` inherits client privileges from the platform defaults, so both
-- need an explicit REVOKE.
--
-- REVOKE ALL then GRANT SELECT states the matrix positively and is PostgreSQL-version
-- agnostic: it withdraws every privilege the running server defines, including ones added by
-- later majors (PG17's MAINTAIN), instead of enumerating a list that silently goes stale.
--
-- service_role is included, correcting the first draft of this containment. Both overlays ARE
-- in the backup catalogue (`backup_export_tables`, 20261118100000:54-55), but they are read
-- through `backup_export_table`, which is SECURITY DEFINER and holds EXECUTE for service_role —
-- so no direct table privilege is required. `merge_guest_players` and the person-stamp paths
-- are likewise SECURITY DEFINER and run as their owner. Keeping the grant "in case something
-- needs it" is exactly the unjustified standing privilege ABC-14 removed elsewhere.
--
-- supabase/seed.sql re-grants ALL to service_role on every table after migrations run, so the
-- overlays are added to its deny-list; otherwise a local `supabase db reset` would silently
-- undo this and the ACL guard would pass in production while failing to describe local/CI.
REVOKE ALL ON TABLE public.academy_player_metadata  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.academy_player_locations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.academy_player_metadata  TO authenticated;
GRANT SELECT ON TABLE public.academy_player_locations TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. The overlay writer RPC and the person-stamp functions are not callable at all.
-- ─────────────────────────────────────────────────────────────────────────────
-- `set_player_location` is SECURITY DEFINER and manager-gated, but its gate is the same
-- `is_academy_manager` check that never proved anything about the SUBJECT — it is the RPC form
-- of the direct write closed above, so it closes with it. service_role is included: no
-- server-side caller invokes it (verified across supabase/functions and the migration chain),
-- and a standing privilege with no caller is a standing risk.
REVOKE ALL ON FUNCTION public.set_player_location(uuid, uuid, uuid, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.set_player_location(uuid, uuid, uuid, uuid, boolean) IS
  'Attach/suppress a club for a player. ABC-16 withdrew EXECUTE from every client and from service_role: the manager gate never established that the subject belongs to the academy. A later H1 command re-opens curation on canonical membership.';

-- The stamp functions are trigger functions whose EXECUTE defaults to PUBLIC, which let any
-- client call them directly as an oracle. PostgreSQL checks EXECUTE on a trigger function when
-- the trigger is CREATED, not each time it fires, so withdrawing it does not disturb the
-- triggers installed by 20260826260000 — asserted at 9d below and demonstrated against a real
-- server in abc16OverlayPrivileges.realpg.test.ts.
REVOKE ALL ON FUNCTION public.stamp_person_id_academy_player_metadata()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.stamp_person_id_academy_player_locations()
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. ABC-17 — the partial booking-subject guard is WITHDRAWN.
-- ─────────────────────────────────────────────────────────────────────────────
-- An earlier draft installed a BEFORE UPDATE trigger freezing `player_id` /
-- `guest_player_id` for client roles, and leaned on it to argue that the booking-derived
-- admission left in `get_players_overview` was dependable. That argument was wrong twice over:
--
--   * the guard covered UPDATE only, while the trainer INSERT policy (20260116200114) admits a
--     dual-key row — an owned guest alongside an arbitrary `player_id` — so a forged subject
--     never needed an UPDATE;
--   * every booking that already exists predates the guard, and privileged writers bypass it
--     by design, so it could not make historical rows trustworthy either.
--
-- A complete client write invariant would have to cover every legitimate booking flow (public
-- slot and cyclus payment, cart, guest intake, trainer and academy creation, rebooking, merge
-- re-keying). That has not been proven here, and the standing instruction is to remove a
-- partial guard rather than overclaim it. So the trigger is dropped and the boundary is moved
-- entirely to the READERS: bookings are activity, never evidence about a person.
--
-- DROP IF EXISTS on both, so the migration is rerunnable and so a database that received the
-- earlier draft converges on this state rather than keeping a guard this file no longer
-- describes.
DROP TRIGGER IF EXISTS trg_guard_booking_subject_immutable ON public.bookings;
DROP FUNCTION IF EXISTS public.guard_booking_subject_immutable();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8b. ABC-18 — the legacy guest↔account bridge is frozen going forward.
-- ─────────────────────────────────────────────────────────────────────────────
-- `linked_profile_id` and `twin_of_profile_id` name a registered profile, but the
-- `guest_players` write policies validate only who owns the GUEST row (20260224171306), so a
-- caller can point an owned guest at anyone. Downstream those columns — and the
-- `person_links` equality derived from them — were read as identity.
--
-- EXISTING ROWS ARE PRESERVED BYTE-IDENTICALLY. Historical provenance cannot be
-- reconstructed: `person_links` has no provenance column and `collapse_guest_person_into`
-- repoints `person_id` in place. So this freezes AUTHORING and leaves the past untouched; the
-- readers stop trusting it (sections 9-10), and re-trusting anything historical needs the
-- attestation/proposal model that belongs to A/U2 under its own material-schema gate.
--
-- SECURITY INVOKER (the default) is required: the guard reads `current_user`, and a definer
-- function would report its owner for every caller and never fire.
CREATE OR REPLACE FUNCTION public.guard_guest_bridge_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- service_role is included: it is reachable from Edge functions that accept client input,
  -- so it is not a trusted authoring context for an identity claim. Internal re-keying runs
  -- inside SECURITY DEFINER functions, which execute as the function owner and are unaffected.
  IF current_user IN ('authenticated', 'anon', 'service_role') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.linked_profile_id IS NOT NULL OR NEW.twin_of_profile_id IS NOT NULL THEN
        RAISE EXCEPTION 'a guest cannot be created already linked to an account'
          USING ERRCODE = '42501',
                HINT = 'Create the guest, then use a reviewed link proposal.';
      END IF;
    ELSIF NEW.linked_profile_id IS DISTINCT FROM OLD.linked_profile_id
       OR NEW.twin_of_profile_id IS DISTINCT FROM OLD.twin_of_profile_id THEN
      RAISE EXCEPTION 'a guest''s account link cannot be set or changed here'
        USING ERRCODE = '42501',
              HINT = 'Linking a guest to an account is a reviewed decision, not a field edit.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_guest_bridge_columns() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_guard_guest_bridge_columns ON public.guest_players;
CREATE TRIGGER trg_guard_guest_bridge_columns
  BEFORE INSERT OR UPDATE ON public.guest_players
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_guest_bridge_columns();

-- The minting RPCs. `link_guest_data_to_profile` had NO grant or revoke anywhere in the chain,
-- so it sat on PostgreSQL's default PUBLIC EXECUTE while being SECURITY DEFINER and rewriting
-- booking subjects as its owner — a direct route around every guard above.
REVOKE ALL ON FUNCTION public.link_guest_data_to_profile(uuid) FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'claim_guest_twin_for_academy'
  ) THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8c. ABC-18 — the two staff↔player visibility helpers fail closed.
-- ─────────────────────────────────────────────────────────────────────────────
-- `is_player_of_trainer` was booking-derived end to end. `is_player_of_academy` was a booking
-- arm OR a guest-bridge arm (`twin_of_profile_id`, `linked_profile_id`, or guest→person→profile
-- equality). Every one of those is Class C or Class D, so nothing admissible remains for a
-- REGISTERED subject and both close to admin-only.
--
-- They are not dropped: they gate `profiles_public` arms and profile UPDATE policies, and a
-- missing function would error rather than deny. Signature, volatility and grants are unchanged
-- so no caller drifts — `authenticated` keeps EXECUTE because RLS evaluates helpers as the
-- session user and revoking it would break every policy that calls them.
--
-- CONSEQUENCE, stated rather than discovered later: an academy manager or trainer can no longer
-- see or update a registered player's profile through these predicates. Directly owned GUEST
-- rows are unaffected — they are reached by ownership, not by these helpers.
CREATE OR REPLACE FUNCTION public.is_player_of_trainer(p_player_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.is_admin(auth.uid());
$$;

COMMENT ON FUNCTION public.is_player_of_trainer(uuid) IS
  'ABC-18: fails closed to admin-only. Its sole evidence was a booking subject, which the slot owner can choose at INSERT, so it never established anything about the person.';

CREATE OR REPLACE FUNCTION public.is_player_of_academy(p_player_id uuid, p_academy_profile_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT public.is_admin(auth.uid());
$$;

COMMENT ON FUNCTION public.is_player_of_academy(uuid, uuid) IS
  'ABC-18: fails closed to admin-only. Its evidence was a booking subject (caller-chosen) or a guest bridge (linked_profile_id / twin_of_profile_id / person equality derived from them), all non-authoritative. Canonical membership is the replacement and belongs to U2.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Install assertions — the migration proves its own postcondition.
-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges are read back from the SERVER's own catalog rather than compared against a
-- hard-coded universe, so a later PostgreSQL major that adds a privilege type cannot make this
-- guard quietly incomplete.
DO $$
DECLARE
  v_tbl text;
  v_privs text[];
  v_bad text;
BEGIN
  FOREACH v_tbl IN ARRAY ARRAY['academy_player_metadata', 'academy_player_locations'] LOOP
    -- 9a. across PUBLIC, anon, authenticated and service_role the ONLY privilege is
    --     authenticated's SELECT.
    SELECT coalesce(array_agg(DISTINCT a.privilege_type ORDER BY a.privilege_type), ARRAY[]::text[])
      INTO v_privs
      FROM pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      LEFT JOIN pg_roles r ON r.oid = a.grantee
     WHERE c.oid = ('public.' || v_tbl)::regclass
       AND (a.grantee = 0 OR r.rolname IN ('anon', 'authenticated', 'service_role'));

    IF v_privs <> ARRAY['SELECT']::text[] THEN
      RAISE EXCEPTION 'ABC-16: client/service privileges on % must be exactly {SELECT}, found %', v_tbl, v_privs;
    END IF;

    -- effective checks too: role inheritance can grant what the direct ACL does not show.
    IF has_table_privilege('authenticated', 'public.' || v_tbl, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'DELETE')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'TRUNCATE')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'REFERENCES')
       OR has_table_privilege('authenticated', 'public.' || v_tbl, 'TRIGGER') THEN
      RAISE EXCEPTION 'ABC-16: authenticated retains an effective write privilege on %', v_tbl;
    END IF;

    IF has_table_privilege('service_role', 'public.' || v_tbl, 'SELECT')
       OR has_table_privilege('service_role', 'public.' || v_tbl, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || v_tbl, 'UPDATE')
       OR has_table_privilege('service_role', 'public.' || v_tbl, 'DELETE') THEN
      RAISE EXCEPTION 'ABC-16: service_role retains direct access to % — the backup path uses SECURITY DEFINER functions', v_tbl;
    END IF;

    -- reads must survive: usability is a requirement of this containment.
    IF NOT has_table_privilege('authenticated', 'public.' || v_tbl, 'SELECT') THEN
      RAISE EXCEPTION 'ABC-16: authenticated lost SELECT on % — reads must remain', v_tbl;
    END IF;
  END LOOP;

  -- 9b. no policy on either overlay still permits a client write.
  SELECT string_agg(tablename || '.' || policyname || ' (' || cmd || ')', ', ')
    INTO v_bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('academy_player_metadata', 'academy_player_locations')
     AND cmd <> 'SELECT';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ABC-16: non-SELECT policy still present on an overlay table: %', v_bad;
  END IF;

  -- 9c. the overlay writer, the stamp functions and the new guard are not callable by anyone
  --     who could reach them from outside the database.
  IF has_function_privilege('authenticated', 'public.set_player_location(uuid,uuid,uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_player_location(uuid,uuid,uuid,uuid,boolean)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.set_player_location(uuid,uuid,uuid,uuid,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-16: set_player_location is still callable';
  END IF;
  IF has_function_privilege('authenticated', 'public.stamp_person_id_academy_player_metadata()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.stamp_person_id_academy_player_locations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.guard_guest_bridge_columns()', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-16: a trigger function is still client-callable';
  END IF;
  IF has_function_privilege('authenticated', 'public.guest_booked_with_trainer(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-17: the retired booked-guest oracle is still client-callable';
  END IF;

  -- 9c-bis. the bridge minting RPC is not callable by any untrusted role.
  IF has_function_privilege('authenticated', 'public.link_guest_data_to_profile(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.link_guest_data_to_profile(uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.link_guest_data_to_profile(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-18: link_guest_data_to_profile is still callable by an untrusted role';
  END IF;

  -- 9d. the stamp triggers still exist — withdrawing EXECUTE must not have disturbed them —
  --     and the bridge guard is installed while the withdrawn booking guard is gone.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stamp_person_id_academy_player_metadata' AND NOT tgisinternal)
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_stamp_person_id_academy_player_locations' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ABC-16: a person-stamp trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_guest_bridge_columns' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ABC-18: the guest bridge guard trigger is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_guard_booking_subject_immutable' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ABC-17: the withdrawn partial booking guard is still installed';
  END IF;

  -- 9d-bis. the two staff visibility helpers admit nothing but admin.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('is_player_of_trainer', 'is_player_of_academy')
       AND p.prosrc ~ 'bookings|linked_profile_id|twin_of_profile_id|person_links'
  ) THEN
    RAISE EXCEPTION 'ABC-18: a staff visibility helper still reads a booking or a guest bridge';
  END IF;

  -- 9e. no authority predicate reads an overlay OR a booking any more.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('guest_belongs_to_user_academy', 'get_player_email_edit_capability', 'filter_academy_priority_ids')
       AND p.prosrc ~ 'academy_player_(metadata|locations)|public\.bookings'
  ) THEN
    RAISE EXCEPTION 'ABC-16/17: an authority predicate still references an overlay or a booking';
  END IF;

  -- 9f. the trainer booked-guest policy is gone and the academy guest policy still routes
  --     through the narrowed predicate.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'guest_players'
       AND policyname = 'Trainers can view guests booked into their slots'
  ) THEN
    RAISE EXCEPTION 'ABC-17: the booking-derived trainer guest policy is still installed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'guest_players'
       AND policyname = 'Academy managers can view related academy guest players'
       AND cmd = 'SELECT' AND qual::text ILIKE '%guest_belongs_to_user_academy%'
  ) THEN
    RAISE EXCEPTION 'ABC-16: the academy guest SELECT policy is not the expected one';
  END IF;
END $$;
