-- D7 RUNTIME — ONE TYPED VERDICT, ASKED BY EVERY DECISION POINT.
--
-- OWNER DECISION: `ONE_SEALED_P_OWNED_OFFER_CONTRACT_PLUS_ONE_N_OWNED_TYPED_VERDICT_USED_BY_
-- ENQUEUE_RESOLVE_BEGIN_AND_RECOVERY`, `DEFER_RULE=NO_DEFERRAL_OR_RECOVERY_MAY_RELEASE_AT_OR_AFTER_
-- THE_CUTOFF_IT_CANCELS_INSTEAD`, `DEADLINE=INVITATION_CUTOFF_IS_LEAST_OF_SLOT_PRIORITY_WINDOW_AND_
-- ROUND_MEMBER_WINDOW`.
--
-- ── WHY ONE FUNCTION ────────────────────────────────────────────────────────────────────────
--
-- The checks used to be re-implemented at three call sites. That is why round 3's operational gates
-- reached only the resolver, round 4's round check reached only the resolver, and round 4's cutoff
-- guard reached only the quiet-hours branch of one of them. Three copies means three chances to fix
-- two of them.
--
-- There is now ONE decision. `pre_dispatch_resolve`, `begin_dispatch` and `recover_expired_leases`
-- all ask it and translate the answer into their own vocabulary. A future gate is added here, once.
--
-- ── FROZEN VERSUS CURRENT ───────────────────────────────────────────────────────────────────
--
-- A FROZEN fact is something the message PROMISES. If it changed, the sentence in the recipient's
-- inbox is no longer true, and deferring would only delay a lie — so the invitation is CANCELLED.
-- The whole set is one digest, computed by `d7_p_invite_offer`, so no future fact can be forgotten
-- at this layer: it either enters the digest or it is not part of the offer.
--
-- A CURRENT gate is a condition of sending NOW. Transient ones DEFER; terminal ones CANCEL.
--
-- ── THE CUTOFF IS THE INVITATION'S OWN ─────────────────────────────────────────────────────
--
-- `least(slot.priority_window_ends_at, round.member_window_ends_at)`. `least` ignores NULLs, which is
-- exactly right: either bound alone still binds.
--
-- The email states the PRIORITY deadline, and `respond_to_priority_claim` refuses after it and marks
-- the claim expired. Dispatch used the MEMBER window, which can be days later — so an invitation
-- could be sent that was already dead on arrival. And no release instant may land at or after the
-- cutoff: a deferral past it produced a row that became claimable, resolved, was refused
-- `window_invalid`, was recovered to a schedule already in the past, and went round forever.

