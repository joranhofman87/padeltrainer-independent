-- D7 RUNTIME — DISPATCH LINEARIZATION: ELIGIBILITY IS RE-READ AT THE DURABLE DECISION.
--
-- OWNER DECISION. The durable `begin_dispatch` transaction is the LINEARIZATION POINT for
-- member-open eligibility. Whatever the world does before that transaction observes eligibility is
-- seen and honoured; whatever it does after does not retroactively invalidate an authorization that
-- has already been taken.
--
-- WHAT WAS WRONG. The dispatch path is three separate transactions and one external call, in this
-- order:
--
--   1. `rebook_member_open_pre_dispatch_resolve`  — reads live eligibility, answers `proceed`
--   2.  (the worker returns to its own process)
--   3. `rebook_member_open_begin_dispatch`        — authorizes exactly one provider call
--   4. `sendOnce`                                 — the provider call itself
--
-- Step 1 was the ONLY place eligibility was read. Step 3 re-verified the capability, the frozen
-- request and the member window — but not eligibility. So everything the world could do between
-- steps 1 and 3 was invisible to the send that raced it: a seat claimed, a decline landing, a
-- sibling cycle closing, or a rebook group captain settling an invoice to `paid`. That last one is
-- what made this worth closing: the slot-level paid-group hold installed by
-- `20261203120000_d7_paid_group_hold_safety.sql` was enforced at step 1 and nowhere later, so a
-- payment landing in the gap still let an invitation go out for a seat on a court somebody had
-- just paid for in full.
--
-- WHAT THIS FILE DOES. It replaces exactly ONE function body — `rebook_member_open_begin_dispatch`
-- — to re-read live eligibility through `abc27_a_live_eligible`, the SAME authority step 1 uses,
-- with the SAME two arguments, at the last point in the transaction before any durable artifact
-- exists. If eligibility has changed, the row is refused with this function's existing refusal
-- semantic: outcome `refused`, a named reason, no grant, no operation, no column write, and — by
-- the worker's own exhaustive switch — zero provider calls.
--
-- WHAT IT DOES NOT CLAIM, AND THE STATEMENT IS DELIBERATE. It does not make an eligibility read and
-- an external send atomic, because nothing can. The residual window is now the interval between
-- the re-read's snapshot and this transaction's commit. Driving that to zero would require taking a
-- lock the payment path must also take, and holding a payment or booking lock across a provider
-- fetch is a deadlock-and-latency hazard this design refuses to accept. **A payment committed
-- after the linearization point does not retroactively invalidate an already-authorized external
-- send, and an email that has been sent cannot be recalled.** No code, comment or document in this
-- release says otherwise.
--
-- WHAT IT DOES NOT DO. No new relation, column, index, trigger, role, RLS policy, grant, runtime
-- API, provider effect or permission widening. No schedule is armed. Not one byte of the frozen
-- ABC-27 migration changes. The function keeps its exact signature, result type, owner, ACL,
-- volatility, SECURITY DEFINER flag, `search_path` and error semantics — every one of which is
-- captured before the replacement and re-compared after it, in the same transaction.
--
-- ON THE PREDECESSOR'S WORDING. `20261203120000_d7_paid_group_hold_safety.sql` opens with the owner
-- decision in its absolute form — "an invitation must NEVER offer a freed seat on a court that a
-- PAID rebook group already holds". Those bytes are left alone: they state the RULE, which is
-- unchanged and correct. What that file could not state, because `begin_dispatch` did not yet ask,
-- is WHEN the rule is enforced. This file answers that, and the operational statement lives here
-- and in `docs/ABC27_ROLLOUT_RUNBOOK.md`: the rule binds at every point eligibility is observed, the
-- last of which is the linearization point below.
--
-- ON THE TWO REFUSAL REASONS. Neither is minted here. `ineligible` is the terminal outcome this
-- unit already writes for exactly this condition, and `unreadable_policy_state` is the hold it
-- already takes when this same authority cannot answer. The transport decodes `refusal_reason` as
-- a diagnostic label and logs it; it is not a dispatch decision and no client branches on it.
--
-- ── THE PREREQUISITE GUARD ───────────────────────────────────────────────────────────────────
--
-- This file sorts AFTER ABC-27, and the frozen ABC-27 evidence suite builds its predecessor from
-- the migrations directory MINUS the file under test — which sweeps this file in and replays it
-- BEFORE ABC-27, an order production never sees. The function it replaces does not exist there, so
-- the block refuses to act. A skipping migration is a FAIL-OPEN, and it is paid for:
-- `src/test/d7ForwardChain.realpg.test.ts` replays the directory in TRUE filename order and proves
-- from the INSTALLED CATALOG that the replacement actually happened.
--
-- ── HOW THE REPLACEMENT IS LEGAL ─────────────────────────────────────────────────────────────
--
-- `rebook_member_open_begin_dispatch` is a DOMAIN-N body: ABC-27 leaves it at the owner of
-- `public.notification_outbox`, which is the same resolution ABC-27 itself uses for `v_n` rather
-- than a hardcoded role name. This file resolves it the same way, refuses if the function is not
-- owned by it, refuses if the applying role may not act as it, and performs the replacement AS that
-- role. `CREATE OR REPLACE FUNCTION` preserves the OID, the owner and the ACL by construction; the
-- post-checks prove it did rather than trusting that it does.

