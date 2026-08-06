-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N5 ROUND 2 — the boundary at the DISPATCH door, and the proof that no group predates it.
--
-- Round 1 gated materialization (where a row enters the digest path) and the instant claim. The
-- review found what that leaves open: a digest group that ALREADY EXISTS carries its members'
-- history, and nothing re-checked it on the way to the provider. Opening the path would then
-- release any pre-existing group — pending, leased, prepared, request_ready, split, or
-- orphan-re-entered — regardless of when its members' events happened.
--
-- Two closures, because one of them only holds going forward:
--   * the CLAIM (the single door every send goes through: prepare, split, oversize-finalize and
--     the send itself all require the ownership it stamps) refuses an inert path and passes over
--     any group holding a pre-boundary member;
--   * this migration ASSERTS that no such group exists at install time, so the contract starts
--     from a state it can prove rather than from a state it hopes for.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- the install-time proof. In production this is trivially satisfied (the digest engine has never
-- been enabled, so no group has ever been formed); if it ever is not, the rows are named and a
-- human decides, because silently sending or silently dropping historical digests are both worse.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('group %s (%s, path %s: %s)', g.id, g.state, b.path, x.why), '; ')
    INTO v_bad
    FROM public.notification_digest_groups g
    JOIN public.notification_activation_boundaries b
      ON b.path = g.channel || ':digest'
    CROSS JOIN LATERAL (
      SELECT CASE
        -- an ACTIVE path: only the members that predate the recorded boundary matter
        WHEN b.state = 'active' THEN
          nullif((SELECT count(*) FROM public.notification_outbox o
                   WHERE o.digest_group_id = g.id AND o.created_at < b.boundary_at), 0)::text
          || ' member(s) predate the boundary'
        -- an INERT path: its boundary will be set LATER, so EVERY member of an existing group
        -- predates it by definition. A group here is a group that must never be dispatched, and
        -- the scan predicate alone would not catch one already carrying worker ownership.
        ELSE 'the path is inert, so every member predates the boundary it has yet to be given'
      END AS why) x
   WHERE g.terminal_at IS NULL AND x.why IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'notif N5: a non-terminal digest group can never be sent under its path''s activation boundary (a digest is delivered whole). Reconcile before deploying: %', v_bad;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.claim_notification_digest_group(
    p_run_id uuid, p_channel text, p_now timestamptz, p_worker text, p_stale_minutes int DEFAULT 15)
  RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE g record; v_iter int := 0; v_bump timestamptz; v_cb record; v_promote boolean := false; v_n int;
        v_boundary timestamptz;
