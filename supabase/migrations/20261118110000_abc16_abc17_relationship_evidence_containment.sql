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
--   Class B — server-owned, and the ONLY admissible evidence in this release:
--               * a directly owned guest — `guest_players.academy_profile_id` = the academy, or
--                 `.trainer_id` = the trainer. The write policies require the row to ALREADY be
--                 the caller's, so nobody can claim someone else's guest. No active-trainer
--                 union: a trainer may serve several academies.
--               * a caller-bound self profile — `profiles.user_id = auth.uid()`. The subject is
--                 the caller, so there is nothing to forge.
--               * explicit admin, public-trainer and managed-trainer relations.
--
--             Everything else — person equality, `person_links`, `linked_profile_id`,
--             `twin_of_profile_id` — NEVER grants identity, access, routing or mutation. Those
--             columns remain readable as inert legacy observations only.
--
--   Class C — untrusted, permanently. `bookings.player_id` / `bookings.guest_player_id`:
--             creating a booking on the academy's own slot is a real transaction, but nothing
--             constrains the SUBJECT, and no guard in this release makes one authority-grade.
--             Bookings are ACTIVITY ONLY: they may colour state for a subject that is ALREADY
--             in scope by independent evidence, and they may never put one there. The academy policy (20260704120000) and the trainer policy
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

