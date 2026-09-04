-- D7 RUNTIME — REVIEW ROUND 2 CORRECTIONS: THE CLAIM AT DISPATCH, AND A HOLD THAT HOLDS.
--
-- ── P1 · DISPATCH RE-READ THE CLAIM'S STATUS AND NOT ITS IDENTITY ───────────────────────────
--
-- `20261203310000` gave an invitation an eligibility answer — is the claim still pending — and
-- stopped there. A claim's `player_id` / `guest_player_id` are mutable by the slot owner while its
-- status stays `pending`, so this was reachable:
--
--   1. claim C is pending for Alice; the sender freezes bytes addressed to Alice carrying claim
--      token T;
--   2. the slot owner repoints C at Bob, still pending;
--   3. resolve and begin both see `still_pending = true` and authorize;
--   4. the worker POSTs the frozen bytes — Bob's claim token, delivered to Alice.
--
-- The token is a bearer credential. This is the identity invariant the INSERT guard proves at
-- enqueue and nothing re-proved at dispatch, which is the only moment that matters, because the
-- linearization point is where every other fact is re-read.
--
-- Both the resolver and `begin_dispatch` now require the claim's CURRENT routing identity to be the
-- one the frozen bytes were built for: the same guest (or the same absence of one) and the same
-- destination address. A claim that moved to another person routes somewhere else and is refused.
--
-- ── P1 · "NO CAPTURE HERE" IS NOT "NO CAPTURE ANYWHERE" ─────────────────────────────────────
--
-- `abc27_a_resolve_invite_round` filtered provenance by claim AND academy, so a claim captured by
-- academy B's round looked UNCAPTURED to academy A — and A's fallback then accepted any round of A's
-- own. The source table deliberately has no live claim FK, so that provenance survives a claim being
-- moved between academies. Provenance is now read for the CLAIM, and a capture belonging to another
-- academy is a refusal rather than an absence.
--
-- ── P2 · A HOLD THAT WROTE NOTHING WAS NOT A HOLD ───────────────────────────────────────────
--
-- The early branch returned `held` and wrote nothing, so the row stayed `leased`. The worker returns
-- on any non-proceed disposition assuming durable state exists; the janitor later restored the row
-- to its exact claimable origin, and it could be claimed, held and recovered forever — consuming a
-- lease in every batch. `held` now moves the row to `configuration_hold` through the same
-- authorize-and-present machinery every other transition uses, so it leaves the claimable set and
-- stays where an operator can see it.

