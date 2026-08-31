-- D7 RUNTIME — REVIEW ROUND 4 CORRECTIONS: THE OFFER, THE RACE, AND THE COUNTING.
--
-- ── P1 · `begin_dispatch` DID NOT RE-RESOLVE THE ROUND ──────────────────────────────────────
--
-- Round 3 taught the resolver to re-check which round a claim belongs to and did not teach
-- `begin_dispatch` the same. Resolve and begin are SEPARATE RPCs, so between them the claim could be
-- captured by a newer same-academy round while person, address, guest and slot all stayed put — and
-- begin would then authorize the stale round's invitation. That is precisely the race the
-- linearization point exists to close.
--
-- Both now ask the resolver about the row's OWN round, which also fixes a false refusal: dispatch
-- was calling it with `p_round = NULL`, so a claim with no capture record — legitimately enqueued
-- against a supplied same-academy round — resolved to NULL and was held every single time.
--
-- ── P1 · THE STAMPED SLOT PROVED THE CLAIM, NOT THE OFFER ───────────────────────────────────
--
-- `d7_slot_id` records which slot the claim sat on WHEN THE ENQUEUE RAN. The bytes were rendered
-- earlier, from a separate read, and they describe a session's date, time, price and deadline. Two
-- gaps followed:
--
--   the claim could move between rendering and enqueue, so the stamp agreed with the claim and the
--     bytes described a different session; and
--   the slot's own time or price could be edited after enqueue, so the id still matched and the
--     offer was stale anyway.
--
-- So the caller now states which slot it rendered from and the enqueue REFUSES if that is not the
-- claim's current slot, and the offer-bearing facts are fingerprinted at enqueue and re-compared at
-- dispatch. An invitation is only sent while it still describes the session it is offering.
--
-- ── P1 · A DEFERRAL PAST THE ROUND'S WINDOW LOOPED FOREVER ─────────────────────────────────
--
-- Quiet hours can bump past `member_window_ends_at`. The row went to `quiet_hours_deferred`, became
-- claimable when its schedule passed, resolved `proceed`, and `begin_dispatch` refused
-- `window_invalid` — leaving it leased for the janitor to restore to a schedule already in the past,
-- so it was immediately claimable again. Invitations cannot enter the member-only unresolved closer,
-- so nothing ended it. The member-open path checks this and holds; so does this one now.
--
-- ── P1 · THE CROSS-TENANT CHECK WAS CHECK-THEN-INSERT ──────────────────────────────────────
--
-- `IF EXISTS` is not serialized with the INSERT, and the real unique key is tenant-scoped, so two
-- concurrent enqueues under two academies could both pass and both commit. A transaction-scoped
-- advisory lock on the CLAIM makes the pair atomic without a new relation or constraint.
--
-- ── P2 · "SENDABLE" WAS AN ALLOW-LIST, AND IT WAS WRONG IN BOTH DIRECTIONS ─────────────────
--
-- `queued / retry_wait / needs_admission` reported everything else as unsendable — including the two
-- DEFERRED states, which are exactly the claimable ones, and `leased`, which may be mid-dispatch.
-- Inverted: only the states that genuinely need a human are not-sendable. Partitioning by complement
-- is also what stops the next state added upstream from silently defaulting to the wrong side.