-- The shipped signature is THREE uuids (20260826210000:82-86), granted to authenticated at
-- :142-143. An earlier draft revoked a two-uuid overload: on the real chain the name check
-- passed and the wrong-signature REVOKE aborted the whole migration. Pinned by
-- `regprocedure` so the argument list is part of the statement rather than a comment.
REVOKE ALL ON FUNCTION public.claim_guest_twin_for_academy(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- `find_guest_twin_for_academy` is the discovery half of the same claim flow. It answers
-- "which guest row in this academy is this profile's twin", which is only useful as the input
-- to a claim that is now impossible, and is itself a bridge oracle.
REVOKE ALL ON FUNCTION public.find_guest_twin_for_academy(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8d. ABC-18 — the OWNER-CONTEXT auto-link paths are retired.
-- ─────────────────────────────────────────────────────────────────────────────
-- Revoking EXECUTE is not a freeze. The BEFORE guard at 8b stops a client naming a profile
-- directly, but three SECURITY DEFINER paths ran as the function owner and re-created the link
-- from a mutable email anyway:
--
--   * `link_guest_data_on_guest_player_change` — an AFTER INSERT OR UPDATE OF
--     (linked_profile_id, email) trigger on guest_players (20260530190000:169-173) whose email
--     arm calls `link_guest_data_to_profile` for EVERY profile sharing the address (:145,:159);
--   * `link_guest_invoices_on_signup` — the same call at signup (:106);
--   * `mint_person_for_guest` / `mint_person_for_profile` / `relink_person_on_twin_change` —
--     collapse a guest's person into a profile's on a unique-email pair or a twin stamp.
--
-- So an authenticated INSERT with the victim's email and NULL bridge fields passed the guard
-- and was linked a moment later, in owner context. That is the bypass this section closes.
--
-- An email or name match may SUGGEST a proposal. It may never confirm one. There is no
-- email-only signup exception — a special case there is the same defect with a nicer story.
--
-- NO DML: functions and triggers only. Every existing link, person, booking and invoice keeps
-- its current value; nothing is re-derived, cleared or re-stamped.

-- (1) guest insert/email change no longer links anything.
DROP TRIGGER IF EXISTS trg_link_guest_data_on_guest_player_change ON public.guest_players;

CREATE OR REPLACE FUNCTION public.link_guest_data_on_guest_player_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ABC-18: inert. Retained as an object so nothing that references it errors; its trigger is
  -- dropped above. Editing a guest's email is a contact-detail change and nothing more.
  RETURN NEW;
END;
$$;

-- (2) signup no longer claims guest history by email.
DROP TRIGGER IF EXISTS trg_link_guest_invoices_on_signup ON public.profiles;

CREATE OR REPLACE FUNCTION public.link_guest_invoices_on_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- ABC-18: inert. Signing up with an address that appears on a guest row is a coincidence of
  -- mutable PII, not proof the two are the same person — and it granted roles, follows,
  -- bookings and invoices. A claim flow returns with the attestation model in A/U2.
  RETURN NEW;
END;
$$;

-- (3) a guest always mints its OWN person; email and twin never collapse two persons.
CREATE OR REPLACE FUNCTION public.mint_person_for_guest()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email text := nullif(btrim(NEW.email), '');
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE guest_player_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- Structural mint: this guest row becomes its own person. Deterministic id (the guest's own)
  -- exactly as before, so nothing downstream that assumes that shape changes.
  INSERT INTO public.persons (
    id, full_name, first_name, last_name, email, phone, birth_date,
    skill_rating, rating_system, billing_business_name, billing_address, billing_btw_number
  ) VALUES (
    NEW.id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
    NEW.skill_rating, NEW.rating_system, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.person_links (person_id, guest_player_id)
  VALUES (NEW.id, NEW.id)
  ON CONFLICT (guest_player_id) DO NOTHING;

  -- NO review/proposal row is written here. An earlier draft logged one on every email
  -- coincidence; that was wrong. Such a row has no counterpart, tenant or idempotency key, it
  -- duplicates the address as fresh PII, and anyone able to insert a guest could flood the
  -- table by reusing a known address. H0 mints separate structural persons and stops. An
  -- actionable, attested proposal is A/U2 work under its later material gate.
  RETURN NEW;
END;
$$;

-- (3b) a new profile mints its OWN person and never absorbs a guest's on an email match.
CREATE OR REPLACE FUNCTION public.mint_person_for_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.person_links WHERE profile_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  -- The STRUCTURAL MIRROR is reproduced byte-for-byte from the effective definition
  -- (20261115100000:594-625) — including `user_id`, which carries the canonical login identity,
  -- plus rating_member_id, avatar_url, bio, location, preferred_language, the billing fields and
  -- stripe_customer_id. Only the email-collapse tail below it is removed. An earlier draft of
  -- this containment dropped seven of these columns, which would have silently degraded every
  -- new account's person row.
  INSERT INTO public.persons (
    id, user_id, full_name, first_name, last_name, email, phone, birth_date,
    skill_rating, rating_system, rating_member_id, avatar_url, bio, location,
    preferred_language, billing_business_name, billing_address, billing_btw_number,
    stripe_customer_id
  ) VALUES (
    NEW.id, NEW.user_id, NEW.full_name, NEW.first_name, NEW.last_name, NEW.email, NEW.phone, NEW.birth_date,
    NEW.skill_rating, NEW.rating_system, NEW.rating_member_id, NEW.avatar_url, NEW.bio, NEW.location,
    NEW.preferred_language, NEW.billing_business_name, NEW.billing_address, NEW.billing_btw_number,
    NEW.stripe_customer_id
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.person_links (person_id, profile_id)
  VALUES (NEW.id, NEW.id)
  ON CONFLICT (profile_id) DO NOTHING;

  -- The reverse unique-email collapse (guest existed first, the human signs up with that
  -- address) is REMOVED. It moved bookings, invoices and memberships on the strength of a
  -- mutable string. No proposal row replaces it here — see mint_person_for_guest.
  RETURN NEW;
END;
$$;

-- (3c) `merge_guest_players` is retired as a client mutation.
--
-- Not patched — retired. Its effective body (20261115100000:236) still reads and propagates
-- `twin_of_profile_id` / `linked_profile_id`, re-keys bookings and invoices, and can move
-- memberships between persons. Every one of those is an identity decision taken on legacy
-- bridge values that this containment has just declared non-authoritative, so leaving it
-- callable would reopen the whole boundary through one RPC.
--
-- The function and every existing row are preserved. A canonical, idempotent guest-merge
-- command belongs to U2.
REVOKE ALL ON FUNCTION public.merge_guest_players(text, uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.merge_guest_players(text, uuid, uuid, uuid, jsonb) IS
  'ABC-18: no longer callable by any external role. It propagates legacy twin/linked bridge values and re-keys bookings, invoices and memberships — identity decisions on evidence that is not authoritative. A canonical idempotent merge command is U2 work.';

-- (3c-bis) `collapse_guest_person_into` is not callable by any external role.
--
-- 20260826280000:954 revoked it from PUBLIC, anon and authenticated but NOT service_role, while
-- its sibling `collapse_guest_person_into_reporting` WAS revoked from service_role
-- (20261115100000:223) — an asymmetry that reads as an oversight rather than a decision.
--
-- It is the single most powerful identity primitive in the schema: it repoints
-- `person_links.person_id` in place and re-keys bookings, invoices, intake requests, priority
-- claims, session notes and location overlays onto another person. Reachable by service_role it
-- undoes this whole containment in one call, and it is the reason historical link provenance
-- cannot be reconstructed.
REVOKE ALL ON FUNCTION public.collapse_guest_person_into(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.collapse_guest_person_into(uuid, uuid, uuid) IS
  'ABC-18: callable by no external role. It repoints person_links in place and re-keys bookings, invoices, claims and notes onto another person — an identity decision, and the reason legacy link provenance is unrecoverable. Internal definer callers are unaffected.';

-- (3d) the obsolete clear-on-repurpose trigger is retired.
--
-- `clear_guest_twin_on_repurpose` (20260826240000:283-284) nulls `NEW.twin_of_profile_id` when a
-- stamped guest is renamed to a different human. It existed to stop a stale stamp being READ as
-- identity — which no reader does any more.
--
-- Left installed it produces a phantom failure: an ordinary rename or email edit on a
-- historically twinned guest trips the trigger, which sets the column to NULL, which the ABC-18
-- bridge guard then sees as a client-side change and rejects — so the whole edit fails for a
-- reason the user cannot act on. Retiring it lets those edits succeed while the stored stamp
-- stays exactly as it is: inert observation, never cleared, never trusted.
DROP TRIGGER IF EXISTS trg_clear_guest_twin_on_repurpose ON public.guest_players;

-- (4) changing a twin stamp no longer moves anyone between persons.
CREATE OR REPLACE FUNCTION public.relink_person_on_twin_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- ABC-18: inert. A twin stamp is caller-authored, so re-pointing a person on the strength of
  -- one moved identity, memberships, bookings and invoices on an unverified assertion.
  RETURN NEW;
END;
$$;

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
-- 8e. ABC-17/18 — the roster reader keeps only directly owned guests.
-- ─────────────────────────────────────────────────────────────────────────────
-- What is withdrawn, and why each one had to go:
--
--   * REGISTERED ADMISSION BY BOOKING. A profile entered the roster because it had a booking on
--     a slot run by one of the academy's active trainers. The subject of that booking is chosen
--     by whoever owns the slot, so the academy could admit — and read the full PII of — any
--     profile it liked. Removed outright; canonical membership (U2) is the replacement.
--   * THE ACTIVE-TRAINER UNION. Academy scope also pulled in guests owned by any active trainer.
--     A trainer can work for several academies and can have private guests, so that union
--     crosses tenant boundaries. Academy scope is now exactly
--     `guest_players.academy_profile_id = p_scope_id`; trainer scope exactly `trainer_id`.
--   * PERSON EXPANSION AND CROSS-PERSON DEDUP. Rows were merged per person via `person_links`,
--     so one row could carry a sibling row's identity — and that equality descends from the
--     legacy email/twin bridge. Each in-scope guest is now exactly one row, keyed by itself.
--
-- What is kept: the manager/trainer authorization gate, the owner-scoped soft-removal
-- suppression, owner-scoped notes and tags, search, filters, sorting and paging. Club chips are
-- the owner's own curated rows plus slots this guest actually booked WITHIN the owner's scope —
-- booking activity about a subject already in scope by ownership, which is allowed.
--
-- `person_id` is returned as NULL. An earlier draft fell back to the guest's own id when no
-- link existed, which hands the client a guest UUID in a column named for the canonical person
-- — indistinguishable downstream from a real person id, and for a legacy collapsed row it would
-- have returned the SHARED person uuid that the bridge created. No person UUID escapes this
-- reader.
--
-- Signature, volatility, security and grants are unchanged, so no caller or generated type
-- drifts. `profile_id` is now always NULL and `player_type` always 'guest'; the UI renders a
-- neutral placeholder for registered players rather than their personal data.
CREATE OR REPLACE FUNCTION public.get_players_overview(
  p_scope text,
  p_scope_id uuid,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'name',
  p_sort_dir text DEFAULT 'asc',
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  player_key text,
  player_type text,
  guest_player_id uuid,
  profile_id uuid,
  person_id uuid,
  full_name text,
  email text,
  phone text,
  billing_business_name text,
  billing_address text,
  billing_btw_number text,
  skill_rating numeric,
  rating_system text,
  notes text,
  source text,
  birth_date date,
  has_trained boolean,
  created_at timestamptz,
  owner_trainer_id uuid,
  metadata_id uuid,
  tag_ids uuid[],
  academy_notes text,
  trainer_ids uuid[],
  location_ids uuid[],
  location_names text[],
  has_active_cyclus boolean,
  has_overdue_payment boolean,
  email_undeliverable boolean,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tokens text[];
  v_filter_trainer uuid   := nullif(p_filters->>'trainer_id','')::uuid;
  v_filter_location uuid  := nullif(p_filters->>'location_id','')::uuid;
  v_level_gt numeric      := (p_filters->>'level_gt')::numeric;
  v_level_max numeric     := (p_filters->>'level_max')::numeric;
  v_level_unrated boolean := coalesce((p_filters->>'level_unrated')::boolean, false);
  v_has_cyclus boolean    := (p_filters->>'has_active_cyclus')::boolean;
  v_tag text              := nullif(p_filters->>'tag_id','');
  v_payment text          := nullif(p_filters->>'payment','');
  v_limit integer         := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer        := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- Authorization is unchanged: the function bypasses RLS, so the gate stays explicit.
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.trainer_profiles tp
       WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  IF coalesce(btrim(p_search), '') <> '' THEN
    v_tokens := regexp_split_to_array(public.fold_search_text(btrim(p_search)), '\s+');
  END IF;

  RETURN QUERY
  WITH owned AS (
    -- DIRECT OWNERSHIP ONLY. Exactly one column decides scope; there is no union.
    SELECT g.*
    FROM public.guest_players g
    WHERE (p_scope = 'academy' AND g.academy_profile_id = p_scope_id)
       OR (p_scope = 'trainer'  AND g.trainer_id        = p_scope_id)
  ),
  meta AS (
    -- Owner-scoped overlay: notes, tags and soft removal. Presentation only, and only for rows
    -- whose owner IS this scope — never another tenant's overlay.
    SELECT m.*
    FROM public.academy_player_metadata m
    WHERE m.guest_player_id IS NOT NULL
      AND ((p_scope = 'academy' AND m.academy_profile_id  = p_scope_id)
        OR (p_scope = 'trainer' AND m.trainer_profile_id = p_scope_id))
  ),
  visible AS (
    SELECT o.*, mt.id AS m_id, mt.tag_ids AS m_tag_ids, mt.notes AS m_notes
    FROM owned o
    LEFT JOIN meta mt ON mt.guest_player_id = o.id
    -- LEFT JOIN + IS NULL keeps guests with NO overlay row and drops soft-removed ones. (An
    -- earlier draft wrote this predicate twice, OR'd with itself — same result, no excuse.)
    WHERE mt.removed_at IS NULL
  ),
  enriched AS (
    SELECT
      v.*,
      (SELECT coalesce(array_agg(DISTINCT loc.lid), '{}'::uuid[]) FROM (
         SELECT apl.location_id AS lid
         FROM public.academy_player_locations apl
         WHERE p_scope = 'academy' AND apl.academy_profile_id = p_scope_id
           AND apl.guest_player_id = v.id AND apl.dismissed = false
         UNION
         -- CONFIRMED/COMPLETED only. A cancelled or still-pending seat is an unverified
         -- observation about who the booking is for; it must not shape displayed state.
         SELECT s.location_id
         FROM public.bookings b
         JOIN public.availability_slots s ON s.id = b.slot_id
         WHERE b.guest_player_id = v.id
           AND b.status IN ('confirmed', 'completed')
           AND s.location_id IS NOT NULL
           AND ((p_scope = 'academy' AND s.academy_profile_id = p_scope_id)
             OR (p_scope = 'trainer' AND s.trainer_id = p_scope_id))
       ) loc) AS p_location_ids,
      EXISTS (
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.guest_player_id = v.id AND s.cyclus_id IS NOT NULL AND s.end_time >= now()
          AND b.status IN ('confirmed', 'completed')
          AND ((p_scope = 'academy' AND s.academy_profile_id = p_scope_id)
            OR (p_scope = 'trainer' AND s.trainer_id = p_scope_id))
      ) AS p_has_cyclus,
      EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.guest_player_id = v.id
          AND ((p_scope = 'academy' AND i.academy_profile_id = p_scope_id)
            OR (p_scope = 'trainer' AND i.trainer_id = p_scope_id))
          -- The effective predecessor's semantics (20261006120000:424-427): a literal
          -- 'overdue' status OR a past-due, unpaid, non-terminal invoice. Restricting this to
          -- the literal status silently under-reports real debt.
          AND (lower(i.status) = 'overdue'
            OR (i.due_date < current_date
                AND i.paid_at IS NULL
                AND lower(coalesce(i.status, '')) NOT IN ('paid','cancelled','draft','void')))
      ) AS p_overdue,
      EXISTS (
        -- The trainer filter, restored WITHOUT the ownership union: the guest is already in
        -- scope by direct ownership, and this only asks whether that guest has independently
        -- in-scope confirmed/completed activity with the named trainer.
        SELECT 1 FROM public.bookings b
        JOIN public.availability_slots s ON s.id = b.slot_id
        WHERE b.guest_player_id = v.id
          AND b.status IN ('confirmed', 'completed')
          AND s.trainer_id = v_filter_trainer
          AND ((p_scope = 'academy' AND s.academy_profile_id = p_scope_id)
            OR (p_scope = 'trainer' AND s.trainer_id = p_scope_id))
      ) AS p_with_filter_trainer
    FROM visible v
  ),
  filtered AS (
    SELECT e.* FROM enriched e
    WHERE (v_tokens IS NULL OR (
            SELECT bool_and(public.fold_search_text(
                     coalesce(e.full_name,'') || ' ' || coalesce(e.email,'') || ' ' || coalesce(e.phone,'')
                   ) LIKE '%' || tok || '%')
            FROM unnest(v_tokens) AS tok))
      AND (v_level_gt IS NULL OR e.skill_rating > v_level_gt)
      AND (v_level_max IS NULL OR e.skill_rating <= v_level_max)
      AND (NOT v_level_unrated OR e.skill_rating IS NULL)
      AND (v_has_cyclus IS NULL OR v_has_cyclus = e.p_has_cyclus)
      AND (v_payment IS NULL OR (v_payment = 'overdue') = e.p_overdue)
      AND (v_filter_location IS NULL OR v_filter_location = ANY (e.p_location_ids))
      AND (v_filter_trainer IS NULL
           OR e.trainer_id = v_filter_trainer
           OR e.p_with_filter_trainer)
      AND (v_tag IS NULL
           OR (v_tag = 'untagged' AND coalesce(array_length(e.m_tag_ids, 1), 0) = 0)
           OR (v_tag <> 'untagged' AND e.m_tag_ids @> ARRAY[v_tag::uuid]))
  )
  SELECT
    'g_' || f.id::text,
    'guest'::text,
    f.id,
    NULL::uuid,                                   -- no registered admission: never a profile
    NULL::uuid,                                   -- see the header: no person UUID escapes
    coalesce(nullif(btrim(f.full_name), ''), 'Unknown'),
    coalesce(f.email, ''),
    coalesce(f.phone, ''),
    f.billing_business_name,
    f.billing_address,
    f.billing_btw_number,
    f.skill_rating,
    coalesce(nullif(f.rating_system, ''), 'knltb'),
    f.notes,
    f.source,
    f.birth_date,
    coalesce(f.has_trained, false),
    f.created_at,
    f.trainer_id,
    f.m_id,
    coalesce(f.m_tag_ids, '{}'::uuid[]),
    f.m_notes,
    CASE WHEN f.trainer_id IS NOT NULL THEN ARRAY[f.trainer_id] ELSE '{}'::uuid[] END,
    f.p_location_ids,
    (SELECT coalesce(array_agg(l.name ORDER BY l.name), '{}'::text[])
       FROM public.locations l WHERE l.id = ANY (f.p_location_ids)),
    f.p_has_cyclus,
    f.p_overdue,
    false,                                        -- deliverability is surfaced by its own reader
    count(*) OVER ()
  FROM filtered f
  ORDER BY
    CASE WHEN p_sort = 'name'       AND coalesce(p_sort_dir,'asc') = 'asc'  THEN f.full_name END ASC,
    CASE WHEN p_sort = 'name'       AND coalesce(p_sort_dir,'asc') = 'desc' THEN f.full_name END DESC,
    CASE WHEN p_sort = 'email'      AND coalesce(p_sort_dir,'asc') = 'asc'  THEN f.email END ASC,
    CASE WHEN p_sort = 'email'      AND coalesce(p_sort_dir,'asc') = 'desc' THEN f.email END DESC,
    CASE WHEN p_sort = 'skill'      AND coalesce(p_sort_dir,'asc') = 'asc'  THEN f.skill_rating END ASC,
    CASE WHEN p_sort = 'skill'      AND coalesce(p_sort_dir,'asc') = 'desc' THEN f.skill_rating END DESC,
    CASE WHEN p_sort = 'created_at' AND coalesce(p_sort_dir,'asc') = 'desc' THEN f.created_at END DESC,
    f.created_at ASC,
    f.id ASC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

COMMENT ON FUNCTION public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer) IS
  'ABC-17/18: directly owned guests only — academy scope is guest_players.academy_profile_id, trainer scope is trainer_id. No active-trainer union (a trainer can serve several academies), no booking-admitted registered profiles (the booking subject is chosen by the slot owner), and no person_links expansion or cross-person dedup (that equality descends from the legacy email/twin bridge). profile_id is always NULL.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8f. `get_person_refs_for_scope` — a clicked guest resolves to itself, and stops.
-- ─────────────────────────────────────────────────────────────────────────────
-- It expanded a clicked guest to the person's OTHER in-scope guests and to the linked profile,
-- and reported `has_login` from `persons.user_id`. Every one of those crosses the bridge: the
-- sibling set and the profile come from `person_links` equality that descends from the legacy
-- email/twin merge, and `has_login` discloses that a guest row is an account holder.
--
-- Now: an in-scope guest returns ONLY itself, `profile_id` NULL, `has_login` false. A clicked
-- PROFILE returns nothing — registered admission is withdrawn, so there is no authorized profile
-- ref to hand back. Signature and grants unchanged.
CREATE OR REPLACE FUNCTION public.get_person_refs_for_scope(
  p_scope text,
  p_scope_id uuid,
  p_guest_id uuid DEFAULT NULL,
  p_profile_id uuid DEFAULT NULL
)
RETURNS TABLE (guest_ids uuid[], profile_id uuid, has_login boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_scope = 'academy' THEN
    IF NOT public.is_academy_manager(auth.uid(), p_scope_id) THEN
      RAISE EXCEPTION 'not authorized for academy %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSIF p_scope = 'trainer' THEN
    IF NOT EXISTS (SELECT 1 FROM public.trainer_profiles tp
                    WHERE tp.id = p_scope_id AND tp.user_id = auth.uid()) THEN
      RAISE EXCEPTION 'not authorized for trainer %', p_scope_id USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'invalid scope: %', p_scope;
  END IF;

  RETURN QUERY
  SELECT ARRAY[g.id], NULL::uuid, false
  FROM public.guest_players g
  WHERE g.id = p_guest_id
    AND ((p_scope = 'academy' AND g.academy_profile_id = p_scope_id)
      OR (p_scope = 'trainer'  AND g.trainer_id        = p_scope_id));
END;
$$;

COMMENT ON FUNCTION public.get_person_refs_for_scope(text, uuid, uuid, uuid) IS
  'ABC-18: a directly owned, in-scope guest resolves to ITSELF only — profile_id NULL, has_login false. Sibling and profile expansion came from person_links equality descended from the legacy email/twin bridge, and has_login disclosed that a guest row is an account holder.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8g. `get_player_locations` — directly scoped guest references only.
-- ─────────────────────────────────────────────────────────────────────────────
-- It authorized the ACADEMY but never the subject, then expanded a guest ref to the person's
-- other guests through `person_links` — so at a shared club it answered "which clubs is this
-- person associated with" for a caller-supplied id. Now the subject must be a guest this scope
-- directly owns, and no expansion happens.
CREATE OR REPLACE FUNCTION public.get_player_locations(
  p_academy_profile_id uuid,
  p_profile_id uuid,
  p_guest_player_id uuid
)
RETURNS TABLE (location_id uuid, location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  -- SUBJECT authorization, which the previous definition never performed.
  IF p_guest_player_id IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.guest_players g
                     WHERE g.id = p_guest_player_id
                       AND g.academy_profile_id = p_academy_profile_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT l.id, l.name
  FROM public.locations l
  WHERE l.id IN (
    SELECT apl.location_id
    FROM public.academy_player_locations apl
    WHERE apl.academy_profile_id = p_academy_profile_id
      AND apl.guest_player_id = p_guest_player_id
      AND apl.dismissed = false
    UNION
    SELECT s.location_id
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE b.guest_player_id = p_guest_player_id
      AND b.status IN ('confirmed', 'completed')   -- same rule as the overview
      AND s.academy_profile_id = p_academy_profile_id
      AND s.location_id IS NOT NULL
  )
  ORDER BY l.name;
END;
$$;

COMMENT ON FUNCTION public.get_player_locations(uuid, uuid, uuid) IS
  'ABC-18: the SUBJECT is authorized, not only the academy — it must be a guest this academy directly owns, and the profile argument is ignored. No person_links expansion: at a shared club the old shape was a cross-tenant player-location oracle.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PASS A1 — profile visibility, roster naming, cycle labels, login flags.
-- ═════════════════════════════════════════════════════════════════════════════
-- Shared rule for a REGISTERED participant whose seat must still be counted: expose no profile
-- or person UUID, no name, no login signal and no bridge-derived identifier. Where a row is
-- needed for compatibility, key it by the BOOKING — a reference to the seat, not to the human —
-- and label it neutrally.

-- 8h. `profiles_public` — nine arms, four withdrawn.
--
-- Withdrawn: (4) is_player_of_trainer, (6) academy-manager-plus-booking, (6b) the
-- linked_profile_id bridge, (9) club-manager-plus-booking. Each admitted a profile on evidence
-- the caller controls — a booking subject they choose, or a guest link they author.
--
-- Retained: (1) public trainers, (2) own profile, (3) admin, (5) academy manager OF THE TRAINER,
-- (7) the caller's OWN booking revealing that trainer's name — the subject there is
-- get_profile_id_for_user(auth.uid()), i.e. caller-bound, so there is nothing to forge — and
-- (8) club manager of the trainer.
--
-- p.user_id IS NOT NULL is added as a global condition: a profile shell with no account is not a
-- public identity and has no business in this view.
CREATE OR REPLACE VIEW public.profiles_public
WITH (security_invoker = off)
AS
SELECT
  p.id, p.user_id, p.full_name, p.avatar_url, p.bio, p.location,
  p.skill_rating, p.rating_system, p.rating_member_id, p.created_at, p.updated_at
FROM public.profiles p
WHERE p.user_id IS NOT NULL
  AND (
    EXISTS (SELECT 1 FROM public.trainer_profiles tp
             WHERE tp.user_id = p.user_id AND tp.is_public = true)
    OR (auth.uid() IS NOT NULL AND p.user_id = auth.uid())
    OR public.is_admin(auth.uid())
    OR p.user_id IN (
      SELECT tp.user_id FROM public.trainer_profiles tp
      JOIN public.academy_trainers atr ON atr.trainer_profile_id = tp.id
      JOIN public.academy_managers am ON am.academy_profile_id = atr.academy_profile_id
      WHERE am.user_id = auth.uid() AND atr.status = 'active'
    )
    OR EXISTS (
      SELECT 1 FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE b.player_id = public.get_profile_id_for_user(auth.uid())
        AND tp.user_id = p.user_id
    )
    OR p.user_id IN (
      SELECT tp.user_id FROM public.trainer_profiles tp
      JOIN public.trainer_locations tl ON tl.trainer_id = tp.id
      JOIN public.club_profiles cp ON cp.location_id = tl.location_id
      JOIN public.club_managers cm ON cm.club_profile_id = cp.id
      WHERE cm.user_id = auth.uid()
    )
  );

GRANT SELECT ON public.profiles_public TO anon, authenticated;

-- 8i. `get_cycle_roster_names` — owned guests by name, everyone else neutral.
CREATE OR REPLACE FUNCTION public.get_cycle_roster_names(_cycle_id uuid)
RETURNS TABLE (id uuid, full_name text, has_login boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_owner_type text;
  v_owner_id uuid;
BEGIN
  SELECT c.owner_type, c.owner_id INTO v_owner_type, v_owner_id
  FROM public.cycles c WHERE c.id = _cycle_id;

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
  SELECT DISTINCT ON (u.uid) u.uid, u.uname, u.ulogin
  FROM (
    -- Directly owned guests: named.
    -- Ownership is judged against THE CYCLE'S OWN SCOPE, not whichever column happens to
    -- match. An academy-owned cycle names academy-owned guests; a trainer-run one names that
    -- trainer's. Accepting either column would let a trainer's private guest be named on an
    -- academy roster merely because that trainer teaches the slot.
    SELECT gp.id AS uid, gp.full_name AS uname, false AS ulogin, 1 AS urank
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    JOIN public.guest_players gp ON gp.id = b.guest_player_id
    WHERE s.cyclus_id = _cycle_id
      AND gp.full_name IS NOT NULL
      AND CASE WHEN v_owner_type = 'academy'
               THEN gp.academy_profile_id = v_owner_id
               ELSE gp.trainer_id = s.trainer_id END
    UNION ALL
    -- Every other seat: the BOOKING id, a neutral label, no login signal.
    SELECT b.id, 'Registered player'::text, false, 2
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE s.cyclus_id = _cycle_id
      AND NOT EXISTS (
        SELECT 1 FROM public.guest_players gp2
        WHERE gp2.id = b.guest_player_id
          AND CASE WHEN v_owner_type = 'academy'
                   THEN gp2.academy_profile_id = v_owner_id
                   ELSE gp2.trainer_id = s.trainer_id END
      )
  ) u
  ORDER BY u.uid, u.urank;
END;
$fn$;

COMMENT ON FUNCTION public.get_cycle_roster_names(uuid) IS
  'ABC-18 A1: names only guests the cycle owner directly owns. Any other seat returns its BOOKING id with a neutral label and has_login = false — no profile or person uuid, no name, no login signal, nothing bridge-derived.';

-- 8j. `get_academy_cyclus_labels` — first names of directly owned guests only.
CREATE OR REPLACE FUNCTION public.get_academy_cyclus_labels(p_academy_profile_id uuid)
RETURNS TABLE (cycle_id uuid, earliest_start timestamptz, first_names text[], location_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
BEGIN
  IF NOT public.is_academy_manager(auth.uid(), p_academy_profile_id) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH cyc AS (
    SELECT c.id, c.location_id FROM public.cycles c
    WHERE c.owner_type = 'academy' AND c.owner_id = p_academy_profile_id AND c.type = 'cyclus'
  ),
  sl AS (
    SELECT s.id AS slot_id, s.cyclus_id, s.start_time, s.location_id
    FROM public.availability_slots s JOIN cyc ON cyc.id = s.cyclus_id
  ),
  earliest AS (
    SELECT DISTINCT ON (cyclus_id) cyclus_id, start_time AS e_start, location_id AS e_loc
    FROM sl ORDER BY cyclus_id, start_time
  ),
  names AS (
    SELECT sl.cyclus_id AS n_cycle,
           coalesce(nullif(btrim(gp.first_name), ''),
                    nullif(split_part(coalesce(gp.full_name, ''), ' ', 1), '')) AS n_first
    FROM sl
    JOIN public.bookings b ON b.slot_id = sl.slot_id
    JOIN public.guest_players gp ON gp.id = b.guest_player_id
    WHERE coalesce(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      AND gp.academy_profile_id = p_academy_profile_id
  )
  SELECT e.cyclus_id, e.e_start,
         (SELECT coalesce(array_agg(DISTINCT n.n_first), '{}'::text[])
            FROM names n WHERE n.n_cycle = e.cyclus_id AND n.n_first IS NOT NULL),
         (SELECT l.name FROM public.locations l WHERE l.id = e.e_loc)
  FROM earliest e;
END;
$fn$;

COMMENT ON FUNCTION public.get_academy_cyclus_labels(uuid) IS
  'ABC-18 A1: first names of DIRECTLY owned guests only. The persons/profile/dual-key fallbacks are withdrawn — a chip row is itself the identity, so there is no neutral form and other seats contribute nothing.';

-- 8k. `get_booking_login_flags` — the login signal is withdrawn.
CREATE OR REPLACE FUNCTION public.get_booking_login_flags(_booking_ids uuid[])
RETURNS TABLE (booking_id uuid, has_login boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT b.id AS booking_id, false AS has_login
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.id = ANY(_booking_ids)
    AND (
      public.is_admin(auth.uid())
      OR s.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      OR (s.academy_profile_id IS NOT NULL
          AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
    );
$fn$;

COMMENT ON FUNCTION public.get_booking_login_flags(uuid[]) IS
  'ABC-18 A1: always false. Every arm disclosed whether a seat belongs to an account holder — via persons.user_id, a caller-chosen booking subject, or person_links. Signature, grants and the authorization gate are unchanged.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PASS A2 — notes, journey, feedback and attendance.
-- ═════════════════════════════════════════════════════════════════════════════
-- Admissible here: explicit admin, the caller's OWN profile (caller-bound, nothing to forge),
-- and a guest the trainer/academy DIRECTLY owns. Withdrawn everywhere: person equality,
-- twin/linked bridges, and booking evidence used to establish who a subject IS.

-- 8l. `subject_guest_reads_as_me` — fails closed.
-- Its three arms were person equality, the twin bridge and the linked bridge. A guest row has no
-- login, so nothing non-bridge can tie one to the caller; there is no narrower version to keep.
CREATE OR REPLACE FUNCTION public.subject_guest_reads_as_me(_guest_player_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT false;
$fn$;

COMMENT ON FUNCTION public.subject_guest_reads_as_me(uuid) IS
  'ABC-18 A2: always false. Person equality, twin_of_profile_id and linked_profile_id were its only arms, and a guest row carries no login, so no non-bridge evidence can tie one to the caller.';

-- 8m. session_player_notes — SELECT.
-- The subject arm keeps only the caller''s own profile. The trainer/academy oversight arms keep
-- slot ownership, but a note ABOUT a registered player is no longer readable through them unless
-- the caller wrote it — owning the slot is not consent to that person''s coaching history.
DROP POLICY IF EXISTS spn_select_subject_player ON public.session_player_notes;
CREATE POLICY spn_select_subject_player ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    author_role IN ('trainer','academy')
    AND visibility = 'shared'
    AND subject_profile_id = public.get_profile_id_for_user(auth.uid())
  );

DROP POLICY IF EXISTS spn_select_trainer ON public.session_player_notes;
CREATE POLICY spn_select_trainer ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = session_player_notes.slot_id AND tp.user_id = auth.uid()
    )
    AND (author_role IN ('trainer','academy') OR (author_role = 'player' AND visibility = 'shared'))
    AND (
      author_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.guest_players gp
        JOIN public.trainer_profiles tp2 ON tp2.id = gp.trainer_id
        WHERE gp.id = session_player_notes.subject_guest_player_id AND tp2.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS spn_select_academy ON public.session_player_notes;
CREATE POLICY spn_select_academy ON public.session_player_notes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = session_player_notes.slot_id
        AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
    AND (author_role IN ('trainer','academy') OR (author_role = 'player' AND visibility = 'shared'))
    AND (
      author_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.guest_players gp
        WHERE gp.id = session_player_notes.subject_guest_player_id
          AND gp.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
      )
    )
  );

-- 8n. session_player_notes — INSERT. A booking no longer authorizes writing about a subject.
DROP POLICY IF EXISTS spn_insert_trainer ON public.session_player_notes;
CREATE POLICY spn_insert_trainer ON public.session_player_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid() AND author_role = 'trainer'
    AND subject_profile_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.availability_slots s
      JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
      WHERE s.id = slot_id AND tp.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.guest_players gp
      JOIN public.trainer_profiles tp2 ON tp2.id = gp.trainer_id
      WHERE gp.id = subject_guest_player_id AND tp2.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = session_player_notes.slot_id
        AND b.guest_player_id = subject_guest_player_id
        AND b.status IN ('pending','confirmed','completed')
    )
  );

DROP POLICY IF EXISTS spn_insert_academy ON public.session_player_notes;
CREATE POLICY spn_insert_academy ON public.session_player_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid() AND author_role = 'academy'
    AND subject_profile_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.availability_slots s
      WHERE s.id = slot_id AND s.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
    AND EXISTS (
      SELECT 1 FROM public.guest_players gp
      WHERE gp.id = subject_guest_player_id
        AND gp.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid()))
    )
    AND EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.slot_id = session_player_notes.slot_id
        AND b.guest_player_id = subject_guest_player_id
        AND b.status IN ('pending','confirmed','completed')
    )
  );

-- 8o. `can_report_attendance_on_slot` — the caller''s own pure-profile seat only.
-- That arm is caller-bound: the subject IS auth.uid()''s profile, so there is nothing to forge.
-- The guest arm was person-stamp plus the twin/linked bridge and is withdrawn.
-- `session_reports_player_summaries` reads through this function, so it narrows with it and
-- needs no separate re-emit (its column tripwire stays intact).
CREATE OR REPLACE FUNCTION public.can_report_attendance_on_slot(
  _slot_id uuid,
  _require_active boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    WHERE b.slot_id = _slot_id
      AND (NOT _require_active
           OR COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap'))
      AND b.player_id = public.get_profile_id_for_user(auth.uid())
      AND b.guest_player_id IS NULL
  );
$fn$;

COMMENT ON FUNCTION public.can_report_attendance_on_slot(uuid, boolean) IS
  'ABC-18 A2: the caller''s OWN pure-profile seat only — caller-bound, so nothing is forgeable. The guest arm (person stamp plus the twin/linked bridge) is withdrawn. FAM-02 dual-keyed rows still grant nothing here.';


-- 8p. `get_player_journey` — self or admin, and no bridge-derived guest set.
-- The two booking arms let a trainer or academy read a registered player''s entire coaching
-- history by authoring a booking naming them. Withdrawn. `v_guest_ids` was the person/twin/
-- linked ref-set; it is now always empty, so guest-seated sessions and guest-keyed notes no
-- longer attach to a profile. Signature, paging, ordering and content shape are unchanged.
CREATE OR REPLACE FUNCTION public.get_player_journey(
  p_profile_id uuid,
  p_limit  integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  slot_id uuid, start_time timestamptz, end_time timestamptz, trainer_id uuid,
  trainer_name text, academy_profile_id uuid, location_name text,
  session_happened boolean, trainer_confirmed boolean, player_confirmed boolean,
  group_summary text, shared_coaching_notes jsonb, own_notes jsonb,
  rating_at_session numeric, rating_system text, total_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_limit  integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
  -- COALESCE is load-bearing: get_profile_id_for_user returns NULL for a caller with no
  -- profile row, so a bare `p_profile_id = ...` yields NULL and `IF NOT (NULL)` does NOT raise —
  -- the gate would open for precisely the callers it exists to stop.
  IF NOT (coalesce(p_profile_id = public.get_profile_id_for_user(auth.uid()), false)
          OR coalesce(public.is_admin(auth.uid()), false)) THEN
    RAISE EXCEPTION 'not authorized for player %', p_profile_id USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH seats AS (
    SELECT b.slot_id AS b_slot
    FROM public.bookings b
    WHERE b.player_id = p_profile_id AND b.guest_player_id IS NULL
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
  ),
  base AS (
    SELECT s.id, s.start_time, s.end_time, s.trainer_id, s.academy_profile_id, s.location_id
    FROM public.availability_slots s
    WHERE s.id IN (SELECT b_slot FROM seats)
  )
  SELECT
    ba.id, ba.start_time, ba.end_time, ba.trainer_id,
    (SELECT pr.full_name FROM public.profiles pr
      JOIN public.trainer_profiles tp ON tp.user_id = pr.user_id
      WHERE tp.id = ba.trainer_id),
    ba.academy_profile_id,
    (SELECT l.name FROM public.locations l WHERE l.id = ba.location_id),
    (SELECT sr.session_happened FROM public.session_reports sr
      WHERE sr.slot_id = ba.id ORDER BY (sr.reporter_role = 'trainer') DESC LIMIT 1),
    EXISTS (SELECT 1 FROM public.session_reports sr WHERE sr.slot_id = ba.id AND sr.reporter_role = 'trainer'),
    EXISTS (SELECT 1 FROM public.session_reports sr WHERE sr.slot_id = ba.id AND sr.reporter_role = 'player'),
    (SELECT sr.public_notes FROM public.session_reports sr
      WHERE sr.slot_id = ba.id AND sr.reporter_role = 'trainer' LIMIT 1),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'author_role', n.author_role,
                                                  'body', n.body, 'created_at', n.created_at))
                FROM public.session_player_notes n
               WHERE n.slot_id = ba.id AND n.visibility = 'shared'
                 AND n.author_role IN ('trainer','academy')
                 AND n.subject_profile_id = p_profile_id), '[]'::jsonb),
    coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'visibility', n.visibility,
                                                  'body', n.body, 'created_at', n.created_at))
                FROM public.session_player_notes n
               WHERE n.slot_id = ba.id AND n.author_role = 'player'
                 AND n.subject_profile_id = p_profile_id), '[]'::jsonb),
    NULL::numeric, NULL::text,
    count(*) OVER ()
  FROM base ba
  ORDER BY ba.start_time DESC
  LIMIT v_limit OFFSET v_offset;
