-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- FINAL INTEGRATION AUDIT (P2) — the long-outage recovery needs a control, not a paragraph.
--
-- Round 3 documented the one case where the instant path can duplicate: nothing bounds the
-- WALL-CLOCK gap between a row's attempts (`next_attempt_at` is a not-before condition), so after
-- an outage longer than the provider's dedup window, resuming can re-send an attempt that may
-- already have been accepted. The procedure told an operator to dispose of the rows that are no
-- longer worth sending before the worker resumes.
--
-- The review found that step impossible: `admin_dispose_pre_boundary_backlog` only takes rows
-- CREATED BEFORE AN ACTIVE PATH'S BOUNDARY, and email:instant's boundary is '-infinity', so no
-- instant row can ever match it. A documented mitigation nobody can execute is worse than none —
-- it reads as safety while leaving the operator to improvise SQL against production, which this
-- bundle exists to make unnecessary.
--
-- So the control exists now. It is the same SHAPE as every other one here: admin fail-closed,
-- request-id idempotent, bounded, audited with the count it moved, and its only write is
-- pending/abandoned-processing → skipped. Nothing in it can start a send.
--
-- WHAT IT WILL NOT DO, deliberately:
--   * it will not touch a row younger than an hour — this is an outage tool, not a "cancel my
--     queue" button, and the floor is what keeps those two apart;
--   * it will not touch a processing row whose lease is still LIVE. A row a worker holds right now
--     may be mid-provider-call, and terminalising it would be a decision made over the top of one
--     already in flight. Only leases older than the same threshold — long since abandoned — are
--     eligible;
--   * it will not resurrect anything: skipped is terminal here, and a row disposed of by mistake
--     is re-created by the producer's next enqueue, not by an undo button in this file.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notification_admin_audit DROP CONSTRAINT notification_admin_audit_action_check;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT notification_admin_audit_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose', 'stale_dispose'));
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT chk_notification_admin_audit_coherent;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT chk_notification_admin_audit_coherent
  CHECK (
    (action = 'channel_kill'
      AND target IN ('email', 'whatsapp') AND new_value = 'killed'
      AND ((outcome = 'applied' AND old_value = 'live')
        OR (outcome = 'already_killed' AND old_value = 'killed')))
    OR (action = 'channel_kill_cleared'
      AND target IN ('email', 'whatsapp') AND outcome = 'applied'
      AND old_value = 'killed' AND new_value = 'live')
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
    OR (action = 'backlog_dispose'
      AND outcome = 'applied' AND new_value = 'pre_activation_boundary' AND old_value ~ '^[0-9]+$')
    -- like the backlog disposal, the old_value carries the SIZE of the act
    OR (action = 'stale_dispose'
      AND target IN ('email', 'whatsapp')
      AND outcome = 'applied' AND new_value = 'stale_after_outage' AND old_value ~ '^[0-9]+$')
  );
ALTER TABLE public.notification_admin_rejected_attempts DROP CONSTRAINT notification_admin_rejected_attempts_action_check;
ALTER TABLE public.notification_admin_rejected_attempts ADD CONSTRAINT notification_admin_rejected_attempts_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose', 'stale_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT notification_admin_requests_action_check;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT notification_admin_requests_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose', 'stale_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT chk_notification_admin_requests_verdict;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT chk_notification_admin_requests_verdict CHECK (
  (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_id_collision'))
  OR (action = 'channel_kill_cleared' AND verdict IN ('cleared', 'rejected_not_killed', 'rejected_stale_kill', 'rejected_backlog_grew'))
  OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
  OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
  OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
  OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
  OR (action = 'backlog_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_path_inert', 'rejected_unknown_path'))
  OR (action = 'stale_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_threshold_too_low'))
);