DO $d7_invite_offer$
DECLARE
  v_n     name;
  v_p     name;
  v_a     name;
  v_src   text;
  v_new   text;
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
    RAISE NOTICE 'D7 invite offer: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_contact(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 invite offer: the batch this file corrects is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='cycles';
  SELECT c.relowner::regrole::name INTO v_a FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='rebook_round_recipient_claim_sources';

  -- ══ THE CLAIM LOOKUP GETS AN INDEX ═══════════════════════════════════════════════════════
  --
  -- The cross-tenant check runs once per invitation and the column had no index, so a large round
  -- against a mature outbox could scan the table N times and exhaust the edge's budget before
  -- enqueueing anything. PARTIAL, because only invitations ever carry this column.
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_notification_outbox_d7_invite_claim
             ON public.notification_outbox (related_slot_priority_claim_id)
           WHERE related_slot_priority_claim_id IS NOT NULL';

  -- ══ THE BRIDGE FINGERPRINTS THE OFFER ════════════════════════════════════════════════════
  --
  -- The facts the invitation actually promises: which session, when, and for how much. A digest is
  -- enough — dispatch only needs to know whether they still describe the same offer.
  EXECUTE 'DROP FUNCTION IF EXISTS public.d7_p_invite_contact(uuid,uuid)';
  EXECUTE $bridge$
    CREATE OR REPLACE FUNCTION public.d7_p_invite_contact(p_academy uuid, p_claim uuid)
    RETURNS TABLE (
      claim_id        uuid,
      player_id       uuid,
      guest_player_id uuid,
      account_user_id uuid,
      slot_id         uuid,
      offer_fp        text,
      destination     text,
      still_pending   boolean
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $sn$
      SELECT c.id, c.player_id, c.guest_player_id,
             CASE WHEN c.guest_player_id IS NULL
                  THEN (SELECT pr.user_id FROM public.profiles pr WHERE pr.id = c.player_id) END,
             c.slot_id,
             encode(pg_catalog.sha256(pg_catalog.convert_to(
               s.id::text || '|' || s.start_time::text || '|' || s.end_time::text
                          || '|' || coalesce(s.price_per_session::text, '') , 'UTF8')), 'hex'),
             CASE
               WHEN c.guest_player_id IS NOT NULL THEN
                 (SELECT nullif(btrim(g.email), '') FROM public.guest_players g WHERE g.id = c.guest_player_id)
               ELSE
                 (SELECT nullif(btrim(pr.email), '') FROM public.profiles pr WHERE pr.id = c.player_id)
             END,
             coalesce(c.status, 'pending') = 'pending'
        FROM public.slot_priority_claims c
        JOIN public.availability_slots s ON s.id = c.slot_id
       WHERE c.id = p_claim
         AND s.academy_profile_id = p_academy
    $sn$
  $bridge$;
  EXECUTE format('ALTER FUNCTION public.d7_p_invite_contact(uuid,uuid) OWNER TO %I', v_p);
  EXECUTE 'REVOKE ALL ON FUNCTION public.d7_p_invite_contact(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.d7_p_invite_contact(uuid,uuid) TO %I', v_n);

  -- ══ THE ROUND RESOLVER GETS A DETERMINISTIC ORDER ════════════════════════════════════════
  --
  -- `captured_at` alone can tie — its uniqueness is per (round, claim), not per instant — and a tie
  -- made the answer depend on which row the planner happened to return, so enqueue and dispatch
  -- could disagree about the same claim.
  EXECUTE $rr$
    CREATE OR REPLACE FUNCTION public.abc27_a_resolve_invite_round(
      p_academy uuid, p_claim uuid, p_round uuid)
    RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $rb$
      WITH d AS (
        SELECT s.rebook_round_id AS rid, s.academy_profile_id AS aid
          FROM public.rebook_round_recipient_claim_sources s
         WHERE s.source_claim_id = p_claim
         ORDER BY s.captured_at DESC, s.rebook_round_id DESC
         LIMIT 1)
      SELECT CASE
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

  -- ══ THE ENQUEUE: SERIALIZED, OFFER-BOUND, AND HONEST ABOUT A CONFLICT ════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) INTO v_src;

  -- The lock is taken on the CLAIM, before the existence check, so the check and the INSERT are one
  -- indivisible decision for that claim whatever tenant each caller is acting for.
  v_new := replace(v_src,
    E'      IF EXISTS (SELECT 1 FROM public.notification_outbox o\n',
    E'      PERFORM pg_catalog.pg_advisory_xact_lock(\n'
    '        pg_catalog.hashtextextended(''d7-invite:'' || p_claim::text, 0));\n'
    '      IF EXISTS (SELECT 1 FROM public.notification_outbox o\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the cross-tenant check did not match'; END IF;
  v_src := v_new;

  -- The caller states which slot it rendered from. A claim that moved between the render and the
  -- enqueue is refused rather than stamped with a slot the bytes do not describe.
  v_new := replace(v_src,
    E'      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = ''rebook_priority_claim_invite'';',
    E'      IF nullif(btrim(coalesce(p_payload->>''d7_rendered_slot_id'','''')), '''') IS NOT NULL\n'
    '         AND (p_payload->>''d7_rendered_slot_id'') IS DISTINCT FROM v_slot::text THEN\n'
    '        RAISE EXCEPTION ''rebook_priority_claim_invite_enqueue_core: claim % moved session between rendering and enqueue'', p_claim\n'
    '          USING ERRCODE = ''42501'';\n'
    '      END IF;\n'
    '      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = ''rebook_priority_claim_invite'';');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the render-slot check did not match'; END IF;
  v_src := v_new;

  -- The slot and the offer fingerprint are both stamped, both server-derived.
  v_new := replace(v_src,
    E'        v_evt.template_email, p_payload || jsonb_build_object(''d7_slot_id'', (SELECT b.slot_id FROM public.d7_p_invite_contact(p_academy, p_claim) b)),',
    E'        v_evt.template_email, p_payload || jsonb_build_object(''d7_slot_id'', v_slot::text, ''d7_offer_fp'', v_fp),');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the payload stamp did not match'; END IF;
  v_src := v_new;

  -- Both come from the ONE bridge read the function already makes.
  v_new := replace(v_src,
    E'        INTO v_claim, v_player, v_guest, v_dest, v_pending',
    E'        INTO v_claim, v_player, v_guest, v_dest, v_pending, v_slot, v_fp');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the bridge INTO list did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'      SELECT b.claim_id, b.player_id, b.guest_player_id, b.destination, b.still_pending',
    E'      SELECT b.claim_id, b.player_id, b.guest_player_id, b.destination, b.still_pending, b.slot_id, b.offer_fp');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the bridge SELECT list did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src, E'      v_state      text;', E'      v_state      text;\n      v_slot       uuid;\n      v_fp         text;');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the enqueue declare did not match'; END IF;
  v_src := v_new;

  -- NOT-SENDABLE IS THE COMPLEMENT. The allow-list called both deferred states unsendable — the two
  -- states that are precisely the claimable ones — and called a mid-dispatch `leased` row held.
  v_new := replace(v_src,
    E'                            CASE WHEN v_state IN (''queued'',''retry_wait'',''needs_admission'')\n'
    '                                 THEN ''already_enqueued'' ELSE ''existing_row_not_sendable'' END::text,',
    E'                            CASE WHEN v_state IS NULL OR v_state IN\n'
    '                                      (''configuration_hold'',''acceptance_uncertain'',''awaiting_reconciliation'')\n'
    '                                 THEN ''existing_row_not_sendable'' ELSE ''already_enqueued'' END::text,');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the conflict classification did not match'; END IF;
  EXECUTE v_new;

  -- ══ THE RESOLVER: THE OFFER, THE ROW'S OWN ROUND, AND A BUMP PAST THE WINDOW ═════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  v_new := replace(v_src,
    E'      b_pending boolean; b_dest text; b_guest uuid; b_user uuid; b_slot uuid;\n',
    E'      b_pending boolean; b_dest text; b_guest uuid; b_user uuid; b_slot uuid; b_fp text;\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the resolver declare did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'      SELECT b.still_pending, b.destination, b.guest_player_id, b.account_user_id, b.slot_id\n'
    '        INTO b_pending, b_dest, b_guest, b_user, b_slot\n',
    E'      SELECT b.still_pending, b.destination, b.guest_player_id, b.account_user_id, b.slot_id, b.offer_fp\n'
    '        INTO b_pending, b_dest, b_guest, b_user, b_slot, b_fp\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the resolver bridge read did not match'; END IF;
  v_src := v_new;
  -- The row's OWN round, not NULL: a claim with no capture record was legitimately enqueued against
  -- a supplied academy round, and asking with NULL guaranteed a hold for it every time.
  v_new := replace(v_src,
    E'         OR public.abc27_a_resolve_invite_round(r.academy, r.claim_id, NULL) IS DISTINCT FROM r.round_id\n',
    E'         OR b_fp IS DISTINCT FROM (r.payload ->> ''d7_offer_fp'')\n'
    '         OR public.abc27_a_resolve_invite_round(r.academy, r.claim_id, r.round_id) IS DISTINCT FROM r.round_id\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the resolver round check did not match'; END IF;
  v_src := v_new;
  -- A BUMP PAST THE ROUND'S WINDOW IS A HOLD, NOT A DEFERRAL. Deferring past it produced a row that
  -- became claimable, resolved `proceed`, was refused `window_invalid`, was recovered to a schedule
  -- already in the past, and went round again forever.
  v_new := replace(v_src,
    E'      IF b_bump > v_now THEN\n',
    E'      IF b_bump > v_now\n'
    '         AND b_bump >= coalesce((SELECT s.member_window_ends_at\n'
    '                                   FROM public.abc27_a_round_state(r.round_id) s), b_bump) THEN\n'
    '        SELECT a.grant_id INTO v_grant\n'
    '          FROM public.abc27_a_authorize_transition(\n'
    '                 ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
    '                 r.id, ''pre_dispatch_defer'', ''leased'', ''configuration_hold'') a;\n'
    '        UPDATE public.notification_outbox o\n'
    '           SET transport_state = ''configuration_hold'', locked_by = NULL, locked_at = NULL,\n'
    '               transport_transition_action = ''pre_dispatch_defer'',\n'
    '               transport_transition_grant_id = v_grant, updated_at = now()\n'
    '         WHERE o.id = r.id;\n'
    '        RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, ''quiet_hours_window_conflict''::text;\n'
    '        RETURN;\n'
    '      END IF;\n'
    '      IF b_bump > v_now THEN\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: the quiet-hours branch did not match'; END IF;
  EXECUTE v_new;

  -- ══ AND begin_dispatch ASKS THE SAME QUESTIONS ═══════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  v_new := replace(v_src,
    E'                                AND NOT public.is_email_suppressed(r.dest)\n',
    E'                                AND NOT public.is_email_suppressed(r.dest)\n'
    '                                AND b.offer_fp       IS NOT DISTINCT FROM (r.pl ->> ''d7_offer_fp'')\n'
    '                                AND public.abc27_a_resolve_invite_round(r.academy, r.member_id, r.round_id)\n'
    '                                    IS NOT DISTINCT FROM r.round_id\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite offer: begin_dispatch eligibility did not match'; END IF;
  EXECUTE v_new;

  -- ══ PROVED FROM THE CATALOG ══════════════════════════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  IF position('abc27_a_resolve_invite_round' IN v_src) = 0 OR position('d7_offer_fp' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite offer: begin_dispatch does not re-resolve the round or the offer';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  IF position('quiet_hours_window_conflict' IN v_src) = 0
     OR position('abc27_a_member_snapshot' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite offer: the resolver lost its window conflict or its member-open policy';
  END IF;

  RAISE NOTICE 'D7: an invitation is only sent while it still describes the offer it was frozen for';
END $d7_invite_offer$;