END;
$fn$;

COMMENT ON FUNCTION public.get_player_journey(uuid, integer, integer) IS
  'ABC-18 A2: self or admin only. The trainer/academy booking arms let staff read a registered player''s whole coaching history by authoring a booking naming them. The person/twin/linked guest ref-set is gone, so only the caller''s own pure-profile seats appear.';

-- 8q. `get_unseen_shared_feedback_count` — same ref-set removal; gate already self/admin.
CREATE OR REPLACE FUNCTION public.get_unseen_shared_feedback_count(p_profile_id uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $fn$
DECLARE
  v_count integer;
BEGIN
  -- Same NULL-safety as get_player_journey: `<>` against a NULL profile yields NULL, not true.
  IF NOT (coalesce(p_profile_id = public.get_profile_id_for_user(auth.uid()), false)
          OR coalesce(public.is_admin(auth.uid()), false)) THEN
    RAISE EXCEPTION 'not authorized for player %', p_profile_id USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::int INTO v_count
  FROM public.session_player_notes n
  WHERE n.visibility = 'shared'
    AND n.author_role IN ('trainer','academy')
    AND n.subject_profile_id = p_profile_id
    AND NOT EXISTS (
      SELECT 1 FROM public.coaching_note_views v
      WHERE v.note_id = n.id AND v.profile_id = p_profile_id
    );

  RETURN coalesce(v_count, 0);
END;
$fn$;

COMMENT ON FUNCTION public.get_unseen_shared_feedback_count(uuid) IS
  'ABC-18 A2: counts shared notes keyed to the caller''s own profile. The person/twin/linked guest ref-set is withdrawn.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PASS A3 — booking ownership, payment visibility, priority and member window.
-- ═════════════════════════════════════════════════════════════════════════════
-- The rule these five share: a PURE-PROFILE row is the only self-evidence. The authenticated
-- profile must be directly and unambiguously the subject — `player_id = me AND
-- guest_player_id IS NULL`. Guest, linked, twin, person-expanded and dual-key variants do not
-- qualify, because each of them derives from a signal someone else authored.
--
-- Capacity, tier, member-window timing, payment and invoice state, booking status, slot/cycle
-- ownership and cancellation rules are untouched: only identity evidence is withdrawn.

-- 8r. `get_my_linked_guest_bookings` — fails closed.
-- The whole function IS the linked-guest booking path: it selects rows where
-- `guest_player_id IS NOT NULL` and then decides they are the caller's via the person stamp or
-- the twin/linked bridge. There is no pure-profile remainder to keep. The caller's own
-- pure-profile bookings were never in here — they come through the player RLS policies, which
-- 20260826290000 already made pure-profile and which this slice leaves alone.
CREATE OR REPLACE FUNCTION public.get_my_linked_guest_bookings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN '[]'::jsonb;
END;
$fn$;

COMMENT ON FUNCTION public.get_my_linked_guest_bookings() IS
  'ABC-18 A3: always []. Every row it returned was a GUEST booking claimed for the caller through the person stamp or the twin/linked bridge — staff-authored evidence about who an account represents. Pure-profile bookings are unaffected; they never came through here.';

-- 8s. `get_my_paid_booking_ids` — pure-profile invoices only.
CREATE OR REPLACE FUNCTION public.get_my_paid_booking_ids()
RETURNS TABLE (booking_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_profile uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT DISTINCT bid
  FROM public.invoices i
  CROSS JOIN LATERAL unnest(coalesce(i.booking_ids, '{}'::uuid[])) AS bid
  WHERE i.status = 'paid'                      -- payment semantics unchanged
    AND i.player_id = v_profile
    AND i.guest_player_id IS NULL;             -- dual-key belongs to the guest, not to me
END;
$fn$;

COMMENT ON FUNCTION public.get_my_paid_booking_ids() IS
  'ABC-18 A3: pure-profile invoices only (player_id = me AND guest_player_id IS NULL). The person-stamp and twin/linked arms let a staff-authored link expose another account''s payment state. Invoice status semantics are unchanged.';

-- 8t. `get_my_pending_priority_claims` — explicit pure-profile claims only.
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
AS $fn$
DECLARE
  v_profile uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT c.id, c.claim_token, c.slot_id, c.rebook_group_id,
         s.start_time, s.end_time, s.cyclus_id, s.cyclus_name,
         s.price_per_session, s.priority_window_ends_at
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  WHERE c.status = 'pending'                   -- claim status semantics unchanged
    AND c.player_id = v_profile
    AND c.guest_player_id IS NULL;             -- a dual-key claim belongs to the guest
END;
$fn$;

COMMENT ON FUNCTION public.get_my_pending_priority_claims() IS
  'ABC-18 A3: explicit pure-profile claims only. The person-stamp and twin/linked arms let a staff-authored guest link hand one account another''s rebooking priority.';

-- 8u. `is_cycle_member` — pure-profile seats only.
-- The guest arm resolved through `guest_verified_account_profile`, i.e. person_links → twin →
-- linked. Grants are unchanged (service_role only), and so is the cancelled-status filter that
-- capacity and tier logic depend on.
CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id)
  SELECT EXISTS (
    SELECT 1
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE s.cyclus_id = _cycle_id
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
      AND b.guest_player_id IS NULL
      AND b.player_id = (SELECT id FROM me)
  );
$fn$;

COMMENT ON FUNCTION public.is_cycle_member(uuid, uuid) IS
  'ABC-18 A3: pure-profile seats only. The guest arm resolved through guest_verified_account_profile (person_links → twin → linked), which is staff-authored. Status filtering, and therefore capacity and tier behaviour, is unchanged.';

-- 8v. `can_book_member_window` — pure-profile rebooker, pure-profile claim, explicit list.
-- Retained: (a) narrowed to a pure-profile seat, (b) the pure-profile priority claim, and
-- (c) the cycle's explicit `rebook_priority_people` profile list. Withdrawn: (d) and (e), the
-- guest-claim and linked-ex-guest arms, both of which resolve identity through person_links or
-- the twin/linked bridge. Window TIMING is untouched — this function is an eligibility gate
-- only and never affects capacity.
CREATE OR REPLACE FUNCTION public.can_book_member_window(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH me AS (SELECT id FROM public.profiles WHERE user_id = _user_id LIMIT 1)
  SELECT
    -- (a) existing rebooker, pure-profile seat
    EXISTS (
      SELECT 1
      FROM public.bookings b
      JOIN public.availability_slots s ON s.id = b.slot_id
      WHERE s.cyclus_id = _cycle_id
        AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')
        AND b.guest_player_id IS NULL
        AND b.player_id = (SELECT id FROM me)
    )
    -- (b) original cohort: an explicit PURE-PROFILE priority claim in this round
    OR EXISTS (
      SELECT 1
      FROM public.slot_priority_claims spc
      JOIN public.availability_slots s ON s.id = spc.slot_id
      WHERE s.source_cycle_id = _cycle_id
        AND spc.player_id = (SELECT id FROM me)
        AND spc.guest_player_id IS NULL
    )
    -- (c) the cycle's explicit registered priority list — a profile id staff named directly,
    --     not an identity inferred from a guest row
    OR EXISTS (
      SELECT 1
      FROM public.cycles c
      WHERE c.id = _cycle_id
        AND COALESCE(c.settings->'rebook_priority_people', '[]'::jsonb) ? (SELECT id::text FROM me)
    );
$fn$;

COMMENT ON FUNCTION public.can_book_member_window(uuid, uuid) IS
  'ABC-18 A3: a pure-profile seat in the cycle, an explicit pure-profile priority claim, or the cycle''s explicit rebook_priority_people list. The guest-claim and linked-ex-guest arms are withdrawn — both resolved identity through person_links or the twin/linked bridge. Pure authorization gate: it never affects capacity, and window timing is unchanged.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 8w. A3 correction — the RLS policy and can_book_slot, not just the RPCs.
-- ─────────────────────────────────────────────────────────────────────────────
-- A3 narrowed `get_my_pending_priority_claims`, but that reader was never the only way in. The
-- underlying SELECT policy still matched a raw `player_id`, so a DUAL-KEY claim — one naming a
-- parent profile alongside a child's guest row — disclosed its `claim_token` straight from the
-- table. That token is the bearer credential `respond_to_priority_claim` accepts, so the leak
-- was equivalent to letting the parent accept or decline the child's seat.
--
-- The responder is token-authorized and is deliberately left as shipped: closing the disclosure
-- closes the path, and rewriting a token check would alter unrelated accept/release semantics.
-- The slot-owner/admin policy is independently valid (it authorizes on slot OWNERSHIP, not on
-- who the claim names) and is likewise untouched.
DROP POLICY IF EXISTS "Players read own priority claims" ON public.slot_priority_claims;
CREATE POLICY "Players read own priority claims"
  ON public.slot_priority_claims
  FOR SELECT
  TO authenticated
  USING (
    player_id = public.get_profile_id_for_user(auth.uid())
    AND guest_player_id IS NULL   -- a dual-key claim belongs to the GUEST, not to this account
  );

-- `can_book_slot` — the priority tier gate carried the same raw arm, so a dual-key claim also
-- bought a booking. Re-emitted from its effective definition (20260925100000) with ONLY that
-- predicate added: tier resolution, the members window, the hidden tier, the booking cutoff and
-- the return contract are byte-for-byte what shipped. Capacity, status, payment and cancellation
-- live elsewhere and are untouched.
CREATE OR REPLACE FUNCTION public.can_book_slot(_slot_id uuid, _user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_tier    text := public.resolve_slot_booking_tier(_slot_id);
  v_profile uuid := public.get_profile_id_for_user(_user_id);
  v_src     uuid;
BEGIN
  IF v_tier = 'priority' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.slot_priority_claims
      WHERE slot_id = _slot_id
        AND player_id = v_profile
        AND guest_player_id IS NULL      -- ABC-18 A3: pure-profile claims only
        AND status IN ('pending', 'claimed')
    ) THEN
      RETURN 'priority_restricted';
    END IF;

  ELSIF v_tier = 'members' THEN
    SELECT source_cycle_id INTO v_src FROM public.availability_slots WHERE id = _slot_id;
    IF NOT COALESCE(public.can_book_member_window(_user_id, v_src), false) THEN
      RETURN 'members_only';
    END IF;

  ELSIF v_tier = 'hidden' THEN
    RETURN 'slot_not_released';
  END IF;

  -- Booking cutoff, last: the player may be eligible for this tier and still be too late.
  IF public.is_slot_within_player_booking_cutoff(_slot_id) THEN
    RETURN 'booking_cutoff';
  END IF;

  RETURN '';  -- 'public', or eligible for the current tier
END;
$fn$;

COMMENT ON FUNCTION public.can_book_slot(uuid, uuid) IS
  'ABC-18 A3 correction: the priority tier requires a PURE-PROFILE claim (player_id = me AND guest_player_id IS NULL) — a dual-key claim belongs to the guest. Tier resolution, the members window, the hidden tier, booking cutoff and the return contract are unchanged.';

-- ═════════════════════════════════════════════════════════════════════════════
-- ABC-20 — transitional rebook-invoice idempotency, guest-first.
-- ═════════════════════════════════════════════════════════════════════════════
-- `uq_invoices_rebook_cyclus_claimant` (20260705130000:22) keys on
-- `COALESCE(player_id, guest_player_id)` — PROFILE-FIRST. On a DUAL-KEY invoice that resolves to
-- the profile, which contradicts the FAM-02 rule the rest of this system now follows: a row
-- carrying both columns belongs to the GUEST, and the profile column beside it is legacy
-- decoration. Two consequences, both live:
--
--   * a guest's dual-key invoice and a DIFFERENT person's pure-profile invoice for the same
--     cyclus collapse onto one index key, so one of them cannot be created;
--   * the same guest can hold two active invoices for one cyclus — one dual-key, one guest-only —
--     because the profile-first key separates rows that are the same person.
--
-- Replacement: two partial indexes that never rewrite a row.
--
--   guest rows        UNIQUE (rebook_cyclus_id, guest_player_id)  WHERE guest_player_id IS NOT NULL
--   pure-profile rows UNIQUE (rebook_cyclus_id, player_id)        WHERE guest_player_id IS NULL
--
-- The two predicates PARTITION the space (guest_player_id is either null or not), so every active
-- rebook invoice is covered by exactly one of them and nothing is double-constrained.
--
-- TRANSITIONAL. The end state is a single key on canonical `persons.id`, which U2 owns; that
-- cannot be used yet because person stamps descend from the legacy bridge this containment has
-- just declared non-authoritative. These indexes hold the line until then.
--
-- NO ROW IS TOUCHED. If existing data cannot satisfy the new shape the migration REFUSES and
-- changes nothing — no merge, no cancel, no re-key, no inference about who anyone is.

-- ── preflight: refuse rather than repair ────────────────────────────────────────────────────
DO $$
DECLARE
  v_guest_dupes   text;
  v_profile_dupes text;
BEGIN
  SELECT string_agg(format('cyclus=%s guest=%s (%s invoices)', rebook_cyclus_id, guest_player_id, n), '; ')
    INTO v_guest_dupes
    FROM (
      SELECT rebook_cyclus_id, guest_player_id, count(*) AS n
        FROM public.invoices
       WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled' AND guest_player_id IS NOT NULL
       GROUP BY rebook_cyclus_id, guest_player_id
      HAVING count(*) > 1
    ) d;

  SELECT string_agg(format('cyclus=%s player=%s (%s invoices)', rebook_cyclus_id, player_id, n), '; ')
    INTO v_profile_dupes
    FROM (
      SELECT rebook_cyclus_id, player_id, count(*) AS n
        FROM public.invoices
       WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled'
         AND guest_player_id IS NULL AND player_id IS NOT NULL
       GROUP BY rebook_cyclus_id, player_id
      HAVING count(*) > 1
    ) d;

  IF v_guest_dupes IS NOT NULL OR v_profile_dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'ABC-20 refused: existing active rebook invoices already violate the guest-first uniqueness contract. Guest conflicts: [%]. Pure-profile conflicts: [%]. No row was changed. Resolve these deliberately (an owner decision about WHICH invoice stands) before re-running; this migration will not merge, cancel or re-key anything.',
      coalesce(v_guest_dupes, 'none'), coalesce(v_profile_dupes, 'none');
  END IF;
END $$;

-- ── the swap ────────────────────────────────────────────────────────────────────────────────
-- Drop first: the old profile-first key would otherwise keep rejecting exactly the pairs the new
-- contract is meant to allow (a guest's dual-key invoice alongside another person's pure-profile
-- invoice for the same cyclus).
DROP INDEX IF EXISTS public.uq_invoices_rebook_cyclus_claimant;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_rebook_cyclus_guest
  ON public.invoices (rebook_cyclus_id, guest_player_id)
  WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled' AND guest_player_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_rebook_cyclus_pure_profile
  ON public.invoices (rebook_cyclus_id, player_id)
  WHERE rebook_cyclus_id IS NOT NULL AND status <> 'cancelled'
    AND guest_player_id IS NULL AND player_id IS NOT NULL;

COMMENT ON INDEX public.uq_invoices_rebook_cyclus_guest IS
  'ABC-20: one active rebook invoice per (cyclus, guest). Covers dual-key rows — a row carrying both columns belongs to the GUEST (FAM-02).';
COMMENT ON INDEX public.uq_invoices_rebook_cyclus_pure_profile IS
  'ABC-20: one active rebook invoice per (cyclus, profile), PURE-PROFILE rows only. Transitional until U2 can key on canonical persons.id.';

-- ── install assertion ───────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_claimant') THEN
    RAISE EXCEPTION 'ABC-20: the profile-first rebook index is still installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_guest')
     OR NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_pure_profile') THEN
    RAISE EXCEPTION 'ABC-20: a guest-first rebook index is missing';
  END IF;
  -- the pure-profile index must be restricted to guest-null rows, or it re-creates the collision
  IF (SELECT pg_get_indexdef(oid) FROM pg_class WHERE relname = 'uq_invoices_rebook_cyclus_pure_profile')
     !~ 'guest_player_id IS NULL' THEN
    RAISE EXCEPTION 'ABC-20: the pure-profile rebook index must exclude dual-key rows';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ABC-20 cluster — the token boundaries resolve identity guest-first.
-- ═════════════════════════════════════════════════════════════════════════════
-- Canonical rule (FAM-02, the same one personRefOf/personKeyOf encode in TS): a row carrying
-- BOTH identity columns belongs to the GUEST; the player_id beside it is legacy link decoration.
-- Resolution order is therefore: guest present → guest only; else player present → pure-profile
-- (guest must be null); else fail closed. No boundary may run an UNSCOPED sibling query.

-- ── 1. the claim-by-token boundary now SUPPLIES the identity it is resolved by ───────────────
-- The claim object exposed only {id, status, claim_token}, so the browser had nothing to resolve
-- and had to infer the claimant elsewhere. Adding the two columns is what lets the client apply
-- the same guest-first rule instead of guessing — and it is what makes the pure-profile sibling
-- sweep possible AT ALL, since a caller with no identity can only be given the fail-closed path.
--
-- `player_name` also becomes guest-first: on a dual-key claim the profile join won and the page
-- showed the ACCOUNT HOLDER's name over a seat that belongs to the guest.
CREATE OR REPLACE FUNCTION public.get_priority_claim_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'claim', jsonb_build_object(
      'id', c.id,
      'status', c.status,
      'claim_token', c.claim_token,
      -- ABC-20: the caller resolves these guest-first (personRefOf). Exposed so the client
      -- applies the shared rule rather than inferring identity from anything else.
      'player_id', c.player_id,
      'guest_player_id', c.guest_player_id
    ),
    'slot', jsonb_build_object(
      'id', s.id, 'start_time', s.start_time, 'end_time', s.end_time,
      'cyclus_id', s.cyclus_id, 'cyclus_name', s.cyclus_name, 'location_id', s.location_id,
      'price_per_session', s.price_per_session, 'total_price', s.total_price,
      'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id, 'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*)
      FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    -- guest-first: a dual-key claim is the GUEST's seat, so it must not display the account
    -- holder's name.
    'player_name', COALESCE(gp.full_name, p.full_name),
    'booked_by_captain_name', CASE
      WHEN c.booked_by_player_id IS NOT NULL OR c.booked_by_guest_player_id IS NOT NULL
      THEN COALESCE(NULLIF(bgp.first_name, ''), NULLIF(split_part(bgp.full_name, ' ', 1), ''),
                    NULLIF(bp.first_name, ''), NULLIF(split_part(bp.full_name, ' ', 1), ''))
      ELSE NULL
    END,
    'rebook_rules', (SELECT cy.settings->>'rebook_rules' FROM public.cycles cy WHERE cy.id = s.cyclus_id),
    'rebook_claim_info', (SELECT cy.settings->>'rebook_claim_info' FROM public.cycles cy WHERE cy.id = s.cyclus_id),
    'rebook_payment_mode', (
      SELECT CASE WHEN cy.settings->>'rebook_payment_mode' = 'upfront' THEN 'upfront' ELSE 'deferred_split' END
      FROM public.cycles cy WHERE cy.id = s.cyclus_id
    ),
    'split_payment', (
      SELECT COALESCE((cy.settings->>'split_payment')::boolean, false)
      FROM public.cycles cy WHERE cy.id = s.cyclus_id
    )
  )
  INTO result
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  LEFT JOIN public.profiles p ON p.id = c.player_id
  LEFT JOIN public.guest_players gp ON gp.id = c.guest_player_id
  LEFT JOIN public.profiles bp ON bp.id = c.booked_by_player_id
  LEFT JOIN public.guest_players bgp ON bgp.id = c.booked_by_guest_player_id
  WHERE c.claim_token = _token
  LIMIT 1;

  RETURN result;
