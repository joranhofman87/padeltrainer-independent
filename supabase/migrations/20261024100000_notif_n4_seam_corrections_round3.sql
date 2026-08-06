-- N4 whole-unit seam review, ROUND 3 (thread 019fd319). One runtime gap that had been in M1
-- since it was written and only became visible when the proof harness was made to execute it,
-- plus two honesty corrections.
--
--   1. CAUSALITY. bind validated the run's KIND (dispatch/email/digest-worker token/unfinished)
--      but never that the run could actually be the one this invocation caused. A cron run that
--      started BEFORE a manual invocation was opened could claim and bind it: the durable record
--      then attributes a deliberate invocation to a run that predates it, and the run the
--      dispatch really started is refused with 'conflict_other_run'. smoke/canary are protected
--      by their artifacts' "no dispatch run in flight" assertion; purpose='manual' has no
--      artifact and no such protection.
--   2. The evidence-continuity assertion (round 2) checked PRESENCE, not identity: an M2-era
--      kill whose id was later replayed post-M3 carries an 'already_killed' audit row, which
--      satisfied "an audit row exists" while the applied decision itself stayed unevidenced.
--   3. The authority matrix reported a digest verdict for WhatsApp, which has no digest path at
--      all (the resolver routes only email into digests; the worker is email-only).

-- ── SEAM 12: a run cannot own an invocation it predates ─────────────────────────────────────
-- The invocation is opened BEFORE the pg_net dispatch, and the run is started by the worker that
-- dispatch triggers — so a run that caused an invocation ALWAYS starts at or after requested_at.
-- Both timestamps come from the same server clock, so this is a total order, not an estimate.
CREATE OR REPLACE FUNCTION public.bind_notification_worker_invocation(
  p_invocation_id uuid,
  p_worker_run_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.notification_worker_invocations%ROWTYPE;
        v_run public.notification_worker_runs%ROWTYPE;
BEGIN
  IF p_invocation_id IS NULL OR p_worker_run_id IS NULL THEN
    RAISE EXCEPTION 'bind_notification_worker_invocation: both ids are required';
  END IF;
  SELECT * INTO v FROM public.notification_worker_invocations
   WHERE id = p_invocation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;                    -- STOP: nothing to own
  IF v.status = 'pending' THEN
    SELECT * INTO v_run FROM public.notification_worker_runs r
     WHERE r.run_id = p_worker_run_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'run_missing'; END IF;              -- STOP
    IF v_run.phase <> 'dispatch' OR v_run.channel <> 'email'
       OR v_run.worker NOT LIKE 'notification-digest-worker:%' THEN
      RETURN 'run_wrong_kind';                                   -- STOP
    END IF;
    IF v_run.ended_at IS NOT NULL THEN
      RETURN 'run_already_ended';                                -- STOP: stale evidence
    END IF;
    -- CAUSALITY (round 3): a run that was already going when this invocation was requested
    -- cannot be the run the request caused. Without it, an in-flight cron tick could claim a
    -- manual invocation opened microseconds later — binding evidence to the wrong run and
    -- locking the real one out with 'conflict_other_run'.
    IF v_run.started_at < v.requested_at THEN
      RETURN 'run_predates_invocation';                          -- STOP: not this run's evidence
    END IF;
    UPDATE public.notification_worker_invocations
       SET status = 'started', worker_run_id = p_worker_run_id
     WHERE id = v.id;
    RETURN 'bound';                                              -- proceed
  END IF;
  IF v.status = 'started' THEN
    IF v.worker_run_id = p_worker_run_id THEN
      RETURN 'replayed';                                         -- provably identical retry: proceed
    END IF;
    RETURN 'conflict_other_run';                                 -- STOP: another run owns it
  END IF;
  RETURN 'resolved';                                             -- STOP: completed/abandoned
END;
$$;
COMMENT ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) IS
  'N4 M1 (round 3): the worker stamps its run onto the invocation. Typed verdicts; only bound|replayed may proceed. The run must be THIS pipeline''s unfinished email dispatch under a digest-worker token AND must not have started before the invocation was requested — a run that predates the request cannot be its cause.';
REVOKE ALL ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) TO service_role;