-- ── the read: what a disposal would take, before anyone decides ─────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_stale_outbox_preview(
  p_channel text,
  p_older_than_minutes int
) RETURNS TABLE (channel text, older_than_minutes int, pending int, abandoned_processing int, oldest timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cut timestamptz;
BEGIN
  PERFORM public.notif_admin_gate();
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_stale_outbox_preview: unknown channel %', p_channel;
  END IF;
  IF coalesce(p_older_than_minutes, 0) < 60 THEN
    RAISE EXCEPTION 'admin_stale_outbox_preview: the threshold floor is 60 minutes — this reads what an OUTAGE left behind, not a live queue';
  END IF;
  v_cut := now() - make_interval(mins => p_older_than_minutes);
  RETURN QUERY
  SELECT p_channel, p_older_than_minutes,
         count(*) FILTER (WHERE o.status = 'pending')::int,
         count(*) FILTER (WHERE o.status = 'processing')::int,
         min(o.updated_at)
    FROM public.notification_outbox o
   WHERE o.channel = p_channel
     AND o.delivery_mode IS DISTINCT FROM 'digest'      -- digest members belong to the state machine
     AND o.updated_at < v_cut
     AND (o.status = 'pending'
          OR (o.status = 'processing' AND o.locked_at IS NOT NULL AND o.locked_at < v_cut));
END;
$$;
COMMENT ON FUNCTION public.admin_stale_outbox_preview(text, int) IS
  'N7/audit: what a long-outage disposal would take on this channel — pending rows and ABANDONED processing rows (a live lease is never counted) older than the threshold, plus the oldest one. Read-only; the threshold floor of 60 minutes keeps this an outage tool rather than a queue-cancel button.';
REVOKE ALL ON FUNCTION public.admin_stale_outbox_preview(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stale_outbox_preview(text, int) TO authenticated, service_role;

-- ── the act ─────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_dispose_stale_outbox(
  p_channel text,
  p_older_than_minutes int,
  p_reason text,
  p_request_id uuid,
  p_limit int DEFAULT 500
) RETURNS TABLE (verdict text, disposed int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fp text;
  v_replay text;
  v_n int := 0;
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_cut timestamptz;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: platform admin only';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: a reason (3-500 chars) is required';
  END IF;

  -- the threshold and the batch size are part of the DECISION, so they are in the fingerprint:
  -- a retry that widens either is conflicting reuse, not a replay
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'stale_dispose', 'channel', p_channel, 'older_than_minutes', p_older_than_minutes,
    'reason', btrim(p_reason), 'limit', v_limit));
  v_replay := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'stale_dispose', p_channel, p_reason, v_fp);
  IF v_replay IS NOT NULL THEN
    verdict := v_replay; disposed := 0; RETURN NEXT; RETURN;
  END IF;

  IF coalesce(p_older_than_minutes, 0) < 60 THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'stale_dispose', p_channel, p_reason,
      format('threshold %s is below the 60-minute floor', coalesce(p_older_than_minutes, 0)));
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'rejected_threshold_too_low');
    disposed := 0; RETURN NEXT; RETURN;
  END IF;
  v_cut := now() - make_interval(mins => p_older_than_minutes);

  WITH doomed AS (
    SELECT o.id
      FROM public.notification_outbox o
     WHERE o.channel = p_channel
       AND o.delivery_mode IS DISTINCT FROM 'digest'
       AND o.updated_at < v_cut
       AND (o.status = 'pending'
            -- an ABANDONED lease only: a row a worker holds right now may be mid-provider-call,
            -- and terminalising that is a decision taken over the top of one already in flight
            OR (o.status = 'processing' AND o.locked_at IS NOT NULL AND o.locked_at < v_cut))
     ORDER BY o.updated_at
     LIMIT v_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.notification_outbox o
     SET status = 'skipped', skip_reason = 'stale_after_outage',
         locked_at = NULL, locked_by = NULL, updated_at = now()
    FROM doomed
   WHERE o.id = doomed.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF v_n = 0 THEN
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'nothing_to_dispose');
    disposed := 0; RETURN NEXT; RETURN;
  END IF;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'stale_dispose', p_channel, v_n::text, 'stale_after_outage', 'applied', btrim(p_reason));
  verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'disposed');
  disposed := v_n; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_dispose_stale_outbox(text, int, text, uuid, int) IS
  'N7/audit: the sanctioned long-outage recovery — terminally skip instant rows an outage left behind (skip_reason stale_after_outage) so resuming cannot re-send an attempt the provider may already have accepted outside its dedup window. Admin fail-closed, request-id idempotent (threshold and batch size are in the fingerprint), bounded <=1000 SKIP LOCKED, audited with the count. Never touches a digest member, a live lease, or anything younger than the 60-minute floor; its only write is pending/abandoned-processing -> skipped.';
REVOKE ALL ON FUNCTION public.admin_dispose_stale_outbox(text, int, text, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dispose_stale_outbox(text, int, text, uuid, int) TO authenticated, service_role;
