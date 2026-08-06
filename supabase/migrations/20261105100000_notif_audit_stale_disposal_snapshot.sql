-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- FINAL INTEGRATION AUDIT, ROUND 2 (P1) — the disposal acted on a set the operator never saw.
--
-- `admin_stale_outbox_preview` computed `now() - threshold` and showed a count.
-- `admin_dispose_stale_outbox` then computed `now() - threshold` AGAIN, at act time, and deleted
-- whatever matched. Those are two different cutoffs. Between the operator reading a number and
-- clicking the button, the window slides forward: rows that were 59 minutes old become eligible,
-- and rows a worker was about to claim change state. The UI said the disposal was bounded to what
-- was shown. It was not — it was bounded to whatever the second query happened to find.
--
-- This is a DESTRUCTIVE operation with a confirmation dialog, so "roughly the same set" is not the
-- standard. The decision must be a SNAPSHOT the operator can actually consent to:
--
--   * the cutoff is passed IN, not recomputed. `admin_stale_outbox_preview` now returns the exact
--     `cutoff_at` it measured, and the act takes that timestamp. With a fixed cutoff the eligible
--     set can only shrink (updated_at moves forward, never back), so nothing can wander INTO the
--     set after it was shown;
--   * the counts are asserted. The operator passes back the numbers they saw, and a mismatch in
--     either direction is refused as `rejected_stale_preview` — including a shrink, because a set
--     that moved at all is a set the operator has not seen;
--   * the count is made TRANSACTIONALLY TRUE. The act takes `SHARE ROW EXCLUSIVE` on the outbox
--     before counting, which blocks producers and workers for the (short, bounded) life of the
--     statement. SHARE ROW EXCLUSIVE rather than SHARE because it conflicts with ITSELF: two
--     concurrent disposals serialize instead of deadlocking on the lock upgrade that SHARE →
--     ROW EXCLUSIVE would require;
--   * the cutoff and both counts are in the request fingerprint, so a retry that widens the window
--     or accepts a different set is conflicting reuse rather than a replay.
--
-- The 60-minute floor survives as a floor on the CUTOFF: this is an outage tool, and a cutoff
-- inside the last hour would make it a queue-cancel button.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.notification_admin_requests DROP CONSTRAINT chk_notification_admin_requests_verdict;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT chk_notification_admin_requests_verdict CHECK (
  (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_id_collision'))
  OR (action = 'channel_kill_cleared' AND verdict IN ('cleared', 'rejected_not_killed', 'rejected_stale_kill', 'rejected_backlog_grew'))
  OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
  OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
  OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
  OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
  OR (action = 'backlog_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_path_inert', 'rejected_unknown_path'))
  -- 'rejected_threshold_too_low' becomes 'rejected_cutoff_too_recent' (the input is a cutoff now);
  -- 'rejected_stale_preview' is the new refusal that makes the confirmation mean something.
  OR (action = 'stale_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_cutoff_too_recent', 'rejected_stale_preview'))
);

-- ── the read: what a disposal would take, AND the cutoff that defines it ─────────────────────
DROP FUNCTION IF EXISTS public.admin_stale_outbox_preview(text, int);
CREATE OR REPLACE FUNCTION public.admin_stale_outbox_preview(
  p_channel text,
  p_older_than_minutes int
) RETURNS TABLE (channel text, older_than_minutes int, cutoff_at timestamptz,
                 pending int, abandoned_processing int, oldest timestamptz)
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
  SELECT p_channel, p_older_than_minutes, v_cut,
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
  'N7/audit: what a long-outage disposal would take on this channel — pending rows and ABANDONED processing rows (a live lease is never counted) older than the threshold, the oldest one, and the EXACT cutoff instant that defines the set. The cutoff is what the operator hands back to admin_dispose_stale_outbox, so the act works on the snapshot they saw rather than on a window that has slid forward since.';
