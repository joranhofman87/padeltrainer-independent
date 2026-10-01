-- D7 RUNTIME — THE CROSSED CUTOFF IS `after_cutoff`, NOT `window_invalid`.
--
-- ROUND-4 P3-10. `20261203130000` added a second deadline fence after the eligibility re-read, and
-- reported everything it caught as `window_invalid`. Two different facts were collapsed into one
-- reason: the member WINDOW closing means the round is over, while this row's own acceptance-
-- uncertainty CUTOFF passing means only that its deadline elapsed. An operator reading
-- `window_invalid` for the second would look for a finished round and find an open one.
--
-- This unit already carries both reasons — the original fence returns `after_cutoff` in exactly this
-- situation — so nothing is minted here; the re-fence is simply taught the distinction the fence
-- above it already makes. The `first_dispatch_at IS NOT NULL` guard mirrors the original: a
-- first-ever dispatch derives its cutoff inside this same transaction, so it cannot have passed.
--
-- Nothing else in the body changes: `src/test/d7ForwardChain.realpg.test.ts` compares the whole
-- body byte-for-byte against ABC-27 with the inserted region removed, and pins the region itself by
-- digest, so any other edit here fails there.

DO $d7_after_cutoff$
DECLARE
  v_ident   CONSTANT text := 'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)';
  v_entry   CONSTANT name := current_user;
  v_n       name;
  v_oid     oid;
  v_count   int;
  b_oid     oid;  b_owner name;  b_acl text;  b_secdef boolean;  b_vol "char";
  b_config  text; b_args  text;  b_result text; b_kind "char";  b_src text;
  a_owner   name; a_acl   text;  a_secdef boolean; a_vol "char";
  a_config  text; a_args  text;  a_result text; a_kind "char";  a_src text;
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 prerequisites absent — skipping (this file sorts after ABC-27)';
    RETURN;
  END IF;

  v_oid := to_regprocedure(v_ident);
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'D7 after-cutoff: % is absent', v_ident;
  END IF;
  SELECT count(*)::int INTO v_count FROM pg_catalog.pg_proc p
   WHERE p.proname = 'rebook_member_open_begin_dispatch';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'D7 after-cutoff: expected exactly one routine named rebook_member_open_begin_dispatch, found %', v_count;
  END IF;

  -- THE PREDECESSOR MUST BE THE LINEARIZED BODY, not the original. This file edits a fence that
  -- `20261203130000` introduced; applying it to a body without that fence would install a
  -- differently-shaped function while every check below still passed.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_oid AND p.prosrc LIKE '%v_after := clock_timestamp()%') THEN
    RAISE EXCEPTION 'D7 after-cutoff: the installed begin_dispatch does not carry the linearization re-fence — apply 20261203130000 first';
  END IF;

  SELECT p.oid, p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO b_oid, b_owner, b_acl, b_secdef, b_vol, b_config, b_args, b_result, b_kind, b_src
    FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;

  SELECT c.relowner::regrole::name INTO v_n
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'notification_outbox';
  IF v_n IS NULL THEN
    RAISE EXCEPTION 'D7 after-cutoff: cannot resolve the Domain-N owner';
  END IF;
  IF b_owner IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'D7 after-cutoff: % is owned by % but the Domain-N owner is %', v_ident, b_owner, v_n;
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, v_n, 'MEMBER') THEN
    RAISE EXCEPTION 'D7 after-cutoff: % is not a member of the Domain-N owner %', current_user, v_n;
  END IF;
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', v_n);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'D7 after-cutoff: % may not SET ROLE to % (%)', v_entry, v_n, SQLERRM;
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
    IF v_window <= v_after THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'window_invalid'::text;
      RETURN;
    END IF;
    -- A CROSSED UNCERTAINTY CUTOFF IS `after_cutoff`, NOT `window_invalid`.
    --
    -- Those are different facts and this unit already has a reason for each: the window closing
    -- means the round is over, while the cutoff passing means THIS row's own acceptance-uncertainty
    -- deadline elapsed. The first re-fence collapsed both into `window_invalid`, which would have an
    -- operator reading "the round ended" for a row whose round is still open. The distinction only
    -- arises for a LATER generation, exactly as in the original fence above: a first-ever dispatch
    -- derives its cutoff from this same transaction, so it cannot have passed.
    IF r.first_dispatch_at IS NOT NULL AND v_after >= v_cutoff THEN
      RETURN QUERY SELECT 'refused'::text, NULL::timestamptz, NULL::timestamptz, NULL::text, NULL::text, 'after_cutoff'::text;
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

  EXECUTE format('SET LOCAL ROLE %I', v_entry);

  SELECT p.proowner::regrole::name, p.proacl::text, p.prosecdef, p.provolatile,
         p.proconfig::text, pg_get_function_identity_arguments(p.oid),
         pg_get_function_result(p.oid), p.prokind,
         encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
    INTO a_owner, a_acl, a_secdef, a_vol, a_config, a_args, a_result, a_kind, a_src
    FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(v_ident);

  IF to_regprocedure(v_ident) IS DISTINCT FROM b_oid THEN
    RAISE EXCEPTION 'D7 after-cutoff: the function identity moved';
  END IF;
  IF a_owner IS DISTINCT FROM b_owner THEN RAISE EXCEPTION 'D7 after-cutoff: owner changed'; END IF;
  IF a_acl IS DISTINCT FROM b_acl THEN RAISE EXCEPTION 'D7 after-cutoff: the ACL changed from % to %', b_acl, a_acl; END IF;
  IF a_secdef IS DISTINCT FROM b_secdef THEN RAISE EXCEPTION 'D7 after-cutoff: SECURITY DEFINER changed'; END IF;
  IF a_vol IS DISTINCT FROM b_vol THEN RAISE EXCEPTION 'D7 after-cutoff: volatility changed from % to %', b_vol, a_vol; END IF;
  IF a_config IS DISTINCT FROM b_config THEN RAISE EXCEPTION 'D7 after-cutoff: search_path changed'; END IF;
  IF a_args IS DISTINCT FROM b_args THEN RAISE EXCEPTION 'D7 after-cutoff: the signature changed'; END IF;
  IF a_result IS DISTINCT FROM b_result THEN RAISE EXCEPTION 'D7 after-cutoff: the result type changed'; END IF;
  IF a_kind IS DISTINCT FROM b_kind THEN RAISE EXCEPTION 'D7 after-cutoff: prokind changed'; END IF;
  SELECT count(*)::int INTO v_count FROM pg_catalog.pg_proc p
   WHERE p.proname = 'rebook_member_open_begin_dispatch';
  IF v_count <> 1 THEN RAISE EXCEPTION 'D7 after-cutoff: an overload appeared'; END IF;
  IF a_src = b_src THEN RAISE EXCEPTION 'D7 after-cutoff: the body is unchanged — the replacement was a no-op'; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure(v_ident)
                    AND p.prosrc LIKE '%v_after >= v_cutoff%'
                    AND p.prosrc LIKE '%''after_cutoff''%') THEN
    RAISE EXCEPTION 'D7 after-cutoff: the installed body does not distinguish the crossed cutoff';
  END IF;

  RAISE NOTICE 'D7: a cutoff crossed during the eligibility re-read now reports after_cutoff';
END $d7_after_cutoff$;