END;
$fn$;

COMMENT ON FUNCTION public.get_priority_claim_by_token(text) IS
  'ABC-20: supplies player_id and guest_player_id so the caller resolves the claimant guest-first (personRefOf), and names the claimant guest-first — a dual-key claim is the GUEST''s seat.';

-- ── 3. the resume-payment boundary is guest-first ────────────────────────────────────────────
-- Both branches tested `c.player_id IS NOT NULL` FIRST, so a DUAL-KEY guest token resolved to
-- the profile and could be handed the public_token of a PURE-PROFILE invoice — a different
-- person's payment page, complete with their amount and their seats.
--
-- Now: guest present → match invoices by guest_player_id; else pure-profile, and the invoice must
-- itself be pure (i.guest_player_id IS NULL) so the profile branch cannot reach a guest's
-- dual-key invoice either. Neither present → fail closed.
CREATE OR REPLACE FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c public.slot_priority_claims%ROWTYPE;
  v_cyclus_id uuid;
  v_inv public.invoices%ROWTYPE;
  v_gid uuid;
  v_pid uuid;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- guest-first resolution, once
  v_gid := c.guest_player_id;
  v_pid := CASE WHEN c.guest_player_id IS NOT NULL THEN NULL ELSE c.player_id END;
  IF v_gid IS NULL AND v_pid IS NULL THEN RETURN NULL; END IF;   -- fail closed

  IF c.rebook_group_id IS NOT NULL THEN
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_group_id = c.rebook_group_id
      AND ((v_gid IS NOT NULL AND i.guest_player_id = v_gid)
        OR (v_pid IS NOT NULL AND i.player_id = v_pid AND i.guest_player_id IS NULL))
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  ELSE
    SELECT s.cyclus_id INTO v_cyclus_id FROM public.availability_slots s WHERE s.id = c.slot_id;
    IF v_cyclus_id IS NULL THEN RETURN NULL; END IF;
    SELECT i.* INTO v_inv FROM public.invoices i
    WHERE i.rebook_cyclus_id = v_cyclus_id
      AND ((v_gid IS NOT NULL AND i.guest_player_id = v_gid)
        OR (v_pid IS NOT NULL AND i.player_id = v_pid AND i.guest_player_id IS NULL))
      AND i.status NOT IN ('paid', 'cancelled', 'draft')
      AND i.public_token IS NOT NULL
      AND i.public_token_revoked_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('public_token', v_inv.public_token, 'status', v_inv.status);
END;
$fn$;

COMMENT ON FUNCTION public.get_unpaid_rebook_invoice_by_claim_token(text) IS
  'ABC-20: guest-first. A dual-key guest token matches invoices by guest_player_id and can never be handed a PURE-PROFILE invoice''s public_token; the profile branch requires the invoice itself be pure. Neither identity ⇒ NULL.';

-- ── install assertions ──────────────────────────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_priority_claim_by_token';
  IF v_src !~ '''player_id'', c\.player_id' OR v_src !~ '''guest_player_id'', c\.guest_player_id' THEN
    RAISE EXCEPTION 'ABC-20: get_priority_claim_by_token must expose both identity columns';
  END IF;
  IF v_src !~ 'COALESCE\(gp\.full_name, p\.full_name\)' THEN
    RAISE EXCEPTION 'ABC-20: get_priority_claim_by_token must name the claimant guest-first';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_unpaid_rebook_invoice_by_claim_token';
  -- the profile branch must never reach a dual-key invoice
  IF v_src !~ 'i\.player_id = v_pid AND i\.guest_player_id IS NULL' THEN
    RAISE EXCEPTION 'ABC-20: the resume-payment profile branch must require a PURE-PROFILE invoice';
  END IF;
  IF v_src ~ 'c\.player_id IS NOT NULL AND i\.player_id = c\.player_id' THEN
    RAISE EXCEPTION 'ABC-20: the resume-payment boundary is still profile-first';
  END IF;
END $$;

-- ── 5. the group RPCs use namespaced GUEST-FIRST identity ───────────────────────────────────
-- Two distinct defects, both from resolving profile-first on dual-key rows:
--
--   * `get_rebook_group_by_token` built member keys as
--     `CASE WHEN player_id IS NOT NULL THEN 'p:'||player ELSE 'g:'||guest END`. A dual-key row
--     therefore keyed as `p:<stale player_id>` — so TWO DIFFERENT GUESTS sharing one legacy
--     player_id collapsed into a single group member, and `is_self` could match the wrong person.
--
--   * `rebook_group_apply` / `rebook_group_manage` matched with a raw OR:
--       (player_id = ANY(keep_player)) OR (guest_player_id = ANY(keep_guest))
--     A dual-key row matched through the PLAYER arm even though it belongs to the guest, so
--     keeping or removing by profile id swept guest seats — and, in manage, booked and PAID them.
--
-- The transform is exclusive rather than preferential: guest present ⇒ decide ONLY by guest;
-- otherwise decide only by a pure player. Bodies are otherwise re-emitted unchanged, so capacity,
-- status, cutoff, group and payment semantics are untouched.

CREATE OR REPLACE FUNCTION public.get_rebook_group_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_self_key text;
  v_members jsonb;
  v_paid boolean;
  v_invoice_id uuid;
  v_invoice_status text;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  v_self_key := CASE WHEN c.guest_player_id IS NOT NULL THEN 'g:' || c.guest_player_id::text
                     ELSE 'p:' || c.player_id::text END;

  -- Has the captain already paid for their group seat? (drives can_manage_group)
  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = c.booking_id AND b.payment_status = 'paid'
  ) INTO v_paid;

  -- The single active group invoice for this group (NULL until someone pays-first).
  SELECT id, status INTO v_invoice_id, v_invoice_status FROM public.invoices
  WHERE rebook_group_id = c.rebook_group_id AND status <> 'cancelled'
  ORDER BY created_at DESC LIMIT 1;

  SELECT jsonb_agg(m ORDER BY m->>'first_name')
  INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'key', CASE WHEN g.guest_player_id IS NOT NULL THEN 'g:' || g.guest_player_id::text
                  ELSE 'p:' || g.player_id::text END,
      'first_name', COALESCE(NULLIF(p.first_name, ''), NULLIF(split_part(p.full_name, ' ', 1), ''),
                             NULLIF(gp.first_name, ''), NULLIF(split_part(gp.full_name, ' ', 1), ''), '—'),
      'status', CASE WHEN bool_or(g.status = 'claimed') THEN 'claimed'
                     WHEN bool_or(g.status = 'pending') THEN 'pending'
                     ELSE 'declined' END,
      'is_self', (CASE WHEN g.guest_player_id IS NOT NULL THEN 'g:' || g.guest_player_id::text
                       ELSE 'p:' || g.player_id::text END) = v_self_key,
      'has_email', COALESCE(NULLIF(p.email, '') IS NOT NULL OR NULLIF(gp.email, '') IS NOT NULL, false)
    ) AS m
    FROM public.slot_priority_claims g
    LEFT JOIN public.profiles p ON p.id = g.player_id
    LEFT JOIN public.guest_players gp ON gp.id = g.guest_player_id
    WHERE g.rebook_group_id = c.rebook_group_id
    GROUP BY g.player_id, g.guest_player_id, p.first_name, p.full_name, p.email, gp.first_name, gp.full_name, gp.email
  ) sub;

  RETURN jsonb_build_object(
    'rebook_group_id', c.rebook_group_id,
    -- PAID group invoice ⇒ the court is settled: no member may start another group pay
    -- (or be shown the buttons). An UNPAID active invoice keeps this true so any member
    -- can complete an abandoned captain checkout (double-pay guard re-serves it).
    'can_rebook_group', (c.status = 'pending'
      AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())
      AND COALESCE(v_invoice_status, '') <> 'paid'),
    -- The captain paid up front → may keep managing the roster even though their claim is 'claimed'.
    'can_manage_group', (c.status = 'claimed' AND v_paid),
    'group_invoice_id', v_invoice_id,
    'group_invoice_status', v_invoice_status,
    'self_key', v_self_key,
    'slot', jsonb_build_object(
      'id', s.id, 'start_time', s.start_time, 'end_time', s.end_time,
      'cyclus_id', s.cyclus_id, 'cyclus_name', s.cyclus_name,
      'price_per_session', s.price_per_session, 'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id, 'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*) FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    'members', COALESCE(v_members, '[]'::jsonb)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rebook_group_apply(
  _token text,
  _keep_keys jsonb DEFAULT '[]'::jsonb,
  _new_guest_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_group uuid;
  v_cap_player uuid;
  v_cap_guest uuid;
  v_keep_player uuid[] := '{}';
  v_keep_guest uuid[] := '{}';
  v_seats integer;
  v_max integer;
  v_booking_id uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_skipped_full integer := 0;
  v_skipped_existing integer := 0;
  v_added integer := 0;
  v_is_own boolean;
  v_existing_booking uuid;
  v_booking_ids uuid[] := '{}';
  k text;
  rec record;
  gid uuid;
  slotrec record;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Claim not found'; END IF;
  IF c.rebook_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_group');
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;
  IF c.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded', 'status', c.status);
  END IF;
  IF s.priority_window_ends_at IS NOT NULL AND s.priority_window_ends_at < now() THEN
    UPDATE public.slot_priority_claims SET status = 'expired', responded_at = now() WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'window_expired');
  END IF;

  -- UPFRONT GUARD (incident fix): this deferred path books confirmed-but-UNPAID seats. On an
  -- upfront cycle the whole-group payment must go through create-group-rebook-invoice instead —
  -- refuse server-side rather than trusting the client's mode resolution (a stale frontend or the
  -- silent cycles_public fallback could route an upfront group here and seat it without payment).
  IF (SELECT cy.settings->>'rebook_payment_mode' FROM public.cycles cy WHERE cy.id = s.cyclus_id) = 'upfront' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'upfront_cycle');
  END IF;

  v_group := c.rebook_group_id;
  v_cap_player := c.player_id;
  v_cap_guest := c.guest_player_id;

  -- Serialize the whole group so two captains can't both apply concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 1));

  -- Parse keep keys; the captain is ALWAYS kept.
  FOR k IN SELECT jsonb_array_elements_text(_keep_keys) LOOP
    IF k LIKE 'p:%' THEN v_keep_player := array_append(v_keep_player, substring(k from 3)::uuid);
    ELSIF k LIKE 'g:%' THEN v_keep_guest := array_append(v_keep_guest, substring(k from 3)::uuid);
    END IF;
  END LOOP;
  IF v_cap_player IS NOT NULL THEN v_keep_player := array_append(v_keep_player, v_cap_player); END IF;
  IF v_cap_guest IS NOT NULL THEN v_keep_guest := array_append(v_keep_guest, v_cap_guest); END IF;

  -- 1) Decline removed members' PENDING claims only (never cancel a booked/paid seat).
  FOR rec IN
    SELECT id FROM public.slot_priority_claims
    WHERE rebook_group_id = v_group AND status = 'pending'
      AND NOT (
        CASE WHEN guest_player_id IS NOT NULL
             THEN guest_player_id = ANY(v_keep_guest)
             ELSE player_id IS NOT NULL AND player_id = ANY(v_keep_player) END
      )
    FOR UPDATE
  LOOP
    UPDATE public.slot_priority_claims
      SET status = 'declined', responded_at = now(), decline_reason = 'captain_removed'
      WHERE id = rec.id;
    v_declined := v_declined + 1;
  END LOOP;

  -- 2) Book kept members' PENDING claims, capacity-guarded per slot (reuse the lock key).
  FOR rec IN
    SELECT spc.id, spc.slot_id, spc.player_id, spc.guest_player_id, av.max_participants
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots av ON av.id = spc.slot_id
    WHERE spc.rebook_group_id = v_group AND spc.status = 'pending'
      AND (
        CASE WHEN spc.guest_player_id IS NOT NULL
             THEN spc.guest_player_id = ANY(v_keep_guest)
             ELSE spc.player_id IS NOT NULL AND spc.player_id = ANY(v_keep_player) END
      )
    ORDER BY av.start_time
    FOR UPDATE OF spc
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));
    v_is_own := (rec.player_id IS NOT DISTINCT FROM v_cap_player
                 AND rec.guest_player_id IS NOT DISTINCT FROM v_cap_guest);

    -- If this member already holds an ACTIVE booking on the slot — matched to the M-17
    -- unique-active-booking index set ('pending'/'confirmed'/'completed') — never INSERT a
    -- duplicate (it would raise 23505 and abort the whole group). Just mark their claim
    -- claimed against the existing booking + keep it in the group's booking set.
    SELECT id INTO v_existing_booking FROM public.bookings
      WHERE slot_id = rec.slot_id
        AND player_id IS NOT DISTINCT FROM rec.player_id
        AND guest_player_id IS NOT DISTINCT FROM rec.guest_player_id
        AND status IN ('pending', 'confirmed', 'completed')
      LIMIT 1;
    IF v_existing_booking IS NOT NULL THEN
      UPDATE public.slot_priority_claims
        SET status = 'claimed', responded_at = now(), booking_id = v_existing_booking,
            booked_by_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_player END,
            booked_by_guest_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_guest END
        WHERE id = rec.id;
      v_booking_ids := array_append(v_booking_ids, v_existing_booking);
      v_skipped_existing := v_skipped_existing + 1;
      CONTINUE;
    END IF;

    -- Capacity: count only seats actually occupied (the canonical occupying set).
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id AND (status IN ('confirmed', 'pending', 'pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
    IF v_seats >= COALESCE(rec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
    VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'pending', now(), now())
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id,
          booked_by_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_player END,
          booked_by_guest_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_guest END
      WHERE id = rec.id;
    v_booking_ids := array_append(v_booking_ids, v_booking_id);
    v_booked := v_booked + 1;
  END LOOP;

  -- 3) Add new guests: one claim + booking per distinct slot in the group, capacity-guarded.
  --    Skip a slot for a guest who already has a claim there (treated by the keep/remove logic).
  IF array_length(_new_guest_ids, 1) IS NOT NULL THEN
    FOREACH gid IN ARRAY _new_guest_ids LOOP
      IF gid IS NULL THEN CONTINUE; END IF;
      FOR slotrec IN
        SELECT DISTINCT spc.slot_id, av.max_participants
        FROM public.slot_priority_claims spc
        JOIN public.availability_slots av ON av.id = spc.slot_id
        WHERE spc.rebook_group_id = v_group
        ORDER BY 1
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(slotrec.slot_id::text, 0));
        -- Already a member (claim) OR already actively booked on this slot → don't duplicate.
        -- The active-booking check matches the M-17 unique index set, preventing 23505.
        IF EXISTS (SELECT 1 FROM public.slot_priority_claims
                   WHERE slot_id = slotrec.slot_id AND guest_player_id = gid)
           OR EXISTS (SELECT 1 FROM public.bookings
                   WHERE slot_id = slotrec.slot_id AND guest_player_id = gid
                     AND status IN ('pending', 'confirmed', 'completed')) THEN
          CONTINUE;
        END IF;
        SELECT count(*) INTO v_seats FROM public.bookings
          WHERE slot_id = slotrec.slot_id AND (status IN ('confirmed', 'pending', 'pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
        IF v_seats >= COALESCE(slotrec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

        INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, created_at, updated_at)
        VALUES (slotrec.slot_id, gid, 'confirmed', 'pending', now(), now())
        RETURNING id INTO v_booking_id;

        INSERT INTO public.slot_priority_claims
          (slot_id, guest_player_id, rebook_group_id, status, responded_at, booking_id,
           booked_by_player_id, booked_by_guest_player_id)
        VALUES (slotrec.slot_id, gid, v_group, 'claimed', now(), v_booking_id, v_cap_player, v_cap_guest);

        v_booking_ids := array_append(v_booking_ids, v_booking_id);
        v_booked := v_booked + 1;
        v_added := v_added + 1;
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', (v_booked > 0 OR v_skipped_existing > 0),
    'group', true,
    'rebook_group_id', v_group,
    'booked', v_booked,
    'declined', v_declined,
    'added', v_added,
    'skipped_existing', v_skipped_existing,
    'skipped_full', v_skipped_full,
    'booking_ids', to_jsonb(v_booking_ids)
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.rebook_group_manage(
  _token text,
  _keep_keys jsonb DEFAULT '[]'::jsonb,
  _new_guest_ids uuid[] DEFAULT '{}'::uuid[],
  _invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  c public.slot_priority_claims;
  v_group uuid;
  v_cap_player uuid;
  v_cap_guest uuid;
  v_cap_paid boolean;
  v_keep_player uuid[] := '{}';
  v_keep_guest uuid[] := '{}';
  v_seats integer;
  v_booking_id uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_added integer := 0;
  v_skipped_full integer := 0;
  v_skipped_existing integer := 0;
  v_new_ids uuid[] := '{}';
  k text;
  rec record;
  gid uuid;
  slotrec record;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_group');
  END IF;

  -- Gate: the captain must have already PAID (claim 'claimed' + a paid booking). This path
  -- never charges — it only assigns covered seats — so it must not run before payment.
  SELECT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = c.booking_id AND b.payment_status = 'paid')
    INTO v_cap_paid;
  IF c.status <> 'claimed' OR NOT v_cap_paid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_paid');
  END IF;

  v_group := c.rebook_group_id;
  v_cap_player := c.player_id;
  v_cap_guest := c.guest_player_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 1));

  FOR k IN SELECT jsonb_array_elements_text(_keep_keys) LOOP
    IF k LIKE 'p:%' THEN v_keep_player := array_append(v_keep_player, substring(k from 3)::uuid);
    ELSIF k LIKE 'g:%' THEN v_keep_guest := array_append(v_keep_guest, substring(k from 3)::uuid);
    END IF;
  END LOOP;
  IF v_cap_player IS NOT NULL THEN v_keep_player := array_append(v_keep_player, v_cap_player); END IF;
  IF v_cap_guest IS NOT NULL THEN v_keep_guest := array_append(v_keep_guest, v_cap_guest); END IF;

  -- 1) Decline removed members' PENDING claims (never touch a booked/paid seat).
  FOR rec IN
    SELECT id FROM public.slot_priority_claims
    WHERE rebook_group_id = v_group AND status = 'pending'
      AND NOT (
        CASE WHEN guest_player_id IS NOT NULL
             THEN guest_player_id = ANY(v_keep_guest)
             ELSE player_id IS NOT NULL AND player_id = ANY(v_keep_player) END
      )
    FOR UPDATE
  LOOP
    UPDATE public.slot_priority_claims
      SET status = 'declined', responded_at = now(), decline_reason = 'captain_removed'
      WHERE id = rec.id;
    v_declined := v_declined + 1;
  END LOOP;

  -- 2) Book kept members' PENDING claims as COVERED (paid by the captain), capacity-guarded.
  FOR rec IN
    SELECT spc.id, spc.slot_id, spc.player_id, spc.guest_player_id, av.max_participants
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots av ON av.id = spc.slot_id
    WHERE spc.rebook_group_id = v_group AND spc.status = 'pending'
      AND (
        CASE WHEN spc.guest_player_id IS NOT NULL
             THEN spc.guest_player_id = ANY(v_keep_guest)
             ELSE spc.player_id IS NOT NULL AND spc.player_id = ANY(v_keep_player) END
      )
    ORDER BY av.start_time
    FOR UPDATE OF spc
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));
    -- Already actively booked (M-17 index set) → don't duplicate; just claim it.
    IF EXISTS (SELECT 1 FROM public.bookings WHERE slot_id = rec.slot_id
                 AND player_id IS NOT DISTINCT FROM rec.player_id
                 AND guest_player_id IS NOT DISTINCT FROM rec.guest_player_id
                 AND status IN ('pending','confirmed','completed')) THEN
      UPDATE public.slot_priority_claims SET status = 'claimed', responded_at = now(),
        booked_by_player_id = v_cap_player, booked_by_guest_player_id = v_cap_guest
        WHERE id = rec.id;
      v_skipped_existing := v_skipped_existing + 1;
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id AND (status IN ('confirmed','pending','pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
    IF v_seats >= COALESCE(rec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, paid_at,
                                 paid_by_player_id, paid_by_guest_player_id, created_at, updated_at)
    VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'paid', now(),
            v_cap_player, v_cap_guest, now(), now())
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id,
          booked_by_player_id = v_cap_player, booked_by_guest_player_id = v_cap_guest
      WHERE id = rec.id;
    v_new_ids := array_append(v_new_ids, v_booking_id);
    v_booked := v_booked + 1;
  END LOOP;

  -- 3) Add new guests as COVERED bookings, one per slot, capacity-guarded.
  IF array_length(_new_guest_ids, 1) IS NOT NULL THEN
    FOREACH gid IN ARRAY _new_guest_ids LOOP
      IF gid IS NULL THEN CONTINUE; END IF;
      FOR slotrec IN
        SELECT DISTINCT spc.slot_id, av.max_participants
        FROM public.slot_priority_claims spc
        JOIN public.availability_slots av ON av.id = spc.slot_id
        WHERE spc.rebook_group_id = v_group
        ORDER BY 1
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(slotrec.slot_id::text, 0));
        IF EXISTS (SELECT 1 FROM public.slot_priority_claims
                     WHERE slot_id = slotrec.slot_id AND guest_player_id = gid)
           OR EXISTS (SELECT 1 FROM public.bookings WHERE slot_id = slotrec.slot_id
                        AND guest_player_id = gid AND status IN ('pending','confirmed','completed')) THEN
          CONTINUE;
        END IF;
        SELECT count(*) INTO v_seats FROM public.bookings
          WHERE slot_id = slotrec.slot_id AND (status IN ('confirmed','pending','pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
        IF v_seats >= COALESCE(slotrec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

        INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, paid_at,
                                     paid_by_player_id, paid_by_guest_player_id, created_at, updated_at)
        VALUES (slotrec.slot_id, gid, 'confirmed', 'paid', now(), v_cap_player, v_cap_guest, now(), now())
        RETURNING id INTO v_booking_id;

        INSERT INTO public.slot_priority_claims
          (slot_id, guest_player_id, rebook_group_id, status, responded_at, booking_id,
           booked_by_player_id, booked_by_guest_player_id)
        VALUES (slotrec.slot_id, gid, v_group, 'claimed', now(), v_booking_id, v_cap_player, v_cap_guest);

        v_new_ids := array_append(v_new_ids, v_booking_id);
        v_booked := v_booked + 1;
        v_added := v_added + 1;
      END LOOP;
    END LOOP;
  END IF;

  -- 4) Link the newly-covered bookings onto the captain's already-paid group invoice (record
  --    only — the amount is the fixed court price and does not change with the roster).
  --    P2-3: the invoice MUST be this group's own tagged invoice (rebook_group_id = v_group),
  --    not an arbitrary client-supplied paid invoice belonging to another tenant.
  IF _invoice_id IS NOT NULL AND array_length(v_new_ids, 1) IS NOT NULL THEN
    UPDATE public.invoices
      SET booking_ids = (
        SELECT array(SELECT DISTINCT unnest(COALESCE(booking_ids, '{}'::uuid[]) || v_new_ids))
      )
      WHERE id = _invoice_id AND status = 'paid' AND rebook_group_id = v_group;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'group', true,
    'rebook_group_id', v_group,
    'booked', v_booked,
    'declined', v_declined,
    'added', v_added,
    'skipped_full', v_skipped_full,
    'skipped_existing', v_skipped_existing,
    'booking_ids', to_jsonb(v_new_ids)
  );