DO $d7_invite_identity$
DECLARE
  v_src   text;
  v_new   text;
  v_i     int;
  v_hits  int;
  v_n     name;
  v_a     name;
  c_subs CONSTANT text[][] := ARRAY[
    -- `begin_dispatch` needs the two identity columns in scope to compare them.
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     E'         o.canonical_request_bytes, o.provider_idempotency_key',
     E'         o.canonical_request_bytes, o.provider_idempotency_key,\n'
     '         o.destination_normalized AS dest, o.recipient_guest_player_id AS guest_id',
     '1'],
    -- THE LINEARIZATION POINT RE-READS IDENTITY, not just status. `still_pending` alone authorized a
    -- send to whoever the row was addressed to when it was frozen, however the claim had moved since.
    ['public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
     E'                   ELSE (SELECT b.still_pending FROM public.d7_p_invite_contact(r.academy, r.member_id) b)',
     E'                   ELSE (SELECT b.still_pending\n'
     '                                AND b.guest_player_id IS NOT DISTINCT FROM r.guest_id\n'
     '                                AND b.destination     IS NOT DISTINCT FROM r.dest\n'
     '                           FROM public.d7_p_invite_contact(r.academy, r.member_id) b)',
     '1'],
    -- The resolver's branch: the same test, and a hold that is written down.
    ['public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
     E'    IF coalesce((SELECT b.still_pending FROM public.d7_p_invite_contact(r.academy, r.claim_id) b), false) THEN\n'
     '      RETURN QUERY SELECT ''proceed''::text, NULL::text, NULL::timestamptz, NULL::text;\n'
     '    ELSE\n'
     '      RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, ''claim_no_longer_pending''::text;\n'
     '    END IF;',
     E'    IF coalesce((SELECT b.still_pending\n'
     '                        AND b.guest_player_id IS NOT DISTINCT FROM r.recipient_guest_player_id\n'
     '                        AND b.destination     IS NOT DISTINCT FROM r.dest\n'
     '                   FROM public.d7_p_invite_contact(r.academy, r.claim_id) b), false) THEN\n'
     '      RETURN QUERY SELECT ''proceed''::text, NULL::text, NULL::timestamptz, NULL::text;\n'
     '    ELSE\n'
     '      SELECT a.operation_id, a.grant_id INTO v_op, v_grant\n'
     '        FROM public.abc27_a_authorize_transition(\n'
     '               ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
     '               r.id, ''pre_dispatch_defer'', ''leased'', ''configuration_hold'') a;\n'
     '      UPDATE public.notification_outbox o\n'
     '         SET transport_state              = ''configuration_hold'',\n'
     '             transport_transition_action  = ''pre_dispatch_defer'',\n'
     '             transport_transition_grant_id = v_grant,\n'
     '             updated_at                   = now()\n'
     '       WHERE o.id = r.id;\n'
     '      RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, ''claim_no_longer_invitable''::text;\n'
     '    END IF;',
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
    RAISE NOTICE 'D7 invite identity: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.abc27_a_resolve_invite_round(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 invite identity: the batch this file corrects is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_a FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='rebook_round_recipient_claim_sources';

  -- ══ PROVENANCE IS READ FOR THE CLAIM, NOT FOR THE CLAIM IN THIS ACADEMY ══════════════════
  EXECUTE $rr$
    CREATE OR REPLACE FUNCTION public.abc27_a_resolve_invite_round(
      p_academy uuid, p_claim uuid, p_round uuid)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $rb$
      WITH d AS (
        SELECT s.rebook_round_id AS rid, s.academy_profile_id AS aid
          FROM public.rebook_round_recipient_claim_sources s
         WHERE s.source_claim_id = p_claim
         ORDER BY s.captured_at DESC
         LIMIT 1)
      SELECT CASE
               -- CAPTURED BY SOMEONE ELSE. Reading provenance per academy made this look like an
               -- absence, and the fallback below then handed the claim to a round of the asking
               -- academy. A capture that is not ours is a refusal.
               WHEN (SELECT aid FROM d) IS NOT NULL AND (SELECT aid FROM d) <> p_academy THEN NULL
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

  FOR v_i IN 1 .. array_length(c_subs, 1) LOOP
    IF to_regprocedure(c_subs[v_i][1]) IS NULL THEN
      RAISE EXCEPTION 'D7 invite identity: % is not installed', c_subs[v_i][1];
    END IF;
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(c_subs[v_i][1])) INTO v_src;
    v_hits := (length(v_src) - length(replace(v_src, c_subs[v_i][2], ''))) / length(c_subs[v_i][2]);
    IF v_hits <> c_subs[v_i][4]::int THEN
      RAISE EXCEPTION 'D7 invite identity: % carries % occurrence(s) of a substitution expected exactly % time(s): %',
        c_subs[v_i][1], v_hits, c_subs[v_i][4], left(c_subs[v_i][2], 70);
    END IF;
    EXECUTE replace(v_src, c_subs[v_i][2], c_subs[v_i][3]);
    SELECT pg_catalog.pg_get_functiondef(to_regprocedure(c_subs[v_i][1])) INTO v_src;
    IF position(c_subs[v_i][3] IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 invite identity: % did not take substitution %', c_subs[v_i][1], left(c_subs[v_i][3], 70);
    END IF;
  END LOOP;

  -- PROVED FROM THE CATALOG: both re-reads compare identity, and the hold is written down.
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  IF position('b.destination     IS NOT DISTINCT FROM r.dest' IN v_src) = 0
     OR position(E'transport_state              = ''configuration_hold''' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite identity: the resolver does not re-read identity or does not durably hold';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  IF position('b.destination     IS NOT DISTINCT FROM r.dest' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite identity: begin_dispatch does not re-read identity';
  END IF;

  RAISE NOTICE 'D7: an invitation is re-proved against its claim at the linearization point';
END $d7_invite_identity$;
