-- D7 RUNTIME — THE OUTBOX GUARD, SPLIT ALONG THE SUBJECT.
--
-- OWNER DECISION (`APPROVE_D7_RUNTIME_TRANSPORT_SUBJECT_GENERALIZATION_AND_CANONICAL_OUTBOX_CLOSURE_V1`):
--   `IN_FLIGHT_WORK=...THEN_ADD_THE_SUBJECT_MODEL_AUTHORITY_AND_GUARD_SUCCESSORS`
--
-- ── THE GAP THIS CLOSES, WHICH IS THE WHOLE REASON THE FILE EXISTS ──────────────────────────
--
-- `notification_outbox_round_ref_guard` is the unconditional authority on this table, and every
-- transport invariant it enforces on UPDATE sits behind ONE test:
--
--     IF OLD.event_type = 'rebook_member_open_player' THEN
--
-- Everything inside is skipped for any other event type: the write-once request identity, the
-- monotonic lease and dispatch generation, the refusal to lose transport state, and — most
-- importantly — `abc27_a_consume_transition_grant`, which is what makes a D7 mutation PRESENT the
-- grant that authorized it.
--
-- So the moment `20261203270000` let an invitation into the transport, its UPDATEs would have gone
-- through this guard enforcing nothing at all. A `begin_dispatch` on an invitation would issue a
-- grant and then never consume it, leaving the one-live-grant key holding a grant that authorized a
-- write nobody checked. That is not a smaller version of the authority — it is its absence.
--
-- ── WHAT IS WIDENED, AND WHAT IS LEFT MEMBER-OPEN ──────────────────────────────────────────
--
-- WIDENED, because the invariant is about TRANSPORT and applies to any protected row: the UPDATE
--   transport block, the template/payload immutability, and the DELETE retention refusal.
--
-- NOT WIDENED, because the invariant is about a MEMBER rather than about transport. One of these
-- gets an invitation branch of its own instead; the other gets nothing, and says why:
--
--   The INSERT arm's member-open branch, which validates the row's recipient identity against its
--     snapshot through `abc27_a_validate_member_open_insert`. It stays exactly as ABC-27 wrote it,
--     and the invitation gets its OWN branch beside it rather than a widened one.
--
--     A first version of this file left the invitation with no branch at all, on the reading that
--     `d7_p_invite_recipient_snapshot` is granted to the Domain-A owner while this guard runs as
--     Domain N — so closing it would need a cross-owner grant. That reading was WRONG:
--     `20261203250000` grants both bridges to `v_n`, the CONSUMING owner, precisely so an N-owned
--     reader can call them ("Not service_role, not Domain A", in its own words). The check is
--     reachable, so it is made, and the shape CHECK constraint is no longer the only thing standing
--     between an invitation and a recipient identity that is not the claim's.
--
--   The G-8 arming branch. An invitation cannot reach it (`pre_dispatch_resolve` is not widened),
--     and if one ever did, `abc27_a_validate_arm_stamp` would be handed a NULL subject while
--     `subject_uuid` is NOT NULL — so no grant can match and the write is refused. Fail-closed
--     already, and left that way deliberately rather than given a branch that has never run.
--
-- The subject is read as `coalesce(recipient, claim)`, unambiguous because
-- `chk_notification_outbox_transport_subject_exclusive` makes two subjects unrepresentable.

