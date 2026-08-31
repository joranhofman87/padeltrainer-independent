-- D7 RUNTIME — REVIEW ROUND 1 CORRECTIONS: THE INVITATION ACTUALLY DISPATCHES.
--
-- An independent adversarial review of `20261203240000`–`20261203300000` returned four P1 defects.
-- This file closes the four that are database-side; the edge-side one is corrected in
-- `send-priority-claim-invitation/index.ts` in the same change.
--
-- ── P1 · AN INVITATION COULD NEVER REACH THE PROVIDER ───────────────────────────────────────
--
-- The enqueue worked and nothing downstream did. The worker calls `pre_dispatch_resolve`
-- unconditionally, and that routine was left filtered to `rebook_member_open_player`, so an
-- invitation got `refused` / `capability_mismatch` and zero provider calls. Even past it,
-- `begin_dispatch` was fenced to hand a priority-claim subject a NULL eligibility, which it turns
-- into `refused` / `unreadable_policy_state`.
--
-- That NULL was deliberate and correct WHEN IT WAS WRITTEN — there was no eligibility authority for
-- an invitation, and inventing one would have been worse than refusing. There is one now: the claim
-- itself. `d7_p_invite_contact` already reports whether the claim is still pending, and it is
-- already granted to Domain N, so both routines can ask the only question that matters.
--
-- ── P1 · ONE INVITATION COULD STALL A BATCH OF MEMBER-OPEN ROWS ─────────────────────────────
--
-- `20261203270000` widened `claim_batch`'s internal cursor to a coalesced subject and did NOT widen
-- its `RETURN QUERY`, which still projected `related_rebook_round_recipient_id` — NULL for an
-- invitation. The worker's decoder requires a UUID there and rejects the WHOLE batch if any row is
-- malformed, so a single invitation would leave every member-open row in its lease until the
-- janitor recovered them, and could poison the next batch too.
--
-- This is the "mechanical substitution matched fewer sites than intended" failure the exact-count
-- assertions are meant to catch, and they did not, because each site was independently correct — the
-- count was right and the SET was wrong. The projection is widened here.
--
-- ── P1 · A SUPPLIED ROUND WAS NEVER CHECKED AGAINST THE CLAIM ──────────────────────────────
--
-- `coalesce(p_round, derived)` trusted a supplied round completely: not that it belonged to the
-- tenant, not that it was the round that captured this claim, not that it was related to the claim
-- at all. An academy-A manager could attribute an invitation to academy B's round. The resolver
-- below makes the DERIVED round authoritative and accepts a supplied one only when it agrees, or —
-- when the claim has no capture record — only when it is genuinely that academy's round.
--
-- ── P2 · THE DOMAIN AGREEMENT PROVED THE WRONG THING ───────────────────────────────────────
--
-- Grant consumption proved `target.target_domain = grant.subject_domain`: that the grant agrees with
-- ITSELF. It never proved either equals the domain the OUTBOX ROW's event type implies. A grant
-- minted as `snapshot_member` over an invitation's outbox id and claim id was internally consistent
-- and would have been accepted. The guard knows the row's event type, so it now passes the derived
-- domain in and the consume matches against it.
--
-- The delete path takes the cheaper form: it requires a `rebook_round_recipient_decisions` row, which
-- an invitation can never have, so its domain is pinned to the literal rather than parameterised.