DO $d7_dispatch_linearization$
DECLARE
  v_ident   CONSTANT text := 'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)';
  -- THE ROLE THIS BLOCK WAS ENTERED WITH, so it can be restored exactly. `RESET ROLE` returns to
  -- `session_user`, which is NOT necessarily the role that entered: a privileged login that had
  -- already done `SET ROLE restricted_migrator` would be silently ELEVATED for the rest of the
  -- migration run by a `RESET`. Capturing and restoring the entry role cannot do that.
  v_entry   CONSTANT name := current_user;
  v_n       name;
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
  -- `pg_catalog`, NOT `information_schema`. The information_schema views are PRIVILEGE-FILTERED:
  -- they show a column only to a role that owns the relation or holds a privilege on it. A
  -- deployment role able to assume one owner but holding nothing on `notification_outbox` would see
  -- the column as ABSENT, take this skip, and let the migration be recorded as applied over
  -- nothing. `pg_attribute` is not filtered, so the guard answers the question it is actually
  -- asking: does the object exist, not may I see it.
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27 and must never run before it)';
    RETURN;
  END IF;

  -- THE EXACT REVIEWED IDENTITY MUST ALREADY EXIST. A same-named function at another signature is
  -- not the authority this file is authorised to replace, and creating one would ADD a surface.
  v_oid := to_regprocedure(v_ident);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'D7 dispatch linearization: % is absent — this file replaces an existing authority, it does not create one', v_ident;
  END IF;

  -- …AND IT MUST BE THE ONLY ROUTINE OF THAT NAME, ANYWHERE. Asking `to_regprocedure` about one
  -- signature says nothing about an overload or a shadowing copy in another schema sitting beside
  -- it, and after this file runs there must still be exactly one thing that name can mean.
  SELECT count(*)::int INTO v_count
    FROM pg_catalog.pg_proc p
   WHERE p.proname = 'rebook_member_open_begin_dispatch';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'D7 dispatch linearization: expected exactly one routine named rebook_member_open_begin_dispatch, found %', v_count;
  END IF;

  SELECT p.oid, p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO b_oid, b_owner, b_acl, b_secdef, b_vol, b_config, b_args, b_result, b_kind, b_src
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  -- THE DOMAIN-N OWNER, RESOLVED THE WAY ABC-27 RESOLVES IT — never hardcoded. A hardcoded name
  -- would be wrong on some install, or would quietly "fix" the very drift this refusal exists to
  -- catch.
  SELECT c.relowner::regrole::name INTO v_n
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'notification_outbox';
  IF v_n IS NULL THEN
    RAISE EXCEPTION 'D7 dispatch linearization: cannot resolve the Domain-N owner — public.notification_outbox is missing';
  END IF;
  IF b_owner IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'D7 dispatch linearization: % is owned by % but the Domain-N owner is % — refusing to replace an authority this file does not understand',
      v_ident, b_owner, v_n;
  END IF;

  -- FAIL CLOSED IF THE APPLYING ROLE MAY NOT ACT AS THE OWNER. Without this the replacement would
  -- fail deep inside with a bare "must be owner", after the capture above had already run.
  --
  -- MEMBERSHIP IS THE PORTABLE PRE-CHECK, NOT THE AUTHORITY. `pg_has_role(..., 'USAGE')` tests
  -- INHERITANCE, which is not the same capability as `SET ROLE`: since PostgreSQL 16 a membership
  -- can carry `SET` without `INHERIT` and vice versa, so a USAGE test both rejects a role that
  -- could set and admits one that cannot. `MEMBER` is the version-portable membership question, and
  -- the real gate is the `SET LOCAL ROLE` itself — attempted below, with its failure re-raised as a
  -- message that says what to do instead of a bare permission error.
  IF NOT pg_catalog.pg_has_role(current_user, v_n, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 dispatch linearization: % is not a member of the Domain-N owner % — apply this migration as a role that is',
      current_user, v_n;
  END IF;

  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', v_n);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'D7 dispatch linearization: % may not SET ROLE to the Domain-N owner % (%) — grant it the SET option or apply as that role',
      v_entry, v_n, SQLERRM;
  END;

  CREATE OR REPLACE FUNCTION public.rebook_member_open_begin_dispatch(
    p_outbox_id       uuid,
    p_worker_token    text,
    p_lease_generation int,
    p_request_hash    bytea,
    p_canonical_request_bytes  text,
    p_provider_idempotency_key text,
    p_leased_from_state        text
  ) RETURNS TABLE (
    outcome                  text,
    first_dispatch_at        timestamptz,
    uncertainty_deadline_at  timestamptz,
    canonical_request_bytes  text,
    provider_idempotency_key text,
    refusal_reason           text
  )
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
  DECLARE
    r            record;
    v_grant      uuid;
    v_round_found boolean;
    v_window     timestamptz;   -- the round's member window, read through the A bridge
    v_sampled_now timestamptz;   -- sampled ONCE; every current comparison uses it
    v_dispatch_at timestamptz;   -- the stored/returned first-dispatch value
    v_cutoff     timestamptz;
    v_eligible   boolean;      -- the live eligibility answer, re-read at the linearization point
    v_after      timestamptz;  -- the clock re-sampled AFTER that read, for the deadline recheck
  BEGIN
    -- EXACT CAPABILITY. Every component must match the row as stored; a stale worker, a superseded
    -- generation or a drifted request hash finds nothing here.
    --
    -- TWO-OWNER BRIDGE (§7.2): this body is Domain N. The round it needs is Domain-A authority, so
    -- the former `JOIN public.rebook_rounds` is now the A-owned reader. The join was INNER, so an
    -- absent round refused as `capability_mismatch` before any other check; the `found` test below
    -- is placed at exactly that position and keeps that refusal order byte-for-byte.
    SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,
           o.tenant_academy_profile_id AS academy, o.leased_from_state, o.lease_generation,
           o.dispatch_authorized_generation, o.first_dispatch_at, o.uncertainty_deadline_at,
           o.canonical_request_bytes, o.provider_idempotency_key
      INTO r
      FROM public.notification_outbox o
     WHERE o.id = p_outbox_id
       AND o.event_type = 'rebook_member_open_player'
       AND o.transport_state = 'leased'
       AND o.locked_by = p_worker_token
       AND o.lease_generation = p_lease_generation
       AND o.request_hash = p_request_hash
     FOR UPDATE OF o;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'capability_mismatch'::text;
      RETURN;
    END IF;

    SELECT s.found, s.member_window_ends_at INTO v_round_found, v_window
      FROM public.abc27_a_round_state(r.round_id) s;
    IF NOT v_round_found THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'capability_mismatch'::text;
      RETURN;
    END IF;

    -- This generation already holds an authorization: it may already have called the provider, so
    -- it may not call again.
    IF r.dispatch_authorized_generation IS NOT DISTINCT FROM r.lease_generation THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'already_authorized_this_generation'::text;
      RETURN;
    END IF;

    -- ADMISSIBLE ORIGINS. `acceptance_uncertain` is refused: a same-key re-POST needs persisted
    -- affirmative provider-contract authority and both approved bounds, and no such authority
    -- exists in this release, so the origin stays unsendable rather than silently sendable.
    IF r.leased_from_state = 'acceptance_uncertain' THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'repost_not_contract_authorized'::text;
      RETURN;
    END IF;
    IF r.leased_from_state IS NULL
       OR r.leased_from_state NOT IN ('queued','retry_wait',
                                      'quiet_hours_deferred','channel_kill_deferred') THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'origin_state_not_admissible'::text;
      RETURN;
    END IF;

    -- The frozen request must exist and be intact; nothing here reconstructs a body.
    IF r.canonical_request_bytes IS NULL OR btrim(coalesce(r.provider_idempotency_key,'')) = '' THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'frozen_request_missing'::text;
      RETURN;
    END IF;

    -- THE CALLER'S OWN VIEW OF THE FROZEN REQUEST MUST MATCH THE STORED ONE. Row identity, token,
    -- generation and hash together still allow a worker holding a stale copy of the body or key to
    -- proceed; comparing the presented bytes and key closes that, so a re-POST cannot submit
    -- anything other than what the database froze.
    IF p_canonical_request_bytes IS DISTINCT FROM r.canonical_request_bytes
       OR p_provider_idempotency_key IS DISTINCT FROM r.provider_idempotency_key
       -- The origin the caller believes it holds must match the stored one exactly: a worker acting
       -- on a stale view of WHY the row was leased could otherwise treat an uncertainty re-POST as
       -- an ordinary first send.
       OR p_leased_from_state IS DISTINCT FROM r.leased_from_state THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'frozen_request_mismatch'::text;
      RETURN;
    END IF;

    -- ONE SAMPLED DATABASE TIME, held in its own variable and never overwritten. Every current
    -- comparison — the window and the cutoff — uses THIS value. `now()` is transaction start, so a
    -- long transaction could otherwise authorize a dispatch after the real cutoff had passed; and
    -- sampling twice would let the window and the cutoff be judged against different instants.
    v_sampled_now := clock_timestamp();
    IF v_window IS NULL
       OR v_window = 'infinity'::timestamptz
       OR v_window <= v_sampled_now THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'window_invalid'::text;
      RETURN;
    END IF;

    -- EVERY CHECK RESOLVES BEFORE ANY ARTIFACT EXISTS. A refused begin must leave no operation, no
    -- target and no grant behind: a stray unconsumed grant is standing authority for a transition
    -- that was just judged inadmissible.
    IF r.first_dispatch_at IS NULL AND r.uncertainty_deadline_at IS NULL THEN
      -- FIRST EVER: the stored pair is derived from the one sampled value.
      v_dispatch_at := v_sampled_now;
      v_cutoff      := least(v_window, v_sampled_now + interval '23 hours');
    ELSE
      -- LATER GENERATION: the pair is immutable and is returned unchanged. The cutoff test uses the
      -- SAME sampled value as the window test above — never a second clock read.
      v_dispatch_at := r.first_dispatch_at;
      v_cutoff      := r.uncertainty_deadline_at;
      IF v_sampled_now >= v_cutoff THEN
        RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'after_cutoff'::text;
        RETURN;
      END IF;
    END IF;

    -- ══ THE LINEARIZATION POINT ══════════════════════════════════════════════════════════════
    --
    -- LIVE ELIGIBILITY, RE-READ HERE, IN THIS TRANSACTION, IMMEDIATELY BEFORE THE DURABLE DECISION.
    --
    -- WHY IT IS HERE AND NOT EARLIER. `pre_dispatch_resolve` reads eligibility in a SEPARATE
    -- transaction that has already committed by the time this one starts; the worker then returns to
    -- its own process and calls back in. Everything the world could do in between — a seat claimed, a
    -- decline landing, a sibling closing, a rebook group's captain invoice settling to `paid` — was
    -- invisible to the send that raced it. This body is the last authority the row passes through
    -- before an external message becomes authorized, so this is where the question has to be asked.
    --
    -- WHY IT IS HERE AND NOT LATER. Every check in this function resolves BEFORE any artifact
    -- exists, and that ordering is load-bearing: a refusal after `abc27_a_authorize_transition` would
    -- leave a stray unconsumed grant behind — standing authority for a transition just judged
    -- inadmissible. So the last possible correct position is exactly this one: after every other
    -- fence, before the grant and before the UPDATE, with nothing between it and them.
    --
    -- WHY A FRESH OBSERVATION IS WHAT THIS BUYS. This function is VOLATILE, so in READ COMMITTED
    -- each statement inside it takes its own snapshot. `abc27_a_live_eligible` is the SAME authority
    -- `pre_dispatch_resolve` consults, called with the same two arguments, so the two can never
    -- disagree about what eligibility MEANS — only about WHEN it was observed. This call observes it
    -- as late as a durable decision can.
    --
    -- WHAT IT DOES NOT BUY, STATED PLAINLY. The residual window is now the interval between this
    -- statement's snapshot and this transaction's commit, rather than two network round trips and a
    -- provider call. It is not zero and it cannot be made zero here: driving it to zero would mean
    -- taking a lock that the payment path must also take, and holding a payment or booking lock
    -- across an external send is precisely what this design refuses to do. A payment that commits
    -- after this observation does not retroactively invalidate an already-authorized send — an email
    -- that has been authorized cannot be recalled, and no code here pretends otherwise.
    --
    -- FAIL CLOSED ON BOTH NON-ANSWERS. `abc27_a_live_eligible` returns NULL when the policy state is
    -- unreadable; NULL is refused rather than coerced, exactly as `pre_dispatch_resolve` refuses to
    -- read it as `false`. Both refusals are the EXISTING refusal semantic of this function — outcome
    -- `refused`, a named reason, zero artifacts, zero provider calls — and both reasons are drawn
    -- from this unit's own closed vocabularies rather than minted here: `ineligible` is the terminal
    -- outcome the resolver writes for exactly this condition, and `unreadable_policy_state` is the
    -- hold it takes when this same authority cannot answer.
    --
    -- WHAT HAPPENS TO A REFUSED ROW. Nothing durable, which is the point: the row keeps its lease and
    -- its generation, the worker counts a refusal and stops, and the janitor returns the lease to its
    -- exact stored origin. The next resolve re-reads the same authority and writes the honest
    -- terminal decision. A refusal here is therefore a DEFERRAL of judgement to the surface that owns
    -- terminal decisions, never a silent drop.
    -- THE CONTRACT DEPENDS ON READ COMMITTED, SO IT IS CHECKED RATHER THAN ASSUMED.
    --
    -- Everything above rests on one property: this function is VOLATILE, so under READ COMMITTED
    -- each statement inside it takes a FRESH snapshot and the re-read below therefore observes
    -- payments committed after this transaction began. Under REPEATABLE READ or SERIALIZABLE every
    -- statement reuses the transaction's first snapshot, and the re-read would faithfully report
    -- eligibility as it stood BEFORE the payment — a stale answer wearing a fresh answer's clothes.
    --
    -- AND THE ISOLATION LEVEL IS AMBIENT. `ALTER ROLE … SET default_transaction_isolation` or
    -- `ALTER DATABASE … SET …` changes it for every future session without touching one line of
    -- this body, one grant, or one object any catalog diff compares. So the property is verified
    -- here, in the transaction that depends on it, and a session that cannot provide it is refused
    -- rather than served a stale observation: not sending is always recoverable, and sending on a
    -- read that could not see the payment is not.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'unreadable_policy_state'::text;
      RETURN;
    END IF;

    v_eligible := public.abc27_a_live_eligible(r.round_id, r.member_id);
    IF v_eligible IS NULL THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'unreadable_policy_state'::text;
      RETURN;
    END IF;
    IF NOT v_eligible THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'ineligible'::text;
      RETURN;
    END IF;

    -- AND THE DEADLINE FENCE IS RE-SAMPLED, BECAUSE THE ELIGIBILITY READ TAKES TIME.
    --
    -- The window and cutoff above were judged against `v_sampled_now`, taken BEFORE this read. That
    -- was the last fence in the old body, so "checked at v_sampled_now" and "checked immediately
    -- before authorizing" were the same instant. They are not any more: this read is measured in
    -- milliseconds and grows with the recipient's provenance breadth, so a row whose member window
    -- expires DURING it would previously have been authorized after the window had closed.
    --
    -- THE STORED PAIR IS NOT RECOMPUTED. `v_dispatch_at` and `v_cutoff` remain derived from the one
    -- original sample — they are immutable by contract and a second derivation would move a value
    -- the unit promises never moves. This is a second FENCE against a second sample, not a second
    -- derivation, so the deadline semantics above are preserved exactly and only the refusal
    -- boundary moves later, which is the direction that is safe.
    v_after := clock_timestamp();
    IF v_window <= v_after OR v_after >= v_cutoff THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'window_invalid'::text;
      RETURN;
    END IF;

    -- TWO-OWNER BRIDGE: issuance is the A issuer's; this Domain-N entrypoint only presents. The
    -- purpose/action pair is the one `abc27_a_consume_transition_grant` maps `begin_dispatch` to.
    SELECT a.grant_id INTO v_grant
      FROM public.abc27_a_authorize_transition(
             'dispatch_outcome', r.academy, r.round_id, r.member_id,
             r.id, 'begin_dispatch', 'leased', 'leased') a;

    IF r.first_dispatch_at IS NULL THEN
      UPDATE public.notification_outbox o
         SET first_dispatch_at             = v_dispatch_at,
             uncertainty_deadline_at       = v_cutoff,
             dispatch_authorized_generation = p_lease_generation,
             transport_transition_action    = 'begin_dispatch',
             transport_transition_grant_id  = v_grant,
             updated_at = now()
       WHERE o.id = r.id;
    ELSE
      UPDATE public.notification_outbox o
         SET dispatch_authorized_generation = p_lease_generation,
             transport_transition_action    = 'begin_dispatch',
             transport_transition_grant_id  = v_grant,
             updated_at = now()
       WHERE o.id = r.id;
    END IF;

    RETURN QUERY SELECT 'begun'::text, v_dispatch_at, v_cutoff,
                        r.canonical_request_bytes, r.provider_idempotency_key, NULL::text;
  END;
  $$;

  -- BACK TO THE ROLE THIS BLOCK WAS ENTERED WITH — not `RESET ROLE`. See `v_entry` above.
  EXECUTE format('SET LOCAL ROLE %I', v_entry);

  -- ── NOTHING BUT THE BODY MOVED ─────────────────────────────────────────────────────────────
  --
  -- `CREATE OR REPLACE FUNCTION` preserves the OID, the owner and the ACL by construction, and
  -- restates volatility, SECURITY DEFINER and `search_path` from the text above. Every one of them
  -- is re-read and compared rather than trusted, because "it preserves them" is a claim about
  -- PostgreSQL and about the text, and the text is what this file changes.
  SELECT p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO a_owner, a_acl, a_secdef, a_vol, a_config, a_args, a_result, a_kind, a_src
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_ident);

  IF to_regprocedure(v_ident) IS DISTINCT FROM b_oid THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the function identity moved — a replacement must not create a second object';
  END IF;
  IF a_owner IS DISTINCT FROM b_owner THEN
    RAISE EXCEPTION 'D7 dispatch linearization: owner changed from % to %', b_owner, a_owner;
  END IF;
  IF a_acl IS DISTINCT FROM b_acl THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the ACL changed from % to % — this file widens no privilege', b_acl, a_acl;
  END IF;
  IF a_secdef IS DISTINCT FROM b_secdef THEN
    RAISE EXCEPTION 'D7 dispatch linearization: SECURITY DEFINER changed';
  END IF;
  IF a_vol IS DISTINCT FROM b_vol THEN
    RAISE EXCEPTION 'D7 dispatch linearization: volatility changed from % to % — a STABLE body would re-use the calling snapshot and defeat the whole point of this file', b_vol, a_vol;
  END IF;
  IF a_config IS DISTINCT FROM b_config THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the settings (search_path) changed from % to %', b_config, a_config;
  END IF;
  IF a_args IS DISTINCT FROM b_args THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the signature changed from (%) to (%)', b_args, a_args;
  END IF;
  IF a_result IS DISTINCT FROM b_result THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the result type changed from % to %', b_result, a_result;
  END IF;
  IF a_kind IS DISTINCT FROM b_kind THEN
    RAISE EXCEPTION 'D7 dispatch linearization: prokind changed from % to % — a function may not become a procedure', b_kind, a_kind;
  END IF;

  -- AND STILL EXACTLY ONE ROUTINE OF THAT NAME, ANYWHERE. `CREATE OR REPLACE` at a signature that
  -- differs from the one captured above would have created an OVERLOAD rather than replaced
  -- anything, and every check above would have gone on describing the untouched original.
  SELECT count(*)::int INTO v_count
    FROM pg_catalog.pg_proc p
   WHERE p.proname = 'rebook_member_open_begin_dispatch';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'D7 dispatch linearization: % routines named rebook_member_open_begin_dispatch exist after the replacement — a replacement must not add an overload', v_count;
  END IF;

  -- ── AND THE BODY DID CHANGE ────────────────────────────────────────────────────────────────
  --
  -- Without this a copy-paste that re-installed the ORIGINAL body would pass every check above and
  -- ship a migration that repairs nothing while reporting itself applied.
  IF a_src = b_src THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the body is unchanged — the replacement was a no-op';
  END IF;

  -- …and it changed in the ONE way this file is for. THIS IS THE MIGRATION'S OWN SELF-CHECK, not
  -- the release's proof: a source predicate can only ever say the text mentions something. What the
  -- installed authority actually DOES is proved behaviourally, on a real chain, against a payment
  -- committed between the resolve and the begin — `src/test/d7RuntimeContract.realpg.test.ts`.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
     WHERE p.oid = to_regprocedure(v_ident)
       AND p.prosrc LIKE '%abc27_a_live_eligible%'
  ) THEN
    RAISE EXCEPTION 'D7 dispatch linearization: the installed body does not consult the live-eligibility authority';
  END IF;

  RAISE NOTICE 'D7: begin_dispatch re-reads live eligibility at the durable decision';
END $d7_dispatch_linearization$;
