-- ════════════════════════════════════════════════════════════════════════════════════════════
-- D7 Stage 7.4-C — CROSS-OWNER CONTENTION CLOSURE.
--
-- Timestamp `20261118115500` is coordinator-issued to this unit inside the reserved pre-U2 ABC
-- block. It sorts AFTER the ABC-16/17 containment migration `20261118110000` (whose bytes are
-- the current authority for `settle_paid_bookings`) and BEFORE the ABC-27/28 round authority
-- `20261118120000`, so the D7 unit's Stage-0 sees the definitions this file installs. It is NOT
-- self-allocated.
--
-- WHY THIS IS ITS OWN MIGRATION, AND NOT PART OF THE D7 UNIT. Both functions below belong to
-- OTHER authorities: `enforce_booking_slot_tier` is the shipped booking tier/member-window
-- gate, and `settle_paid_bookings` is the ABC-23 paid-settlement command. D7 is allowed to
-- observe that its own design collides with them; it is not allowed to quietly re-own them.
-- Burying a change to two cross-owner authorities inside a 1.2 MB round-authority migration
-- would make both un-reviewable and un-revertable as separate decisions, so the owner approved
-- exactly one separately owned migration instead. Rollback for either half is re-emitting the
-- prior body, which is why the preflight below pins the exact predecessor each one replaces.
--
-- THE ONE DEFECT THIS CLOSES, MEASURED ON THE REAL INSTALLED CHAIN. The settlement authority
-- takes its per-slot advisory lock BEFORE it locks the booking rows. Direct RLS booking DML is
-- inherently booking-first: the tuple lock is taken before any BEFORE-row trigger runs, so a
-- client reviving a cancelled booking holds the booking tuple and only then reaches the tier
-- trigger's advisory acquisition. Run against each other, those two orders are a genuine
-- wait-for cycle, and PostgreSQL picks the SETTLEMENT as the victim: it dies at its
-- `bookings … FOR UPDATE` with a raw `40P01` whose DETAIL leaks pids, the advisory key and
-- tuple identity, while the unpaid revive wins. On a payment webhook that is captured money
-- turning into an unhandled 500 and an endless provider retry.
--
-- WHAT THIS INSTALLS, AND NOTHING ELSE:
--
--   §2  `public.enforce_booking_slot_tier` — re-emitted whole from its authoritative current
--       definition, with ONE arm changed: the same-slot cancelled→active revive acquires the
--       per-slot advisory lock TRY-ONLY and, when it cannot, refuses with one closed,
--       object-free, retryable 40001. That removes this trigger from the wait-for graph, so the
--       cycle cannot form at all. INSERT and slot-move keep byte-identical BLOCKING semantics —
--       capacity on those arms is still decided under an exclusive lock.
--   §3  `public.settle_paid_bookings` — re-emitted whole from its authoritative current
--       definition, with ONE narrow handler added on its own outermost block: `deadlock_detected`
--       becomes the typed retryable refusal `deadlock_retry` in the vocabulary the function
--       already has, rolled back atomically by that block's subtransaction.
--
-- WHAT THIS DOES NOT DO. No table, column, index, constraint, policy, RLS or FORCE change; no
-- role, ACL or default-privilege change; no new relation, no backfill, no data write; no change
-- to any function's identity, overload set, owner, SECURITY DEFINER status, search path or
-- effective EXECUTE; no client, Edge or runtime change; no lock, statement or deadlock timeout;
-- no retry loop; no change to who may book what, to capacity, to eligibility or to pricing. §4
-- proves each of those by comparing a structural fingerprint taken before the two replacements
-- against the same fingerprint taken after.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- §1. Preflight — refuse to adopt, and refuse to replace an unreviewed body.
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- A `CREATE OR REPLACE` is silent about what it replaced. Both functions below are cross-owner
-- authorities, so replacing a body other than the one that was actually reviewed would be
-- overwriting someone else's un-reviewed decision. Each predecessor is therefore pinned by the
-- SHA-256 of its `prosrc`, derived from a clean disposable install of the full repaired 614-file
-- lineage — not transcribed from a review note. The identity, owner, SECURITY DEFINER status and
-- configuration are pinned alongside, because a body digest alone would accept a re-owned or
-- re-configured function carrying identical source text.
DO $d7c_preflight$
DECLARE
  v_tier_oid    oid;
  v_settle_oid  oid;
  v_src         text;
  v_n           integer;