DO $d7_invite_dispatch$
DECLARE
  v_n       name;
  v_a       name;
  v_src     text;
  v_new     text;
  v_i       int;
  v_hits    int;
  v_item    text;
  v_acl_old text[];
  v_acl_new text[];
  v_owner   name;
  v_ct_old  CONSTANT text :=
    'public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text)';
  v_ct_new  CONSTANT text :=
    'public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text,text)';
  c_subs CONSTANT text[][] := ARRAY[
    -- ══ P1 · THE CLAIMER'S RETURNED SUBJECT ═════════════════════════════════════════════════
    -- The worker decodes this column as a UUID. NULL there rejects the entire batch, member-open
    -- rows included.
    ['public.rebook_member_open_claim_batch(text,int)',
     E'      SELECT o.id, o.related_rebook_round_recipient_id, o.lease_generation, o.leased_from_state,',
     E'      SELECT o.id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id), o.lease_generation, o.leased_from_state,',
     '1'],

    -- ══ P1 · AN INVITATION'S ELIGIBILITY ════════════════════════════════════════════════════
    -- The claim's own pending state, read through the bridge Domain N already holds. A claim that
    -- has been answered is not eligible; a claim this academy does not own returns no row at all,
    -- which is NULL, which `begin_dispatch` already turns into a refusal that writes nothing.
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     E'v_eligible := CASE WHEN r.subject_domain = ''snapshot_member'' THEN public.abc27_a_live_eligible(r.round_id, r.member_id) ELSE NULL END;',
     E'v_eligible := CASE WHEN r.subject_domain = ''snapshot_member''\n'
     '                   THEN public.abc27_a_live_eligible(r.round_id, r.member_id)\n'
     '                   ELSE (SELECT b.still_pending FROM public.d7_p_invite_contact(r.academy, r.member_id) b)\n'
     '              END;',
     '1'],

    -- ══ P1 · THE RESOLVER ADMITS AN INVITATION, AND ANSWERS IT FIRST ════════════════════════
    ['public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
     E'     AND o.event_type = ''rebook_member_open_player''\n',
     E'     AND o.event_type = ANY (public.rebook_round_protected_event_types())\n',
     '1'],
    ['public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
     E'         o.recipient_user_id, o.recipient_guest_player_id, o.destination_normalized AS dest,',
     E'         o.recipient_user_id, o.recipient_guest_player_id, o.destination_normalized AS dest,\n'
     '         o.event_type, o.related_slot_priority_claim_id AS claim_id,',
     '1'],
    -- THE EARLY RETURN. Placed immediately after the row is locked and before one line of
    -- member-open policy runs, so an invitation cannot fall into a member snapshot, a preference
    -- lookup, a decision write or a delete-pair — none of which it can satisfy.
    --
    -- It issues NO grant and writes NOTHING. `held` is the honest disposition for a claim that has
    -- been answered: the machine will not send, the row is retained, and a human decides. A terminal
    -- is not available to an invitation (that path writes a recipient decision) and inventing one
    -- here would be exactly the kind of parallel authority this design exists to avoid.
    ['public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
     E'  IF NOT FOUND THEN\n    RETURN QUERY SELECT ''refused''::text, NULL::text, NULL::timestamptz, ''capability_mismatch''::text;\n    RETURN;\n  END IF;',
     E'  IF NOT FOUND THEN\n    RETURN QUERY SELECT ''refused''::text, NULL::text, NULL::timestamptz, ''capability_mismatch''::text;\n    RETURN;\n  END IF;\n'
     '  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n'
     '    IF coalesce((SELECT b.still_pending FROM public.d7_p_invite_contact(r.academy, r.claim_id) b), false) THEN\n'
     '      RETURN QUERY SELECT ''proceed''::text, NULL::text, NULL::timestamptz, NULL::text;\n'
     '    ELSE\n'
     '      RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, ''claim_no_longer_pending''::text;\n'
     '    END IF;\n'
     '    RETURN;\n'
     '  END IF;',
     '1'],

    -- ══ P1 · THE ROUND IS RESOLVED, NOT TRUSTED ═════════════════════════════════════════════
    ['public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)',
     E'      v_round := coalesce(p_round, public.abc27_a_claim_round(p_academy, p_claim));',
     E'      v_round := public.abc27_a_resolve_invite_round(p_academy, p_claim, p_round);',
     '1'],
    ['public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)',
     E'        RAISE EXCEPTION ''rebook_priority_claim_invite_enqueue_core: claim % belongs to no rebook round'', p_claim',
     E'        RAISE EXCEPTION ''rebook_priority_claim_invite_enqueue_core: claim % has no round this academy may invite it for'', p_claim',
     '1'],

    -- ══ P2 · A COMMA IN A DISPLAY NAME IS AN ADDRESS SEPARATOR ══════════════════════════════
    -- The edge sanitizer deliberately KEEPS commas, because the direct-send path it was written for
    -- wrapped the phrase in quotes. This path strips quotes, so a comma would split the mailbox.
    -- The bytes are permanent once enqueued, so the character is removed rather than escaped.
    ['public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)',
     E'      v_from_name := left(regexp_replace(v_from_name, ''[[:cntrl:]"<>\\\\]'', '''', ''g''), 120);',
     E'      v_from_name := left(regexp_replace(v_from_name, ''[[:cntrl:]",<>\\\\]'', '''', ''g''), 120);',
     '1'],

    -- ══ P2 · THE DELETE PATH IS MEMBER-OPEN, IN THE BODY RATHER THAN ONLY IN A COMMENT ══════
    ['public.abc27_a_consume_delete_grant(uuid,uuid,uuid,uuid,uuid,text)',
     E'    AND g.subject_uuid IS NOT DISTINCT FROM p_member',
     E'    AND g.subject_domain = ''snapshot_member''\n    AND g.subject_uuid IS NOT DISTINCT FROM p_member',
     '1']
  ];
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'related_slot_priority_claim_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 invite dispatch: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_contact(uuid,uuid)') IS NULL
     OR to_regprocedure(v_ct_old) IS NULL THEN
    RAISE EXCEPTION 'D7 invite dispatch: the batch this file corrects is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_a FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='rebook_round_recipient_claim_sources';

  -- ══ THE ROUND RESOLVER ═══════════════════════════════════════════════════════════════════
  --
  -- Derived wins. A supplied round is accepted only when it AGREES with the round that captured this
  -- claim, and — when the claim has no capture record at all — only when it is a round of this very
  -- academy. Every other combination returns NULL, and the caller refuses on NULL.
  EXECUTE $rr$
    CREATE OR REPLACE FUNCTION public.abc27_a_resolve_invite_round(
      p_academy uuid, p_claim uuid, p_round uuid)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $rb$
      WITH d AS (
        SELECT s.rebook_round_id AS rid
          FROM public.rebook_round_recipient_claim_sources s
         WHERE s.source_claim_id = p_claim
           AND s.academy_profile_id = p_academy
         ORDER BY s.captured_at DESC
         LIMIT 1)
      SELECT CASE
               WHEN (SELECT rid FROM d) IS NOT NULL
                 THEN CASE WHEN p_round IS NULL OR p_round = (SELECT rid FROM d)
                           THEN (SELECT rid FROM d) END
               ELSE (SELECT r.id FROM public.rebook_rounds r
                      WHERE r.id = p_round AND r.academy_profile_id = p_academy)
             END
    $rb$
  $rr$;
  EXECUTE format('ALTER FUNCTION public.abc27_a_resolve_invite_round(uuid,uuid,uuid) OWNER TO %I', v_a);
  EXECUTE 'REVOKE ALL ON FUNCTION public.abc27_a_resolve_invite_round(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.abc27_a_resolve_invite_round(uuid,uuid,uuid) TO %I', v_n);

  -- ══ THE CONSUME PATH LEARNS THE ROW'S OWN DOMAIN ═════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ct_old)) INTO v_src;
  SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[]),
         p.proowner::regrole::name
    INTO v_acl_old, v_owner
    FROM pg_catalog.pg_proc p LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
   WHERE p.oid = to_regprocedure(v_ct_old) GROUP BY p.proowner;

  v_new := replace(v_src,
    'p_old_state text, p_new_state text)',
    'p_old_state text, p_new_state text, p_row_domain text)');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'D7 invite dispatch: the consume signature tail did not match';
  END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'    AND g.subject_uuid IS NOT DISTINCT FROM p_member',
    E'    AND g.subject_domain = p_row_domain\n    AND g.subject_uuid IS NOT DISTINCT FROM p_member');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'D7 invite dispatch: the consume subject predicate did not match';
  END IF;

  EXECUTE format('DROP FUNCTION %s', v_ct_old);
  EXECUTE v_new;
  IF v_owner IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_ct_new, v_owner);
  END IF;
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_ct_new);
  IF v_acl_old IS NOT NULL THEN
    FOREACH v_item IN ARRAY v_acl_old LOOP
      IF position('X' IN split_part(split_part(v_item, '/', 1), '=', 2)) > 0 THEN
        IF split_part(v_item, '=', 1) = '' THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', v_ct_new);
        ELSE
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_ct_new, split_part(v_item, '=', 1));
        END IF;
      END IF;
    END LOOP;
  END IF;
  SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[])
    INTO v_acl_new
    FROM pg_catalog.pg_proc p LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
   WHERE p.oid = to_regprocedure(v_ct_new);
  IF v_acl_old IS DISTINCT FROM v_acl_new THEN
    RAISE EXCEPTION 'D7 invite dispatch: consume ACL restore is not byte-equivalent (before=% after=%)',
      v_acl_old, v_acl_new;
  END IF;

  -- The guard is the ONLY caller, and it is the only place that knows the row's event type.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.notification_outbox_round_ref_guard()')) INTO v_src;
  v_new := replace(v_src,
    E'      OLD.tenant_academy_profile_id, OLD.related_rebook_round_id,\n      OLD.transport_state, NEW.transport_state);',
    E'      OLD.tenant_academy_profile_id, OLD.related_rebook_round_id,\n      OLD.transport_state, NEW.transport_state,\n'
    '      public.rebook_round_transport_subject_domain_for_event(OLD.event_type));');
  IF v_new = v_src THEN
    RAISE EXCEPTION 'D7 invite dispatch: the guard consume call did not match';
  END IF;
  EXECUTE v_new;

  -- ══ THE REMAINING SUBSTITUTIONS ══════════════════════════════════════════════════════════
  FOR v_i IN 1 .. array_length(c_subs, 1) LOOP
    IF to_regprocedure(c_subs[v_i][1]) IS NULL THEN
      RAISE EXCEPTION 'D7 invite dispatch: % is not installed', c_subs[v_i][1];
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(c_subs[v_i][1])) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_subs[v_i][2], ''))) / length(c_subs[v_i][2]);
    IF v_hits <> c_subs[v_i][4]::int THEN
      RAISE EXCEPTION 'D7 invite dispatch: % carries % occurrence(s) of a substitution expected exactly % time(s): %',
        c_subs[v_i][1], v_hits, c_subs[v_i][4], left(c_subs[v_i][2], 70);
    END IF;
    EXECUTE replace(v_src, c_subs[v_i][2], c_subs[v_i][3]);
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(c_subs[v_i][1])) INTO v_src;
    IF position(c_subs[v_i][3] IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 invite dispatch: % did not take substitution %', c_subs[v_i][1], left(c_subs[v_i][3], 70);
    END IF;
  END LOOP;

  -- ══ PROVED FROM THE CATALOG ══════════════════════════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  IF position('abc27_a_member_snapshot' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite dispatch: the resolver lost its member-open snapshot read';
  END IF;
  IF position(E'IF r.event_type = ''rebook_priority_claim_invite'' THEN' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite dispatch: the resolver has no invitation branch';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.rebook_member_open_claim_batch(text,int)')) INTO v_src;
  IF position('coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id), o.lease_generation' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite dispatch: the claimer still projects a member-only subject';
  END IF;

  RAISE NOTICE 'D7: an invitation now resolves, begins and dispatches on its own subject';
END $d7_invite_dispatch$;
