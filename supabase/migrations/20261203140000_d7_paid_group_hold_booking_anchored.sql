-- D7 RUNTIME — THE PAID-GROUP COURT HOLD, ANCHORED ON THE BOOKING.
--
-- OWNER DECISION (round-4 P1-2 / P2-4, `APPROVE_D7_RUNTIME_PAID_GROUP_HOLD_BOOKING_ANCHORED_AUTHORITY_V1`).
-- A court is held when a NON-CANCELLED booking on that court has `payment_status = 'paid'` and
-- carries a captain in `paid_by_player_id` or `paid_by_guest_player_id`. Invoice `booking_ids` and
-- `slot_priority_claims` are NOT hold authority.
--
-- WHY THE PREDECESSOR HAD TO BE REPLACED. `20261203120000` derived the hold from a claim joined to a
-- paid invoice. Three measured facts defeat that:
--
--   1. THE CLAIM IS DELETED BY AN ORDINARY GUEST MERGE. Every shipped merge revision runs
--      `DELETE FROM public.slot_priority_claims s WHERE s.guest_player_id = p_source_guest_id AND
--      EXISTS (SELECT 1 FROM public.slot_priority_claims t WHERE t.slot_id = s.slot_id AND
--      t.guest_player_id = p_target_guest_id)` and then REPOINTS the invoice. The payment and the
--      booking survive; the slot-to-group link is exactly what is dropped. A merge could therefore
--      release a court somebody had paid for in full.
--   2. `invoices.academy_profile_id` IS NULL ON THESE INVOICES. It is nullable with no default, and
--      none of `create-rebook-invoice`, `create-rebook-invoice-public` or
--      `create-group-rebook-invoice` sets it. An academy predicate on the invoice would evaluate to
--      NULL and disable the hold everywhere — a failure that only shows up as under-suppression,
--      which no test that merely checks "suppression fires" would ever catch.
--   3. `invoices.booking_ids` IS APPEND-ONLY. Both maintainers write
--      `array(SELECT DISTINCT unnest(COALESCE(booking_ids,'{}') || v_new_ids))`, so a cancelled
--      booking stays in the array for ever.
--
-- WHY THE BOOKING IS THE RIGHT AUTHORITY. It is where the product already keeps this fact. A covered
-- re-seat is inserted straight onto the court with `payment_status = 'paid'`, `paid_at` and the
-- captain in `paid_by_*` (`20260626110000`, `20260817110000`), and `rebook_group_manage` decides a
-- group is paid by reading `bookings.payment_status = 'paid'` and nothing else. This closure reads
-- the same fact from the same place rather than reconstructing it from mutable rows.
--
-- TENANT CONTAINMENT IS THE JOIN. The booking must be on THIS slot; a booking on this slot is on
-- this academy's court by construction. There is no tenant filter to forget, no invoice to forge,
-- and no group UUID whose secrecy has to hold.
--
-- WHAT IS RETAINED. Arm (5) — the frozen cycle-wide `upfront` suppression — is untouched, and so is
-- every typed D7 tenant, idempotency and recovery guard. The function keeps its exact signature,
-- result type, owner, ACL, volatility, SECURITY DEFINER flag and `search_path`, each captured before
-- the replacement and re-compared after it in the same transaction.
--
-- WHAT CHANGES BEHAVIOURALLY, IN BOTH DIRECTIONS. A hold now survives guest-merge claim deletion.
-- And a claim carrying a `rebook_group_id` with no paid booking NO LONGER suppresses — the stale or
-- unpaid claim-only block the owner directed be removed. Both directions are proved adversarially in
-- `src/test/d7RuntimeContract.realpg.test.ts`.
--
-- ── THE PREREQUISITE GUARD ───────────────────────────────────────────────────────────────────
--
-- This file sorts AFTER ABC-27, and the frozen suite builds its predecessor from the migrations
-- directory MINUS the file under test — which sweeps this file in and replays it BEFORE ABC-27. The
-- function it replaces does not exist there, so the block refuses to act. A skipping migration is a
-- FAIL-OPEN, and it is paid for: `src/test/d7ForwardChain.realpg.test.ts` replays the directory in
-- TRUE filename order and proves from the installed catalog that the replacement happened.

