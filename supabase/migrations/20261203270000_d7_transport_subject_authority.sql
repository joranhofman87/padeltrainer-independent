-- D7 RUNTIME — THE TRANSPORT AUTHORITY, ON THE CLOSED SUBJECT TRIPLE.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_TRANSPORT_SUBJECT_GENERALIZATION_AND_CANONICAL_OUTBOX_CLOSURE_V1`):
--   `SIGNATURE=DROP_AND_RECREATE_WITH_REQUIRED_SUBJECT_DOMAIN_NO_DEFAULTED_PARAMETER_NO_UNLISTED_DEPENDENT_DROP_OR_CASCADE`
--   `ACL=CAPTURE_EFFECTIVE_proacl_BEFORE_EACH_DROP_RESTORE_AND_PROVE_BYTE_EQUIVALENCE_IN_BOTH_DIRECTIONS`
--   `PIN_WIDENING_PROOF=...PROVE_THE_FULL_DOMAIN_UUID_TRIPLE_ON_EVERY_GRANT_CONSUMPTION_PATH`
--
-- ── WHERE THE DOMAIN COMES FROM, AND WHY IT IS A PARAMETER ──────────────────────────────────
--
-- The obvious hardening — have `abc27_a_authorize_transition` read the outbox row and prove the
-- caller's claimed subject against it — is NOT AVAILABLE, and the reason is a privilege boundary
-- rather than a preference. Domain A holds no grant on `public.notification_outbox`; measured, no
-- `abc27_a_*` routine reads that table, and giving A one would be a new permission class, which the
-- standing `STOP_RULE` reserves to the owner.
--
-- So the domain is DERIVED — never asserted — at the only place that already holds the row: the
-- machine entrypoint, from `o.event_type`, through the total map
-- `rebook_round_transport_subject_domain_for_event`. A caller cannot pass a domain that disagrees
-- with the row, because it does not choose one. `authorize_transition` then validates that what it
-- received is a member of the closed vocabulary and refuses anything else, so an unknown domain
-- cannot enter the tables even if a future caller is written by hand.
--
-- ── WHICH ROUTINES ARE WIDENED, AND WHICH ARE NOT ──────────────────────────────────────────
--
-- The superseded `d7_transport_vocabulary_widening` widened SEVEN routines as "event-blind". The
-- audit behind `20261203260000` found none of them is. This file widens SIX, and the seventh is
-- deliberately left alone:
--
--   WIDENED, SUBJECT-RESOLVED — claim_batch, begin_dispatch, record_dispatch_outcome,
--     recover_expired_leases. Each resolves its subject by `coalesce`, which is unambiguous because
--     `chk_notification_outbox_transport_subject_exclusive` makes two subjects unrepresentable.
--
--   WIDENED, PROJECTION ONLY — dispatch_status, dispatch_status_by_capability. They report; they
--     issue no grant. They keep projecting the snapshot-member column, which is NULL for an
--     invitation: a claim id is not something a status reader needs to disclose.
--
--   NOT WIDENED, BY DESIGN — close_unresolved. It writes a `rebook_round_recipient_decisions` row on
--     BOTH arms, and that table carries a composite FK to `rebook_round_recipients`. An invitation
--     has no such row, so every path through it is unreachable for one. Leaving it member-open is
--     not a gap: an unresolved invitation stays in its transport state until an operator clears it,
--     which is exactly `ODB_UNKNOWN_IS_CLEARED_ONLY_BY_AN_OPERATOR` and `SEND_SAFETY=...UNKNOWN_
--     NEVER_AUTOMATICALLY_SENDABLE_OPERATOR_RESOLVED_ONLY`. Widening it would have manufactured an
--     automatic resolution the owner has twice ruled out.
--
-- Re-issued from the CATALOG via `pg_get_functiondef` with exact asserted substitutions, so
-- everything not substituted is byte-identical by construction rather than by inspection.

DO $d7_subject_authority$
DECLARE
  v_a        name;
  v_acl_old  text[];
  v_acl_new  text[];
  v_owner    name;
  v_src      text;
  v_new      text;
  v_ident    text;
  v_hits     int;
  v_i        int;
  v_item     text;
  -- [routine, old, new]. One row per substitution; a routine may appear more than once.
  c_subs CONSTANT text[][] := ARRAY[
    -- ══ THE FOUR REMAINING DOMAIN-A ROUTINES ═════════════════════════════════════════════════
    -- The renamed column, and the full triple on every consumption path. `t.target_domain` is
    -- matched against `g.subject_domain` rather than a literal: the grant and the operation target
    -- must AGREE, which is what makes the pair a triple instead of two independent facts.
    ['public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text)',
     'AND t.target_domain = ''snapshot_member'' AND t.target_uuid = p_member',
     'AND t.target_domain = g.subject_domain AND t.target_uuid = p_member', '1'],
    ['public.abc27_a_consume_transition_grant(uuid,text,uuid,uuid,uuid,uuid,text,text)',
     'AND g.rebook_round_recipient_id IS NOT DISTINCT FROM p_member',
     'AND g.subject_uuid IS NOT DISTINCT FROM p_member', '1'],
    ['public.abc27_a_consume_delete_grant(uuid,uuid,uuid,uuid,uuid,text)',
     'AND t.target_domain = ''snapshot_member'' AND t.target_uuid = p_member',
     'AND t.target_domain = g.subject_domain AND t.target_uuid = p_member', '1'],
    -- NOTE the alias. `g.` is the transition; `d.rebook_round_recipient_id` in this same body is the
    -- DECISIONS table and must keep its name. Substituting on the bare column would have renamed a
    -- column on a table this migration never touches.
    ['public.abc27_a_consume_delete_grant(uuid,uuid,uuid,uuid,uuid,text)',
     'AND g.rebook_round_recipient_id IS NOT DISTINCT FROM p_member',
     'AND g.subject_uuid IS NOT DISTINCT FROM p_member', '1'],
    -- THE FULL TRIPLE HERE TOO. `PIN_WIDENING_PROOF` asks for the domain/uuid triple on every grant
    -- consumption path, and this one validates the stamped delete grant. Matching the subject alone
    -- would let a grant of the WRONG domain satisfy it if the uuids ever coincided; the literal also
    -- states, in the body rather than only in a comment, that G-8 arming is member-open.
    ['public.abc27_a_validate_arm_stamp(uuid,uuid,uuid,uuid,text)',
     'AND delg.rebook_round_recipient_id IS NOT DISTINCT FROM p_member',
     'AND delg.subject_domain = ''snapshot_member''
      AND delg.subject_uuid IS NOT DISTINCT FROM p_member', '1'],
    -- `issue_delete_pair` serves the pre-dispatch terminal path, which is member-open only (it
    -- writes a decision). Its two grants are stamped with the literal domain, not a parameter.
    ['public.abc27_a_issue_delete_pair(uuid,uuid,uuid,uuid,text,text,timestamptz)',
     '(operation_id, outbox_id, rebook_round_recipient_id, action,',
     '(operation_id, outbox_id, subject_uuid, subject_domain, action,', '2'],
    ['public.abc27_a_issue_delete_pair(uuid,uuid,uuid,uuid,text,text,timestamptz)',
     'VALUES (v_op, p_outbox, p_member, ''pre_dispatch_terminal_delete''',
     'VALUES (v_op, p_outbox, p_member, ''snapshot_member'', ''pre_dispatch_terminal_delete''', '1'],
    ['public.abc27_a_issue_delete_pair(uuid,uuid,uuid,uuid,text,text,timestamptz)',
     'VALUES (v_op, p_outbox, p_member, ''pre_dispatch_terminal_arm''',
     'VALUES (v_op, p_outbox, p_member, ''snapshot_member'', ''pre_dispatch_terminal_arm''', '1'],

    -- ══ SUBJECT RESOLUTION IN THE FOUR GRANT-ISSUING ENTRYPOINTS ═════════════════════════════
    -- One identical select-list line in all four. `coalesce` is safe because exactly one of the two
    -- columns can be non-null; the domain is derived from the row, never chosen.
    ['public.rebook_member_open_claim_batch(text,int)',
     'SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,',
     'SELECT o.id, o.related_rebook_round_id AS round_id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id) AS member_id, public.rebook_round_transport_subject_domain_for_event(o.event_type) AS subject_domain,', '1'],
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     'SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,',
     'SELECT o.id, o.related_rebook_round_id AS round_id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id) AS member_id, public.rebook_round_transport_subject_domain_for_event(o.event_type) AS subject_domain,', '1'],
    ['public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
     'SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,',
     'SELECT o.id, o.related_rebook_round_id AS round_id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id) AS member_id, public.rebook_round_transport_subject_domain_for_event(o.event_type) AS subject_domain,', '1'],
    ['public.rebook_member_open_recover_expired_leases(int,int)',
     'SELECT o.id, o.related_rebook_round_id AS round_id, o.related_rebook_round_recipient_id AS member_id,',
     'SELECT o.id, o.related_rebook_round_id AS round_id, coalesce(o.related_rebook_round_recipient_id, o.related_slot_priority_claim_id) AS member_id, public.rebook_round_transport_subject_domain_for_event(o.event_type) AS subject_domain,', '1'],

    -- ══ PASSING THE DERIVED DOMAIN ═══════════════════════════════════════════════════════════
    -- ANCHORED ON ARGUMENT ORDER, NOT ON LAYOUT. The first attempt pinned each call's full text from
    -- the frozen file and failed on `begin_dispatch`, which `20261203130000` and `20261203150000`
    -- re-issue — so the INSTALLED text is theirs, not ABC-27's. This anchor survives that because it
    -- names the argument sequence instead of the indentation.
    --
    -- It cannot collide with the `write_incident` call in record_dispatch_outcome, which passes
    -- `r.round_id, r.academy, r.member_id` — the same three names in a DIFFERENT order. The shorter
    -- `, r.member_id,` would have matched it and silently given an unrelated function an extra
    -- argument; the exact-count assertion is what would have caught that, and this is what avoids it.
    ['public.rebook_member_open_claim_batch(text,int)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, r.subject_domain,', '1'],
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, r.subject_domain,', '1'],
    ['public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, r.subject_domain,', '1'],
    ['public.rebook_member_open_recover_expired_leases(int,int)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, r.subject_domain,', '1'],

    -- ══ THE TWO MEMBER-OPEN-ONLY CALLERS ════════════════════════════════════════════════════
    --
    -- `pre_dispatch_resolve` and `close_unresolved` are NOT widened — they carry member-open
    -- semantics and this release leaves them serving one event type. They still have to be re-issued,
    -- because `authorize_transition` changed shape and a caller that does not pass the new argument
    -- no longer resolves to any function at all.
    --
    -- They pass the LITERAL domain rather than a derived one, which is the honest encoding of "this
    -- path is member-open": if an invitation ever reached here, the literal would be wrong and the
    -- issuing authority's row-shape checks would refuse it, instead of a derived value quietly making
    -- it work on a path nobody designed for invitations.
    --
    -- Found by the member-open end-to-end suite, not by reading: the kill, quiet-hours and
    -- begun-then-lost cases all failed the moment the signature changed. Four call sites in two
    -- routines is exactly what a "drop and recreate" costs, and the cost is visible here.
    ['public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, ''snapshot_member'',', '3'],
    ['public.rebook_member_open_close_unresolved(int)',
     ', r.academy, r.round_id, r.member_id,',
     ', r.academy, r.round_id, r.member_id, ''snapshot_member'',', '1'],

    -- ══ THE MEMBER-OPEN PRODUCT SEMANTICS, FENCED BY DOMAIN ══════════════════════════════════
    -- `abc27_a_member_decided` answers a question about a snapshot member. For an invitation there is
    -- no decision relation to consult, so the filter must not exclude it — and must not be reached
    -- with a NULL member either, which would make the result depend on that function's null
    -- handling rather than on this fence.
    ['public.rebook_member_open_claim_batch(text,int)',
     E'public.abc27_a_member_decided(\n             o.related_rebook_round_recipient_id, o.related_rebook_round_id)',
     E'(o.event_type = ''rebook_member_open_player'' AND public.abc27_a_member_decided(\n             o.related_rebook_round_recipient_id, o.related_rebook_round_id))', '1'],
    -- A decision and an incident are both member-open records with an FK to `rebook_round_recipients`.
    -- An invitation reaching either would abort the batch and take that batch's member-open rows with
    -- it, so the fence is what keeps one event type's outcome from destroying the other's progress.
    -- THE LINEARIZATION RE-READ. `20261203130000` inserted this into begin_dispatch and
    -- `20261203150000` re-issued it, so it is absent from the frozen file and a static read of
    -- ABC-27 alone does not show it — it was found by dumping the INSTALLED body.
    --
    -- `abc27_a_live_eligible(round, member)` answers a question about a snapshot member. Handed an
    -- invitation it would be handed a CLAIM id, and would answer about a recipient that does not
    -- exist. NULL is the correct answer for an invitation today, and it is not a shrug: begin_dispatch
    -- turns a NULL into `refused` / `unreadable_policy_state`, which writes nothing, keeps the lease
    -- and leaves the row exactly where it was. There genuinely is no readable eligibility policy for
    -- an invitation until the invite semantics supply one, and this says so instead of guessing.
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     'v_eligible := public.abc27_a_live_eligible(r.round_id, r.member_id);',
     'v_eligible := CASE WHEN r.subject_domain = ''snapshot_member'' THEN public.abc27_a_live_eligible(r.round_id, r.member_id) ELSE NULL END;',
     '1'],
    ['public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
     E'PERFORM public.abc27_a_write_decision(\n      r.member_id, r.round_id, r.academy, v_decision, clock_timestamp(), v_op);',
     E'IF r.subject_domain = ''snapshot_member'' THEN\n      PERFORM public.abc27_a_write_decision(\n        r.member_id, r.round_id, r.academy, v_decision, clock_timestamp(), v_op);\n    END IF;', '1'],
    ['public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
     E'PERFORM public.abc27_a_write_incident(\n      r.round_id, r.academy, r.member_id,\n      CASE WHEN v_class = ''invariant_fault'' THEN ''invalid_provider_observation'' ELSE ''configuration_hold'' END);',
     E'IF r.subject_domain = ''snapshot_member'' THEN\n      PERFORM public.abc27_a_write_incident(\n        r.round_id, r.academy, r.member_id,\n        CASE WHEN v_class = ''invariant_fault'' THEN ''invalid_provider_observation'' ELSE ''configuration_hold'' END);\n    END IF;', '1']
  ];
  -- The six that admit the protected set. `close_unresolved` is absent by design — see the header.
  c_widen CONSTANT text[] := ARRAY[
    'public.rebook_member_open_claim_batch(text,int)',
    'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
    'public.rebook_member_open_record_dispatch_outcome(uuid,text,int,bytea,int,text,text,text,boolean)',
    'public.rebook_member_open_recover_expired_leases(int,int)',
    'public.rebook_member_open_dispatch_status(uuid)',
    'public.rebook_member_open_dispatch_status_by_capability(uuid,int,bytea,text)'
  ];
  c_old_evt CONSTANT text := 'event_type = ''rebook_member_open_player''';
  c_new_evt CONSTANT text := 'event_type = ANY (public.rebook_round_protected_event_types())';
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR to_regprocedure('public.rebook_round_transport_subject_domains()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                     WHERE attrelid = to_regclass('public.rebook_round_transport_transitions')
                       AND attname = 'subject_domain' AND attnum > 0 AND NOT attisdropped) THEN
    RAISE NOTICE 'D7 subject authority: prerequisites absent — skipping';
    RETURN;
  END IF;

  -- ══ 1 · THE ISSUING AUTHORITY — DROP AND RECREATE WITH A REQUIRED DOMAIN ═══════════════════
  v_ident := 'public.abc27_a_authorize_transition(text,uuid,uuid,uuid,uuid,text,text,text)';
  IF to_regprocedure(v_ident) IS NOT NULL THEN
    -- CAPTURE FIRST. `DROP FUNCTION` discards the ACL and the owner, and both were set by loops in
    -- the frozen install that will never run again. Reconstructing them from that file would encode
    -- what was true at install; capturing them here encodes what is true now.
    SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[]), p.proowner::regrole::name
      INTO v_acl_old, v_owner
      FROM pg_catalog.pg_proc p
      LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
     WHERE p.oid = to_regprocedure(v_ident)
     GROUP BY p.proowner;

    -- No CASCADE, per `NO_UNLISTED_DEPENDENT_DROP_OR_CASCADE`: if anything genuinely depends on this
    -- routine, the drop must fail loudly rather than take the dependant with it.
    EXECUTE format('DROP FUNCTION %s', v_ident);
  ELSE
    SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[]), p.proowner::regrole::name
      INTO v_acl_old, v_owner
      FROM pg_catalog.pg_proc p
      LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
     WHERE p.oid = to_regprocedure('public.abc27_a_authorize_transition(text,uuid,uuid,uuid,text,uuid,text,text,text)')
     GROUP BY p.proowner;
  END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION public.abc27_a_authorize_transition(
      -- THE DOMAIN SITS BESIDE THE SUBJECT IT DESCRIBES, not at the end of the list. A first version
      -- appended it as a ninth trailing parameter and every caller silently passed it FIFTH, because
      -- the natural place to widen `…, r.member_id, …` is right there — PostgreSQL then reported a
      -- missing function rather than a wrong one, which is the good failure, but the lesson is that
      -- the signature should match where the value actually belongs.
      p_purpose text, p_academy uuid, p_round uuid, p_member uuid, p_subject_domain text,
      p_outbox uuid, p_action text, p_from text, p_to text
    ) RETURNS TABLE (operation_id uuid, grant_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $body$
    DECLARE v_op uuid; v_grant uuid;
    BEGIN
      -- THE CLOSED VOCABULARY, ENFORCED AT THE DOOR. The callers derive this from the outbox row and
      -- cannot get it wrong; this refuses the case where a future caller does not derive it at all.
      IF p_subject_domain IS NULL
         OR NOT (p_subject_domain = ANY (public.rebook_round_transport_subject_domains())) THEN
        RAISE EXCEPTION 'abc27_a_authorize_transition: % is not a transport subject domain',
          coalesce(p_subject_domain, '<null>') USING ERRCODE = '42501';
      END IF;
      IF p_member IS NULL THEN
        RAISE EXCEPTION 'abc27_a_authorize_transition: a % transition has no subject', p_subject_domain
          USING ERRCODE = '42501';
      END IF;
      INSERT INTO public.rebook_round_operations
        (operation_txid, purpose, command_id, academy_profile_id, round_id, contract_version)
      VALUES (pg_current_xact_id(), p_purpose, gen_random_uuid(), p_academy, p_round, 'abc27.wire.v1')
      RETURNING rebook_round_operations.operation_id INTO v_op;
      INSERT INTO public.rebook_round_operation_targets (operation_id, target_kind, target_domain, target_uuid)
      VALUES (v_op, p_subject_domain, p_subject_domain, p_member);
      INSERT INTO public.rebook_round_transport_transitions
        (operation_id, outbox_id, subject_uuid, subject_domain, action,
         from_transport_state, to_transport_state, issued_txid)
      VALUES (v_op, p_outbox, p_member, p_subject_domain, p_action, p_from, p_to, pg_current_xact_id())
      RETURNING rebook_round_transport_transitions.grant_id INTO v_grant;
      RETURN QUERY SELECT v_op, v_grant;
    END;
    $body$
  $fn$;

  v_ident := 'public.abc27_a_authorize_transition(text,uuid,uuid,uuid,text,uuid,text,text,text)';
  IF v_owner IS NOT NULL THEN
    EXECUTE format('ALTER FUNCTION %s OWNER TO %I', v_ident, v_owner);
  END IF;
  -- RESTORE, then PROVE. A fresh function carries a default `PUBLIC=X`; the captured ACL is replayed
  -- verbatim after that default is removed, so the result is the captured set and nothing besides.
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', v_ident);
  IF v_acl_old IS NOT NULL THEN
    FOREACH v_item IN ARRAY v_acl_old LOOP
      -- aclitem text is `grantee=privs/grantor`; an empty grantee is PUBLIC. Only EXECUTE (`X`) is
      -- meaningful for a function, and it is the only privilege replayed.
      IF position('X' IN split_part(split_part(v_item, '/', 1), '=', 2)) > 0 THEN
        IF split_part(v_item, '=', 1) = '' THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', v_ident);
        ELSE
          EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', v_ident, split_part(v_item, '=', 1));
        END IF;
      END IF;
    END LOOP;
  END IF;

  SELECT coalesce(array_agg(a::text ORDER BY a::text) FILTER (WHERE a IS NOT NULL), ARRAY[]::text[]) INTO v_acl_new
    FROM pg_catalog.pg_proc p LEFT JOIN LATERAL unnest(p.proacl) AS a ON true
   WHERE p.oid = to_regprocedure(v_ident);
  -- BOTH DIRECTIONS, per `ACL=`. A one-sided containment check would pass a restore that silently
  -- ADDED a grantee, which is the direction that matters for a security-definer authority.
  -- COMPARED AS SORTED ARRAYS, not with `<> ALL`. `x <> ALL (arr)` yields NULL the moment either
  -- side carries a NULL, and a NULL is not TRUE, so the whole check would report "equivalent" for
  -- an ACL it never actually compared. `IS DISTINCT FROM` on the two aggregated arrays has no such
  -- hole, and both arrays are built with the same ORDER BY so the comparison is order-stable.
  IF v_acl_old IS DISTINCT FROM v_acl_new THEN
    RAISE EXCEPTION 'D7 subject authority: ACL restore is not byte-equivalent (before=% after=%)',
      v_acl_old, v_acl_new;
  END IF;
  RAISE NOTICE 'D7 subject authority: authorize_transition re-created, owner=%, acl=%', v_owner, v_acl_new;

  -- ══ 2 · EVERY OTHER ROUTINE, BY EXACT SUBSTITUTION ════════════════════════════════════════
  FOR v_i IN 1 .. array_length(c_subs, 1) LOOP
    v_ident := c_subs[v_i][1];
    IF to_regprocedure(v_ident) IS NULL THEN
      RAISE EXCEPTION 'D7 subject authority: % is not installed', v_ident;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_subs[v_i][2], ''))) / length(c_subs[v_i][2]);
    -- EXACT, not "at least one". A substitution that silently matched a second site would rewrite a
    -- statement nobody reviewed; `issue_delete_pair` legitimately carries the same INSERT column list
    -- twice (the arm grant and the delete grant), and that count is stated rather than tolerated.
    IF v_hits <> c_subs[v_i][4]::int THEN
      RAISE EXCEPTION 'D7 subject authority: % carries % occurrence(s) of a substitution expected exactly % time(s): %',
        v_ident, v_hits, c_subs[v_i][4], left(c_subs[v_i][2], 70);
    END IF;
    v_new := replace(v_src, c_subs[v_i][2], c_subs[v_i][3]);
    EXECUTE v_new;
    -- PROVED FROM THE CATALOG: the old text is gone and the new text is present in the INSTALLED
    -- body, not merely in the string that was executed.
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    IF position(c_subs[v_i][3] IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 subject authority: % did not take substitution %', v_ident, left(c_subs[v_i][3], 70);
    END IF;
  END LOOP;

  -- ══ 3 · THE PROTECTED EVENT SET ═══════════════════════════════════════════════════════════
  FOREACH v_ident IN ARRAY c_widen LOOP
    IF to_regprocedure(v_ident) IS NULL THEN
      RAISE EXCEPTION 'D7 subject authority: % is not installed', v_ident;
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_old_evt, ''))) / length(c_old_evt);
    IF v_hits < 1 THEN
      RAISE EXCEPTION 'D7 subject authority: % carries no member-open comparison to widen', v_ident;
    END IF;
    RAISE NOTICE 'D7 subject authority: widening % — % site(s)', v_ident, v_hits;
    EXECUTE replace(v_src, c_old_evt, c_new_evt);
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    IF position('rebook_round_protected_event_types' IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 subject authority: % did not take the protected vocabulary', v_ident;
    END IF;
    IF position(c_old_evt IN v_src) > 0 THEN
      RAISE EXCEPTION 'D7 subject authority: % still carries a bare member-open comparison', v_ident;
    END IF;
  END LOOP;

  -- close_unresolved must NOT have been widened by any of the above. Asserted rather than assumed,
  -- because the whole safety argument for the invitation's unresolved state rests on it.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.rebook_member_open_close_unresolved(int)')) INTO v_src;
  IF position(c_old_evt IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 subject authority: close_unresolved is no longer member-open scoped — an invitation could reach a decision write';
  END IF;

  RAISE NOTICE 'D7: the transport authority now issues and consumes on the closed subject triple';
END $d7_subject_authority$;
