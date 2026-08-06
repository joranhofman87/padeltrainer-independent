
-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N5 M3 — the readiness envelope's two N5-dependent checks become REAL, and the backlog they
-- reveal gets a sanctioned disposal. Recreated whole from its N4 M6 definition (20261021100000);
-- everything above the N5 block is byte-identical.
-- ═══════════════════════════════════════════════════════════════════════════════════════════
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
  checks := checks || jsonb_build_object('id', 'pre_activation_backlog_eligible_count',
    'status', CASE WHEN v = 0 THEN 'pass' ELSE 'fail' END,
    'value', least(v, 1000), 'capped', v > 1000,
    'detail', CASE WHEN v > 1000 THEN 'at least 1000' ELSE v::text END
              || ' pending row(s) predate their path''s activation boundary — refused by the send authorities, and disposable only through admin_dispose_pre_boundary_backlog');
  add_fail := add_fail OR v > 0;

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
  'The versioned readiness envelope {schema_version, as_of, readiness, checks[]}. Named check ids; kill/circuit/invocation/in-flight/orphan/cron states from authoritative DB reads. N5 made the boundary checks real: durable_activation_boundary proves every delivery path carries a coherent boundary row, and pre_activation_backlog_eligible_count counts the pending rows that predate their path''s boundary and can therefore never send. DIGEST_SEND_ENABLED remains unreadable from SQL, so the overall verdict is fail (something failed) or not_provable — never pass.';
REVOKE ALL ON FUNCTION public.admin_notification_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_readiness() TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N5 M3b — DISPOSING of the backlog the boundary refuses.
--
-- The send authorities make historical rows ineligible, which is the invariant. But ineligible
-- is not the same as finished: those rows stay 'pending' forever, so every admin surface shows
-- a queue that never drains and the readiness envelope can never reach zero. They need a
-- terminal state, and reaching it must be a DELIBERATE, bounded, audited act — never a sweep
-- that runs on its own, and never anything that can put a row back on a send path.
--
-- Note what this cannot do, by construction: its only write moves 'pending' → 'skipped' with a
-- reason. There is no arm that sets a row back to pending, changes a destination, or dispatches
-- anything — the N4 doctrine that this surface offers no generic retry/resend holds here too.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- the audit + registry vocabulary grows by one action
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT notification_admin_audit_action_check;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT notification_admin_audit_action_check
  CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT chk_notification_admin_audit_coherent;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT chk_notification_admin_audit_coherent
  CHECK (
    (action = 'channel_kill'
      AND target IN ('email', 'whatsapp') AND new_value = 'killed'
      AND ((outcome = 'applied' AND old_value = 'live')
        OR (outcome = 'already_killed' AND old_value = 'killed')))
    OR (action = 'circuit_reset'
      AND target IN ('email', 'whatsapp') AND new_value = 'closed'
      AND ((outcome = 'applied' AND old_value IN ('open', 'half_open'))
        OR (outcome = 'already_closed' AND old_value = 'closed')))
    OR (action = 'group_cancel'
      AND outcome = 'applied' AND new_value = 'retry_stopped'
      AND old_value IN ('pending', 'leased', 'prepared', 'request_ready'))
    OR (action = 'orphan_resolve'
      AND outcome = 'applied' AND old_value = 'quarantined' AND new_value = 'resolved')
    OR (action = 'orphan_requeue'
      AND outcome = 'applied' AND old_value = 'quarantined' AND new_value = 'requeued')
    -- the disposal's old_value is the count it moved, so the audit row carries the SIZE of the
    -- act and not merely that it happened
    OR (action = 'backlog_dispose'
      AND outcome = 'applied' AND new_value = 'pre_activation_boundary' AND old_value ~ '^[0-9]+$')
  );
ALTER TABLE public.notification_admin_rejected_attempts DROP CONSTRAINT notification_admin_rejected_attempts_action_check;
ALTER TABLE public.notification_admin_rejected_attempts ADD CONSTRAINT notification_admin_rejected_attempts_action_check
  CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT notification_admin_requests_action_check;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT notification_admin_requests_action_check
  CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT chk_notification_admin_requests_verdict;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT chk_notification_admin_requests_verdict CHECK (
  (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_id_collision'))
  OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
  OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
  OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
  OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
  OR (action = 'backlog_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_path_inert', 'rejected_unknown_path'))
);

