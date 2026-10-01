-- D7 RUNTIME — THE INVITE'S RECIPIENT FACTS REACH DOMAIN N THROUGH DOMAIN-P BRIDGES.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_CANONICAL_OUTBOX_TRANSPORT_IMPLEMENTATION_V1`):
--   `CROSS_OWNER=INVITE_RECIPIENT_FACTS_REACH_DOMAIN_N_ONLY_THROUGH_P_OWNED_SELECT_ONLY_d7_p_BRIDGES
--    _GRANTED_TO_THE_N_OWNER_ALONE`
--   `LOCK_ORDER=NO_PRODUCT_ROW_LOCK_AND_NO_OUTBOX_COLUMN_FK_TO_slot_priority_claims`
--
-- ── WHY A BRIDGE AT ALL, STATED ACCURATELY ──────────────────────────────────────────────────
--
-- MEASURED FIRST, THEN WRITTEN. The preflight assumed Domain N and Domain P were distinct owners
-- and that a Domain-N body therefore could not read `slot_priority_claims` at all. That is NOT the
-- topology: `notification_outbox` and `public.cycles` are both owned by `postgres`. Only Domain A
-- — the round-command authority — is a separate role, which is why `20261203180000` refuses to
-- install when the A and P owners resolve equal.
--
-- So this bridge is NOT a privilege boundary today, and claiming it were one would be a comment
-- that lies about the code beneath it. What it is:
--
--   * ONE named place where transport reads product. `pre_dispatch_resolve` reaching into
--     `slot_priority_claims`, `availability_slots`, `guest_players` and `profiles` inline would put
--     four product dependencies inside a transport body, where nobody reviewing delivery would
--     think to look for them.
--   * A TENANCY ANCHOR that is relational rather than asserted: the claim's slot must belong to the
--     academy the caller named, checked here once instead of at every call site.
--   * A CONTACT-PRESENCE projection that returns a boolean and never an address.
--   * Correct in advance if the owners are ever separated, which is the direction this project has
--     moved twice already.
--
-- The ownership and grants below are therefore about keeping the negative space closed — no runtime
-- role may reach these — rather than about crossing an owner boundary that does not currently
-- exist.
--
-- ── WHY THEY TAKE NO LOCK, AND CARRY NO FOREIGN KEY ─────────────────────────────────────────
--
-- These are read inside the dispatch transaction, which also writes `notification_outbox`. If they
-- took a product row lock — `FOR UPDATE`, or a referential lock through an FK — that transaction
-- would hold an N→P wait edge while a product path holds P and wants N. `SELECT` only, therefore,
-- and no outbox column references `slot_priority_claims`.
--
-- The claim id travels as a PLAIN UUID. ABC-27 records the same decision for
-- `rebook_round_commands` (`:3419`), where a direct FK made the receipt insert run a referential
-- lookup against a P-owned row after product locks — "an unmanifested A→P wait edge, reached
-- through PostgreSQL's referential machinery rather than a reviewed purpose-specific helper."
--
-- IT ALSO SOLVES THE DEFECT THAT STARTED ALL THIS. The guest-merge path executes
-- `DELETE FROM public.slot_priority_claims …`, so a send record that referenced the claim by FK
-- would be deleted with it — or would block the merge. Keyed by a plain uuid, the outbox row
-- OUTLIVES the claim, which is what makes it a durable send authority rather than a product
-- artefact.