END;
$fn$;

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_rebook_group_by_token';
  IF v_src ~ 'player_id IS NOT NULL THEN ''p:' THEN
    RAISE EXCEPTION 'ABC-20: get_rebook_group_by_token still keys members profile-first';
  END IF;

  FOR v_src IN
    SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname IN ('rebook_group_apply', 'rebook_group_manage')
  LOOP
    IF v_src ~ 'player_id = ANY\(v_keep_player\)\)\s*\n\s*OR \(' THEN
      RAISE EXCEPTION 'ABC-20: a group RPC still uses raw-player OR matching for dual-key rows';
    END IF;
    IF v_src !~ 'guest_player_id IS NOT NULL\s*\n\s*THEN' THEN
      RAISE EXCEPTION 'ABC-20: a group RPC is not guest-first';
    END IF;
  END LOOP;
END $$;
-- ── 4c. `release_rebook_hold` — a profile may release only a PURE-PROFILE hold ───────────────
-- The ownership test was `v_booking.player_id IS DISTINCT FROM v_profile`, which passes for a
-- DUAL-KEY booking: the caller's player_id sits beside somebody else's guest_player_id, and that
-- player_id is legacy link decoration rather than ownership. The account holder could therefore
-- release a guest's held seat — cancelling their booking and re-opening their claim.
--
-- Guest and dual-key holds now fail closed here. Releasing one needs independently valid guest
-- authority, which this RPC (auth.uid()-keyed, and a guest has no login) cannot establish; the
-- legacy profile linkage is explicitly not that authority. Everything else — the FOR UPDATE lock,
-- the payment_pending idempotent no-op, the cancel, and the claim reset — is unchanged.
CREATE OR REPLACE FUNCTION public.release_rebook_hold(_booking_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_profile uuid;
  v_booking public.bookings;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_profile');
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = _booking_id FOR UPDATE;
  IF v_booking.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- ABC-20: PURE-PROFILE only. A dual-key hold belongs to the guest.
  IF v_booking.guest_player_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yours');
  END IF;
  IF v_booking.player_id IS DISTINCT FROM v_profile THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yours');
  END IF;

  IF v_booking.status <> 'payment_pending' THEN
    RETURN jsonb_build_object('ok', true, 'released', false, 'status', v_booking.status);
  END IF;

  UPDATE public.bookings SET status = 'cancelled', updated_at = now() WHERE id = _booking_id;
  UPDATE public.slot_priority_claims
    SET status = 'pending', booking_id = NULL, responded_at = NULL
    WHERE booking_id = _booking_id AND status = 'claimed';

  RETURN jsonb_build_object('ok', true, 'released', true);
END;
$fn$;

COMMENT ON FUNCTION public.release_rebook_hold(uuid) IS
  'ABC-20: a profile may release only a PURE-PROFILE hold. A dual-key hold belongs to the guest and fails closed — legacy profile linkage is not authority, and this auth.uid()-keyed RPC cannot establish guest authority.';

-- ── install assertions for items 2/4/5 ──────────────────────────────────────────────────────
DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'release_rebook_hold';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'ABC-20: release_rebook_hold is missing entirely';
  END IF;
  IF v_src !~ 'v_booking\.guest_player_id IS NOT NULL' THEN
    RAISE EXCEPTION 'ABC-20: release_rebook_hold must refuse dual-key/guest holds';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PASS B §1 — invoice authority, identity and concurrency.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── get_my_invoices — pure-profile only ─────────────────────────────────────────────────────
-- Three admission arms went beyond the caller's own profile: a RAW `i.player_id = v_profile`
-- (which matches DUAL-KEY invoices, i.e. a guest's invoice carrying the caller's stale
-- player_id), `i.person_id = v_person` (person equality), and a twin/linked guest-surrogate set.
-- Each showed one account another person's invoice — amounts, billing identity and status.
--
-- All three are withdrawn. The whole split-freeze apparatus goes with them: it existed only to
-- make the person arm safe, and there is no person arm now. Retained fields and the
-- pure-profile-only billing-edit rule are unchanged.
CREATE OR REPLACE FUNCTION public.get_my_invoices()
RETURNS TABLE (
  id uuid, invoice_number text, invoice_date date, due_date date,
  player_name text, player_business_name text, player_address text, player_btw_number text,
  subtotal numeric, vat_rate numeric, vat_amount numeric, total numeric,
  status text, pdf_url text, sent_at timestamptz, paid_at timestamptz, notes text,
  can_edit_billing boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_profile uuid;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    i.id, i.invoice_number, i.invoice_date, i.due_date,
    i.player_name, i.player_business_name, i.player_address, i.player_btw_number,
    i.subtotal, i.vat_rate, i.vat_amount, i.total,
    i.status, i.pdf_url, i.sent_at, i.paid_at, i.notes,
    true AS can_edit_billing   -- every returned row is already pure-profile and the caller's
  FROM public.invoices i
  WHERE i.status <> 'draft'
    AND i.player_id = v_profile
    AND i.guest_player_id IS NULL;   -- a dual-key invoice belongs to the GUEST
END;
$fn$;

COMMENT ON FUNCTION public.get_my_invoices() IS
  'ABC-18 Pass B: PURE-PROFILE only (player_id = me AND guest_player_id IS NULL). The raw player arm matched dual-key invoices, and the person / twin-linked guest-surrogate arms showed one account another person''s invoice.';

-- ── create_invoice_deduped — typed identity, no person equivalence ──────────────────────────
-- The lock key and one dedup arm resolved through `person_links`, so two rows the bridge called
-- one person could serialize together and DEDUP ONTO EACH OTHER — one human paying, or not
-- paying, for another's bookings. Person equivalence is withdrawn from all three places the
-- brief names: the lock, the overlap search and the dedup arms.
--
-- TYPED IDENTITY: `g:<guest>` when a guest is present (dual-key included — the guest is the
-- recipient), else `p:<profile>` for a pure profile. Neither ⇒ refuse.
--
-- DETERMINISTIC LOCKING covers BOTH dimensions the brief requires:
--   1. the typed recipient — so two creates for one recipient serialize;
--   2. the booking-overlap set — sorted and de-duplicated, so two creates touching the same
--      bookings serialize even under DIFFERENT recipients, which is exactly the cross-recipient
--      double-bill window. Two locks, always taken in the same order (recipient then bookings),
--      so two sessions can never deadlock by acquiring them opposite ways.
--
-- Amounts, snapshots, statuses and the returned shape are untouched.
CREATE OR REPLACE FUNCTION public.create_invoice_deduped(_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_trainer_id uuid := (_payload->>'trainer_id')::uuid;
  v_player_id uuid := NULLIF(_payload->>'player_id', '')::uuid;
  v_guest_player_id uuid := NULLIF(_payload->>'guest_player_id', '')::uuid;
  v_booking_ids uuid[];
  v_recipient_key text;
  v_bk uuid;
  v_winner public.invoices%ROWTYPE;
  v_new public.invoices%ROWTYPE;
BEGIN
  SELECT COALESCE(array_agg(DISTINCT b ORDER BY b), '{}'::uuid[])
    INTO v_booking_ids
    FROM jsonb_array_elements_text(COALESCE(_payload->'booking_ids', '[]'::jsonb)) AS t(b_text),
         LATERAL (SELECT t.b_text::uuid AS b) x;

  -- typed identity, guest-first; neither ⇒ fail closed rather than invoice an unknown recipient
  v_recipient_key := CASE
    WHEN v_guest_player_id IS NOT NULL THEN 'g:' || v_guest_player_id::text
    WHEN v_player_id IS NOT NULL THEN 'p:' || v_player_id::text
    ELSE NULL
  END;
  IF v_recipient_key IS NULL THEN
    RAISE EXCEPTION 'create_invoice_deduped: unscoped recipient' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('inv:' || v_trainer_id::text || ':' || v_recipient_key, 0));

  IF array_length(v_booking_ids, 1) > 0 THEN
    -- PER-BOOKING locks, in deterministic sorted order.
    --
    -- Locking the whole SET under one key is NOT overlap-safe: [A] and [A,B] hash differently,
    -- so two sessions with PARTIAL overlap take disjoint locks, each passes its overlap SELECT
    -- without seeing the other's uncommitted row, and both INSERT — booking A billed twice, to
    -- two different recipients. The exact-set indexes do not reject partial overlap either.
    --
    -- One lock per booking uuid closes it: any two statements touching a shared booking contend
    -- on that booking's own key. Sorted order (v_booking_ids is sorted + de-duplicated above)
    -- means two sessions always acquire shared locks in the same sequence, so they cannot
    -- deadlock by taking them in opposite orders.
    FOREACH v_bk IN ARRAY v_booking_ids LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('invb:' || v_trainer_id::text || ':' || v_bk::text, 0));
    END LOOP;

    -- Overlap is re-read AFTER every lock is held: a competing transaction holding any of these
    -- bookings has now committed or rolled back, so this SELECT sees the settled truth rather
    -- than the pre-lock snapshot.
    SELECT i.* INTO v_winner FROM public.invoices i
    WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
      AND (
        -- pure-profile arm: pure on BOTH sides
        (v_guest_player_id IS NULL AND v_player_id IS NOT NULL
           AND i.player_id = v_player_id AND i.guest_player_id IS NULL)
        -- guest arm: fires for guest-only AND dual-key inbound — the guest is the recipient
        OR (v_guest_player_id IS NOT NULL AND i.guest_player_id = v_guest_player_id)
      )
    ORDER BY i.created_at ASC LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('id', v_winner.id, 'invoice_number', v_winner.invoice_number,
        'status', v_winner.status, 'sent_at', v_winner.sent_at,
        'booking_ids', to_jsonb(v_winner.booking_ids), 'total', v_winner.total, 'deduped', true);
    END IF;

    -- Overlap under a DIFFERENT typed recipient: refuse. Returning or reusing that invoice would
    -- hand this caller another recipient's row; silently inserting a second one would double-bill
    -- the same seats. Neither is acceptable, so the caller is told.
    IF EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.trainer_id = v_trainer_id AND i.status <> 'cancelled' AND i.booking_ids && v_booking_ids
    ) THEN
      RAISE EXCEPTION 'create_invoice_deduped: bookings already invoiced under a different recipient'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  INSERT INTO public.invoices (
    trainer_id, academy_profile_id, invoice_number, invoice_date, due_date, player_id, guest_player_id,
    player_name, player_business_name, player_address, player_btw_number, line_items, subtotal, vat_rate,
    vat_amount, total, vat_breakdown, prices_include_vat, status, booking_ids, split_count, paid_at, sent_at
  ) VALUES (
    v_trainer_id, NULLIF(_payload->>'academy_profile_id', '')::uuid, _payload->>'invoice_number',
    (_payload->>'invoice_date')::date, (_payload->>'due_date')::date, v_player_id, v_guest_player_id,
    _payload->>'player_name', _payload->>'player_business_name', _payload->>'player_address',
    _payload->>'player_btw_number', COALESCE(_payload->'line_items', '[]'::jsonb),
    COALESCE((_payload->>'subtotal')::numeric, 0), COALESCE((_payload->>'vat_rate')::numeric, 21),
    COALESCE((_payload->>'vat_amount')::numeric, 0), COALESCE((_payload->>'total')::numeric, 0),
    CASE WHEN _payload ? 'vat_breakdown' THEN _payload->'vat_breakdown' ELSE NULL END,
    COALESCE((_payload->>'prices_include_vat')::boolean, true), COALESCE(_payload->>'status', 'draft'),
    v_booking_ids, NULLIF(_payload->>'split_count', '')::integer,
    NULLIF(_payload->>'paid_at', '')::timestamptz, NULLIF(_payload->>'sent_at', '')::timestamptz
  ) RETURNING * INTO v_new;

  RETURN jsonb_build_object('id', v_new.id, 'invoice_number', v_new.invoice_number,
    'status', v_new.status, 'sent_at', v_new.sent_at,
    'booking_ids', to_jsonb(v_new.booking_ids), 'total', v_new.total, 'deduped', false);