REVOKE ALL ON FUNCTION public.admin_stale_outbox_preview(text, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_stale_outbox_preview(text, int) TO authenticated, service_role;

-- ── the act: bound to that snapshot, and fail-closed when it moved ───────────────────────────
DROP FUNCTION IF EXISTS public.admin_dispose_stale_outbox(text, int, text, uuid, int);
CREATE OR REPLACE FUNCTION public.admin_dispose_stale_outbox(
  p_channel text,
  p_cutoff_at timestamptz,
  p_expected_pending int,
  p_expected_abandoned int,
  p_reason text,
  p_request_id uuid,
  p_limit int DEFAULT 500
) RETURNS TABLE (verdict text, disposed int, observed_pending int, observed_abandoned int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_fp text;
  v_replay text;
  v_n int := 0;
  v_limit int := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_pending int;
  v_abandoned int;
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
  IF p_cutoff_at IS NULL OR p_expected_pending IS NULL OR p_expected_abandoned IS NULL THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: the cutoff and both expected counts come from admin_stale_outbox_preview and are required — this call decides what to destroy, and it may only destroy what was shown';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_dispose_stale_outbox: a reason (3-500 chars) is required';
  END IF;

  -- the whole DECISION is fingerprinted — cutoff, both counts, batch size. A retry that changes
  -- any of them is a different act wearing the same request id.
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'stale_dispose', 'channel', p_channel, 'cutoff_at', p_cutoff_at,
    'expected_pending', p_expected_pending, 'expected_abandoned', p_expected_abandoned,
    'reason', btrim(p_reason), 'limit', v_limit));
  v_replay := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'stale_dispose', p_channel, p_reason, v_fp);
  IF v_replay IS NOT NULL THEN
    verdict := v_replay; disposed := 0; observed_pending := 0; observed_abandoned := 0;
    RETURN NEXT; RETURN;
  END IF;

  IF p_cutoff_at > now() - make_interval(mins => 60) THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'stale_dispose', p_channel, p_reason,
      format('cutoff %s is inside the last 60 minutes', p_cutoff_at));
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'rejected_cutoff_too_recent');
    disposed := 0; observed_pending := 0; observed_abandoned := 0; RETURN NEXT; RETURN;
  END IF;

  -- MAKE THE COUNT TRUE. SHARE ROW EXCLUSIVE blocks the producers and workers that could change
  -- the set, and conflicts with itself so two disposals serialize rather than deadlocking on the
  -- lock upgrade a plain SHARE would need before the UPDATE below.
  LOCK TABLE public.notification_outbox IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) FILTER (WHERE o.status = 'pending')::int,
         count(*) FILTER (WHERE o.status = 'processing')::int
    INTO v_pending, v_abandoned
    FROM public.notification_outbox o
   WHERE o.channel = p_channel
     AND o.delivery_mode IS DISTINCT FROM 'digest'
     AND o.updated_at < p_cutoff_at
     AND (o.status = 'pending'
          OR (o.status = 'processing' AND o.locked_at IS NOT NULL AND o.locked_at < p_cutoff_at));

  IF v_pending IS DISTINCT FROM p_expected_pending OR v_abandoned IS DISTINCT FROM p_expected_abandoned THEN
    -- EITHER direction. A shrink is not "safe" — it means the set the operator consented to is not
    -- the set in front of us, and consent to destroy 40 rows is not consent to destroy 37 others.
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'stale_dispose', p_channel, p_reason,
      format('the eligible set changed since the preview: expected %s pending / %s abandoned, found %s / %s',
             p_expected_pending, p_expected_abandoned, v_pending, v_abandoned));
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'rejected_stale_preview');
    disposed := 0; observed_pending := v_pending; observed_abandoned := v_abandoned; RETURN NEXT; RETURN;
  END IF;

  IF v_pending + v_abandoned = 0 THEN
    verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'nothing_to_dispose');
    disposed := 0; observed_pending := 0; observed_abandoned := 0; RETURN NEXT; RETURN;
  END IF;

  WITH doomed AS (
    SELECT o.id
      FROM public.notification_outbox o
     WHERE o.channel = p_channel
       AND o.delivery_mode IS DISTINCT FROM 'digest'
       AND o.updated_at < p_cutoff_at
       AND (o.status = 'pending'
            -- an ABANDONED lease only: a row a worker holds right now may be mid-provider-call,
            -- and terminalising that is a decision taken over the top of one already in flight
            OR (o.status = 'processing' AND o.locked_at IS NOT NULL AND o.locked_at < p_cutoff_at))
     ORDER BY o.updated_at
     LIMIT v_limit
     -- no SKIP LOCKED: under SHARE ROW EXCLUSIVE nothing else holds these rows, and skipping a
     -- locked one would silently dispose of fewer than the number just asserted
     FOR UPDATE
  )
  UPDATE public.notification_outbox o
     SET status = 'skipped', skip_reason = 'stale_after_outage',
         locked_at = NULL, locked_by = NULL, updated_at = now()
    FROM doomed
   WHERE o.id = doomed.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'stale_dispose', p_channel, v_n::text, 'stale_after_outage', 'applied', btrim(p_reason));
  verdict := public.notif_admin_record_verdict(auth.uid(), p_request_id, 'stale_dispose', v_fp, 'disposed');
  disposed := v_n; observed_pending := v_pending; observed_abandoned := v_abandoned; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_dispose_stale_outbox(text, timestamptz, int, int, text, uuid, int) IS
  'N7/audit: the sanctioned long-outage recovery — terminally skip instant rows an outage left behind (skip_reason stale_after_outage) so resuming cannot re-send an attempt the provider may already have accepted outside its dedup window. SNAPSHOT-BOUND: it takes the cutoff and both counts from admin_stale_outbox_preview, locks the outbox SHARE ROW EXCLUSIVE, and refuses as rejected_stale_preview if the eligible set has changed in either direction. Admin fail-closed, request-id idempotent (the whole decision is fingerprinted), bounded <=1000, audited with the count. Never touches a digest member, a live lease, or a cutoff inside the last hour.';
REVOKE ALL ON FUNCTION public.admin_dispose_stale_outbox(text, timestamptz, int, int, text, uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dispose_stale_outbox(text, timestamptz, int, int, text, uuid, int) TO authenticated, service_role;