DO $d7_invite_bridges$
DECLARE
  v_n name;
  v_p name;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR to_regclass('public.slot_priority_claims') IS NULL
     OR to_regprocedure('public.rebook_round_protected_event_types()') IS NULL THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after the protected vocabulary)';
    RETURN;
  END IF;

  SELECT c.relowner::regrole::name INTO v_n
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.notification_outbox');
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.cycles');
  IF v_n IS NULL OR v_p IS NULL THEN
    RAISE EXCEPTION 'D7 invite bridges: could not resolve the N (%) and P (%) owners', v_n, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_n, 'MEMBER')
     OR NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 invite bridges: % is not a member of both owners', current_user;
  END IF;

  -- ── THE RECIPIENT SNAPSHOT ────────────────────────────────────────────────────────────────
  --
  -- One row, or none. `none` is the honest answer for a claim that was merged away, responded to,
  -- or never belonged to this academy — and the caller must treat all three identically, because
  -- distinguishing them would make this an existence oracle for another tenant's claims.
  --
  -- CONTACT PRESENCE, NEVER AN ADDRESS. The address is resolved at dispatch by the sender, which
  -- already has it; disclosing it here would put a second copy of a recipient's email inside the
  -- transport layer for no purpose the transport serves.
  CREATE OR REPLACE FUNCTION public.d7_p_invite_recipient_snapshot(
    p_academy uuid,
    p_claim   uuid
  ) RETURNS TABLE (
    claim_id        uuid,
    slot_id         uuid,
    cyclus_id       uuid,
    player_id       uuid,
    guest_player_id uuid,
    has_contact     boolean,
    already_invited boolean,
    still_pending   boolean
  ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $sn$
    SELECT c.id, c.slot_id, s.cyclus_id, c.player_id, c.guest_player_id,
           CASE
             WHEN c.guest_player_id IS NOT NULL
               -- THE GUEST'S OWN ADDRESS ONLY. `resolve_guest_member_contacts` returns exactly
               -- this and the account arm was deliberately removed (Pass B §2): the "account" a
               -- guest resolved to came from a legacy email/name matcher that joins two different
               -- people who once shared an address.
               THEN (SELECT nullif(btrim(g.email), '') IS NOT NULL
                       FROM public.guest_players g WHERE g.id = c.guest_player_id)
             ELSE (SELECT nullif(btrim(pr.email), '') IS NOT NULL
                     FROM public.profiles pr WHERE pr.id = c.player_id)
           END,
           c.invited_at IS NOT NULL,
           coalesce(c.status, 'pending') = 'pending'
      FROM public.slot_priority_claims c
      JOIN public.availability_slots s ON s.id = c.slot_id
     WHERE c.id = p_claim
       -- TENANCY IS RELATIONAL, not a parameter the caller asserts: the claim's slot must belong
       -- to the academy the caller named.
       AND s.academy_profile_id = p_academy
  $sn$;

  -- ── THE ROUND'S OUTSTANDING CLAIMS ────────────────────────────────────────────────────────
  --
  -- The set a drain may consider, bounded and tenant-anchored. It deliberately does NOT decide
  -- sendability: whether a claim may be sent depends on its outbox row, which is Domain N's to
  -- read, and mixing the two here would put delivery correctness inside a product bridge.
  CREATE OR REPLACE FUNCTION public.d7_p_invite_round_claims(
    p_academy uuid,
    p_cyclus  uuid,
    p_limit   int
  ) RETURNS TABLE (claim_id uuid, slot_id uuid, has_contact boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $rc$
    SELECT c.id, c.slot_id,
           CASE
             WHEN c.guest_player_id IS NOT NULL
               THEN (SELECT nullif(btrim(g.email), '') IS NOT NULL
                       FROM public.guest_players g WHERE g.id = c.guest_player_id)
             ELSE (SELECT nullif(btrim(pr.email), '') IS NOT NULL
                     FROM public.profiles pr WHERE pr.id = c.player_id)
           END
      FROM public.slot_priority_claims c
      JOIN public.availability_slots s ON s.id = c.slot_id
     WHERE s.cyclus_id = p_cyclus
       AND s.academy_profile_id = p_academy
       AND coalesce(c.status, 'pending') = 'pending'
     -- ORDERED, so two callers see the same page and a bounded scan is reproducible.
     ORDER BY c.id
     LIMIT greatest(coalesce(p_limit, 0), 0)
  $rc$;

  -- ── OWNERSHIP FIRST, PRIVILEGES SECOND ────────────────────────────────────────────────────
  --
  -- `ALTER FUNCTION … OWNER TO` REWRITES the ACL's owner entries, so a REVOKE/GRANT issued before
  -- the transfer is partly undone by it.
  EXECUTE format('ALTER FUNCTION public.d7_p_invite_recipient_snapshot(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE format('ALTER FUNCTION public.d7_p_invite_round_claims(uuid,uuid,int) OWNER TO %I', v_p);
  REVOKE ALL ON FUNCTION public.d7_p_invite_recipient_snapshot(uuid,uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.d7_p_invite_round_claims(uuid,uuid,int)
    FROM PUBLIC, anon, authenticated, service_role;
  -- THE CONSUMING OWNER ALONE. Not service_role, not Domain A. Today `v_n = v_p = postgres`, so
  -- this grant is a formality — the owner already holds EXECUTE — and it is issued anyway so the
  -- statement stays true, and stays sufficient, if the owners are ever separated.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_invite_recipient_snapshot(uuid,uuid) TO %I', v_n);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_invite_round_claims(uuid,uuid,int) TO %I', v_n);

  RAISE NOTICE 'D7: the invite recipient bridges are installed — % owns them, % may call them', v_p, v_n;
END $d7_invite_bridges$;