END; $fn$;

COMMENT ON FUNCTION public.create_invoice_deduped(jsonb) IS
  'ABC-18 Pass B: typed identity g:<guest> / p:<pure profile>; no person/link/twin/email equivalence in the lock, the overlap search or the dedup arms. Two ordered advisory locks (typed recipient, then the sorted de-duplicated booking set) serialize both same-recipient and cross-recipient overlap. Overlap under a different recipient refuses rather than returning or reusing that recipient''s invoice.';

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_my_invoices';
  IF v_src IS NULL THEN RAISE EXCEPTION 'Pass B: get_my_invoices is missing'; END IF;
  IF v_src !~ 'i\.guest_player_id IS NULL' OR v_src ~ 'person_id|twin_of_profile_id|linked_profile_id' THEN
    RAISE EXCEPTION 'Pass B: get_my_invoices must be pure-profile with no person/twin/link admission';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'create_invoice_deduped';
  IF v_src IS NULL THEN RAISE EXCEPTION 'Pass B: create_invoice_deduped is missing'; END IF;
  IF v_src ~ 'person_links|is_guest_split_frozen|i\.person_id' THEN
    RAISE EXCEPTION 'Pass B: create_invoice_deduped still uses person equivalence';
  END IF;
  -- must lock PER BOOKING (a whole-set key is not overlap-safe), and must do so in a loop
  IF v_src !~ 'FOREACH v_bk IN ARRAY v_booking_ids' OR v_src !~ 'invb:' THEN
    RAISE EXCEPTION 'Pass B: create_invoice_deduped must take a per-booking advisory lock in sorted order';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PASS B §1b — invoice recipient identity, email and delivery status.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── get_invoice_recipient_identity — guest-first, own attributes only ────────────────────────
-- Three defects, each of which routed a guest's invoice to somebody else:
--
--   1. PROFILE-FIRST DISPATCH. The guest arm required `_player_id IS NULL`, so a DUAL-KEY call
--      (both ids passed, which is exactly what a dual-key invoice supplies) matched only the
--      PROFILE arm. The guest's invoice resolved to the linked account's name, email and billing.
--   2. LINKED-PROFILE PREFERENCE inside the guest arm: email took `lp.email` BEFORE `g.email`,
--      and phone/billing preferred `lp.*` too — so even when the guest arm did fire, delivery
--      went to the account rather than the guest.
--   3. METADATA BILLING OVERRIDE. `academy_player_metadata.billing_email` won over both. That
--      table is caller-authored (ABC-16), so it could redirect an invoice by writing a row.
--
-- Now: guest present ⇒ that guest's OWN attributes, nothing else. Pure profile ⇒ direct profile
-- fields. Neither ⇒ no row, i.e. unresolved — callers must treat an empty result as a refusal to
-- send rather than substituting anything.
--
-- `_academy_profile_id` is retained in the signature (callers pass it) but no longer selects an
-- override; it is left in place so no caller has to change shape.
CREATE OR REPLACE FUNCTION public.get_invoice_recipient_identity(
  _player_id uuid DEFAULT NULL,
  _guest_player_id uuid DEFAULT NULL,
  _academy_profile_id uuid DEFAULT NULL
)
RETURNS TABLE (
  full_name text, email text, phone text,
  billing_business_name text, billing_address text, billing_btw_number text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  -- GUEST arm — fires whenever a guest is present, dual-key included.
  SELECT
    COALESCE(
      NULLIF(btrim(COALESCE(g.first_name, '') || ' ' || COALESCE(g.last_name, '')), ''),
      NULLIF(btrim(g.full_name), ''),
      'Unknown Player'
    ),
    COALESCE(NULLIF(btrim(g.email), ''), ''),
    COALESCE(g.phone, ''),
    g.billing_business_name,
    g.billing_address,
    g.billing_btw_number
  FROM public.guest_players g
  WHERE _guest_player_id IS NOT NULL AND g.id = _guest_player_id

  UNION ALL

  -- PURE-PROFILE arm — only when no guest is present.
  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), 'Unknown Player'),
    COALESCE(NULLIF(btrim(p.email), ''), ''),
    COALESCE(p.phone, ''),
    p.billing_business_name,
    p.billing_address,
    p.billing_btw_number
  FROM public.profiles p
  WHERE _guest_player_id IS NULL AND _player_id IS NOT NULL AND p.id = _player_id;
$fn$;

COMMENT ON FUNCTION public.get_invoice_recipient_identity(uuid, uuid, uuid) IS
  'ABC-18 Pass B §1b: guest-first. A guest resolves to its OWN name/email/phone/billing — no linked-profile fallback, no academy_player_metadata billing override (that table is caller-authored). The profile arm requires guest NULL. Neither id ⇒ no row = unresolved.';