DO $d7_paid_group_booking_hold$
DECLARE
  v_ident   CONSTANT text := 'public.abc27_p_live_eligibility(uuid,uuid,uuid[],uuid[],text[],uuid[])';
  -- The role this block was entered with, restored exactly. `RESET ROLE` returns to `session_user`,
  -- which is not necessarily the role that entered.
  v_entry   CONSTANT name := current_user;
  v_p       name;
  v_oid     oid;
  v_count   int;
  b_oid     oid;
  b_owner   name;
  b_acl     text;
  b_secdef  boolean;
  b_vol     "char";
  b_config  text;
  b_args    text;
  b_result  text;
  b_kind    "char";
  b_src     text;
  a_owner   name;
  a_acl     text;
  a_secdef  boolean;
  a_vol     "char";
  a_config  text;
  a_args    text;
  a_result  text;
  a_kind    "char";
  a_src     text;
BEGIN
  -- `pg_catalog`, NOT `information_schema`: those views are privilege-filtered and would read the
  -- column as ABSENT for a role that owns one domain but holds nothing on the other, taking the skip
  -- and recording this migration as applied over nothing.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27 and must never run before it)';
    RETURN;
  END IF;

  -- THE COLUMNS THIS HOLD READS MUST EXIST, or the replacement would install a body that raises at
  -- dispatch time rather than a migration that refuses now.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                  WHERE a.attrelid = to_regclass('public.bookings')
                    AND a.attname IN ('payment_status','paid_by_player_id','paid_by_guest_player_id')
                    AND a.attnum > 0 AND NOT a.attisdropped
                 HAVING count(*) = 3) THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: public.bookings is missing payment_status / paid_by_player_id / paid_by_guest_player_id — the authority this file reads does not exist here';
  END IF;

  v_oid := to_regprocedure(v_ident);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: % is absent — this file replaces an existing authority, it does not create one', v_ident;
  END IF;

  SELECT count(*)::int INTO v_count FROM pg_catalog.pg_proc p WHERE p.proname = 'abc27_p_live_eligibility';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: expected exactly one routine named abc27_p_live_eligibility, found %', v_count;
  END IF;

  SELECT p.oid, p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO b_oid, b_owner, b_acl, b_secdef, b_vol, b_config, b_args, b_result, b_kind, b_src
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  -- THE LEGAL PRODUCT OWNER, RESOLVED THE WAY ABC-27 RESOLVES IT — never hardcoded.
  SELECT c.relowner::regrole::name INTO v_p
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'cycles';
  IF v_p IS NULL THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: cannot resolve the Domain-P owner — public.cycles is missing';
  END IF;
  IF b_owner IS DISTINCT FROM v_p THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: % is owned by % but the Domain-P owner is %', v_ident, b_owner, v_p;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_p, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: % is not a member of the Domain-P owner % — apply this migration as a role that is',
      current_user, v_p;
  END IF;

  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', v_p);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: % may not SET ROLE to the Domain-P owner % (%) — grant it the SET option or apply as that role',
      v_entry, v_p, SQLERRM;
  END;

  CREATE OR REPLACE FUNCTION public.abc27_p_live_eligibility(
    p_academy   uuid,
    p_round     uuid,
    p_recipient uuid[],
    p_cycle     uuid[],
    p_key       text[],
    p_claim     uuid[]
  ) RETURNS TABLE (rebook_round_recipient_id uuid, source_cycle_id uuid, ok boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE
    -- `cardinality()`, NOT `array_length(x, 1)`. PostgreSQL's `uuid[]`/`text[]` accept
    -- MULTIDIMENSIONAL values, `array_length(x, 1)` reports only the FIRST dimension, and `unnest`
    -- flattens every element regardless of shape. A caller passing four 2×5000 arrays would show
    -- `array_length = 2`, satisfy a first-dimension equality check, slip under a first-dimension
    -- bound, and then scan 10,000 candidates. `cardinality()` counts the flattened elements — the
    -- same population `unnest` actually produces — so the check and the scan agree by construction.
    -- `cardinality(NULL::uuid[])` is NULL, and every comparison against NULL is NULL — which an IF
    -- treats as false, so a NULL array would slip past both the ragged check and the bound. Each
    -- count is therefore normalized to 0 first; a NULL array is exactly an empty candidate set.
    v_len int := coalesce(cardinality(p_recipient), 0);
  BEGIN
    IF p_academy IS NULL OR p_round IS NULL THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: academy and round are required' USING ERRCODE = '42501';
    END IF;
    -- ONE DIMENSION ONLY, AND ONLY WHEN THERE IS ANYTHING TO SHAPE. Cardinality equality already
    -- stops a short array being zipped against a long one, so this rule is not about padding — it
    -- is about keeping the DECLARED contract one-dimensional, so a caller cannot hand over a 2×N
    -- value whose transposition is meaningful to it and merely positional here.
    --
    -- THE EMPTY CASE IS NOT A SHAPE VIOLATION. PostgreSQL represents a non-NULL empty array as
    -- DIMENSIONLESS: `array_ndims('{}'::uuid[])` is 0, not 1. A blanket `<> 1` therefore rejects the
    -- perfectly ordinary empty candidate set that `ARRAY(SELECT ... FROM triples)` produces whenever
    -- a round has no provenance rows yet — and it would also have made NULL and `{}` behave
    -- differently, when both mean "no candidates". Each array is shape-checked only when it actually
    -- carries elements.
    IF (coalesce(cardinality(p_recipient), 0) > 0 AND array_ndims(p_recipient) <> 1)
       OR (coalesce(cardinality(p_cycle), 0) > 0 AND array_ndims(p_cycle) <> 1)
       OR (coalesce(cardinality(p_key), 0)   > 0 AND array_ndims(p_key)   <> 1)
       OR (coalesce(cardinality(p_claim), 0) > 0 AND array_ndims(p_claim) <> 1) THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: candidate arrays must be one-dimensional (got %, %, %, % dimensions)',
        coalesce(array_ndims(p_recipient), 0), coalesce(array_ndims(p_cycle), 0),
        coalesce(array_ndims(p_key), 0), coalesce(array_ndims(p_claim), 0) USING ERRCODE = '22023';
    END IF;
    -- The four arrays are ONE relation transposed. Ragged input would silently pair a recipient
    -- with another recipient's claim, so it is refused rather than zipped to the shortest.
    IF coalesce(cardinality(p_cycle), 0) <> v_len
       OR coalesce(cardinality(p_key), 0) <> v_len
       OR coalesce(cardinality(p_claim), 0) <> v_len THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: the candidate arrays are ragged (% recipients, % cycles, % keys, % claims)',
        v_len, coalesce(cardinality(p_cycle), 0), coalesce(cardinality(p_key), 0),
        coalesce(cardinality(p_claim), 0) USING ERRCODE = '22023';
    END IF;
    -- The SAME definition the freeze enforces at capture time (Stage 7.4-A review): two spellings
    -- of this ceiling were exactly the drift that could freeze a universe this check then refuses
    -- forever. The A-owned function carries a counterpart_p grant for this one consultation.
    IF v_len > public.rebook_round_max_claim_sources() THEN
      RAISE EXCEPTION 'abc27_p_live_eligibility: % candidate provenance rows exceeds the approved % per round',
        v_len, public.rebook_round_max_claim_sources()
        USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH triples AS (
      SELECT DISTINCT t.recipient, t.cycle, t.key, t.claim
        FROM unnest(p_recipient, p_cycle, p_key, p_claim) AS t(recipient, cycle, key, claim)
       WHERE t.recipient IS NOT NULL AND t.cycle IS NOT NULL AND t.key IS NOT NULL
    ),
    -- TENANT AND ROUND RE-DERIVED BY P. This join is the containment: it is an INNER join, so an
    -- unowned or unattached cycle drops the pair entirely.
    scoped AS (
      SELECT tr.recipient, tr.cycle, tr.key, tr.claim, c.status AS cycle_status, c.settings AS cycle_settings
        FROM triples tr
        JOIN public.cycles c
          ON c.id = tr.cycle
         AND c.owner_type = 'academy'
         AND c.owner_id = p_academy
         AND c.rebook_round_id = p_round
    ),
    pairs AS (
      SELECT DISTINCT s.recipient, s.cycle, s.key, s.cycle_status, s.cycle_settings FROM scoped s
    )
    SELECT p.recipient, p.cycle,
      (
        -- (1) an OUTSTANDING provenance-linked claim whose CURRENT identity is still this person.
        --     Outstanding is the owner-ruled two-value vocabulary (pending, expired) — see the
        --     eligibility authority's comment for why `expired` is included and `released` is not.
        --     The claim identities are the ones Domain A's immutable provenance named; P proves they
        --     still exist, still sit on a slot of THIS cycle, and still canonicalize to this key.
        EXISTS (
          SELECT 1
            FROM scoped sc
            JOIN public.slot_priority_claims spc ON spc.id = sc.claim
            JOIN public.availability_slots s     ON s.id = spc.slot_id
           WHERE sc.recipient = p.recipient
             AND sc.cycle = p.cycle
             AND s.source_cycle_id = p.cycle
             AND spc.status IN ('pending','expired')
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (2) no seat ALREADY claimed here — they have one, so there is nothing to invite them to.
        AND NOT EXISTS (
          SELECT 1 FROM public.slot_priority_claims spc
            JOIN public.availability_slots s ON s.id = spc.slot_id
           WHERE s.source_cycle_id = p.cycle
             AND spc.status = 'claimed'
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (3) no explicit DECLINE here — they said no to this sibling.
        AND NOT EXISTS (
          SELECT 1 FROM public.slot_priority_claims spc
            JOIN public.availability_slots s ON s.id = spc.slot_id
           WHERE s.source_cycle_id = p.cycle
             AND (spc.status = 'declined' OR spc.response_intent = 'decline')
             AND public.rebook_round_recipient_key(spc.guest_player_id, spc.player_id) = p.key
        )
        -- (4) this sibling has a genuinely free seat. Canonical rules, copied from the detection RPC
        --     that shipped (20260714110000): a booking occupies a seat when it is confirmed, pending
        --     or pending_approval, or payment_pending with a hold that has not expired. This is the
        --     retired `rebook_sibling_has_free_seat`, folded in so there is ONE product reader.
        AND EXISTS (
          SELECT 1 FROM public.availability_slots s
           WHERE s.source_cycle_id = p.cycle
             -- (4a) …AND THE COURT IS NOT ONE A PAID REBOOK GROUP ALREADY HOLDS.
             --
             -- Derived from the canonical slot-level authority `slot_held_by_paid_group`
             -- (20260817100000), predicate-for-predicate, with `_slot_id` bound to this slot. It is
             -- INLINED rather than called because calling it would need an EXECUTE grant to the
             -- Domain-P owner, and this closure adds no grant; parity with the canonical authority is
             -- therefore proved behaviourally, slot for slot, rather than asserted.
             --
             -- IT SITS INSIDE ARM (4), NOT BESIDE ARM (5), AND THAT IS THE WHOLE POINT. The paid-group
             -- hold is a fact about ONE COURT: a group that paid for its court in full holds that
             -- court's seats against outsiders, and says nothing about the sibling's other slots. So
             -- it disqualifies THIS slot from being the free seat, and a genuinely free seat on any
             -- other slot of the same sibling still makes the recipient eligible. Expressing it as a
             -- cycle-wide arm would over-suppress every other court in the sibling, which is the
             -- mirror image of the defect this closure repairs.
             --
             -- THE AUTHORITY IS THE BOOKING, NOT THE CLAIM AND NOT THE INVOICE. A covered re-seat is
             -- written straight onto the court as `payment_status = 'paid'` with the CAPTAIN recorded
             -- in `paid_by_player_id` / `paid_by_guest_player_id` (20260626110000, 20260817110000),
             -- and `rebook_group_manage` itself decides a group is paid by reading exactly that. So
             -- this is the product's own paid fact, read where the product keeps it.
             --
             -- WHY NOT THE CLAIM. `slot_priority_claims` is deleted by the shipped guest-merge on a
             -- slot collision — `DELETE ... WHERE s.guest_player_id = p_source_guest_id AND EXISTS
             -- (... t.guest_player_id = p_target_guest_id)` — while the payment and the booking
             -- survive. A hold derived from claims therefore vanishes on an ordinary merge, which is
             -- the defect this file repairs.
             --
             -- WHY NOT THE INVOICE. `invoices.academy_profile_id` is NULL on precisely these
             -- invoices: none of `create-rebook-invoice`, `create-rebook-invoice-public` or
             -- `create-group-rebook-invoice` sets it, so an academy predicate there would be NULL and
             -- would silently disable the hold. And `invoices.booking_ids` is append-only, so it
             -- retains cancelled bookings for ever.
             --
             -- THE TENANT BOUNDARY IS THE JOIN ITSELF. The booking must be on THIS slot, and a
             -- booking on this slot belongs to this academy's court by construction — containment is
             -- relational, not a filter that can be forgotten and not a group UUID that has to stay
             -- secret.
             --
             -- `paid_by_*` NON-NULL IS WHAT MAKES IT A GROUP HOLD. It is set only when somebody ELSE
             -- paid. A member who paid for their own seat occupies a seat — which the capacity count
             -- below already handles — and does not hold the whole court against outsiders.
             --
             -- CANCELLED AND UNPAID RECORDS NEVER BLOCK A RELEASE, which is the other half of the
             -- owner's rule: a cancelled booking is not a hold, and neither is an unpaid one.
             AND NOT EXISTS (
               SELECT 1
                 FROM public.bookings hb
                WHERE hb.slot_id = s.id
                  AND hb.status IS DISTINCT FROM 'cancelled'
                  AND hb.payment_status = 'paid'
                  AND (hb.paid_by_player_id IS NOT NULL OR hb.paid_by_guest_player_id IS NOT NULL)
             )
             AND (
               SELECT count(*) FROM public.bookings b
                WHERE b.slot_id = s.id
                  AND (
                    COALESCE(b.status, 'confirmed') IN ('confirmed','pending','pending_approval')
                    OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
                  )
             ) < COALESCE(s.max_participants, 1)
        )
        -- (4b) THE SIBLING IS STILL OPEN, RE-READ NOW. The freeze proved every sibling was `open` at
        --      freeze time (§8 step 3), but the freeze and the send are separated by the whole member
        --      window. Read from the SAME row the tenant anchor above matched, so the open-ness and
        --      the ownership are one observation rather than two.
        AND p.cycle_status = 'open'
        -- (5) NOT an excluded upfront/paid group: an upfront round is paid in full at claim time, so
        --     "a seat freed up, come and take it" is not an instrument the product can honour.
        AND COALESCE(p.cycle_settings->>'rebook_payment_mode', '') <> 'upfront'
      ) AS ok
      FROM pairs p;
  END;
  $$;

  -- BACK TO THE ROLE THIS BLOCK WAS ENTERED WITH — not `RESET ROLE`.
  EXECUTE format('SET LOCAL ROLE %I', v_entry);

  SELECT p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO a_owner, a_acl, a_secdef, a_vol, a_config, a_args, a_result, a_kind, a_src
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_ident);

  IF to_regprocedure(v_ident) IS DISTINCT FROM b_oid THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the function identity moved — a replacement must not create a second object';
  END IF;
  IF a_owner IS DISTINCT FROM b_owner THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: owner changed from % to %', b_owner, a_owner;
  END IF;
  IF a_acl IS DISTINCT FROM b_acl THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the ACL changed from % to % — this file widens no privilege', b_acl, a_acl;
  END IF;
  IF a_secdef IS DISTINCT FROM b_secdef THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: SECURITY DEFINER changed';
  END IF;
  IF a_vol IS DISTINCT FROM b_vol THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: volatility changed from % to %', b_vol, a_vol;
  END IF;
  IF a_config IS DISTINCT FROM b_config THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the settings (search_path) changed from % to %', b_config, a_config;
  END IF;
  IF a_args IS DISTINCT FROM b_args THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the signature changed from (%) to (%)', b_args, a_args;
  END IF;
  IF a_result IS DISTINCT FROM b_result THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the result type changed from % to %', b_result, a_result;
  END IF;
  IF a_kind IS DISTINCT FROM b_kind THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: prokind changed from % to %', b_kind, a_kind;
  END IF;

  SELECT count(*)::int INTO v_count FROM pg_catalog.pg_proc p WHERE p.proname = 'abc27_p_live_eligibility';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: % routines named abc27_p_live_eligibility exist after the replacement', v_count;
  END IF;

  IF a_src = b_src THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the body is unchanged — the replacement was a no-op';
  END IF;

  -- …and it changed in the ONE way this file is for. These are the migration's own self-checks; what
  -- the installed authority DOES is proved behaviourally on a real chain, in both directions, by
  -- `src/test/d7RuntimeContract.realpg.test.ts`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(v_ident)
       AND p.prosrc LIKE '%hb.paid_by_player_id IS NOT NULL OR hb.paid_by_guest_player_id IS NOT NULL%'
       AND p.prosrc LIKE '%hb.payment_status = ''paid''%'
  ) THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the installed body does not carry the booking-anchored hold';
  END IF;
  -- THE CLAIM AND INVOICE ANCHORS ARE GONE, which is half the point of this file.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(v_ident)
       AND p.prosrc LIKE '%hi.rebook_group_id = hspc.rebook_group_id%'
  ) THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the retired claim/invoice hold is still present — it is replaced, not supplemented';
  END IF;
  -- …and the frozen cycle-wide upfront suppression is RETAINED beside it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(v_ident) AND p.prosrc LIKE '%rebook_payment_mode%'
  ) THEN
    RAISE EXCEPTION 'D7 booking-anchored hold: the cycle-wide upfront suppression was lost — it is RETAINED, not replaced';
  END IF;

  RAISE NOTICE 'D7: the paid-group court hold is anchored on the booking and survives claim deletion';
END $d7_paid_group_booking_hold$;