-- …and the CLAIM must not turn that refusal into a failed cron tick. An invocation this run
-- provably cannot own — because the run was already running when it was requested — is not the
-- duplicate-execution hazard the loud arm exists for: the deliberate dispatch is still on its
-- way and will start its own run. This tick is a steady-state tick; it returns NULL and the
-- invocation stays pending for the run that caused it. Every OTHER refusal still RAISES.
CREATE OR REPLACE FUNCTION public.claim_pending_worker_invocation(
  p_worker_run_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv uuid;
  v_status text;
  v_verdict text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));

  SELECT id, status INTO v_inv, v_status
    FROM public.notification_worker_invocations
   WHERE status IN ('pending', 'started')
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;   -- steady-state tick: no deliberate invocation exists
  END IF;

  v_verdict := public.bind_notification_worker_invocation(v_inv, p_worker_run_id);
  IF v_verdict IN ('bound', 'replayed') THEN
    RETURN v_inv;
  END IF;
  IF v_verdict = 'run_predates_invocation' THEN
    RETURN NULL;   -- steady-state tick: the invocation belongs to a run that has not started yet
  END IF;
  RAISE EXCEPTION 'claim_pending_worker_invocation: invocation % (status %) refused this run (%) — verdict %',
    v_inv, v_status, p_worker_run_id, v_verdict;
END;
$$;
COMMENT ON FUNCTION public.claim_pending_worker_invocation(uuid) IS
  'N4 (round 3): the dispatch worker''s startup claim of THE unresolved deliberate invocation. NULL means "this tick owns no deliberate invocation" — either none is unresolved, or the only one was requested AFTER this run started and therefore belongs to a run that has not begun yet. A pending invocation this run CAN own binds; a started one is accepted only as this run''s own replay; anything else RAISES, so a duplicate HTTP request can never proceed as a second unverified pass. Classification is serialized under the open() advisory lock.';
REVOKE ALL ON FUNCTION public.claim_pending_worker_invocation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_worker_invocation(uuid) TO service_role;

-- ── SEAM 13: WhatsApp has no digest path, so it has no digest verdict ───────────────────────
-- enqueue_notification routes ONLY email into digests (20261015120000: the digest branch is
-- guarded by v_channel = 'email'), and the worker itself is email-only. Reporting 'unknown' for
-- whatsapp invited the reading "there may be digests we cannot see"; there is no such path.
CREATE OR REPLACE FUNCTION public.admin_notification_event_states() RETURNS TABLE (
  event_type text, channel text,
  catalog_supported boolean, catalog_default text, required_delivery boolean,
  digest_engine_enabled boolean,     -- ENQUEUE routing only: existing groups still drain
  academy_off_caps int,
  cron_state text,
  circuit_state text,
  circuit_reason text,
  circuit_tripped_at timestamptz,
  kill_state text,
  send_env text,                     -- the channel/path-specific unverifiable env switch
  instant_conclusion text,
  digest_conclusion text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cron text;
BEGIN
  PERFORM public.notif_admin_gate();
  BEGIN
    SELECT CASE WHEN j.active THEN 'active' ELSE 'inactive' END INTO v_cron
      FROM cron.job j WHERE j.jobname = 'notification-digest-worker' LIMIT 1;
    IF v_cron IS NULL THEN v_cron := 'absent'; END IF;
  EXCEPTION WHEN OTHERS THEN
    v_cron := 'unavailable';
  END;

  RETURN QUERY
  SELECT et.key, ch.channel,
         CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END,
         CASE ch.channel WHEN 'email' THEN et.default_email_frequency ELSE et.default_whatsapp_frequency END,
         et.required_delivery,
         et.digest_engine_enabled,
         (SELECT count(*)::int FROM public.academy_notification_restrictions r
           WHERE r.event_type = et.key AND r.channel = ch.channel AND r.max_frequency = 'off'),
         v_cron,
         coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'none'),
         (SELECT cb.reason FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel),
         (SELECT cb.tripped_at FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel),
         CASE WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel)
              THEN 'killed' ELSE 'live' END,
         CASE ch.channel
           WHEN 'email' THEN 'DIGEST_SEND_ENABLED (digest path only) — unverifiable'
           ELSE 'WHATSAPP_SEND_ENABLED (instant path) — unverifiable'
         END,
         -- INSTANT: kill + catalog are its ONLY DB-visible authorities (the breaker governs the
         -- digest path; the instant claim never reads it). WhatsApp additionally depends on an
         -- unverifiable env switch, so it can never conclude 'sendable' from SQL.
         CASE
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN NOT (CASE ch.channel WHEN 'email' THEN et.supports_email ELSE et.supports_whatsapp END) THEN 'stopped'
           WHEN ch.channel = 'whatsapp' THEN 'unknown'
           ELSE 'sendable'
         END,
         -- DIGEST: an EMAIL-ONLY mechanism. WhatsApp has no digest path to conclude about, and
         -- saying 'unknown' there implied invisible digest work that cannot exist. For email:
         -- kill / circuit / catalog / cron are definitive; the engine flag is NOT a stop
         -- (existing groups drain), so the best case is 'unknown' — DIGEST_SEND_ENABLED has the
         -- last word and SQL cannot read it.
         CASE
           WHEN ch.channel <> 'email' THEN 'not_applicable'
           WHEN EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = ch.channel) THEN 'stopped'
           WHEN coalesce((SELECT cb.state FROM public.notification_provider_circuit cb WHERE cb.channel = ch.channel), 'closed') IN ('open', 'half_open') THEN 'stopped'
           WHEN NOT et.supports_email THEN 'stopped'
           WHEN v_cron IN ('inactive', 'absent') THEN 'stopped'
           ELSE 'unknown'
         END
    FROM public.notification_event_types et
    CROSS JOIN (VALUES ('email'), ('whatsapp')) AS ch(channel);