-- ── get_invoices_delivery_status — same guest-first identity ─────────────────────────────────
-- Re-emitted so the status a manager sees is keyed to the SAME recipient the mail actually goes
-- to. Deliverability itself (hard bounce, complaint, provider suppression) is unchanged: only the
-- address it is looked up for changes, from "the linked account's" to "this guest's own".
CREATE OR REPLACE FUNCTION public.get_invoices_delivery_status(_invoice_ids uuid[])
RETURNS TABLE (invoice_id uuid, recipient_email text, delivery_state text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  RETURN QUERY
  SELECT
    i.id,
    r.email,
    CASE
      WHEN NULLIF(btrim(COALESCE(r.email, '')), '') IS NULL THEN 'no_email'
      WHEN EXISTS (
        SELECT 1 FROM public.email_suppressions s
        WHERE lower(s.email) = lower(r.email)
      ) THEN 'undeliverable'
      WHEN i.sent_at IS NOT NULL THEN 'sent'
      ELSE 'not_sent'
    END
  FROM public.invoices i
  CROSS JOIN LATERAL public.get_invoice_recipient_identity(
    i.player_id, i.guest_player_id, i.academy_profile_id
  ) r
  WHERE i.id = ANY(_invoice_ids)
    -- tenant gate unchanged: the caller must own the invoice's trainer or academy, or be admin
    AND (
      public.is_admin(auth.uid())
      OR i.trainer_id IN (SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid())
      OR (i.academy_profile_id IS NOT NULL
          AND i.academy_profile_id IN (SELECT public.get_user_academy_ids(auth.uid())))
    );
END;
$fn$;

COMMENT ON FUNCTION public.get_invoices_delivery_status(uuid[]) IS
  'ABC-18 Pass B §1b: delivery state for the SAME guest-first recipient the mail is sent to. Real provider/suppression status is unchanged; only the address it is resolved for is corrected. Tenant gate preserved.';

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_invoice_recipient_identity';
  IF v_src IS NULL THEN RAISE EXCEPTION 'Pass B §1b: get_invoice_recipient_identity is missing'; END IF;
  -- no linked-profile join, no metadata override, and the guest arm must not require a null player
  IF v_src ~ 'linked_profile_id|academy_player_metadata' THEN
    RAISE EXCEPTION 'Pass B §1b: recipient identity still traverses the bridge or a metadata override';
  END IF;
  IF v_src !~ '_guest_player_id IS NULL AND _player_id IS NOT NULL' THEN
    RAISE EXCEPTION 'Pass B §1b: the profile arm must require guest NULL';
  END IF;

  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_invoices_delivery_status';
  IF v_src IS NULL THEN RAISE EXCEPTION 'Pass B §1b: get_invoices_delivery_status is missing'; END IF;
  IF v_src !~ 'get_invoice_recipient_identity' THEN
    RAISE EXCEPTION 'Pass B §1b: delivery status must resolve through the guest-first identity reader';
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- ABC-23 §1c — settle_paid_bookings: the single atomic paid-settlement authority.
-- ═════════════════════════════════════════════════════════════════════════════
-- Replaces the classifier→raw-UPDATE shape (expired_holds_over_capacity read at
-- mollie-webhook:964, write at :1016). That read is STABLE and takes NO LOCKS, and the write
-- happens later, so two concurrent settlements can both read "fits" and both confirm — the court
-- is oversold. It also judged liveness with transaction-start now() and applied the raw
-- max_participants cap to every booking, ignoring the effective purchase cap used at creation.
--
-- And today a seatless paid hold is merely EXCLUDED from the update: money captured, row left a
-- stale payment_pending hold with no paid marker. That is the financial gap this closes.
--
-- CONTRACT
--   * one transaction owns invoice + bookings; no invoice-first split;
--   * a live hold or an already-occupying booking → confirmed + paid;
--   * an expired hold that still fits → confirmed + paid;
--   * an expired hold that no longer fits → cancelled + PAID, provider ids + paid_at persisted,
--     hold_expires_at cleared, typed `paid_no_seat`. It never occupies and never resurrects;
--   * same-slot expired additions are ALL-OR-NONE — never a UUID-order winner;
--   * independent slots fulfil independently;
--   * duplicate delivery is a state-derived no-op returning the same shape.
--
-- LOCK PROTOCOL (deadlock-free by construction)
--   1. snapshot target booking/slot identities WITHOUT locking;
--   2. slot rows FOR SHARE in ascending uuid order;
--   3. pg_advisory_xact_lock per slot in the same ascending order;
--   4. only then lock the booking/invoice rows and RE-READ, failing closed if anything moved.
--   Every session takes the same keys in the same order, so no cycle can form.
-- The return type changes (invoice_paid_now) and two payer-attribution parameters are added, so
-- the Boundary-A signature is dropped rather than replaced. Both are required by §3: a caller must
-- learn whether IT claimed the invoice transition (to notify/forward exactly once) without reading
-- that out of the refusal channel, and rebook-group coverage must stamp WHO paid inside the same
-- atomic settlement instead of in a second, non-atomic write.
DROP FUNCTION IF EXISTS public.settle_paid_bookings(uuid[], text, text, uuid);

CREATE OR REPLACE FUNCTION public.settle_paid_bookings(
  _booking_ids uuid[],
  _provider_payment_id text,
  _provider_transaction_id text DEFAULT NULL,
  _invoice_id uuid DEFAULT NULL,
  _paid_by_player_id uuid DEFAULT NULL,
  _paid_by_guest_player_id uuid DEFAULT NULL,
  -- 'mollie' = a captured provider payment. 'manual' = a trainer/academy recording an
  -- externally-received payment (bank transfer, cash). Manual settlement writes NO provider
  -- columns: inventing a Mollie id to satisfy this command would put a value in
  -- bookings.mollie_payment_id that no Mollie account can ever resolve, corrupting every
  -- reconciliation that joins on it.
  _settlement_source text DEFAULT 'mollie'
)
RETURNS TABLE (
  confirmed_paid uuid[],
  already_confirmed_paid uuid[],
  paid_no_seat uuid[],
  replayed_paid_no_seat uuid[],
  refused uuid[],
  refusal_reason text,
  -- TRUE only for the request that actually transitioned the invoice to paid. Kept OUT of
  -- refusal_reason deliberately: a caller testing `refusal_reason IS NOT NULL` must never read a
  -- successful settlement as a failure.
  invoice_paid_now boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ids uuid[];
  v_slots uuid[];
  v_slot uuid;
  v_now timestamptz;
  v_conf uuid[] := '{}';
  v_already uuid[] := '{}';
  v_nos uuid[] := '{}';
  v_replay uuid[] := '{}';
  v_ref uuid[] := '{}';
  v_reason text := NULL;
  r RECORD;
  v_cap int;
  v_occ int;
  v_expired uuid[];
  v_fits boolean;
  v_redundant uuid[] := '{}';      -- target holds superseded by an existing active booking
  v_surv RECORD;
  v_late RECORD;                   -- an active seat committed after the survivor scan
  v_invoice public.invoices%ROWTYPE;
  v_invoice_paid_now boolean := false;
  -- NULL in manual mode. Every provider write is COALESCE(existing, v_pay), so a NULL leaves the
  -- column untouched; every provider COMPARISON is `<> v_pay`, which is NULL and therefore never
  -- true. That is deliberate, not incidental: provider identity is not a meaningful check for a
  -- payment that did not come from the provider.
  v_pay text;
  v_txn text;
BEGIN
  IF _settlement_source IS NULL OR _settlement_source NOT IN ('mollie', 'manual') THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                        'invalid_settlement_source'::text, false;
    RETURN;
  END IF;
  v_pay := CASE WHEN _settlement_source = 'manual' THEN NULL ELSE _provider_payment_id END;
  v_txn := CASE WHEN _settlement_source = 'manual' THEN NULL ELSE _provider_transaction_id END;
  -- ── input validation: reject null/empty/duplicate/missing ────────────────────────────────
  IF _booking_ids IS NULL OR array_length(_booking_ids, 1) IS NULL THEN
    -- ── INVOICE-ONLY PATH ────────────────────────────────────────────────────────────────
    -- An invoice can genuinely have no bookings (an administrative or membership invoice).
    -- It still settles through this one authority, atomically and with the same refusal
    -- vocabulary; it is a separate branch because there is no slot, no capacity and no
    -- survivor question here. What it must NOT become is a bypass: an invoice that DOES cite
    -- bookings is refused, so no caller can mark money received while its seats stay unpaid.
    IF _invoice_id IS NULL THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'no_targets'::text, false;
      RETURN;
    END IF;
    IF _settlement_source = 'mollie'
       AND (_provider_payment_id IS NULL OR btrim(_provider_payment_id) = '') THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'missing_provider_payment_id'::text, false;
      RETURN;
    END IF;

    v_now := clock_timestamp();
    SELECT * INTO v_invoice FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
    IF v_invoice.id IS NULL THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'invoice_missing'::text, false;
      RETURN;
    END IF;
    IF COALESCE(v_invoice.status, '') = 'cancelled' THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'invoice_cancelled'::text, false;
      RETURN;
    END IF;
    IF v_invoice.mollie_payment_id IS NOT NULL
       AND v_invoice.mollie_payment_id <> v_pay THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'invoice_provider_conflict'::text, false;
      RETURN;
    END IF;
    IF COALESCE(array_length(v_invoice.booking_ids, 1), 0) > 0 THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                          'invoice_has_bookings'::text, false;
      RETURN;
    END IF;

    UPDATE public.invoices
       SET status = 'paid', paid_at = COALESCE(paid_at, v_now),
           mollie_payment_id = COALESCE(mollie_payment_id, v_pay)
     WHERE id = _invoice_id AND COALESCE(status, '') NOT IN ('paid', 'cancelled');
    v_invoice_paid_now := FOUND;

    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                        NULL::text, v_invoice_paid_now;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(_booking_ids) t(id) WHERE t.id IS NULL) THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                        'null_target'::text, false;
    RETURN;
  END IF;
  SELECT array_agg(DISTINCT t.id ORDER BY t.id) INTO v_ids FROM unnest(_booking_ids) t(id);
  IF array_length(v_ids, 1) <> array_length(_booking_ids, 1) THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], _booking_ids,
                        'duplicate_targets'::text, false;
    RETURN;
  END IF;
  IF _settlement_source = 'mollie'
     AND (_provider_payment_id IS NULL OR btrim(_provider_payment_id) = '') THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                        'missing_provider_payment_id'::text, false;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.bookings b WHERE b.id = ANY(v_ids)) <> array_length(v_ids, 1) THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                        'unknown_target'::text, false;
    RETURN;
  END IF;

  -- ── association: verify against STORED provider identity, never the caller's claim ───────
  -- The invoice is NOT validated here. An earlier draft did a pre-lock EXISTS check, which was
  -- both a TOCTOU (the invoice can be cancelled or re-pointed while we wait on the slot locks)
  -- and less precise — it collapsed missing / cancelled / provider-conflict / association faults
  -- into one reason, and fired first, shadowing the authoritative post-lock diagnosis. Invoice
  -- validation now happens once, against the LOCKED row, further down.

  -- Refuse a DIFFERENT non-null stored provider id rather than overwrite it.
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = ANY(v_ids)
      AND b.mollie_payment_id IS NOT NULL
      AND b.mollie_payment_id <> v_pay
      -- ...but only while the booking is still UNSETTLED. A booking that is ALREADY PAID under a
      -- different provider payment is not a conflict to refuse, it is a seat somebody else
      -- already paid for: the correct outcome is the no-op below (already_confirmed_paid), and
      -- its stored provider id is left alone. Refusing here failed an ENTIRE rebook-group
      -- coverage batch because one member had paid their own seat first — the captain's payment
      -- then covered nobody, terminally.
      AND COALESCE(b.payment_status, '') <> 'paid'
  ) THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                        'provider_payment_id_conflict'::text, false;
    RETURN;
  END IF;

  -- ── 1. snapshot slot identities WITHOUT locking ──────────────────────────────────────────
  SELECT array_agg(DISTINCT b.slot_id ORDER BY b.slot_id) INTO v_slots
  FROM public.bookings b WHERE b.id = ANY(v_ids) AND b.slot_id IS NOT NULL;

  -- ── 2+3. slot rows FOR SHARE, then advisory locks, both in ascending uuid order ──────────
  IF v_slots IS NOT NULL THEN
    PERFORM 1 FROM public.availability_slots s
     WHERE s.id = ANY(v_slots) ORDER BY s.id FOR SHARE;
    FOREACH v_slot IN ARRAY v_slots LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended(v_slot::text, 0));
    END LOOP;
  END IF;

  -- ── 4. lock the targets and RE-READ; fail closed if anything moved while we waited ───────
  PERFORM 1 FROM public.bookings b WHERE b.id = ANY(v_ids) ORDER BY b.id FOR UPDATE;

  IF (SELECT array_agg(DISTINCT b.slot_id ORDER BY b.slot_id)
        FROM public.bookings b WHERE b.id = ANY(v_ids) AND b.slot_id IS NOT NULL)
     IS DISTINCT FROM v_slots THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                        'target_slots_changed'::text, false;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = ANY(v_ids)
      AND b.mollie_payment_id IS NOT NULL
      AND b.mollie_payment_id <> v_pay
      AND COALESCE(b.payment_status, '') <> 'paid'   -- same narrowing as the pre-lock check
  ) THEN
    RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                        'provider_payment_id_conflict'::text, false;
    RETURN;
  END IF;

  -- ── invoice: lock and RE-READ before any booking mutation ────────────────────────────────
  -- Validating the invoice before the lock is a TOCTOU: it can be cancelled, re-pointed or
  -- claimed by another payment while we wait on the slot locks. Everything below is decided
  -- against the LOCKED row, and the update is conditional on that same state so a concurrently
  -- cancelled invoice is never resurrected.
  IF _invoice_id IS NOT NULL THEN
    SELECT * INTO v_invoice FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
    IF v_invoice.id IS NULL THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                          'invoice_missing'::text, false;
      RETURN;
    END IF;
    IF COALESCE(v_invoice.status, '') = 'cancelled' THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                          'invoice_cancelled'::text, false;
      RETURN;
    END IF;
    IF v_invoice.mollie_payment_id IS NOT NULL
       AND v_invoice.mollie_payment_id <> v_pay THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                          'invoice_provider_conflict'::text, false;
      RETURN;
    END IF;
    IF NOT (v_ids <@ COALESCE(v_invoice.booking_ids, '{}'::uuid[])) THEN
      RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], v_ids,
                          'invoice_association_mismatch'::text, false;
      RETURN;
    END IF;
  END IF;

  -- Liveness is judged AFTER the locks, with clock_timestamp() — transaction-start now() would
  -- classify against a moment that may be long past by the time contention clears.
  v_now := clock_timestamp();

  -- ── M-17 SURVIVOR RESOLUTION ─────────────────────────────────────────────────────────────
  -- A paid hold can collide with the (slot, guest) / (slot, player WHERE guest IS NULL) partial
  -- unique indexes when staff added the SAME person to the SAME slot while the payment was in
  -- flight. The pre-existing ACTIVE row is the operational survivor: it already occupies the
  -- seat, so the hold is redundant. Confirming the hold would raise 23505 and, on a service-role
  -- webhook, turn captured money into an endless 500/retry loop.
  --
  -- Typed identity is the INDEX's identity, which is guest-first by construction: a dual-key
  -- row's player_id is never pure-profile identity. Person/link/twin/email equality grants
  -- nothing here.
  --
  -- Survivors are resolved AFTER the slot and target locks, and locked in UUID order, so this
  -- adds no new lock-ordering edge.
  FOR v_surv IN
    SELECT h.id AS hold_id, o.id AS survivor_id
      FROM public.bookings h
      JOIN public.bookings o
        ON o.slot_id = h.slot_id
       AND o.id <> h.id
       AND NOT (o.id = ANY(v_ids))
       AND o.status IN ('pending', 'confirmed', 'completed')
       AND CASE WHEN h.guest_player_id IS NOT NULL
                THEN o.guest_player_id = h.guest_player_id
                ELSE o.player_id = h.player_id AND o.guest_player_id IS NULL
                     AND h.player_id IS NOT NULL AND h.guest_player_id IS NULL END
     WHERE h.id = ANY(v_ids)
       AND h.status = 'payment_pending'
     ORDER BY o.id, h.id
  LOOP
    PERFORM 1 FROM public.bookings WHERE id = v_surv.survivor_id FOR UPDATE;
    v_redundant := v_redundant || v_surv.hold_id;
  END LOOP;

  -- ── per slot: decide, then apply ─────────────────────────────────────────────────────────
  IF v_slots IS NOT NULL THEN
  FOREACH v_slot IN ARRAY v_slots LOOP
    -- capacity mode is DB-DERIVED from stored shapes, never caller-selected.
    SELECT CASE
             WHEN EXISTS (
               SELECT 1 FROM public.invoices i
               WHERE (i.rebook_cyclus_id IS NOT NULL OR i.rebook_group_id IS NOT NULL)
                 AND v_ids && COALESCE(i.booking_ids, '{}'::uuid[])
             ) THEN COALESCE(s.max_participants, 1)
             WHEN COALESCE(s.split_payment, false) OR COALESCE(s.allow_single_booking, false)
               THEN COALESCE(s.max_participants, 1)
             ELSE 1
           END
      INTO v_cap
      FROM public.availability_slots s WHERE s.id = v_slot;

    -- expired-hold targets on THIS slot (the only ones needing new capacity)
    SELECT COALESCE(array_agg(b.id ORDER BY b.id), '{}'::uuid[]) INTO v_expired
      FROM public.bookings b
     WHERE b.id = ANY(v_ids) AND b.slot_id = v_slot
       AND b.status = 'payment_pending'
       AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at <= v_now
       AND COALESCE(b.payment_status, '') <> 'paid'
       -- A redundant hold consumes NO new seat: its survivor already occupies the one it would
       -- have taken. Counting it would refuse a settlement that fits, and two target holds for
       -- one typed seat would double-count.
       AND NOT (b.id = ANY(v_redundant));

    -- seats already taken by anyone who is NOT one of those expired additions
    SELECT count(*) INTO v_occ
      FROM public.bookings o
     WHERE o.slot_id = v_slot
       AND NOT (o.id = ANY(v_expired))
       AND public.booking_occupies_seat(o.status, o.hold_expires_at);

    -- ALL-OR-NONE within the slot: the whole expired set fits, or none of it does. Never a
    -- uuid-order winner.
    v_fits := array_length(v_expired, 1) IS NULL
              OR (v_occ + array_length(v_expired, 1)) <= v_cap;

    IF array_length(v_expired, 1) IS NOT NULL AND NOT v_fits THEN
      -- paid_no_seat: financially paid, never occupying, hold cleared.
      FOR r IN SELECT b.id, b.payment_status, b.status FROM public.bookings b
                WHERE b.id = ANY(v_expired) LOOP
        IF r.status = 'cancelled' AND r.payment_status = 'paid' THEN
          v_replay := v_replay || r.id;         -- stable replay, no side effects
        ELSE
          UPDATE public.bookings
             SET status = 'cancelled',
                 payment_status = 'paid',
                 mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                 mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                 paid_at = COALESCE(paid_at, v_now),
                 hold_expires_at = NULL,
                 updated_at = v_now
           WHERE id = r.id;
          v_nos := v_nos || r.id;
        END IF;
      END LOOP;
    END IF;

    -- ── redundant holds: settle onto the survivor ────────────────────────────────────────
    FOR v_surv IN
      SELECT DISTINCT ON (o.id) h.id AS hold_id, o.id AS survivor_id,
             o.status AS s_status, o.payment_status AS s_payment,
             o.mollie_payment_id AS s_provider
        FROM public.bookings h
        JOIN public.bookings o
          ON o.slot_id = h.slot_id AND o.id <> h.id AND NOT (o.id = ANY(v_ids))
         AND o.status IN ('pending', 'confirmed', 'completed')
         AND CASE WHEN h.guest_player_id IS NOT NULL
                  THEN o.guest_player_id = h.guest_player_id
                  ELSE o.player_id = h.player_id AND o.guest_player_id IS NULL
                       AND h.player_id IS NOT NULL AND h.guest_player_id IS NULL END
       WHERE h.id = ANY(v_redundant) AND h.slot_id = v_slot
       -- DISTINCT ON (o.id): several target holds for ONE typed seat consume one seat and
       -- produce ONE first-transition result, never one per hold.
       ORDER BY o.id, h.id
    LOOP
      IF v_surv.s_provider IS NOT NULL AND v_surv.s_provider <> v_pay THEN
        -- The survivor belongs to a DIFFERENT captured payment. Touching it would attribute one
        -- person's money to another's seat, so it is left exactly as it is and THIS payment is
        -- represented durably on its own hold.
        FOR r IN SELECT b.id, b.status, b.payment_status FROM public.bookings b
                  WHERE b.id = ANY(v_redundant) AND b.slot_id = v_slot LOOP
          IF r.status = 'cancelled' AND r.payment_status = 'paid' THEN
            v_replay := v_replay || r.id;
          ELSE
            UPDATE public.bookings
               SET status = 'cancelled', payment_status = 'paid',
                   mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                   mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                   paid_at = COALESCE(paid_at, v_now), hold_expires_at = NULL, updated_at = v_now
             WHERE id = r.id;
            v_nos := v_nos || r.id;
          END IF;
        END LOOP;
      ELSE
        -- Stamp the survivor paid on its FIRST paid transition only. `completed` is preserved —
        -- demoting it to 'confirmed' would rewrite a finished session's history.
        IF COALESCE(v_surv.s_payment, '') <> 'paid' THEN
          UPDATE public.bookings
             SET payment_status = 'paid',
                 status = CASE WHEN status = 'completed' THEN status ELSE 'confirmed' END,
                 mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                 mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                 paid_at = COALESCE(paid_at, v_now), updated_at = v_now
           WHERE id = v_surv.survivor_id;
          v_conf := v_conf || v_surv.survivor_id;
        END IF;
        -- the redundant hold is cancelled WITHOUT being marked paid: the money is attributed to
        -- the survivor, and a second paid row would double-count the payment.
        UPDATE public.bookings
           SET status = 'cancelled', hold_expires_at = NULL, updated_at = v_now
         WHERE id = ANY(v_redundant) AND slot_id = v_slot AND status = 'payment_pending';

        -- An invoice must not end up paid while pointing only at the cancelled hold: substitute
        -- the survivor, de-duplicated, so the billed row is the one that actually holds the seat.
        IF _invoice_id IS NOT NULL THEN
          UPDATE public.invoices
             SET booking_ids = (
                   SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])
                     FROM unnest(
                       array_remove(COALESCE(booking_ids, '{}'::uuid[]), v_surv.hold_id)
                       || v_surv.survivor_id
                     ) AS t(x))
           WHERE id = _invoice_id;
        END IF;
      END IF;
    END LOOP;

    -- everything else on this slot that is not a refused expired addition settles normally
    FOR r IN
      SELECT b.id, b.payment_status, b.status FROM public.bookings b
       WHERE b.id = ANY(v_ids) AND b.slot_id = v_slot
         AND NOT (b.id = ANY(v_nos)) AND NOT (b.id = ANY(v_replay))
         AND NOT (b.id = ANY(v_redundant))
    LOOP
      IF r.payment_status = 'paid' AND r.status <> 'cancelled' THEN
        v_already := v_already || r.id;         -- duplicate delivery: state-derived no-op
      ELSIF r.status = 'cancelled' AND r.payment_status = 'paid' THEN
        -- Already settled as paid_no_seat by an earlier delivery. It is a REPLAY, not a
        -- resurrect-refusal: reporting it as refused would make retries look like conflicts and
        -- would hide that this payment is already reconciled. It stays cancelled and paid; no
        -- side effect fires again.
        v_replay := v_replay || r.id;
      ELSIF r.status = 'cancelled' THEN
        v_ref := v_ref || r.id;                 -- never resurrect an unrelated cancellation
        v_reason := COALESCE(v_reason, 'already_cancelled');
      ELSE
        BEGIN
          UPDATE public.bookings
             SET status = 'confirmed',
                 payment_status = 'paid',
                 mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                 mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                 paid_at = COALESCE(paid_at, v_now),
                 hold_expires_at = NULL,
                 updated_at = v_now
           WHERE id = r.id;
          v_conf := v_conf || r.id;
        EXCEPTION WHEN unique_violation THEN
          -- A writer that does NOT take this command's advisory key -- staff adding the same
          -- person to this slot -- committed an active row after the survivor scan above and
          -- before this UPDATE. The M-17 partial indexes then reject the confirm. Captured money
          -- must never become an endless 23505/500, so the collision is reconciled here, inside
          -- the same transaction: the implicit savepoint rolls back only this statement.
          SELECT o.id, o.status, o.payment_status, o.mollie_payment_id
            INTO v_late
            FROM public.bookings h
            JOIN public.bookings o
              ON o.slot_id = h.slot_id AND o.id <> h.id AND NOT (o.id = ANY(v_ids))
             AND o.status IN ('pending', 'confirmed', 'completed')
             AND CASE WHEN h.guest_player_id IS NOT NULL
                      THEN o.guest_player_id = h.guest_player_id
                      ELSE o.player_id = h.player_id AND o.guest_player_id IS NULL
                           AND h.player_id IS NOT NULL AND h.guest_player_id IS NULL END
           WHERE h.id = r.id
           ORDER BY o.id
           LIMIT 1
             FOR UPDATE OF o;
          -- Any other unique violation is NOT this reconcilable collision; re-raise it rather
          -- than reporting a settlement that did not happen.
          IF NOT FOUND THEN RAISE; END IF;

          IF v_late.mollie_payment_id IS NOT NULL
             AND v_late.mollie_payment_id <> v_pay THEN
            UPDATE public.bookings
               SET status = 'cancelled', payment_status = 'paid',
                   mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                   mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                   paid_at = COALESCE(paid_at, v_now), hold_expires_at = NULL, updated_at = v_now
             WHERE id = r.id;
            v_nos := v_nos || r.id;
          ELSE
            IF COALESCE(v_late.payment_status, '') <> 'paid' THEN
              UPDATE public.bookings
                 SET payment_status = 'paid',
                     status = CASE WHEN status = 'completed' THEN status ELSE 'confirmed' END,
                     mollie_payment_id = COALESCE(mollie_payment_id, v_pay),
                     mollie_transaction_id = COALESCE(mollie_transaction_id, v_txn),
                 paid_by_player_id = COALESCE(paid_by_player_id, _paid_by_player_id),
                 paid_by_guest_player_id = COALESCE(paid_by_guest_player_id, _paid_by_guest_player_id),
                     paid_at = COALESCE(paid_at, v_now), updated_at = v_now
               WHERE id = v_late.id;
              v_conf := v_conf || v_late.id;
            END IF;
            UPDATE public.bookings
               SET status = 'cancelled', hold_expires_at = NULL, updated_at = v_now
             WHERE id = r.id AND status = 'payment_pending';
            IF _invoice_id IS NOT NULL THEN
              UPDATE public.invoices
                 SET booking_ids = (
                       SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[])
                         FROM unnest(
                           array_remove(COALESCE(booking_ids, '{}'::uuid[]), r.id) || v_late.id
                         ) AS t(x))
               WHERE id = _invoice_id;
            END IF;
          END IF;
        END;
      END IF;
    END LOOP;
  END LOOP;
  END IF;

  -- ── invoice settles in THIS transaction, never invoice-first ─────────────────────────────
  -- The invoice stays paid even when every booking came back paid_no_seat: the money was
  -- captured, and ABC-23 does not auto-refund.
  IF _invoice_id IS NOT NULL THEN
    -- Conditional on the state we LOCKED and re-read: a concurrently cancelled invoice is never
    -- resurrected, and a second delivery does not re-stamp paid_at.
    UPDATE public.invoices
       SET status = 'paid',
           paid_at = COALESCE(paid_at, v_now),
           mollie_payment_id = COALESCE(mollie_payment_id, v_pay)
     WHERE id = _invoice_id
       AND COALESCE(status, '') NOT IN ('paid', 'cancelled');
    v_invoice_paid_now := FOUND;
  END IF;

  -- deterministic + de-duplicated result arrays
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_conf FROM unnest(v_conf) t(x);
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_already FROM unnest(v_already) t(x);
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_nos FROM unnest(v_nos) t(x);
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_replay FROM unnest(v_replay) t(x);
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}'::uuid[]) INTO v_ref FROM unnest(v_ref) t(x);

  -- refusal_reason stays PURELY a refusal channel. An earlier draft folded `invoice_paid_now`
  -- into it, which would make any caller testing `refusal_reason IS NOT NULL` read a successful
  -- invoice settlement as a failure. No caller needs the indicator until Boundary B, and adding
  -- a result column changes the return type, so it is deliberately not returned yet;
  -- v_invoice_paid_now remains request-local.
  RETURN QUERY SELECT v_conf, v_already, v_nos, v_replay, v_ref, v_reason, v_invoice_paid_now;
END;
$fn$;