BEGIN
  -- Exactly one overload of each, under its exact expected signature.
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enforce_booking_slot_tier';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C preflight: expected exactly one public.enforce_booking_slot_tier, found %', v_n
      USING HINT = 'This migration re-emits a single reviewed definition. An unexpected overload set means the authority moved; stop rather than adapt.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_paid_bookings';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C preflight: expected exactly one public.settle_paid_bookings, found %', v_n
      USING HINT = 'This migration re-emits a single reviewed definition. An unexpected overload set means the authority moved; stop rather than adapt.';
  END IF;

  v_tier_oid   := to_regprocedure('public.enforce_booking_slot_tier()');
  v_settle_oid := to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)');
  IF v_tier_oid IS NULL OR v_settle_oid IS NULL THEN
    RAISE EXCEPTION 'D7.4-C preflight: an expected cross-owner authority does not exist under its pinned signature'
      USING HINT = 'This migration adopts nothing by name. Both predecessors must already exist exactly as reviewed.';
  END IF;

  -- Execution identity of each predecessor, pinned.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid = v_tier_oid
      AND p.proowner::regrole::text = 'postgres' AND p.prosecdef
      AND p.proconfig::text = '{search_path=public}' AND p.prorettype = 'trigger'::regtype
  ) THEN
    RAISE EXCEPTION 'D7.4-C preflight: public.enforce_booking_slot_tier is not the reviewed owner/SECURITY DEFINER/search_path/return shape';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p WHERE p.oid = v_settle_oid
      AND p.proowner::regrole::text = 'postgres' AND p.prosecdef
      AND p.proconfig::text = '{search_path=public}' AND p.proretset
  ) THEN
    RAISE EXCEPTION 'D7.4-C preflight: public.settle_paid_bookings is not the reviewed owner/SECURITY DEFINER/search_path/set-returning shape';
  END IF;

  -- The exact predecessor bodies this file is authorized to replace.
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_src
    FROM pg_proc p WHERE p.oid = v_tier_oid;
  IF v_src IS DISTINCT FROM '395d317eb5f25c3b4bf57b653d0406aada81d9a083dda283c133037e67bb3396' THEN
    RAISE EXCEPTION 'D7.4-C preflight: public.enforce_booking_slot_tier body is %, not the reviewed predecessor', v_src
      USING HINT = 'Only the revive arm of the REVIEWED body is authorized to change. A different predecessor means someone else changed this authority; re-review rather than overwrite.';
  END IF;
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') INTO v_src
    FROM pg_proc p WHERE p.oid = v_settle_oid;
  IF v_src IS DISTINCT FROM 'b3feb7f942e9e5dafc05a16965a517aaf18de8059421dd18ac6977eba39799dc' THEN
    RAISE EXCEPTION 'D7.4-C preflight: public.settle_paid_bookings body is %, not the reviewed predecessor', v_src
      USING HINT = 'Only one narrow deadlock handler is authorized to be added to the REVIEWED body. A different predecessor means the settlement authority moved; re-review rather than overwrite.';
  END IF;
END
$d7c_preflight$;

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- §1b. The before-fingerprint. §4 proves nothing structural moved by re-deriving it after.
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Asserting "this migration changed no table" by listing what it does not do is not a proof.
-- This captures ONE digest over the whole `public` schema's relations, columns, constraints,
-- indexes, policies, RLS/FORCE flags, owners and relation ACLs, plus a SECOND digest over every
-- routine's identity, owner, SECURITY DEFINER status, configuration, raw ACL and effective
-- EXECUTE vector EXCLUDING the two bodies this file replaces. §4 re-derives both and requires
-- byte equality, so any structural or privilege side effect fails the install rather than
-- shipping unnoticed. The table is dropped explicitly at the end of the file.
CREATE TEMP TABLE d7c_before_fingerprint (kind text PRIMARY KEY, digest text NOT NULL);