BEGIN
  -- N4 M2 KILL SWITCH — FIRST. NULL is this function's own idle answer, so a killed channel
  -- reads as "no group due" and the worker ends the loop without touching the ledger. Shares
  -- the kill-set's per-channel advisory lock (no mid-claim interleave).
  IF public.notif_channel_kill_gate(p_channel) THEN
    RETURN NULL;
  END IF;

  -- N5 (round 2) NO-BACKLOG BOUNDARY. Materialization gates where a row ENTERS the digest path,
  -- which is enough for every group formed from here on — but a group that already exists carries
  -- its members' history with it, and this claim is the single door every send goes through
  -- (prepare/split/oversize/send all require the ownership this stamps). An inert path therefore
  -- dispatches nothing at all, and a group holding ANY pre-boundary member is passed over below.
  v_boundary := public.notif_activation_boundary(p_channel || ':digest');
  IF v_boundary IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM notif_digest_assert_run(p_run_id, 'dispatch', p_channel);
  PERFORM notif_digest_require_range(p_stale_minutes, 1, 1440, 'claim: p_stale_minutes');

  -- breaker preflight (one read; lock only when the state machine must move).
  SELECT * INTO v_cb FROM public.notification_provider_circuit WHERE channel = p_channel;
  IF FOUND AND v_cb.state = 'open' THEN
    IF v_cb.retry_at IS NULL OR p_now < v_cb.retry_at THEN RETURN NULL; END IF;  -- held / not due: no scan
    v_promote := true;                                       -- due → first claimable group becomes the probe
  ELSIF FOUND AND v_cb.state = 'half_open' THEN
    IF v_cb.probe_locked_at IS NOT NULL AND v_cb.probe_locked_at < p_now - make_interval(mins => p_stale_minutes) THEN
      -- stale probe lease (crash before/after HTTP) → re-arm under the row lock, then promote a fresh probe.
      UPDATE public.notification_provider_circuit SET state = 'open', probe_group_id = NULL,
             probe_attempt_id = NULL, probe_locked_at = NULL, retry_at = p_now
       WHERE channel = p_channel AND state = 'half_open'
         AND probe_locked_at IS NOT NULL AND probe_locked_at < p_now - make_interval(mins => p_stale_minutes);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN v_promote := true; ELSE RETURN NULL; END IF;   -- someone else moved it → back off
    ELSIF v_cb.probe_group_id IS NOT NULL THEN
      -- only the bound probe is claimable; everything else waits (untouched — no deferral writes).
      SELECT * INTO g FROM public.notification_digest_groups dg
       WHERE dg.id = v_cb.probe_group_id AND dg.channel = p_channel
         AND dg.state = 'request_ready' AND dg.locked_by IS NULL AND dg.available_at <= p_now
         -- N5 (round 3): the probe is the ONE claim that does not come from the scan below, so it
         -- needs the boundary check of its own. A pre-boundary group promoted to probe before this
         -- contract existed would otherwise be handed ownership and sent — as the breaker's own
         -- half-open probe, i.e. the single most privileged send in the system.
         AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o
                          WHERE o.digest_group_id = dg.id AND o.created_at < v_boundary)
       FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN RETURN NULL; END IF;
      UPDATE public.notification_digest_groups
         SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    ELSE
      RETURN NULL;                                           -- half_open with no probe yet bound elsewhere
    END IF;
  END IF;

  LOOP  -- circuit closed, or open+due (v_promote): scan for work
    v_iter := v_iter + 1;
    IF v_iter > 200 THEN RETURN NULL; END IF;   -- hard scan bound (never unbounded)
    SELECT * INTO g FROM public.notification_digest_groups dg
     WHERE dg.channel = p_channel
       -- N5 (round 2): a group holding ANY member created before this path's boundary can never
       -- be sent — the boundary excludes those events and a group is delivered whole. It is
       -- excluded from the SCAN, not skipped after selection: SKIP LOCKED does not skip rows this
       -- transaction itself holds, so a post-selection CONTINUE would re-pick the same row until
       -- the iteration cap and starve every group behind it. Passed over rather than
       -- terminalized — deciding the fate of historical work is an operator's act (the readiness
       -- envelope counts these; the disposal is the sanctioned exit), never something a dispatch
       -- claim does on its way past.
       AND NOT EXISTS (SELECT 1 FROM public.notification_outbox o
                        WHERE o.digest_group_id = dg.id AND o.created_at < v_boundary)
       AND ( (state IN ('pending','request_ready') AND locked_by IS NULL AND available_at <= p_now)
          OR (state = 'awaiting_evidence' AND available_at <= p_now)
          OR (state IN ('leased','prepared','request_ready','sending')
              AND locked_at IS NOT NULL AND locked_at < p_now - make_interval(mins => p_stale_minutes)) )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- uncertainty age-out — ANY due uncertain group (request_ready | sending | awaiting_evidence), handled
    -- BEFORE the quiet-hours/breaker deferral branches. Otherwise a group whose deadline is already past
    -- would be deferred to least(bump, deadline) = the already-due deadline, re-selected, and hot-loop until
    -- the v_iter cap (one call emitting 200 'deferred' ledger rows). Finalize delivery_unknown, commit
    -- reservations, write exactly ONE outcome ledger event, and continue.
    IF g.uncertain_since IS NOT NULL AND g.uncertain_deadline_at IS NOT NULL AND p_now >= g.uncertain_deadline_at THEN
      PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'age_out', p_now);
      PERFORM notif_digest_commit_reservations(g.id, p_now);
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
      CONTINUE;
    END IF;

    -- crash reclaim of a stale-locked group.
    IF g.locked_at IS NOT NULL AND g.locked_at < p_now - make_interval(mins => p_stale_minutes)
       AND g.state IN ('leased','prepared','request_ready','sending') THEN
      IF g.state = 'sending' THEN
        -- the uncertainty window is anchored to the FIRST HTTP dispatch (the frozen idempotency key's
        -- provider-side dedup window starts there, not at crash discovery). Late discovery — at/after
        -- first_send_at + 23h — must finalize delivery_unknown, never become sendable again: a re-POST
        -- outside the provider window would DUPLICATE delivery.
        IF p_now >= notif_digest_uncertainty_deadline(g.first_send_at, g.uncertain_deadline_at) THEN
          PERFORM notif_digest_finalize_group(g.id, 'delivery_unknown', 'uncertain_age_out', p_now);
          PERFORM notif_digest_commit_reservations(g.id, p_now);
          PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'delivery_unknown', 0);
          CONTINUE;
        END IF;
        UPDATE public.notification_digest_groups
           SET uncertain_since = coalesce(uncertain_since, p_now),
               uncertain_deadline_at = notif_digest_uncertainty_deadline(first_send_at, uncertain_deadline_at),
               state = 'request_ready',
               locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, available_at = p_now, updated_at = p_now
         WHERE id = g.id;
      ELSE
        UPDATE public.notification_digest_groups
           SET locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
         WHERE id = g.id;
      END IF;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
      RETURN g.id;
    END IF;

    -- quiet hours: bump available_at (a genuine SCHEDULING change), do not claim — capped at the uncertainty
    -- deadline (an uncertain group must never be scheduled past first_send_at + 23h).
    v_bump := notif_digest_quiet_hours_bump(p_now, g.recipient_timezone);
    IF v_bump > p_now THEN
      UPDATE public.notification_digest_groups
         SET available_at = least(v_bump, coalesce(g.uncertain_deadline_at, 'infinity'::timestamptz)), updated_at = p_now
       WHERE id = g.id;
      PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'deferred', 0);
      CONTINUE;
    END IF;

    -- open+due: promote THIS candidate to the probe — CAS under the circuit row lock, re-validated.
    IF v_promote THEN
      UPDATE public.notification_provider_circuit
         SET state = 'half_open', probe_group_id = g.id, probe_attempt_id = NULL, probe_locked_at = p_now
       WHERE channel = p_channel AND state = 'open' AND (retry_at IS NOT NULL AND p_now >= retry_at);
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n <> 1 THEN RETURN NULL; END IF;   -- another worker promoted/re-tripped first → back off, no writes
      v_promote := false;
    END IF;

    -- claimable: lease it.
    UPDATE public.notification_digest_groups
       SET state = CASE WHEN g.state = 'pending' THEN 'leased' ELSE g.state END,
           locked_by = p_worker, locked_at = p_now, worker_run_id = p_run_id, updated_at = p_now
     WHERE id = g.id;
    PERFORM notif_digest_ledger(p_run_id, g.id, NULL, 'leased', 0);
    RETURN g.id;
  END LOOP;