CREATE OR REPLACE FUNCTION public.admin_dispose_pre_boundary_backlog(
  p_path text,
  p_reason text,
  p_request_id uuid,
  p_limit int DEFAULT 500
) RETURNS TABLE (verdict text, disposed int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  b public.notification_activation_boundaries%ROWTYPE;
  v_fp text;
  v_replay text;
  v_n int := 0;
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_channel text;
  v_digest boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_dispose_pre_boundary_backlog: platform admin only';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_dispose_pre_boundary_backlog: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_dispose_pre_boundary_backlog: a reason (3-500 chars) is required';
  END IF;

  -- the batch SIZE is part of the decision, so it is in the fingerprint: a retry that widens the
  -- batch is conflicting reuse, not a replay
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'backlog_dispose', 'path', p_path, 'reason', btrim(p_reason), 'limit', v_limit));
  v_replay := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'backlog_dispose', p_path, p_reason, v_fp);
  IF v_replay IS NOT NULL THEN
    verdict := v_replay; disposed := 0; RETURN NEXT; RETURN;   -- the recorded decision, unchanged
  END IF;

  SELECT * INTO b FROM public.notification_activation_boundaries WHERE path = p_path;
  IF NOT FOUND THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'backlog_dispose', p_path, p_reason,
      'unknown delivery path');
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'backlog_dispose', v_fp, 'rejected_unknown_path');
    disposed := 0; RETURN NEXT; RETURN;
  END IF;
  IF b.state <> 'active' THEN
    -- an inert path has no boundary, so nothing is provably historical: disposing there would be
    -- deleting a queue on a guess
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'backlog_dispose', p_path, p_reason,
      'the path is inert — nothing is provably pre-boundary until it has been opened');
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'backlog_dispose', v_fp, 'rejected_path_inert');
    disposed := 0; RETURN NEXT; RETURN;
  END IF;

  v_channel := split_part(p_path, ':', 1);
  v_digest  := split_part(p_path, ':', 2) = 'digest';

  WITH doomed AS (
    SELECT o.id
      FROM public.notification_outbox o
     WHERE o.channel = v_channel
       AND (CASE WHEN v_digest THEN o.delivery_mode = 'digest' ELSE o.delivery_mode IS DISTINCT FROM 'digest' END)
       AND o.status = 'pending'
       AND o.created_at < b.boundary_at
       -- a digest member already inside a group belongs to the state machine, not here
       AND (NOT v_digest OR o.digest_group_id IS NULL)
     ORDER BY o.created_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_outbox o
     SET status = 'skipped', skip_reason = 'pre_activation_boundary',
         locked_at = NULL, locked_by = NULL, updated_at = now()
    FROM doomed
   WHERE o.id = doomed.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'backlog_dispose', v_fp, 'nothing_to_dispose');
    disposed := 0; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'backlog_dispose', p_path, v_n::text, 'pre_activation_boundary', 'applied', btrim(p_reason));
  verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'backlog_dispose', v_fp, 'disposed');
  disposed := v_n; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_dispose_pre_boundary_backlog(text, text, uuid, int) IS
  'N5: terminally skip the pending rows a delivery path''s activation boundary has made permanently ineligible (skip_reason pre_activation_boundary). Admin fail-closed, request-id idempotent, bounded (<=1000 per call, SKIP LOCKED), audited with the COUNT it moved. Refuses an inert path — nothing is provably historical until a path has been opened. Its only write is pending -> skipped: no arm of this function can put a row back on a send path.';
REVOKE ALL ON FUNCTION public.admin_dispose_pre_boundary_backlog(text, text, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dispose_pre_boundary_backlog(text, text, uuid, int) TO authenticated, service_role;

-- ── the admin READ: what state is each delivery path in, and what is stuck behind it ────────
-- Fixed columns, admin fail-closed, bounded by construction (three rows). The backlog count is
-- saturating like every other N4 gauge: an operator needs "is there any, and roughly how much",
-- and a bounded count presented as exact misleads.
CREATE OR REPLACE FUNCTION public.admin_notification_activation_boundaries() RETURNS TABLE (
  path text, state text, boundary_at timestamptz, reason text, activated_by uuid,
  pending_before_boundary int, pending_before_boundary_capped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE CAP constant int := 1000;
BEGIN
  PERFORM public.notif_admin_gate();
  RETURN QUERY
  SELECT b.path, b.state, b.boundary_at, b.reason, b.activated_by,
         least(x.n, CAP)::int, x.n > CAP
    FROM public.notification_activation_boundaries b
    CROSS JOIN LATERAL (
      SELECT count(*)::bigint AS n FROM (
        SELECT 1 FROM public.notification_outbox o
         WHERE b.state = 'active'
           AND o.status = 'pending'
           AND o.channel = split_part(b.path, ':', 1)
           AND (CASE WHEN split_part(b.path, ':', 2) = 'digest'
                     THEN o.delivery_mode = 'digest' AND o.digest_group_id IS NULL
                     ELSE o.delivery_mode IS DISTINCT FROM 'digest' END)
           AND o.created_at < b.boundary_at
         LIMIT CAP + 1) y) x
   ORDER BY b.path;
END;
$$;
COMMENT ON FUNCTION public.admin_notification_activation_boundaries() IS
  'N5: one row per delivery path — its state, its boundary, who opened it and why, and how many pending rows predate that boundary (saturating at 1000). The admin surface reads this; opening a path is a runbook act and is not exposed here.';
REVOKE ALL ON FUNCTION public.admin_notification_activation_boundaries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_notification_activation_boundaries() TO authenticated, service_role;