INSERT INTO d7c_before_fingerprint (kind, digest) VALUES ('structural', (
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce((
    SELECT string_agg(s.x, E'\x1e' ORDER BY s.x) FROM (
      SELECT 'REL' || E'\x1f' || c.relname || E'\x1f' || c.relkind::text
             || E'\x1f' || c.relrowsecurity::text || E'\x1f' || c.relforcerowsecurity::text
             || E'\x1f' || c.relowner::regrole::text
             || E'\x1f' || coalesce(c.relacl::text, '<default>') AS x
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      UNION ALL
      SELECT 'COL' || E'\x1f' || c.relname || E'\x1f' || a.attname || E'\x1f' || a.attnum::text
             || E'\x1f' || format_type(a.atttypid, a.atttypmod) || E'\x1f' || a.attnotnull::text
             || E'\x1f' || coalesce(nullif(a.attgenerated::text, ''), '<none>')
             || E'\x1f' || coalesce(nullif(a.attidentity::text, ''), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(d.adbin, d.adrelid), '<none>')
             || E'\x1f' || coalesce(a.attacl::text, '<none>')
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON' || E'\x1f' || c.relname || E'\x1f' || con.conname || E'\x1f' || con.contype::text
             || E'\x1f' || con.convalidated::text || E'\x1f' || pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'IDX' || E'\x1f' || ic.relname || E'\x1f' || pg_get_indexdef(i.indexrelid)
             || E'\x1f' || i.indisvalid::text || E'\x1f' || i.indisready::text || E'\x1f' || i.indislive::text
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'POL' || E'\x1f' || c.relname || E'\x1f' || p.polname || E'\x1f' || p.polcmd::text
             || E'\x1f' || p.polpermissive::text
             || E'\x1f' || coalesce((SELECT string_agg(coalesce(r.rolname::text, 'PUBLIC'), ','
                                       ORDER BY coalesce(r.rolname::text, 'PUBLIC'))
                                       FROM unnest(p.polroles) e(roleoid)
                                       LEFT JOIN pg_roles r ON r.oid = e.roleoid), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(p.polqual, p.polrelid), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '<none>')
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'TRG' || E'\x1f' || c.relname || E'\x1f' || t.tgname || E'\x1f' || pg_get_triggerdef(t.oid)
             || E'\x1f' || t.tgenabled::text
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ) s), ''), 'UTF8')), 'hex')
));
INSERT INTO d7c_before_fingerprint (kind, digest) VALUES ('routine', (
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce((
    SELECT string_agg(s.x, E'\x1e' ORDER BY s.x) FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
             || E'\x1f' || pg_get_function_result(p.oid)
             || E'\x1f' || p.proowner::regrole::text
             || E'\x1f' || p.prosecdef::text
             || E'\x1f' || p.prokind::text
             || E'\x1f' || p.provolatile::text
             || E'\x1f' || l.lanname
             || E'\x1f' || coalesce(p.proconfig::text, '<none>')
             || E'\x1f' || coalesce(p.proacl::text, '<default>')
             || E'\x1f' || (SELECT string_agg(r2.rolname || '=' ||
                              has_function_privilege(r2.rolname, p.oid, 'EXECUTE')::text,
                              ',' ORDER BY r2.rolname)
                              FROM (VALUES ('postgres'),('anon'),('authenticated'),('service_role')) r2(rolname)) AS x
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = 'public'
    ) s), ''), 'UTF8')), 'hex')
));

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- §2. public.enforce_booking_slot_tier — the revive arm stops waiting.
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- RE-EMITTED WHOLE, NOT PATCHED. The body below is the authoritative current definition read
-- back out of the catalog on a clean install of the full repaired lineage, with exactly one
-- region replaced. Emitting the whole function is what makes the review unit "the definition
-- that will exist", instead of a text edit whose result the reader has to simulate. Everything
-- else — the `auth.uid()` skip, the early-return arm, the capacity count and its allow-list, the
-- `slot_full` 23514, the `can_book_slot` tier gate and its message pass-through, SECURITY
-- DEFINER, the pinned search path, the owner and every grant — is byte-identical to the
-- predecessor §1 pinned.
--
-- THE UNCONTENDED BEHAVIOUR OF EVERY ARM IS UNCHANGED. `pg_try_advisory_xact_lock` and
-- `pg_advisory_xact_lock` acquire the same lock on the same key; they differ only when the lock
-- is already held by another transaction. With no contention the revive arm takes the lock,
-- counts seats and answers 23514 `slot_full` or admits, exactly as before.