END $$;

COMMENT ON FUNCTION public.claim_notification_digest_group(uuid, text, timestamptz, text, int) IS
  'The dispatch worker''s group claim — the single door every digest send goes through. Gates, in order: the channel KILL switch, the N5 ACTIVATION BOUNDARY (inert path dispatches nothing; a group holding any pre-boundary member is passed over), the run assertion, the circuit/probe state machine, then the bounded scan with uncertainty age-out and stale reclaim.';


-- ── the readiness envelope counts the groups too ────────────────────────────────────────────
-- Round 1's backlog check counted OUTBOX rows. A pre-boundary GROUP is the same fact one hop
-- later: work that can never send, in a queue that says otherwise. Recreated whole from the
-- round-1 definition (20261029100000); only that one check's body changes.
CREATE OR REPLACE FUNCTION public.admin_notification_readiness() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  checks jsonb := '[]'::jsonb;
  v bigint; v2 bigint;
  v_cron text;
  v_txt text;
  add_fail boolean := false;
BEGIN
  PERFORM public.notif_admin_gate();

  -- kill switches: authoritative DB state (M4 pin)
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_channel_kill_switches LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'channel_kills', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' channel(s) killed');
  add_fail := add_fail OR v > 0;

  -- circuit state
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_provider_circuit WHERE state <> 'closed' LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'provider_circuits', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' circuit(s) not closed');
  add_fail := add_fail OR v > 0;

  -- unresolved deliberate invocations (M1)
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_worker_invocations WHERE status IN ('pending', 'started') LIMIT 11) b;
  checks := checks || jsonb_build_object('id', 'unresolved_invocations', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'detail', v || ' deliberate invocation(s) unresolved');
  add_fail := add_fail OR v > 0;

  -- in-flight work: claimed/sending/uncertain
  -- the verdict needs zero/nonzero authority, not an exact tally: every scan is LIMIT-bounded,
  -- and a SATURATED count says 'at least' — a bounded count presented as exact misleads
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_outbox WHERE status = 'processing' LIMIT 1001) b;
  SELECT count(*) INTO v2 FROM (SELECT 1 FROM public.notification_digest_groups
   WHERE state IN ('sending', 'awaiting_evidence') OR (uncertain_since IS NOT NULL AND terminal_at IS NULL) LIMIT 1001) b;
  checks := checks || jsonb_build_object('id', 'in_flight_work', 'status', CASE WHEN v + v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000) + least(v2, 1000), 'capped', (v > 1000 OR v2 > 1000),
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END || ' instant row(s) processing, '
           || CASE WHEN v2 > 1000 THEN 'at least 1000' ELSE v2::text END || ' digest group(s) mid-send/uncertain');
  add_fail := add_fail OR (v + v2) > 0;

  -- quarantined orphans await a human
  SELECT count(*) INTO v FROM (SELECT 1 FROM public.notification_orphan_reconcile_state WHERE quarantined LIMIT 1001) b;
  checks := checks || jsonb_build_object('id', 'quarantined_orphans', 'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000), 'capped', v > 1000,
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END || ' orphan(s) quarantined');
  add_fail := add_fail OR v > 0;

  -- cron IDENTITY, not merely active (finding 9): plain allowlisted SELECT, no command text
  BEGIN
    SELECT CASE WHEN j.active THEN 'active' ELSE 'inactive' END INTO v_cron
      FROM cron.job j WHERE j.jobname = 'notification-digest-worker' LIMIT 1;
    v_txt := coalesce(v_cron, 'absent');
  EXCEPTION WHEN OTHERS THEN
    v_txt := 'unavailable';
  END;
  checks := checks || jsonb_build_object('id', 'digest_cron', 'status',
    CASE v_txt WHEN 'inactive' THEN 'pass' WHEN 'unavailable' THEN 'not_provable' ELSE 'fail' END,
    'detail', 'notification-digest-worker: ' || v_txt || ' (identity/hash verification lives in the reviewed rollout artifacts, not here)');
  add_fail := add_fail OR v_txt IN ('active', 'absent');

  -- THE ENV SWITCH — the visible line, never a tooltip, never implied verified (finding 16)
  checks := checks || jsonb_build_object('id', 'digest_send_enabled_env', 'status', 'not_provable',
    'detail', 'DIGEST_SEND_ENABLED is an edge env var no SQL can read — operator assertion only');

  -- ── N5: the two checks that were reported not_provable until the machinery existed ────────
  -- (1) THE MECHANISM. Every delivery path must carry a durable, coherent boundary row — that is
  -- what makes "no historical work" enforceable rather than asserted. A missing or incoherent row
  -- is a FAIL: its send authority would be gating on nothing.
  SELECT count(*) INTO v FROM public.notification_activation_boundaries;
  SELECT count(*) INTO v2 FROM public.notification_activation_boundaries
   WHERE (state = 'active' AND boundary_at IS NULL) OR (state = 'inert' AND boundary_at IS NOT NULL);
  checks := checks || jsonb_build_object('id', 'durable_activation_boundary',
    'status', CASE WHEN v = 3 AND v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', v,
    'detail', (SELECT string_agg(b.path || '=' || b.state
                 || coalesce(' since ' || to_char(b.boundary_at, 'YYYY-MM-DD"T"HH24:MI:SSOF'), ''), ', ' ORDER BY b.path)
                 FROM public.notification_activation_boundaries b)
              || CASE WHEN v <> 3 THEN ' — expected 3 delivery paths, found ' || v ELSE '' END
              || CASE WHEN v2 > 0 THEN ' — ' || v2 || ' incoherent row(s)' ELSE '' END);
  add_fail := add_fail OR v <> 3 OR v2 > 0;

  -- (2) THE BACKLOG ITSELF. The send authorities already REFUSE pre-boundary rows (that is the
  -- invariant, and it is mutation-tested), so this counts what that refusal is holding back:
  -- pending rows that predate their own path's boundary and can therefore never send. Zero is
  -- the ready state; anything else is work an operator must dispose of deliberately, never work
  -- that quietly waits for a switch. Saturating, like every other count here.
  SELECT count(*) INTO v FROM (
    SELECT 1
      FROM public.notification_outbox o
      JOIN public.notification_activation_boundaries b
        ON b.path = o.channel || CASE WHEN o.delivery_mode = 'digest' THEN ':digest' ELSE ':instant' END
     WHERE o.status = 'pending' AND b.state = 'active' AND o.created_at < b.boundary_at
     LIMIT 1001) x;
  -- …and the same fact ONE HOP LATER (round 2): a group holding a pre-boundary member can never
  -- send either, because a digest is delivered whole. Counted separately so the detail says which
  -- shape the operator is looking at — the disposal clears rows, a group needs the state machine.
  SELECT count(*) INTO v2 FROM (
    SELECT 1
      FROM public.notification_digest_groups g
      JOIN public.notification_activation_boundaries b
        ON b.path = g.channel || ':digest' AND b.state = 'active'
     WHERE g.terminal_at IS NULL
       AND EXISTS (SELECT 1 FROM public.notification_outbox o
                    WHERE o.digest_group_id = g.id AND o.created_at < b.boundary_at)
     LIMIT 1001) y;
  checks := checks || jsonb_build_object('id', 'pre_activation_backlog_eligible_count',
    'status', CASE WHEN v + v2 = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000) + least(v2, 1000), 'capped', (v > 1000 OR v2 > 1000),
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END
              || ' pending row(s) and '
              || CASE WHEN v2 > 1000 THEN 'at least 1000' ELSE v2::text END
              || ' non-terminal group(s) predate their path''s activation boundary — refused by every send authority; rows are disposable through admin_dispose_pre_boundary_backlog');
  add_fail := add_fail OR (v + v2) > 0;

  RETURN jsonb_build_object(
    'schema_version', 1,
    'as_of', now(),
    -- 'fail' when anything failed; otherwise 'not_provable' — NEVER 'pass', because
    -- DIGEST_SEND_ENABLED is an edge env var no SQL can read. N5 made the two boundary checks
    -- real, which moves them out of this sentence: what keeps the overall verdict at
    -- not_provable is now ONLY the env switch (and the cron read, where it is unavailable).
    'readiness', CASE WHEN add_fail THEN 'fail' ELSE 'not_provable' END,
    'checks', checks
  );
END;
$$;
COMMENT ON FUNCTION public.admin_notification_readiness() IS
  'The versioned readiness envelope {schema_version, as_of, readiness, checks[]}. N5: durable_activation_boundary proves every delivery path carries a coherent boundary row, and pre_activation_backlog_eligible_count counts BOTH the pending rows and the non-terminal digest groups that predate their path''s boundary and can therefore never send. DIGEST_SEND_ENABLED remains unreadable from SQL, so the overall verdict is fail or not_provable — never pass.';
REVOKE ALL ON FUNCTION public.admin_notification_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_readiness() TO authenticated, service_role;