REVOKE ALL ON FUNCTION public.settle_paid_bookings(uuid[], text, text, uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_paid_bookings(uuid[], text, text, uuid, uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.settle_paid_bookings(uuid[], text, text, uuid, uuid, uuid, text) IS
  'ABC-23: the single atomic paid-settlement authority. Locks slots FOR SHARE then advisory, both in ascending uuid order, before locking and re-reading targets; classifies hold liveness with clock_timestamp() after acquisition. Same-slot expired additions are all-or-none; independent slots fulfil independently. A seatless paid hold becomes cancelled+paid with provider ids and paid_at persisted and the hold cleared — never occupying, never resurrected. service_role only.';

DO $$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_paid_bookings';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ABC-23: settle_paid_bookings is missing'; END IF;
  IF v_src !~ 'FOR SHARE' OR v_src !~ 'pg_advisory_xact_lock' THEN
    RAISE EXCEPTION 'ABC-23: settle_paid_bookings must take both slot locks';
  END IF;
  IF v_src !~ 'clock_timestamp\(\)' THEN
    RAISE EXCEPTION 'ABC-23: hold liveness must be judged with clock_timestamp() after locking';
  END IF;
  IF has_function_privilege('authenticated', 'public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-23: settle_paid_bookings must be service_role only';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-23: service_role must retain EXECUTE';
  END IF;
END $$;

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

  -- 9c-ter. the twin claim/discovery RPCs are pinned by their REAL three-uuid and two-uuid
  --         signatures. `to_regprocedure` returns NULL rather than raising if the overload does
  --         not exist, so a wrong-signature edit fails here instead of aborting mid-migration.
  IF to_regprocedure('public.claim_guest_twin_for_academy(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'ABC-18: the shipped 3-uuid claim_guest_twin_for_academy is missing — wrong overload?';
  END IF;
  IF has_function_privilege('authenticated', 'public.claim_guest_twin_for_academy(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.claim_guest_twin_for_academy(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.find_guest_twin_for_academy(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-18: a twin claim/discovery RPC is still callable';
  END IF;

  -- 9c-quater. the owner-context auto-link triggers are gone and the mint paths no longer
  --            collapse on email or twin.
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_link_guest_data_on_guest_player_change' AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_link_guest_invoices_on_signup' AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_clear_guest_twin_on_repurpose' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'ABC-18: an owner-context auto-link or twin-clearing trigger is still installed';
  END IF;

  -- the merge and collapse primitives are not callable by any external role.
  IF has_function_privilege('authenticated', 'public.merge_guest_players(text,uuid,uuid,uuid,jsonb)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.merge_guest_players(text,uuid,uuid,uuid,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-18: merge_guest_players is still callable';
  END IF;
  IF has_function_privilege('authenticated', 'public.collapse_guest_person_into(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.collapse_guest_person_into(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.collapse_guest_person_into(uuid,uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-18: collapse_guest_person_into is still callable by an external role';
  END IF;

  -- the profile mirror keeps the canonical login identity: dropping user_id here would
  -- silently degrade every new account's person row.
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'mint_person_for_profile') !~ 'NEW\.user_id' THEN
    RAISE EXCEPTION 'ABC-18: mint_person_for_profile no longer mirrors user_id';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('mint_person_for_guest', 'mint_person_for_profile', 'relink_person_on_twin_change',
                         'link_guest_data_on_guest_player_change', 'link_guest_invoices_on_signup')
       AND p.prosrc ~ 'link_guest_data_to_profile|auto_merged'
  ) THEN
    RAISE EXCEPTION 'ABC-18: a person/link path still calls the minter or applies an auto-merge';
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

  -- 9e-bis. the priority surfaces admit pure-profile claims only. A restored raw arm shows up
  --         as a missing guest_player_id null-check in either the policy or the tier gate.
  -- Substring presence is NOT sufficient: `... OR guest_player_id IS NULL` contains the same
  -- text while WIDENING the policy. Require the profile equality AND the null-check, and refuse
  -- any disjunction in the predicate, so a widened rewrite fails here instead of shipping.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'slot_priority_claims'
       AND policyname = 'Players read own priority claims'
       AND qual::text ~ 'get_profile_id_for_user'
       AND qual::text ~ 'guest_player_id IS NULL'
       AND qual::text !~* '\mOR\M'
  ) THEN
    RAISE EXCEPTION 'ABC-18: the player priority-claim policy must be (player_id = me AND guest_player_id IS NULL), with no disjunction';
  END IF;

  -- Same for the tier gate: the null-check must sit inside the slot_priority_claims lookup, and
  -- that lookup must still be keyed on the caller's profile.
  IF (SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'can_book_slot')
     !~ 'slot_priority_claims[\s\S]*player_id = v_profile[\s\S]*guest_player_id IS NULL' THEN
    RAISE EXCEPTION 'ABC-18: can_book_slot must require a PURE-PROFILE priority claim (player_id = me AND guest_player_id IS NULL)';
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


-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ABC-23 §5 — reconciliation of captured money that holds no seat
--
-- Re-emitted from the EFFECTIVE definition (20260712100000_reconcile_payments_service_role.sql),
-- checks 1-9 byte-identical and the authorization gate unchanged: an end-user JWT must be admin,
-- and a NULL uid (the service role, which no end-user key can produce) is the nightly
-- invoice-health-check. Only check 10 is added.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.reconcile_payments(_since interval DEFAULT interval '30 days')
RETURNS TABLE (check_name text, severity text, entity_kind text, entity_id uuid, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Admin for user JWTs; a NULL uid is the service role (edge functions — the
  -- nightly invoice-health-check runs this), which no end-user key can produce.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  -- 1) Stranded invoice: has a Mollie payment id but never reached a terminal status (should be final).
  SELECT 'stranded_invoice'::text, 'P1'::text, 'invoice'::text, i.id,
         jsonb_build_object('status', i.status, 'mollie_payment_id', i.mollie_payment_id, 'total', i.total, 'created_at', i.created_at)
  FROM public.invoices i
  WHERE i.mollie_payment_id IS NOT NULL
    AND i.status NOT IN ('paid', 'cancelled')
    AND i.created_at < now() - interval '1 hour'
    AND i.created_at > now() - _since

  UNION ALL
  -- 2) A PAID invoice whose linked booking is still unpaid + not cancelled (writeback lost).
  SELECT 'invoice_paid_bookings_unpaid'::text, 'P1', 'invoice', i.id,
         jsonb_build_object('booking_id', b.id, 'booking_payment_status', b.payment_status, 'booking_status', b.status)
  FROM public.invoices i
  JOIN public.bookings b ON b.id = ANY(i.booking_ids)
  WHERE i.status = 'paid' AND b.payment_status IS DISTINCT FROM 'paid' AND b.status <> 'cancelled'
    AND COALESCE(i.paid_at, i.created_at) > now() - _since

  UNION ALL
  -- 3) A CANCELLED booking still billed by a PAID invoice (money taken, seat gone).
  SELECT 'cancelled_booking_on_paid_invoice'::text, 'P1', 'booking', b.id,
         jsonb_build_object('invoice_id', i.id)
  FROM public.invoices i
  JOIN public.bookings b ON b.id = ANY(i.booking_ids)
  WHERE i.status = 'paid' AND b.status = 'cancelled'
    AND COALESCE(i.paid_at, i.created_at) > now() - _since

  UNION ALL
  -- 4) Two ACTIVE (non-cancelled) invoices billing the SAME booking (double-pay risk).
  SELECT 'overlapping_active_invoices'::text, 'P0', 'invoice', i1.id,
         jsonb_build_object('other_invoice_id', i2.id,
           'overlap', (SELECT array_agg(x) FROM unnest(i1.booking_ids) x WHERE x = ANY(i2.booking_ids)))
  FROM public.invoices i1
  JOIN public.invoices i2 ON i1.id < i2.id AND i1.booking_ids && i2.booking_ids
  WHERE i1.status <> 'cancelled' AND i2.status <> 'cancelled'

  UNION ALL
  -- 5) More than one ACTIVE invoice for one rebook group (the unique index should prevent this).
  SELECT 'duplicate_rebook_group_invoice'::text, 'P0', 'invoice', i.id,
         jsonb_build_object('rebook_group_id', i.rebook_group_id, 'active_count', cnt.n)
  FROM public.invoices i
  JOIN (
    SELECT rebook_group_id, count(*) AS n FROM public.invoices
    WHERE rebook_group_id IS NOT NULL AND status <> 'cancelled'
    GROUP BY rebook_group_id HAVING count(*) > 1
  ) cnt ON cnt.rebook_group_id = i.rebook_group_id
  WHERE i.status <> 'cancelled'

  UNION ALL
  -- 6) An expired payment_pending hold still occupying capacity (release sweep lagging).
  SELECT 'stale_hold'::text, 'P1', 'booking', b.id,
         jsonb_build_object('slot_id', b.slot_id, 'hold_expires_at', b.hold_expires_at)
  FROM public.bookings b
  WHERE b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL
    AND b.hold_expires_at < now() - interval '10 minutes'

  UNION ALL
  -- 7) A SENT, payable invoice with no public_token → it cannot be paid.
  SELECT 'sent_invoice_no_token'::text, 'P1', 'invoice', i.id,
         jsonb_build_object('status', i.status, 'total', i.total)
  FROM public.invoices i
  WHERE i.status = 'sent' AND i.public_token IS NULL AND i.total > 0

  UNION ALL
  -- 8) A PAID invoice whose total drifts from the sum of its booked amounts (beyond tolerance).
  SELECT 'invoice_total_booking_sum_mismatch'::text, 'P1', 'invoice', s.invoice_id,
         jsonb_build_object('invoice_total', s.total, 'booking_sum', s.booking_sum, 'booking_count', s.n)
  FROM (
    SELECT i.id AS invoice_id, i.total, count(b.id) AS n, COALESCE(sum(b.payment_amount), 0) AS booking_sum
    FROM public.invoices i
    JOIN public.bookings b ON b.id = ANY(i.booking_ids)
    WHERE i.status = 'paid' AND COALESCE(i.paid_at, i.created_at) > now() - _since
    GROUP BY i.id, i.total
  ) s
  WHERE abs(s.total - s.booking_sum) > greatest(0.01, s.n * 0.01)

  UNION ALL
  -- 9) A booking marked paid > 1 day ago that no ACTIVE invoice bills (missing payment trail).
  SELECT 'booking_paid_no_invoice'::text, 'P2', 'booking', b.id,
         jsonb_build_object('slot_id', b.slot_id, 'paid_at', b.paid_at, 'payment_amount', b.payment_amount)
  FROM public.bookings b
  WHERE b.payment_status = 'paid' AND b.paid_at IS NOT NULL
    AND b.paid_at < now() - interval '1 day' AND b.paid_at > now() - _since
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices i WHERE b.id = ANY(i.booking_ids) AND i.status <> 'cancelled'
    )

  UNION ALL
  -- 10) ABC-23 paid_no_seat: money captured on a booking that holds NO seat. Settlement now
  -- records this state explicitly (cancelled + paid) instead of leaving a silent stale hold, so
  -- reconciliation can finally see it.
  --
  -- Deliberately NOT bounded by _since. Every other check is a freshness sweep; this one is an
  -- open financial obligation. A payment the operator has not yet refunded does not stop being
  -- owed because it is 31 days old, and a windowed report would quietly retire exactly the cases
  -- that went unhandled longest.
  --
  -- It clears when the operator sets the LOCAL payment_status to 'refunded' after handling the
  -- refund in Mollie. That is the whole lifecycle: this function still writes nothing, there is
  -- no automated refund, no operator queue and no new table.
  SELECT 'paid_no_seat'::text, 'P0', 'booking', b.id,
         jsonb_build_object(
           'slot_id', b.slot_id,
           'paid_at', b.paid_at,
           'payment_amount', b.payment_amount,
           'mollie_payment_id', b.mollie_payment_id,
           'invoice_ids', (SELECT COALESCE(array_agg(i.id), '{}'::uuid[])
                             FROM public.invoices i WHERE b.id = ANY(i.booking_ids)),
           'resolution', 'refund in Mollie, then set bookings.payment_status = ''refunded''')
  FROM public.bookings b
  WHERE b.status = 'cancelled' AND b.payment_status = 'paid';
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_payments(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_payments(interval) TO authenticated;

DO $chk$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reconcile_payments';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ABC-23 §5: reconcile_payments is missing'; END IF;
  IF COALESCE(v_src !~ 'paid_no_seat', true) THEN
    RAISE EXCEPTION 'ABC-23 §5: reconcile_payments must report paid_no_seat';
  END IF;
  -- The obligation report must not be windowed away. `.` matches newlines in a POSIX regex, so
  -- a whole-body pattern would match any _since anywhere; this looks only at the tail that
  -- starts at the check-10 SELECT.
  IF COALESCE(substring(v_src from position('''paid_no_seat''::text' in v_src)) ~ '_since', false) THEN
    RAISE EXCEPTION 'ABC-23 §5: the paid_no_seat check must not be bounded by _since';
  END IF;
  IF COALESCE(v_src !~ 'has_role', true) THEN
    RAISE EXCEPTION 'ABC-23 §5: reconcile_payments lost its admin gate';
  END IF;
END $chk$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- ABC-23 §4 — who may settle an invoice MANUALLY
--
-- This mirrors, exactly, the authorization the browser used to rely on: the two UPDATE policies
-- on public.invoices.
--   • "Trainers can update their own invoices"   → trainer_id ∈ this user's trainer_profiles
--   • "Academy managers can update invoices"     → is_academy_manager(uid, academy_profile_id)
--
-- There is deliberately NO admin arm: no admin UPDATE policy on public.invoices exists today, so
-- adding one here would WIDEN authority under cover of a refactor. An admin who is also the
-- owning trainer or an academy manager passes through those arms, exactly as now.
--
-- The player arm of the policy set is also excluded on purpose: players may update billing
-- details only, and trg_protect_invoice_financial_columns_for_players blocks them from touching
-- financial columns. Marking an invoice paid has never been theirs.
--
-- auth.uid() IS NOT NULL is load-bearing: the service role has a NULL uid, and a NULL-uid caller
-- must never satisfy a user-authorization check by accident.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.can_settle_invoice_manually(_invoice_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.invoices i
     WHERE i.id = _invoice_id
       AND auth.uid() IS NOT NULL
       AND (
         i.trainer_id IN (
           SELECT tp.id FROM public.trainer_profiles tp WHERE tp.user_id = auth.uid()
         )
         OR (
           i.academy_profile_id IS NOT NULL
           AND public.is_academy_manager(auth.uid(), i.academy_profile_id)
         )
       )
  );
$$;

REVOKE ALL ON FUNCTION public.can_settle_invoice_manually(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_settle_invoice_manually(uuid) TO authenticated;

DO $chk$
DECLARE v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'can_settle_invoice_manually';
  IF v_src IS NULL THEN RAISE EXCEPTION 'ABC-23 §4: can_settle_invoice_manually is missing'; END IF;
  IF COALESCE(v_src !~ 'auth\.uid\(\) IS NOT NULL', true) THEN
    RAISE EXCEPTION 'ABC-23 §4: the manual-settlement gate must refuse a NULL uid';
  END IF;
  IF COALESCE(v_src ~ 'has_role', false) THEN
    RAISE EXCEPTION 'ABC-23 §4: the manual-settlement gate must not add an admin arm';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.can_settle_invoice_manually(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ABC-23 §4: authenticated must be able to evaluate its own gate';
  END IF;
END $chk$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- PASS B §2 — guest/account contact separation
--
-- A guest's contact details are the GUEST's. The rebook senders used to fall back to an
-- "account" address resolved through the legacy bridge chain (curated person links, then
-- twin_of_profile_id, then linked_profile_id). Every element of that chain is Class D evidence:
-- it was written by an email/name matcher, not by anything that verified a relationship. Two
-- different people who once shared an address are joined by it, and a claim token or reminder
-- addressed to "the account" then reaches the wrong person.
--
-- So the account arm is withdrawn at the source and again at every consumer, rather than only at
-- the source: one restored function must not be able to re-open all of them.
--
-- SIGNATURES AND GRANTS ARE UNCHANGED. Result SHAPES are unchanged too — the account columns
-- remain and are always NULL/false — so no caller breaks and no types drift.
--
-- INTENTIONAL PRODUCT LOSS, recorded rather than discovered later:
--   • a guest with no email of their own is now UNRESOLVED and is skipped, where before they
--     would have been emailed at a linked account address;
--   • member-open recipients can no longer be told apart into "has an account" and "needs one",
--     because that was decided by the same bridge, so the signup CTA is shown to every guest.
-- Neither is a silent failure: both surface through the existing explicit skipped/unresolved
-- outcomes.
--
-- The bridge identifiers are deliberately ABSENT from every body below, including in comments —
-- the install assertions grep `prosrc`, and an explanatory comment naming the thing it forbids
-- would fail its own check. That trap has cost this branch a debug cycle before.
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guest_verified_account_profile(_guest_id uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Fail-closed. No legacy relationship evidence establishes an account for a guest, so there is
  -- no account profile to return. Kept as an object with its original signature and grants so
  -- every existing caller keeps working and simply resolves nothing.
  SELECT NULL::uuid;
$$;
REVOKE ALL ON FUNCTION public.guest_verified_account_profile(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guest_verified_account_profile(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_guest_member_contacts(_guest_ids uuid[])
RETURNS TABLE (
  guest_id uuid,
  own_name text,
  own_email text,
  account_name text,
  account_email text,
  has_account boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Own attributes only. The account columns are retained at their original positions and types
  -- so the row shape callers destructure is unchanged; they are constant NULL/false because no
  -- account can be established for a guest.
  SELECT
    gp.id,
    gp.full_name,
    NULLIF(btrim(gp.email), ''),
    NULL::text,
    NULL::text,
    false
  FROM public.guest_players gp
  WHERE gp.id = ANY(_guest_ids);
$$;
REVOKE ALL ON FUNCTION public.resolve_guest_member_contacts(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_guest_member_contacts(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.guests_have_rebook_contact(_guest_ids uuid[])
RETURNS TABLE (guest_id uuid, has_contact boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Oversize input still FAILS LOUD rather than silently truncating: getCycleRebookStatus reads
  -- every absent id as has_contact=false, so a capped WHERE would show reachable members as
  -- unreachable. Unchanged from the effective definition.
  IF cardinality(_guest_ids) > 1000 THEN
    RAISE EXCEPTION 'guests_have_rebook_contact: too many ids (%); max 1000 per call', cardinality(_guest_ids)
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  RETURN QUERY
  -- The tenant gate is unchanged: only guests holding a claim on a slot in a cycle owned by an
  -- academy the CALLER manages are answered about at all.
  WITH authorized AS (
    SELECT DISTINCT spc.guest_player_id AS gid
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots s ON s.id = spc.slot_id
    JOIN public.cycles c ON c.id = s.cyclus_id AND c.owner_type = 'academy'
    JOIN public.academy_managers am ON am.academy_profile_id = c.owner_id AND am.user_id = auth.uid()
    WHERE spc.guest_player_id = ANY(_guest_ids)
  )
  SELECT a.gid, (NULLIF(btrim(gp.email), '') IS NOT NULL)
  FROM authorized a
  JOIN public.guest_players gp ON gp.id = a.gid;
END;
$$;
REVOKE ALL ON FUNCTION public.guests_have_rebook_contact(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.guests_have_rebook_contact(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.rebook_claims_needing_auto_reminder(_lead_hours int DEFAULT 24)
RETURNS TABLE (
  cycle_id uuid,
  cycle_name text,
  academy_name text,
  player_id uuid,
  guest_player_id uuid,
  recipient_name text,
  recipient_email text,
  claim_token text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Guest-first namespaced key (FAM-02): a guest row is exactly g:<guest>, so a child and the
  -- adult whose address once matched theirs remain two representatives, not one.
  SELECT DISTINCT ON (c.id, COALESCE('g:' || spc.guest_player_id::text, 'p:' || spc.player_id::text))
    c.id,
    c.name,
    ap.name,
    spc.player_id,
    spc.guest_player_id,
    -- A guest shows their OWN name and is addressed at their OWN email. The claim's player_id is
    -- not consulted: it is decoration on a dual-key row, not proof of anything. A pure profile
    -- (player_id set, guest null) keeps its own direct profile contact.
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN NULLIF(btrim(gp.full_name), '')
         ELSE pr.full_name END,
    CASE WHEN spc.guest_player_id IS NOT NULL
         THEN NULLIF(btrim(gp.email), '')
         ELSE NULLIF(btrim(pr.email), '') END,
    spc.claim_token
  FROM public.slot_priority_claims spc
  JOIN public.availability_slots s ON s.id = spc.slot_id
  JOIN public.cycles c ON c.id = s.cyclus_id
  JOIN public.academy_profiles ap ON ap.id = c.owner_id
  LEFT JOIN public.profiles pr ON pr.id = spc.player_id
  LEFT JOIN public.guest_players gp ON gp.id = spc.guest_player_id
  WHERE spc.status = 'pending'
    AND spc.claim_token IS NOT NULL
    AND spc.reminder_sent_at IS NULL
    AND spc.expires_at IS NOT NULL
    AND spc.expires_at > now()
    AND spc.expires_at <= now() + make_interval(hours => _lead_hours)
    AND s.start_time > now()
  ORDER BY c.id,
           COALESCE('g:' || spc.guest_player_id::text, 'p:' || spc.player_id::text),
           spc.expires_at;
$$;
REVOKE ALL ON FUNCTION public.rebook_claims_needing_auto_reminder(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebook_claims_needing_auto_reminder(int) TO service_role;

DO $chk$
DECLARE
  v_src text;
  v_fn text;
  -- Assembled at runtime so the forbidden identifiers never appear as literals in prosrc, which
  -- is what the greps below inspect.
  v_bridge text[] := ARRAY['person_' || 'links', 'twin_of_' || 'profile_id', 'linked_' || 'profile_id'];
  v_tok text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'guest_verified_account_profile',
    'resolve_guest_member_contacts',
    'guests_have_rebook_contact',
    'rebook_claims_needing_auto_reminder'
  ] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;
    IF v_src IS NULL THEN
      RAISE EXCEPTION 'Pass B §2: % is missing', v_fn;
    END IF;
    FOREACH v_tok IN ARRAY v_bridge LOOP
      IF position(v_tok in v_src) > 0 THEN
        RAISE EXCEPTION 'Pass B §2: % still reads legacy relationship evidence (%)', v_fn, v_tok;
      END IF;
    END LOOP;
  END LOOP;

  -- The tenant gate and the loud over-cap guard must both survive the narrowing.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'guests_have_rebook_contact';
  IF COALESCE(v_src !~ 'academy_managers', true) THEN
    RAISE EXCEPTION 'Pass B §2: guests_have_rebook_contact lost its tenant gate';
  END IF;
  IF COALESCE(v_src !~ 'program_limit_exceeded', true) THEN
    RAISE EXCEPTION 'Pass B §2: guests_have_rebook_contact lost its over-cap refusal';
  END IF;

  -- Pure-profile contact must remain reachable, or the narrowing has silenced legitimate sends.
  SELECT p.prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'rebook_claims_needing_auto_reminder';
  IF COALESCE(v_src !~ 'pr\.email', true) THEN
    RAISE EXCEPTION 'Pass B §2: the pure-profile arm lost its direct profile contact';
  END IF;

  -- Grants unchanged: none of these may become client-callable, and the one that always was
  -- (the manager-facing contact predicate) must stay so.
  IF has_function_privilege('anon', 'public.resolve_guest_member_contacts(uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.resolve_guest_member_contacts(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Pass B §2: resolve_guest_member_contacts must stay service_role only';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.guests_have_rebook_contact(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Pass B §2: guests_have_rebook_contact must stay callable by managers';
  END IF;
END $chk$;