DO $d7_verdict$
DECLARE
  v_n    name;
  v_src  text;
  v_new  text;
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
    RAISE NOTICE 'D7 verdict: prerequisites absent — skipping';
    RETURN;
  END IF;
  IF to_regprocedure('public.d7_p_invite_offer(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'D7 verdict: the offer contract is not installed';
  END IF;

  SELECT c.relowner::regrole::name INTO v_n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname='public' AND c.relname='notification_outbox';

  EXECUTE $verdict$
    CREATE OR REPLACE FUNCTION public.rebook_priority_claim_invite_verdict(p_outbox uuid)
    RETURNS TABLE (verdict text, reason text, defer_until timestamptz, cutoff_at timestamptz)
    LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
    AS $vb$
    DECLARE
      o        record;
      f        record;
      v_now    timestamptz := clock_timestamp();
      v_win    timestamptz;
      v_cutoff timestamptz;
      v_until  timestamptz;
    BEGIN
      SELECT x.id, x.tenant_academy_profile_id AS academy, x.tenant_trainer_id AS trainer,
             x.related_rebook_round_id AS round_id, x.related_slot_priority_claim_id AS claim_id,
             x.destination_normalized AS dest, x.payload
        INTO o
        FROM public.notification_outbox x
       WHERE x.id = p_outbox
         AND x.event_type = 'rebook_priority_claim_invite';
      IF NOT FOUND THEN
        RETURN QUERY SELECT 'cancel'::text, 'not_an_invitation'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      SELECT * INTO f FROM public.d7_p_invite_offer(o.academy, o.claim_id);
      -- Absent OR another tenant's: the contract is fenced by academy, so a foreign claim simply is
      -- not there. The refusal is relational rather than an assumption about the UUID.
      IF NOT FOUND THEN
        RETURN QUERY SELECT 'cancel'::text, 'claim_absent_or_foreign'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      -- ── THE FROZEN OFFER, WHOLE ──────────────────────────────────────────────────────────
      IF f.offer_digest IS DISTINCT FROM (o.payload ->> 'd7_offer_digest') THEN
        RETURN QUERY SELECT 'cancel'::text, 'offer_changed'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      -- ── CURRENT GATES ────────────────────────────────────────────────────────────────────
      IF NOT f.still_pending THEN
        RETURN QUERY SELECT 'cancel'::text, 'claim_answered'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;
      -- The capture records WHICH SLOT it was for. If the claim has moved, the round this row is
      -- attributed to and the session its token acts on are no longer the same thing.
      IF f.capture_slot_id IS DISTINCT FROM f.slot_id THEN
        RETURN QUERY SELECT 'cancel'::text, 'placement_incoherent'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;
      IF public.abc27_a_resolve_invite_round(o.academy, o.claim_id, o.round_id) IS DISTINCT FROM o.round_id THEN
        RETURN QUERY SELECT 'cancel'::text, 'round_moved'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;
      -- ── THE CYCLE MUST STILL BE OPEN ────────────────────────────────────────────────────
      --
      -- REVIEW ROUND 4. `cycles.status` was in neither the offer nor the gates, and it is not one
      -- of the offer's TERMS — closing a cycle does not change what the message said. But it
      -- changes whether the message may still be ACTED on: every one of the eighteen sealed facts
      -- stayed put across `open -> closed -> archived`, so the worker went on sending an actionable
      -- bearer invitation into a round the manager had closed, and the accept — which does not
      -- check the status either — booked the player into it.
      -- KEYED ON THE SESSION'S CYCLE ID, not on the status being non-null. A session that carries a
      -- `cyclus_id` whose `cycles` row does not exist reports status NULL, and testing the status
      -- alone let that case through — an actionable bearer link for a cycle whose lifecycle cannot
      -- be established at all. Those rows are expressly possible: the FK was installed `NOT VALID`
      -- and historical orphans were left for owner-run repair (`20260630120000`). A session with NO
      -- cycle is a different, legitimate shape and stays sendable (review round 5).
      IF f.cyclus_id IS NOT NULL AND f.cycle_status IS DISTINCT FROM 'open' THEN
        RETURN QUERY SELECT 'cancel'::text, 'cycle_not_open'::text,
                            NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      IF public.is_email_suppressed(o.dest) THEN
        RETURN QUERY SELECT 'cancel'::text, 'address_suppressed'::text, NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      SELECT s.member_window_ends_at INTO v_win FROM public.abc27_a_round_state(o.round_id) s;
      v_cutoff := least(f.priority_window_ends_at, v_win);

      -- ── A ROW THAT CAN NEVER DISPATCH IS NOT SENDABLE ───────────────────────────────────
      --
      -- REVIEW ROUND 3. With NEITHER a slot cutoff NOR a member window, `least` is NULL and this
      -- used to answer `send` — while `begin_dispatch` refuses a null or infinite window outright.
      -- The row was then leased, judged sendable, refused `window_invalid`, recovered (the janitor
      -- asking this same verdict and hearing `send` again), and leased once more: an invitation
      -- that can never go out, burning a lease in every batch, forever.
      --
      -- Calling it what it is stops the loop and puts it in front of a person. ABC-27's refusal to
      -- dispatch without a finite deadline is the frozen contract; this agrees with it rather than
      -- arguing with it.
      IF v_cutoff IS NULL OR v_cutoff = 'infinity'::timestamptz THEN
        RETURN QUERY SELECT 'cancel'::text, 'no_effective_deadline'::text,
                            NULL::timestamptz, NULL::timestamptz; RETURN;
      END IF;

      IF v_cutoff IS NOT NULL AND v_now >= v_cutoff THEN
        RETURN QUERY SELECT 'cancel'::text, 'deadline_passed'::text, NULL::timestamptz, v_cutoff; RETURN;
      END IF;

      IF public.is_notification_channel_killed('email') THEN
        v_until := v_now + interval '15 minutes';
        IF v_cutoff IS NOT NULL AND v_until >= v_cutoff THEN
          RETURN QUERY SELECT 'cancel'::text, 'deadline_conflict'::text, NULL::timestamptz, v_cutoff; RETURN;
        END IF;
        RETURN QUERY SELECT 'defer'::text, 'channel_kill_deferred'::text, v_until, v_cutoff; RETURN;
      END IF;

      v_until := public.notif_digest_quiet_hours_bump(
                   v_now, public.notif_digest_recipient_timezone(o.academy, o.trainer));
      IF v_until > v_now THEN
        IF v_cutoff IS NOT NULL AND v_until >= v_cutoff THEN
          RETURN QUERY SELECT 'cancel'::text, 'deadline_conflict'::text, NULL::timestamptz, v_cutoff; RETURN;
        END IF;
        RETURN QUERY SELECT 'defer'::text, 'quiet_hours_deferred'::text, v_until, v_cutoff; RETURN;
      END IF;

      RETURN QUERY SELECT 'send'::text, NULL::text, NULL::timestamptz, v_cutoff;
    END;
    $vb$
  $verdict$;
  EXECUTE format('ALTER FUNCTION public.rebook_priority_claim_invite_verdict(uuid) OWNER TO %I', v_n);
  -- The same negative space every D7 writer occupies. A verdict is not an entrypoint.
  EXECUTE 'REVOKE ALL ON FUNCTION public.rebook_priority_claim_invite_verdict(uuid) FROM PUBLIC, anon, authenticated, service_role';

  -- ══ THE RESOLVER ASKS, AND TRANSLATES ════════════════════════════════════════════════════
  --
  -- Its whole invitation branch is replaced by span: the branch has been rewritten three times, so
  -- matching its middle would pin this file to the exact text of the previous three corrections.
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  DECLARE
    v_i int := position(E'  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n' IN v_src);
    v_j int;
    c_end CONSTANT text := E'    RETURN;\n  END IF;\n';
  BEGIN
    IF v_i = 0 THEN RAISE EXCEPTION 'D7 verdict: the resolver has no invitation branch'; END IF;
    v_j := position(c_end IN substr(v_src, v_i));
    IF v_j = 0 THEN RAISE EXCEPTION 'D7 verdict: the invitation branch has no recognisable end'; END IF;
    v_new := substr(v_src, 1, v_i - 1)
      || E'  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n'
         '    DECLARE\n'
         '      d record;\n'
         '    BEGIN\n'
         '      SELECT * INTO d FROM public.rebook_priority_claim_invite_verdict(r.id);\n'
         '      IF d.verdict = ''send'' THEN\n'
         '        RETURN QUERY SELECT ''proceed''::text, NULL::text, NULL::timestamptz, NULL::text;\n'
         '        RETURN;\n'
         '      END IF;\n'
         '      SELECT a.grant_id INTO v_grant\n'
         '        FROM public.abc27_a_authorize_transition(\n'
         '               ''pre_dispatch_terminal'', r.academy, r.round_id, r.claim_id, ''priority_claim'',\n'
         '               r.id, ''pre_dispatch_defer'', ''leased'',\n'
         '               CASE WHEN d.verdict = ''defer'' THEN d.reason ELSE ''configuration_hold'' END) a;\n'
         '      UPDATE public.notification_outbox o\n'
         '         SET transport_state = CASE WHEN d.verdict = ''defer'' THEN d.reason ELSE ''configuration_hold'' END,\n'
         '             locked_by       = NULL,\n'
         '             locked_at       = NULL,\n'
         '             scheduled_for   = coalesce(d.defer_until, o.scheduled_for),\n'
         '             transport_transition_action   = ''pre_dispatch_defer'',\n'
         '             transport_transition_grant_id = v_grant,\n'
         '             updated_at      = now()\n'
         '       WHERE o.id = r.id;\n'
         '      IF d.verdict = ''defer'' THEN\n'
         '        RETURN QUERY SELECT ''deferred''::text, NULL::text, d.defer_until, NULL::text;\n'
         '      ELSE\n'
         '        RETURN QUERY SELECT ''held''::text, NULL::text, NULL::timestamptz, d.reason;\n'
         '      END IF;\n'
         '    END;\n'
         '    RETURN;\n  END IF;\n'
      || substr(v_src, v_i + v_j - 1 + length(c_end));
    EXECUTE v_new;
  END;

  -- ══ begin_dispatch ASKS THE SAME QUESTION ════════════════════════════════════════════════
  -- ══ THE FENCE JUDGES THE INVITATION'S OWN DEADLINE ══════════════════════════════════════
  --
  -- REVIEW ROUND 2, two findings in one place. `begin_dispatch` fences on `v_window` — the ROUND's
  -- member window, read through the A bridge — sampled once and re-checked after the eligibility
  -- read. For an invitation that is the wrong bound in BOTH directions:
  --
  --   · the player's own `priority_window_ends_at` is never fenced there, so a dispatch beginning
  --     just before the slot deadline could authorize the provider request just after it; and
  --   · a round whose member window is NULL or `infinity` is refused outright BEFORE the verdict is
  --     consulted, so an invitation with a perfectly good finite slot cutoff could never begin —
  --     the resolver and the janitor would keep calling it sendable forever.
  --
  -- So for the invitation domain the fence takes the cutoff the VERDICT judged against, which is
  -- `least(priority_window_ends_at, member_window)` and therefore never later than the round's own.
  -- `coalesce` keeps the member window when the verdict has no cutoff to offer (its early cancel
  -- arms), where the eligibility arm below refuses anyway.
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  --
  -- ONE CALL, ONE ANSWER. Review round 3: asking the verdict twice — once for the fence and once
  -- for the eligibility — takes two READ COMMITTED snapshots with no product lock between them, so
  -- a transient cancel in the first (whose cancel arms carry no cutoff, leaving the fence on the
  -- member window) could clear before the second answered `send`. The row would then be armed with
  -- a fence judged against the wrong bound. The answer is read ONCE into a record and both the
  -- fence and the eligibility use that one value.
  -- TWO SCALARS, not a record: plpgsql refuses to read a field of a not-yet-assigned record even
  -- on a branch it will not take, and the member-open arm of the eligibility CASE shares the
  -- expression. Scalars simply start NULL.
  v_new := replace(v_src, E'    v_after      timestamptz;',
                          E'    v_after      timestamptz;\n'
                          '    v_d_verdict  text;\n'
                          '    v_d_cutoff   timestamptz;');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 verdict: begin_dispatch has no place to hold one verdict'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'    v_sampled_now := clock_timestamp();\n',
    E'    v_sampled_now := clock_timestamp();\n'
    '    IF r.subject_domain = ''priority_claim'' THEN\n'
    '      SELECT d.verdict, d.cutoff_at INTO v_d_verdict, v_d_cutoff\n'
    '        FROM public.rebook_priority_claim_invite_verdict(r.id) d;\n'
    '      v_window := coalesce(v_d_cutoff, v_window);\n'
    '    END IF;\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 verdict: begin_dispatch has no single sampled clock to fence on'; END IF;
  EXECUTE v_new;

  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)')) INTO v_src;
  DECLARE
    v_i int := position(E'                   ELSE (SELECT b.still_pending' IN v_src);
    v_j int;
  BEGIN
    IF v_i = 0 THEN RAISE EXCEPTION 'D7 verdict: begin_dispatch has no invitation eligibility arm'; END IF;
    v_j := position(E'              END;' IN substr(v_src, v_i));
    IF v_j = 0 THEN RAISE EXCEPTION 'D7 verdict: begin_dispatch eligibility has no recognisable end'; END IF;
    v_new := substr(v_src, 1, v_i - 1)
      || E'                   ELSE v_d_verdict = ''send''\n'
         '              END;'
      || substr(v_src, v_i + v_j - 1 + length(E'              END;'));
    EXECUTE v_new;
  END;

  -- ══ RECOVERY MAY NOT RESTORE A ROW THE VERDICT WOULD CANCEL ══════════════════════════════
  --
  -- Recovery restores a leased row to `leased_from_state`, and that set includes both deferred
  -- states. A row whose cutoff has since passed was therefore restored to a schedule already in the
  -- past and became claimable immediately — the second half of the deferral loop, which round 4's
  -- correction did not reach because it only touched the resolver.
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_recover_expired_leases(int,int)')) INTO v_src;
  v_new := replace(v_src,
    E'         o.dispatch_authorized_generation\n',
    E'         o.dispatch_authorized_generation, o.event_type\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 verdict: the recovery select did not match'; END IF;
  v_src := v_new;
  v_new := replace(v_src,
    E'      v_to := r.leased_from_state;\n',
    E'      v_to := r.leased_from_state;\n'
    '      IF r.event_type = ''rebook_priority_claim_invite''\n'
    '         AND (SELECT d.verdict FROM public.rebook_priority_claim_invite_verdict(r.id) d) = ''cancel'' THEN\n'
    '        v_to := ''configuration_hold'';\n'
    '      END IF;\n');
  IF v_new = v_src THEN RAISE EXCEPTION 'D7 verdict: the recovery restore did not match'; END IF;
  EXECUTE v_new;

  -- ══ PROVED FROM THE CATALOG ══════════════════════════════════════════════════════════════
  --
  -- All three sites consult the ONE authority, and none of them still carries its own copy of the
  -- gates. The absence assertions are the point: a surviving inline check is a fourth opinion.
  FOREACH v_src IN ARRAY ARRAY[
    'public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)',
    'public.rebook_member_open_begin_dispatch(uuid,text,int,bytea,text,text,text)',
    'public.rebook_member_open_recover_expired_leases(int,int)'
  ] LOOP
    IF position('rebook_priority_claim_invite_verdict' IN
                pg_catalog.pg_get_functiondef(to_regprocedure(v_src))) = 0 THEN
      RAISE EXCEPTION 'D7 verdict: % does not consult the verdict authority', v_src;
    END IF;
  END LOOP;
  SELECT pg_catalog.pg_get_functiondef(
           to_regprocedure('public.rebook_member_open_pre_dispatch_resolve(uuid,text,int)')) INTO v_src;
  -- The invitation branch must no longer answer ANY of these for itself. `d7_p_invite_contact` was
  -- its pending re-read and `is_email_suppressed` its address check; both now live in the verdict,
  -- and a surviving copy inside the branch is a second opinion that can disagree with the one the
  -- send is actually made under.
  --
  -- Scoped to the BRANCH, not the function. The member-open contact loop below it resolves an
  -- address by walking notification contacts and skipping suppressed ones — that is member-open
  -- policy and it must SURVIVE, so a whole-body absence check here would be false and a whole-body
  -- presence check would be satisfied by the wrong occurrence. Both halves are asserted.
  DECLARE
    v_bi   int := position(E'  IF r.event_type = ''rebook_priority_claim_invite'' THEN\n' IN v_src);
    v_bj   int;
    v_body text;
  BEGIN
    IF v_bi = 0 THEN RAISE EXCEPTION 'D7 verdict: the resolver lost its invitation branch'; END IF;
    v_bj := position(E'    RETURN;\n  END IF;\n' IN substr(v_src, v_bi));
    IF v_bj = 0 THEN RAISE EXCEPTION 'D7 verdict: the invitation branch has no end to bound'; END IF;
    v_body := substr(v_src, v_bi, v_bj);
    IF position('d7_p_invite_contact' IN v_body) > 0 THEN
      RAISE EXCEPTION 'D7 verdict: the invitation branch still re-reads the claim for itself';
    END IF;
    IF position('is_email_suppressed' IN v_body) > 0 THEN
      RAISE EXCEPTION 'D7 verdict: the invitation branch still carries its own suppression check';
    END IF;
    IF position('is_notification_channel_killed' IN v_body) > 0 THEN
      RAISE EXCEPTION 'D7 verdict: the invitation branch still carries its own channel-kill check';
    END IF;
    IF position('rebook_priority_claim_invite_verdict' IN v_body) = 0 THEN
      RAISE EXCEPTION 'D7 verdict: the invitation branch does not ask the verdict authority';
    END IF;
    -- ...and member-open's own address and channel policy, which lives AFTER the branch, survives.
    v_body := substr(v_src, v_bi + v_bj);
    IF position('is_email_suppressed' IN v_body) = 0
       OR position('is_notification_channel_killed' IN v_body) = 0 THEN
      RAISE EXCEPTION 'D7 verdict: the member-open address or channel policy was lost';
    END IF;
  END;
  IF position('b_fp IS DISTINCT FROM' IN v_src) > 0 THEN
    RAISE EXCEPTION 'D7 verdict: the resolver still carries its own inline offer comparison';
  END IF;
  IF position('abc27_a_member_snapshot' IN v_src) = 0 THEN
    RAISE EXCEPTION 'D7 verdict: the resolver lost its member-open policy';
  END IF;

  RAISE NOTICE 'D7: one verdict, asked by resolve, begin and recovery';
END $d7_verdict$;