END;
$$;
COMMENT ON FUNCTION public.admin_notification_event_states() IS
  'N4 (round 3): per event x channel, every authority reported separately AND truthfully against what the execution paths actually enforce — the circuit governs the DIGEST path only (the instant claim reads the kill switch alone); digest_engine_enabled gates ENQUEUE routing only, so it is reported but is NOT a stop; digest is EMAIL-ONLY, so whatsapp reports not_applicable rather than unknown; send_env names the channel-specific unverifiable switch.';
REVOKE ALL ON FUNCTION public.admin_notification_event_states() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_event_states() TO authenticated, service_role;

-- ── SEAM 14: the evidence assertion must check the DECISION, not merely a row ───────────────
-- Round 2 accepted any audit row with a matching (actor, request_id, action, target). An M2-era
-- kill whose request id was replayed after M3 carries an 'already_killed' audit row and an
-- 'already_killed' registry verdict — which satisfied that test while the applied decision that
-- actually created the kill row stayed unevidenced. The evidence for a kill row is the APPLIED
-- decision (live→killed) and the 'killed' verdict under this action's canonical fingerprint.
DO $$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(format('kill(channel=%s, actor=%s, request_id=%s)', k.channel, k.activated_by, k.request_id), '; ')
    INTO v_bad
    FROM public.notification_channel_kill_switches k
   WHERE k.activated_by IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.notification_admin_audit a
                      WHERE a.actor = k.activated_by AND a.request_id = k.request_id
                        AND a.action = 'channel_kill' AND a.target = k.channel
                        AND a.outcome = 'applied' AND a.new_value = 'killed');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'notif N4 seam: a kill row has no APPLIED audit decision — its (actor, request_id) is either unrecorded or bound to a different decision (an already_killed replay is not evidence that this kill was applied). Reconcile before deploying: %', v_bad;
  END IF;

  SELECT string_agg(format('audit(actor=%s, request_id=%s, target=%s)', a.actor, a.request_id, a.target), '; ')
    INTO v_bad
    FROM public.notification_admin_audit a
   WHERE a.action = 'channel_kill' AND a.outcome = 'applied'
     AND NOT EXISTS (SELECT 1 FROM public.notification_admin_requests r
                      WHERE r.actor = a.actor AND r.request_id = a.request_id
                        AND r.action = 'channel_kill' AND r.verdict = 'killed'
                        AND r.fingerprint = public.notif_admin_fingerprint(jsonb_build_object(
                              'action', 'channel_kill', 'channel', a.target, 'reason', a.reason)));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'notif N4 seam: an APPLIED channel_kill audit row has no matching registry verdict under this action''s canonical fingerprint — a replay of that id would be judged against the wrong decision. Reconcile before deploying: %', v_bad;
  END IF;
END $$;