DO $d7_guard_split$
DECLARE
  v_src   text;
  v_ident CONSTANT text := 'public.notification_outbox_round_ref_guard()';
  v_i     int;
  v_hits  int;
  c_subs CONSTANT text[][] := ARRAY[
    -- ══ THE UPDATE TRANSPORT BLOCK ═══════════════════════════════════════════════════════════
    -- Anchored on the line that FOLLOWS the gate, because the gate's own text
    -- (`IF OLD.event_type = 'rebook_member_open_player' THEN`) occurs twice in this body — once
    -- here and once in the DELETE arm — and a bare substitution would silently take both.
    [E'IF OLD.event_type = ''rebook_member_open_player'' THEN\n    -- The frozen request identity.',
     E'IF OLD.event_type = ANY (public.rebook_round_protected_event_types()) THEN\n    -- The frozen request identity.',
     '1'],
    -- ══ THE DELETE RETENTION REFUSAL ═════════════════════════════════════════════════════════
    -- An invitation that was authorized to dispatch must be retained for exactly the reason a
    -- member-open row is: a provider call may already have happened, and deletion would erase the
    -- only durable record that it did.
    [E'IF OLD.event_type = ''rebook_member_open_player'' THEN\n      IF OLD.first_dispatch_at IS NOT NULL',
     E'IF OLD.event_type = ANY (public.rebook_round_protected_event_types()) THEN\n      IF OLD.first_dispatch_at IS NOT NULL',
     '1'],
    -- ══ TEMPLATE AND PAYLOAD IMMUTABILITY ════════════════════════════════════════════════════
    -- An invitation's body is frozen at enqueue as `canonical_request_bytes`, and the provider
    -- idempotency key is computed over it. Letting the payload move after that would make a re-POST
    -- carry different bytes under the same key — the exact defect the frozen identity exists to
    -- prevent, so the immutability is not member-open's alone.
    [E'IF OLD.event_type = ''rebook_member_open_player''\n     AND (NEW.template_key IS DISTINCT FROM OLD.template_key',
     E'IF OLD.event_type = ANY (public.rebook_round_protected_event_types())\n     AND (NEW.template_key IS DISTINCT FROM OLD.template_key',
     '1'],
    -- ══ THE SUBJECT, ON BOTH GRANT CONSUMPTION PATHS ═════════════════════════════════════════
    [E'OLD.id, OLD.related_rebook_round_recipient_id,\n      OLD.tenant_academy_profile_id',
     E'OLD.id, coalesce(OLD.related_rebook_round_recipient_id, OLD.related_slot_priority_claim_id),\n      OLD.tenant_academy_profile_id',
     '1'],
    [E'OLD.pending_delete_grant_id, OLD.id, OLD.related_rebook_round_recipient_id,',
     E'OLD.pending_delete_grant_id, OLD.id, coalesce(OLD.related_rebook_round_recipient_id, OLD.related_slot_priority_claim_id),',
     '1'],
    -- ══ THE INSERT ARM'S SYMMETRIC REFUSAL ═══════════════════════════════════════════════════
    -- ABC-27 refuses a snapshot reference on any event that is not member-open, and states why: it
    -- would make that row anti-join-visible for a round it is not part of. A claim reference on any
    -- event that is not an invitation is the same defect wearing the other subject, and it was
    -- unrepresentable only for as long as the column did not exist.
    [E'ELSIF NEW.related_rebook_round_recipient_id IS NOT NULL THEN',
     E'ELSIF NEW.event_type = ''rebook_priority_claim_invite'' THEN\n'
     '      SELECT v.guest_player_id, v.player_id INTO v_ins_guest, v_ins_profile\n'
     '        FROM public.d7_p_invite_recipient_snapshot(\n'
     '               NEW.tenant_academy_profile_id, NEW.related_slot_priority_claim_id) v;\n'
     '      IF NOT FOUND THEN\n'
     '        RAISE EXCEPTION ''notification_outbox: priority claim % is not a claim of academy %'',\n'
     '          NEW.related_slot_priority_claim_id, NEW.tenant_academy_profile_id USING ERRCODE = ''42501'';\n'
     '      END IF;\n'
     '      IF NEW.recipient_person_id IS NOT NULL THEN\n'
     '        RAISE EXCEPTION ''notification_outbox: a priority claim invitation may not carry a person id (claim %)'',\n'
     '          NEW.related_slot_priority_claim_id USING ERRCODE = ''42501'';\n'
     '      END IF;\n'
     '      IF v_ins_guest IS NOT NULL THEN\n'
     '        IF NEW.recipient_guest_player_id IS DISTINCT FROM v_ins_guest THEN\n'
     '          RAISE EXCEPTION ''notification_outbox: invitation for guest claim % carries guest %'',\n'
     '            NEW.related_slot_priority_claim_id,\n'
     '            coalesce(NEW.recipient_guest_player_id::text, ''<null>'') USING ERRCODE = ''42501'';\n'
     '        END IF;\n'
     '        IF NEW.recipient_user_id IS NOT NULL THEN\n'
     '          RAISE EXCEPTION ''notification_outbox: invitation for guest claim % also carries account % — a guest invitation carries the guest UUID only'',\n'
     '            NEW.related_slot_priority_claim_id, NEW.recipient_user_id USING ERRCODE = ''42501'';\n'
     '        END IF;\n'
     '      ELSE\n'
     '        IF NEW.recipient_guest_player_id IS NOT NULL THEN\n'
     '          RAISE EXCEPTION ''notification_outbox: invitation for profile claim % carries a guest recipient'',\n'
     '            NEW.related_slot_priority_claim_id USING ERRCODE = ''42501'';\n'
     '        END IF;\n'
     '        SELECT pr.user_id INTO v_user FROM public.profiles pr WHERE pr.id = v_ins_profile;\n'
     '        IF v_user IS NULL OR NEW.recipient_user_id IS DISTINCT FROM v_user THEN\n'
     '          RAISE EXCEPTION ''notification_outbox: invitation for profile claim % does not carry that profile''''s own account'',\n'
     '            NEW.related_slot_priority_claim_id USING ERRCODE = ''42501'';\n'
     '        END IF;\n'
     '      END IF;\n'
     '    ELSIF NEW.related_slot_priority_claim_id IS NOT NULL THEN\n'
     '      RAISE EXCEPTION ''notification_outbox: only rebook_priority_claim_invite may reference a priority claim (event %)'', NEW.event_type\n'
     '        USING ERRCODE = ''42501'';\n'
     '    ELSIF NEW.related_rebook_round_recipient_id IS NOT NULL THEN',
     '1']
  ];
BEGIN
  IF to_regclass('public.rebook_rounds') IS NULL
     OR to_regprocedure('public.rebook_round_protected_event_types()') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'transport_state'
                       AND a.attnum > 0 AND NOT a.attisdropped)
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                     WHERE a.attrelid = to_regclass('public.notification_outbox')
                       AND a.attname = 'related_slot_priority_claim_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) THEN
    RAISE NOTICE 'D7 guard split: prerequisites absent — skipping';
    RETURN;
  END IF;

  IF to_regprocedure(v_ident) IS NULL THEN
    RAISE EXCEPTION 'D7 guard split: % is not installed', v_ident;
  END IF;

  FOR v_i IN 1 .. array_length(c_subs, 1) LOOP
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_subs[v_i][1], ''))) / length(c_subs[v_i][1]);
    IF v_hits <> c_subs[v_i][3]::int THEN
      RAISE EXCEPTION 'D7 guard split: the guard carries % occurrence(s) of a substitution expected exactly % time(s): %',
        v_hits, c_subs[v_i][3], left(c_subs[v_i][1], 70);
    END IF;
    EXECUTE replace(v_src, c_subs[v_i][1], c_subs[v_i][2]);
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(v_ident)) INTO v_src;
    IF position(c_subs[v_i][2] IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 guard split: the guard did not take substitution %', left(c_subs[v_i][2], 70);
    END IF;
  END LOOP;

  -- ── PROVED FROM THE CATALOG ────────────────────────────────────────────────────────────────
  --
  -- The member-open INSERT validation must SURVIVE. A substitution that widened the INSERT arm by
  -- accident would leave an invitation being validated as a snapshot member — the exact failure an
  -- earlier draft of this batch produced ("names snapshot recipient <NULL> which does not exist"),
  -- and the reason the guard was pulled out of the transport widening in the first place.
  IF position('abc27_a_validate_member_open_insert' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 guard split: the member-open INSERT validation was lost';
  END IF;
  IF position(E'IF NEW.event_type = ''rebook_member_open_player'' THEN' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 guard split: the member-open INSERT branch is no longer member-open scoped';
  END IF;
  -- And the invitation's own branch resolves the claim through the tenant-fenced bridge. Without
  -- this, the substitution above could be reverted to the shape-only version and everything else
  -- here would still pass.
  IF position('d7_p_invite_recipient_snapshot' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 guard split: the invitation INSERT branch does not resolve its claim';
  END IF;
  -- And no bare member-open UPDATE/DELETE gate may remain: three were widened, and if a fourth ever
  -- appears upstream this refuses rather than leaving it silently enforcing nothing for invitations.
  IF position(E'IF OLD.event_type = ''rebook_member_open_player''' IN v_src) > 0 THEN
    RAISE EXCEPTION 'D7 guard split: a bare member-open OLD.event_type gate survives — an invitation would bypass it';
  END IF;

  RAISE NOTICE 'D7: the outbox guard now enforces transport for every protected subject';
END $d7_guard_split$;