CREATE OR REPLACE FUNCTION public.enforce_booking_slot_tier()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_profile uuid;
  v_slot           public.availability_slots;
  v_seats_taken    integer;
  v_reason         text;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  v_caller_profile := public.get_profile_id_for_user(auth.uid());

  IF TG_OP = 'UPDATE'
     AND NEW.slot_id IS NOT DISTINCT FROM OLD.slot_id
     AND NOT (COALESCE(OLD.status, 'confirmed') IN ('cancelled', 'cancelled_swap')
              AND COALESCE(NEW.status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap')) THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_slot FROM public.availability_slots WHERE id = NEW.slot_id;
  IF v_slot.id IS NULL THEN
    RETURN NEW; -- let the FK constraint handle a bad slot_id
  END IF;

  -- ── D7 7.4-C: THE REVIVE ARM ACQUIRES TRY-ONLY; EVERY OTHER ARM IS UNCHANGED ──────────────
  -- Reaching this line at all means the early return above did not fire. For TG_OP='UPDATE'
  -- with an unchanged `slot_id` that can only be the same-slot cancelled→active REVIVE, because
  -- every other same-slot update already returned. The condition below is therefore an exact,
  -- exhaustive restatement of the revive arm — not a widening of it. INSERT and the slot-move
  -- arm keep byte-identical blocking semantics; neither participates in the cycle this closes,
  -- and neither may lose its guarantee that capacity is decided under an exclusive lock.
  --
  -- WHY. The shipped settlement authority takes its per-slot advisory lock BEFORE it locks the
  -- booking rows, while direct RLS booking DML is inherently booking-first: a client revive
  -- holds the booking tuple and only then reaches this acquisition. That is a genuine wait-for
  -- cycle, and the server picks the SETTLEMENT as its victim — captured money dies with a raw
  -- 40P01 while the unpaid revive wins. Try-only removes this trigger from the wait-for graph
  -- entirely, so the cycle cannot form: the client is refused closed and instantly, and the
  -- settlement completes. No timeout, no retry loop, and no change to who may book what.
  IF TG_OP = 'UPDATE' AND NEW.slot_id IS NOT DISTINCT FROM OLD.slot_id THEN
    IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.slot_id::text, 0)) THEN
      -- The same closed refusal contract the source-membership fence raises: class 40001, no
      -- DETAIL, no HINT, and no slot, booking, tenant or subject named, so a caller learns
      -- nothing from it beyond "retry". Raising here aborts the statement and — with no
      -- caller-side handler on any client revive path — the whole transaction, leaving zero
      -- residue. Capacity is NOT decided on this branch: refusing is not admitting.
      RAISE EXCEPTION 'a booking revive could not take its slot capacity lock without waiting'
        USING ERRCODE = '40001';
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.slot_id::text, 0));
  END IF;

  SELECT count(*) INTO v_seats_taken
  FROM public.bookings
  WHERE slot_id = NEW.slot_id
    AND id <> NEW.id
    AND (
      COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
    );

  IF v_seats_taken >= COALESCE(v_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.player_id IS NULL OR NEW.player_id <> v_caller_profile THEN
    RETURN NEW;
  END IF;

  -- Self-booking tier gate — single source of truth (RB02 corrections live inside).
  v_reason := public.can_book_slot(NEW.slot_id, auth.uid());
  IF v_reason <> '' THEN
    RAISE EXCEPTION USING MESSAGE = v_reason, ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$
;

COMMENT ON FUNCTION public.enforce_booking_slot_tier() IS
  'Booking tier/member-window and capacity gate. D7 7.4-C: the same-slot cancelled->active REVIVE arm acquires the per-slot advisory lock TRY-ONLY and refuses with one closed, object-free, retryable 40001 when it cannot; INSERT and slot-move keep their blocking acquisition, so capacity on those arms is still decided under an exclusive lock. This exists because the shipped settlement authority locks slot-advisory-first while direct RLS booking DML is inherently booking-first, which is a genuine wait-for cycle whose victim PostgreSQL picks as the settlement — captured money dying with a raw 40P01 on a payment webhook while an unpaid revive wins. Try-only removes this trigger from the wait-for graph, so the cycle cannot form. No timeout and no retry loop is introduced, no eligibility, capacity, pricing, RLS or client behaviour changes, and the uncontended answer on every arm is identical to the predecessor.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- §3. public.settle_paid_bookings — one narrow retryable outcome.
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- RE-EMITTED WHOLE, for the same reason as §2: this is the ABC-23 settlement authority and its
-- M-17 survivor semantics, and a reader must be able to see the definition that will exist. The
-- body below is the authoritative current definition — the bytes installed by
-- `20261118110000` — with exactly one narrow handler added on its own outermost block. Every
-- refusal value, every lock, every survivor decision, the invoice-only path, the replay
-- semantics and the entire existing vocabulary are byte-identical to the predecessor §1 pinned.
--
-- WHAT THE NEW VALUE MEANS TO A CALLER. `deadlock_retry` joins the existing closed refusal
-- vocabulary. It is the only value in it that promises the call had NO effect at all: the
-- handler's subtransaction rolled every write back before the row was returned. A caller may
-- re-issue the identical call; the function's replay and idempotency semantics are unchanged,
-- so a retry after a genuine deadlock settles exactly once.

CREATE OR REPLACE FUNCTION public.settle_paid_bookings(_booking_ids uuid[], _provider_payment_id text, _provider_transaction_id text DEFAULT NULL::text, _invoice_id uuid DEFAULT NULL::uuid, _paid_by_player_id uuid DEFAULT NULL::uuid, _paid_by_guest_player_id uuid DEFAULT NULL::uuid, _settlement_source text DEFAULT 'mollie'::text)
 RETURNS TABLE(confirmed_paid uuid[], already_confirmed_paid uuid[], paid_no_seat uuid[], replayed_paid_no_seat uuid[], refused uuid[], refusal_reason text, invoice_paid_now boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

-- ── D7 7.4-C: ONE NARROW RETRYABLE OUTCOME, AND NOTHING ELSE ────────────────────────────────
-- This handler is attached to the function's OWN outermost block, and that is what gives it a
-- subtransaction boundary: when it fires, every booking, payment and invoice write this call
-- made has already been rolled back, so a deadlock leaves the world exactly as it found it.
-- The caller is then told so in the function's EXISTING typed vocabulary — one more refusal
-- value, not a new channel, not a new column, and not an exception the webhook must parse.
--
-- IT CATCHES EXACTLY ONE CONDITION. Not WHEN OTHERS, and deliberately not serialization_failure:
-- an arbitrary 40001 is NOT known to be this cycle, and absorbing one would convert a genuine
-- product refusal — the source-membership fence's, or the revive arm's above — into a silent
-- "retry me" that hides a real answer. `deadlock_detected` is 40P01 and nothing else. Every
-- other error, and every existing refusal path, propagates or returns exactly as before.
--
-- NO LOCK IDENTITY LEAVES THIS FUNCTION. The row names no relation, no lock object, no pid and
-- no counterparty; a service-role caller learns only that the call is retryable.
--
-- WHY A ROW AND NOT A RE-RAISE. This authority is called from a payment webhook. A raw 40P01
-- there is an unhandled 500 and an endless provider retry against captured money; a typed
-- refusal is a value the caller already branches on.
--
-- `v_ids` survives the rollback because PL/pgSQL variables are not transactional; if a deadlock
-- were ever raised before de-duplication it is still NULL, hence the COALESCE onto the raw
-- input. No RETURN QUERY can precede this handler — every earlier one is immediately followed
-- by RETURN — so the set this call returns is exactly this one row.
EXCEPTION WHEN deadlock_detected THEN
  RETURN QUERY SELECT '{}'::uuid[], '{}'::uuid[], '{}'::uuid[], '{}'::uuid[],
                      COALESCE(v_ids, _booking_ids, '{}'::uuid[]), 'deadlock_retry'::text, false;
  RETURN;
END;
$function$
;

COMMENT ON FUNCTION public.settle_paid_bookings(uuid[], text, text, uuid, uuid, uuid, text) IS
  'ABC-23 atomic paid-booking settlement with M-17 survivor semantics. D7 7.4-C: a deadlock_detected (40P01) raised anywhere in this call is caught by ONE narrow handler on the function''s own outermost block and returned as the typed retryable refusal `deadlock_retry` in the existing vocabulary. Because that block is a subtransaction, the handler fires only after every booking, payment and invoice write this call made has been rolled back, so the outcome is a genuine no-op the caller may simply re-issue. It catches deadlock_detected and nothing else — not WHEN OTHERS and deliberately not serialization_failure, because an arbitrary 40001 is not known to be this cycle and absorbing one would turn a genuine product refusal (the source-membership fence''s, or the tier revive arm''s) into a silent retry. No lock object, relation, pid or counterparty identity is exposed. Every other refusal value, lock, survivor decision and replay semantic is byte-identical to the predecessor, and the function remains SECURITY DEFINER, service_role-only, with its pinned search path.';

-- ────────────────────────────────────────────────────────────────────────────────────────────
-- §4. Install assertions — this migration proves its own postconditions.
-- ────────────────────────────────────────────────────────────────────────────────────────────
--
-- Two classes of proof. First, INVARIANCE: the structural and routine fingerprints re-derived
-- here must be byte-identical to the ones taken in §1b, which is what makes "no table, column,
-- index, constraint, policy, RLS, trigger, owner, ACL, overload, SECURITY DEFINER, search-path
-- or effective-EXECUTE change" a measured fact rather than a claim. The routine fingerprint
-- deliberately excludes only `prosrc`, so it still covers the identity and privilege facts of
-- the two functions this file rewrites. Second, INTENT: the two installed bodies are exactly the
-- reviewed ones, and each carries the specific structure it was approved for — one try-only
-- acquisition and one surviving blocking acquisition in the tier trigger, exactly one narrow
-- `deadlock_detected` handler and no `WHEN OTHERS` in the settlement.
DO $d7c_postcondition$
DECLARE
  v_now  text;
  v_was  text;
  v_src  text;
  v_body text;
  v_n    integer;
BEGIN
  SELECT digest INTO v_was FROM d7c_before_fingerprint WHERE kind = 'structural';
  v_now := (
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce((
    SELECT string_agg(s.x, E'\x1e' ORDER BY s.x) FROM (
      SELECT 'REL' || E'\x1f' || c.relname || E'\x1f' || c.relkind::text
             || E'\x1f' || c.relrowsecurity::text || E'\x1f' || c.relforcerowsecurity::text
             || E'\x1f' || c.relowner::regrole::text
             || E'\x1f' || coalesce(c.relacl::text, '<default>') AS x
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f','S')
      UNION ALL
      SELECT 'COL' || E'\x1f' || c.relname || E'\x1f' || a.attname || E'\x1f' || a.attnum::text
             || E'\x1f' || format_type(a.atttypid, a.atttypmod) || E'\x1f' || a.attnotnull::text
             || E'\x1f' || coalesce(nullif(a.attgenerated::text, ''), '<none>')
             || E'\x1f' || coalesce(nullif(a.attidentity::text, ''), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(d.adbin, d.adrelid), '<none>')
             || E'\x1f' || coalesce(a.attacl::text, '<none>')
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'CON' || E'\x1f' || c.relname || E'\x1f' || con.conname || E'\x1f' || con.contype::text
             || E'\x1f' || con.convalidated::text || E'\x1f' || pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'IDX' || E'\x1f' || ic.relname || E'\x1f' || pg_get_indexdef(i.indexrelid)
             || E'\x1f' || i.indisvalid::text || E'\x1f' || i.indisready::text || E'\x1f' || i.indislive::text
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'POL' || E'\x1f' || c.relname || E'\x1f' || p.polname || E'\x1f' || p.polcmd::text
             || E'\x1f' || p.polpermissive::text
             || E'\x1f' || coalesce((SELECT string_agg(coalesce(r.rolname::text, 'PUBLIC'), ','
                                       ORDER BY coalesce(r.rolname::text, 'PUBLIC'))
                                       FROM unnest(p.polroles) e(roleoid)
                                       LEFT JOIN pg_roles r ON r.oid = e.roleoid), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(p.polqual, p.polrelid), '<none>')
             || E'\x1f' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '<none>')
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
      UNION ALL
      SELECT 'TRG' || E'\x1f' || c.relname || E'\x1f' || t.tgname || E'\x1f' || pg_get_triggerdef(t.oid)
             || E'\x1f' || t.tgenabled::text
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ) s), ''), 'UTF8')), 'hex')
  );
  IF v_now IS DISTINCT FROM v_was THEN
    RAISE EXCEPTION 'D7.4-C: the public-schema structural fingerprint changed (% -> %)', v_was, v_now
      USING HINT = 'This migration is authorized to change two function bodies and nothing else. A relation, column, constraint, index, policy, trigger, RLS flag, owner or relation ACL moved; stop.';
  END IF;

  SELECT digest INTO v_was FROM d7c_before_fingerprint WHERE kind = 'routine';
  v_now := (
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce((
    SELECT string_agg(s.x, E'\x1e' ORDER BY s.x) FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
             || E'\x1f' || pg_get_function_result(p.oid)
             || E'\x1f' || p.proowner::regrole::text
             || E'\x1f' || p.prosecdef::text
             || E'\x1f' || p.prokind::text
             || E'\x1f' || p.provolatile::text
             || E'\x1f' || l.lanname
             || E'\x1f' || coalesce(p.proconfig::text, '<none>')
             || E'\x1f' || coalesce(p.proacl::text, '<default>')
             || E'\x1f' || (SELECT string_agg(r2.rolname || '=' ||
                              has_function_privilege(r2.rolname, p.oid, 'EXECUTE')::text,
                              ',' ORDER BY r2.rolname)
                              FROM (VALUES ('postgres'),('anon'),('authenticated'),('service_role')) r2(rolname)) AS x
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = 'public'
    ) s), ''), 'UTF8')), 'hex')
  );
  IF v_now IS DISTINCT FROM v_was THEN
    RAISE EXCEPTION 'D7.4-C: the routine identity/privilege fingerprint changed (% -> %)', v_was, v_now
      USING HINT = 'Only prosrc is excluded from this digest. A routine was added or dropped, or an owner, SECURITY DEFINER flag, volatility, language, search path, raw ACL or effective EXECUTE vector moved; stop.';
  END IF;

  -- ── the tier trigger: try-only revive, blocking everywhere else ──────────────────────────
  SELECT p.prosrc INTO v_body FROM pg_proc p WHERE p.oid = to_regprocedure('public.enforce_booking_slot_tier()');
  v_n := (length(v_body) - length(replace(v_body, 'pg_try_advisory_xact_lock', ''))) / length('pg_try_advisory_xact_lock');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C: enforce_booking_slot_tier holds % try-only advisory acquisitions, expected exactly 1', v_n;
  END IF;
  v_n := (length(v_body) - length(replace(v_body, 'PERFORM pg_advisory_xact_lock', ''))) / length('PERFORM pg_advisory_xact_lock');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C: enforce_booking_slot_tier holds % blocking advisory acquisitions, expected exactly 1 (INSERT and slot-move must NOT become try-only)', v_n;
  END IF;
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')), 'hex') INTO v_src;
  IF v_src IS DISTINCT FROM 'b65e65d3d0361d93ad8905262917ec549b17db1bf5ae9dc871205651adac0088' THEN
    RAISE EXCEPTION 'D7.4-C: the installed enforce_booking_slot_tier body is %, not the reviewed one', v_src;
  END IF;

  -- ── the settlement: exactly one narrow retryable outcome ─────────────────────────────────
  SELECT p.prosrc INTO v_body FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)');
  v_n := (length(v_body) - length(replace(v_body, 'EXCEPTION WHEN deadlock_detected', ''))) / length('EXCEPTION WHEN deadlock_detected');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C: settle_paid_bookings holds % deadlock_detected handlers, expected exactly 1', v_n;
  END IF;
  -- `WHEN OTHERS` appears once, inside the comment that explains why it is NOT used. Two or more
  -- occurrences means an executable one was added.
  v_n := (length(v_body) - length(replace(v_body, 'WHEN OTHERS', ''))) / length('WHEN OTHERS');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'D7.4-C: settle_paid_bookings mentions WHEN OTHERS % times, expected exactly the 1 documented refusal to use it', v_n;
  END IF;
  SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(v_body, 'UTF8')), 'hex') INTO v_src;
  IF v_src IS DISTINCT FROM 'da1927a4df3c7e1867fb8e54125bbc862d374e17e32cbc9cf9eaa9970e5e5595' THEN
    RAISE EXCEPTION 'D7.4-C: the installed settle_paid_bookings body is %, not the reviewed one', v_src;
  END IF;

  -- ── the settlement stays service-role-only; the tier trigger stays universally callable ──
  -- Both are also covered by the routine fingerprint above; they are spelled out separately
  -- because these two are the privilege facts a reader of this file will want to see named.
  IF has_function_privilege('anon', to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)'), 'EXECUTE')
     OR has_function_privilege('authenticated', to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'D7.4-C: settle_paid_bookings became reachable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', to_regprocedure('public.settle_paid_bookings(uuid[],text,text,uuid,uuid,uuid,text)'), 'EXECUTE') THEN
    RAISE EXCEPTION 'D7.4-C: settle_paid_bookings lost its service_role EXECUTE';
  END IF;
END
$d7c_postcondition$;

DROP TABLE d7c_before_fingerprint;
