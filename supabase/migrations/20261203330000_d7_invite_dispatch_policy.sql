-- D7 RUNTIME — REVIEW ROUND 3 CORRECTIONS: THE INVITATION OBEYS THE SAME OPERATIONAL POLICY.
--
-- Round 3 found four more P1s. Three are the same shape as rounds 1 and 2 — a fact re-read at the
-- linearization point that was not re-read far enough — and one is about what "once per claim"
-- actually means.
--
-- ── P1 · THE EARLY RETURN SKIPPED EVERY OPERATIONAL GATE ────────────────────────────────────
--
-- Returning `proceed` straight after the identity test meant an invitation never reached the shared
-- checks below it. So a queued invitation would send while the email channel KILL SWITCH was
-- active, would send INSIDE QUIET HOURS even though its event declares `quiet_hours_respect`, and
-- would send to an address that had been hard-bounced or complained AFTER enqueue — because
-- suppression was only ever checked at enqueue, and a durable row can wait a long time.
--
-- The branch now runs the same three gates, using the same functions and the same transport states
-- as the member-open path, and applies a deferral the same way: authorize, present, clear the lease.
--
-- ── P1 · IDENTITY MEANT TOO LITTLE ─────────────────────────────────────────────────────────
--
-- Round 2 compared the guest and the destination. Two more facts move independently of both:
--
--   THE PERSON. Profile emails are explicitly non-unique. Repointing `claim.player_id` from Alice to
--     Bob — same address, both guest ids NULL — passed. Alice then receives a bearer token that
--     `respond_to_priority_claim` books for Bob, because that function reads the LIVE claim.
--
--   THE SLOT. `claim.slot_id` is mutable under the same policy. The frozen HTML describes S1's date,
--     time, price and deadline; moving the claim to S2 in the same academy left every compared fact
--     equal, and the token then booked S2. A materially different offer from the one that was sent.
--
-- The slot has nowhere on the row to be compared against, so the enqueue now STAMPS IT — server
-- derived, from the bridge, never from the caller's payload — into the immutable payload the guard
-- already refuses to let move.
--
-- ── P1 · "ONCE PER CLAIM" WAS ONLY ONCE PER CLAIM PER TENANT ───────────────────────────────
--
-- `uq_notification_outbox_idem` is `(channel, idempotency_key, tenant_scope_key)`. A claim that
-- moves to another academy therefore gets a NEW scope key and a second row — and, past the
-- provider's own time-bounded window, a second provider send for the same claim. The enqueue now
-- refuses when ANY row exists for the claim in ANY tenant, which is the guarantee the design
-- claimed and the constraint alone cannot give.
--
-- The inverse also mattered: a later capture in a NEW round of the SAME academy collides with the
-- old row and returns `already_enqueued`, while dispatch never re-checked which round the claim now
-- belongs to — so the stale row could still send for the old round. Dispatch now re-resolves the
-- round and holds when it has moved.
--
-- ── P3 · A HOLD KEPT ITS LEASE METADATA ────────────────────────────────────────────────────
--
-- The round-2 hold left `locked_by` and `locked_at` populated, so the row claimed forever to be
-- owned by a worker that had long since finished. Every member-open transition clears both; so does
-- this one now.

DO $d7_invite_policy$
DECLARE
  v_n     name;
  v_p     name;
  v_src   text;
  v_new   text;
  v_i     int;
  v_j     int;
  v_hits  int;
  c_start CONSTANT text := E'  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n';
  c_end   CONSTANT text := E'    RETURN;\n  END IF;\n';
  c_branch CONSTANT text :=
    E'  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n'
    '    DECLARE\n'
    '      b_pending boolean; b_dest text; b_guest uuid; b_user uuid; b_slot uuid;\n'
    '      b_bump timestamptz;\n'
    '    BEGIN\n'
    '      SELECT b.still_pending, b.destination, b.guest_player_id, b.account_user_id, b.slot_id\n'
    '        INTO b_pending, b_dest, b_guest, b_user, b_slot\n'
    '        FROM public.d7_p_invite_contact(r.academy, r.claim_id) b;\n'
    '      IF NOT coalesce(b_pending, false)\n'
    '         OR b_guest IS DISTINCT FROM r.recipient_guest_player_id\n'
    '         OR b_user  IS DISTINCT FROM r.recipient_user_id\n'
    '         OR b_dest  IS DISTINCT FROM r.dest\n'
    '         OR b_slot::text IS DISTINCT FROM (r.payload ->> ''d7_slot_id'')\n'
    '         OR public.abc27_a_resolve_invite_round(r.academy, r.claim_id, NULL) IS DISTINCT FROM r.round_id\n'
    '         OR public.is_email_suppressed(r.dest) THEN\n'
    '        SELECT a.grant_id INTO v_grant\n'
    '          FROM public.abc27_a_authorize_transition(\n'
    '                 ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
    '                 r.id, ''pre_dispatch_defer'', ''leased'', ''configuration_hold'') a;\n'
    '        UPDATE public.notification_outbox o\n'
    '           SET transport_state = ''configuration_hold'',\n'
    '               locked_by       = NULL,\n'
    '               locked_at       = NULL,\n'
    '               transport_transition_action   = ''pre_dispatch_defer'',\n'
    '               transport_transition_grant_id = v_grant,\n'
    '               updated_at      = now()\n'
    '         WHERE o.id = r.id;\n'
    '        RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, ''claim_no_longer_invitable''::text;\n'
    '        RETURN;\n'
    '      END IF;\n'
    '      IF public.is_notification_channel_killed(''email'') THEN\n'
    '        b_bump := v_now + interval ''15 minutes'';\n'
    '        SELECT a.grant_id INTO v_grant\n'
    '          FROM public.abc27_a_authorize_transition(\n'
    '                 ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
    '                 r.id, ''pre_dispatch_defer'', ''leased'', ''channel_kill_deferred'') a;\n'
    '        UPDATE public.notification_outbox o\n'
    '           SET transport_state = ''channel_kill_deferred'', locked_by = NULL, locked_at = NULL,\n'
    '               scheduled_for = b_bump,\n'
    '               transport_transition_action = ''pre_dispatch_defer'',\n'
    '               transport_transition_grant_id = v_grant, updated_at = now()\n'
    '         WHERE o.id = r.id;\n'
    '        RETURN QUERY SELECT ''deferred''::text, NULL::text, b_bump, NULL::text;\n'
    '        RETURN;\n'
    '      END IF;\n'
    '      b_bump := public.notif_digest_quiet_hours_bump(\n'
    '                  v_now, public.notif_digest_recipient_timezone(r.academy, r.trainer));\n'
    '      IF b_bump > v_now THEN\n'
    '        SELECT a.grant_id INTO v_grant\n'
    '          FROM public.abc27_a_authorize_transition(\n'
    '                 ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
    '                 r.id, ''pre_dispatch_defer'', ''leased'', ''quiet_hours_deferred'') a;\n'
    '        UPDATE public.notification_outbox o\n'
    '           SET transport_state = ''quiet_hours_deferred'', locked_by = NULL, locked_at = NULL,\n'
    '               scheduled_for = b_bump,\n'
    '               transport_transition_action = ''pre_dispatch_defer'',\n'
    '               transport_transition_grant_id = v_grant, updated_at = now()\n'
    '         WHERE o.id = r.id;\n'
    '        RETURN QUERY SELECT ''deferred''::text, NULL::text, b_bump, NULL::text;\n'
    '        RETURN;\n'
    '      END IF;\n'
    '      RETURN QUERY SELECT ''proceed''::text, NULL::text, NULL::timestamptz, NULL::text;\n'
    '    END;\n'
    '    RETURN;\n  END IF;\n';
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
    RAISE NOTICE 'D7 invite policy: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_contact(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 invite policy: the batch this file corrects is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';
  SELECT c.relowner::regrole::name INTO v_p FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='cycles';

  -- ══ THE BRIDGE ANSWERS TWO MORE FACTS ════════════════════════════════════════════════════
  --
  -- The account behind the claim's profile, and the slot it currently sits on. Both move
  -- independently of the guest id and the address, and both change what an invitation MEANS.
  EXECUTE 'DROP FUNCTION IF EXISTS public.d7_p_invite_contact(uuid,uuid)';
  EXECUTE $bridge$
    CREATE OR REPLACE FUNCTION public.d7_p_invite_contact(p_academy uuid, p_claim uuid)
    RETURNS TABLE (
      claim_id        uuid,
      player_id       uuid,
      guest_player_id uuid,
      account_user_id uuid,
      slot_id         uuid,
      destination     text,
      still_pending   boolean
    ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $sn$
      SELECT c.id, c.player_id, c.guest_player_id,
             CASE WHEN c.guest_player_id IS NULL
                  THEN (SELECT pr.user_id FROM public.profiles pr WHERE pr.id = c.player_id) END,
             c.slot_id,
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

  -- ══ THE ENQUEUE: ONE ROW PER CLAIM ACROSS EVERY TENANT, AND THE SLOT IS STAMPED ══════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) INTO v_src;
  v_new := replace(v_src,
    E'      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = ''rebook_priority_claim_invite'';',
    E'      -- ONE ROW PER CLAIM, IN ANY TENANT. `uq_notification_outbox_idem` includes the generated\n'
    '      -- `tenant_scope_key`, so a claim that moves academies would otherwise get a SECOND row and,\n'
    '      -- past the provider''s own time-bounded window, a second provider send.\n'
    '      IF EXISTS (SELECT 1 FROM public.notification_outbox o\n'
    '                  WHERE o.related_slot_priority_claim_id = p_claim\n'
    '                    AND o.tenant_academy_profile_id IS DISTINCT FROM p_academy) THEN\n'
    '        RAISE EXCEPTION ''rebook_priority_claim_invite_enqueue_core: claim % is already enqueued under another tenant'', p_claim\n'
    '          USING ERRCODE = ''42501'';\n'
    '      END IF;\n'
    '      SELECT * INTO v_evt FROM public.notification_event_types WHERE key = ''rebook_priority_claim_invite'';');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: the enqueue event lookup did not match'; END IF;
  v_src := v_new;
  -- THE SLOT IS SERVER-DERIVED. It is written into the payload, which the outbox guard already makes
  -- immutable, so dispatch has an unforgeable record of the slot the bytes describe.
  v_new := replace(v_src,
    E'        v_evt.template_email, p_payload,',
    E'        v_evt.template_email, p_payload || jsonb_build_object(''d7_slot_id'', (SELECT b.slot_id FROM public.d7_p_invite_contact(p_academy, p_claim) b)),');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: the enqueue payload did not match'; END IF;
  EXECUTE v_new;

  -- ══ A CONFLICT REPORTS WHETHER THE EXISTING ROW CAN STILL BE SENT ═══════════════════════
  --
  -- `already_enqueued` conflated "an invitation is queued" with "an outbox row exists". A row that
  -- has since been HELD — because the claim's address or person changed — reports the same thing, so
  -- a manager pressing resend was told the player had already been invited while nothing could ever
  -- be queued for them again. The state is now part of the answer.
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_priority_claim_invite_enqueue_core(uuid,uuid,uuid,timestamptz,jsonb,uuid,uuid,uuid)')) INTO v_src;
  v_new := replace(v_src,
    E'        SELECT o.id INTO v_row FROM public.notification_outbox o
',
    E'        SELECT o.id, o.transport_state INTO v_row, v_state FROM public.notification_outbox o
');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: the conflict lookup did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'        RETURN QUERY SELECT v_row, ''email''::text, ''skipped''::text, ''already_enqueued''::text,',
    E'        RETURN QUERY SELECT v_row, ''email''::text, ''skipped''::text,
'
    '                            CASE WHEN v_state IN (''queued'',''retry_wait'',''needs_admission'')
'
    '                                 THEN ''already_enqueued'' ELSE ''existing_row_not_sendable'' END::text,');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: the conflict return did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src, E'      v_row        uuid;', E'      v_row        uuid;
      v_state      text;');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: the conflict declare did not match'; END IF;
  EXECUTE v_new;

  -- ══ THE RESOLVER'S BRANCH, REPLACED WHOLE ════════════════════════════════════════════════
  --
  -- Replaced by SPAN rather than by substituting inside it: the branch has been rewritten twice and
  -- matching its middle would pin this file to the exact text of the previous two corrections.
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  v_i := position(c_start IN v_src);
  IF v_i = 0 THEN RAISE EXCEPTION 'D7 invite policy: the resolver has no invitation branch to replace'; END IF;
  v_j := position(c_end IN substr(v_src, v_i));
  IF v_j = 0 THEN RAISE EXCEPTION 'D7 invite policy: the invitation branch has no recognisable end'; END IF;
  v_new := substr(v_src, 1, v_i - 1) || c_branch || substr(v_src, v_i + v_j - 1 + length(c_end));
  -- The payload has to be in scope to compare the stamped slot.
  v_new := replace(v_new,
    E'         o.event_type, o.related_slot_priority_claim_id AS claim_id,',
    E'         o.event_type, o.related_slot_priority_claim_id AS claim_id, o.payload,');
  EXECUTE v_new;

  -- ══ AND begin_dispatch RE-READS THE SAME FACTS ═══════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  v_new := replace(v_src,
    E'         o.destination_normalized AS dest, o.recipient_guest_player_id AS guest_id',
    E'         o.destination_normalized AS dest, o.recipient_guest_player_id AS guest_id,\n'
    '         o.recipient_user_id AS user_id, o.payload AS pl');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: begin_dispatch select did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'                                AND b.destination     IS NOT DISTINCT FROM r.dest\n',
    E'                                AND b.destination     IS NOT DISTINCT FROM r.dest\n'
    '                                AND b.account_user_id IS NOT DISTINCT FROM r.user_id\n'
    '                                AND b.slot_id::text   IS NOT DISTINCT FROM (r.pl ->> ''d7_slot_id'')\n'
    '                                AND NOT public.is_email_suppressed(r.dest)\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 invite policy: begin_dispatch eligibility did not match'; END IF;
  EXECUTE v_new;

  -- ══ PROVED FROM THE CATALOG ══════════════════════════════════════════════════════════════
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  FOREACH v_new IN ARRAY ARRAY[
    'is_notification_channel_killed', 'notif_digest_quiet_hours_bump', 'is_email_suppressed',
    'b.account_user_id', 'b.slot_id', 'abc27_a_resolve_invite_round',
    'abc27_a_member_snapshot'
  ] LOOP
    IF position(v_new IN v_src) = 0 THEN
      RAISE EXCEPTION 'D7 invite policy: the resolver lost %', v_new;
    END IF;
  END LOOP;
  IF position(E'locked_by       = NULL' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 invite policy: the invitation hold does not release its lease';
  END IF;

  RAISE NOTICE 'D7: an invitation now obeys the same kill, quiet-hours and suppression policy';
END $d7_invite_policy$;
