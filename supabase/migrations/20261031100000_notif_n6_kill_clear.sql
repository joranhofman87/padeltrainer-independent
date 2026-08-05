-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N6 — CLEARING A KILL: the procedure the documentation promised and nobody had written.
--
-- A kill switch stops a channel immediately, and until now the only way back was "guard-disable
-- + DELETE as superuser" — which is not a procedure, it is an invitation to improvise at 2am on
-- the one control that decides whether mail resumes. The guard was right to forbid the API path;
-- what was missing is a REVIEWED path.
--
-- ── WHY IT IS SHAPED LIKE THIS ──────────────────────────────────────────────────────────────
--   * It is the runbook's, not the admin surface's. Killing is a stopping control and belongs on
--     the page; UN-killing decides that mail resumes, and this programme keeps that class of
--     decision behind the owner's own gate. Granted to service_role only, so the artifact can
--     call it and no UI can.
--   * It demands the EXACT kill it is clearing (the kill's own request id). An operator who read
--     one incident's kill on screen and clears whatever is there now would otherwise re-open a
--     channel someone killed for a different reason thirty seconds ago.
--   * It reports the BACKLOG the kill accumulated, because clearing is when that queue becomes
--     sendable. The artifact prints it before it commits, and the runbook makes the operator
--     acknowledge it — disposing of it is a separate, deliberate act.
--   * The kill row is deleted, but the DECISION is not: the audit row that recorded the kill
--     stays, and clearing writes its own. The evidence chain reads kill → clear, both immutable.
--   * The guard still refuses every other DELETE. It permits exactly one: a delete inside a
--     transaction that has published THIS row's request id into a transaction-local setting,
--     which only the function below does. An owner with SQL can of course set it — that is not
--     the threat model; ordinary code paths and mistakes are.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── the audit + registry vocabulary grows by one action ─────────────────────────────────────
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT notification_admin_audit_action_check;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT notification_admin_audit_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT chk_notification_admin_audit_coherent;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT chk_notification_admin_audit_coherent
  CHECK (
    (action = 'channel_kill'
      AND target IN ('email', 'whatsapp') AND new_value = 'killed'
      AND ((outcome = 'applied' AND old_value = 'live')
        OR (outcome = 'already_killed' AND old_value = 'killed')))
    -- the way back: killed → live, and only ever 'applied' (there is no idempotent second clear —
    -- the row it names is gone, so a replay is answered from the registry, not by acting again)
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
  );
ALTER TABLE public.notification_admin_rejected_attempts DROP CONSTRAINT notification_admin_rejected_attempts_action_check;
ALTER TABLE public.notification_admin_rejected_attempts ADD CONSTRAINT notification_admin_rejected_attempts_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT notification_admin_requests_action_check;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT notification_admin_requests_action_check
  CHECK (action IN ('channel_kill', 'channel_kill_cleared', 'circuit_reset', 'group_cancel',
                    'orphan_resolve', 'orphan_requeue', 'backlog_dispose'));
ALTER TABLE public.notification_admin_requests DROP CONSTRAINT chk_notification_admin_requests_verdict;
ALTER TABLE public.notification_admin_requests ADD CONSTRAINT chk_notification_admin_requests_verdict CHECK (
  (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_id_collision'))
  OR (action = 'channel_kill_cleared' AND verdict IN ('cleared', 'rejected_not_killed', 'rejected_stale_kill'))
  OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
  OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
  OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
  OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
  OR (action = 'backlog_dispose' AND verdict IN ('disposed', 'nothing_to_dispose', 'rejected_path_inert', 'rejected_unknown_path'))
);

-- ── the guard: still SET-ONLY, with exactly one reviewed way back ────────────────────────────
CREATE OR REPLACE FUNCTION public.notif_channel_kill_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE'
     AND nullif(current_setting('notif.kill_clear_request', true), '') IS NOT DISTINCT FROM OLD.request_id::text THEN
    -- the ONE permitted removal: a transaction that has published the exact kill's request id,
    -- which only clear_notification_channel_kill does — and it writes the audit row first, so a
    -- cleared kill can never be a kill that quietly stopped existing.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'notification_channel_kill_switches is SET-ONLY: no %. Clearing a kill re-opens a live channel — use clear_notification_channel_kill(), which demands the exact kill, audits the clearing and reports the backlog it releases', TG_OP;
END;
$$;

COMMENT ON TABLE public.notification_channel_kill_switches IS
  'N4 M2: a row here KILLS its channel — the instant claim refuses (zero ledger mutations), the digest claim/materialize idle, begin parks, and the workers'' pre-provider re-check releases already-claimed rows. SET-only through every API path; the ONE way back is clear_notification_channel_kill() (N6), a service-role/runbook function that demands the exact kill''s request id, audits the clearing and reports the backlog the kill accumulated.';

-- ── clearing, as a decision with the same shape as every other ───────────────────────────────
CREATE OR REPLACE FUNCTION public.clear_notification_channel_kill(
  p_channel text,
  p_expected_kill_request_id uuid,   -- the kill you READ: a different one is a different incident
  p_reason text,
  p_request_id uuid
) RETURNS TABLE (verdict text, pending_released int, pending_released_capped boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  k public.notification_channel_kill_switches%ROWTYPE;
  CAP constant int := 10000;
  v_n bigint := 0;
  -- THE RUNBOOK IS AN ACTOR. The audit and the request registry are keyed by (actor, request_id),
  -- and psql carries no JWT — leaving it NULL would write an actor-less audit row (the table
  -- refuses one, correctly) and would silently break replay, because (NULL, id) never matches
  -- itself. A stable, documented sentinel makes the runbook path behave exactly like every other
  -- decision: one id, one verdict, a real replay.
  RUNBOOK constant uuid := '00000000-0000-0000-0000-000000000000';
  v_actor uuid := coalesce(auth.uid(), RUNBOOK);
  v_fp text;
  v_replay text;
BEGIN
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'clear_notification_channel_kill: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL OR p_expected_kill_request_id IS NULL THEN
    RAISE EXCEPTION 'clear_notification_channel_kill: both a caller-generated request_id and the kill''s own request id are required — clearing "whatever kill is there" re-opens a channel someone may have killed seconds ago for another reason';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'clear_notification_channel_kill: a reason (3-500 chars) is required';
  END IF;

  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'channel_kill_cleared', 'channel', p_channel,
    'kill_request_id', p_expected_kill_request_id, 'reason', btrim(p_reason)));
  v_replay := public.notif_admin_replay_gate(v_actor, p_request_id, 'channel_kill_cleared', p_channel, p_reason, v_fp);
  IF v_replay IS NOT NULL THEN
    verdict := v_replay; pending_released := 0; pending_released_capped := false; RETURN NEXT; RETURN;
  END IF;

  -- the same per-channel lock every kill-aware authority takes, so a worker cannot be mid-claim
  -- with a stale view while the kill disappears underneath it
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));

  SELECT * INTO k FROM public.notification_channel_kill_switches WHERE channel = p_channel;
  IF NOT FOUND THEN
    PERFORM public.notif_admin_record_refusal(v_actor, p_request_id, 'channel_kill_cleared', p_channel, p_reason,
      'the channel is not killed');
    verdict := public.notif_admin_record_verdict(v_actor, p_request_id, 'channel_kill_cleared', v_fp, 'rejected_not_killed');
    pending_released := 0; pending_released_capped := false; RETURN NEXT; RETURN;
  END IF;
  IF k.request_id IS DISTINCT FROM p_expected_kill_request_id THEN
    PERFORM public.notif_admin_record_refusal(v_actor, p_request_id, 'channel_kill_cleared', p_channel, p_reason,
      format('stale kill: the live kill is %s (%s), not the one you read (%s)', k.request_id, k.reason, p_expected_kill_request_id));
    verdict := public.notif_admin_record_verdict(v_actor, p_request_id, 'channel_kill_cleared', v_fp, 'rejected_stale_kill');
    pending_released := 0; pending_released_capped := false; RETURN NEXT; RETURN;
  END IF;

  -- WHAT THIS RELEASES: everything that queued while the channel was dead. Saturating, like every
  -- other count in this system — the operator needs "is there a pile", not an exact tally.
  SELECT count(*) INTO v_n FROM (
    SELECT 1 FROM public.notification_outbox o
     WHERE o.channel = p_channel AND o.status = 'pending' LIMIT CAP + 1) x;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (v_actor, p_request_id, 'channel_kill_cleared', p_channel, 'killed', 'live', 'applied', btrim(p_reason));

  PERFORM set_config('notif.kill_clear_request', k.request_id::text, true);   -- the guard's one key
  DELETE FROM public.notification_channel_kill_switches WHERE channel = p_channel;
  PERFORM set_config('notif.kill_clear_request', '', true);

  verdict := public.notif_admin_record_verdict(v_actor, p_request_id, 'channel_kill_cleared', v_fp, 'cleared');
  pending_released := least(v_n, CAP)::int; pending_released_capped := v_n > CAP;
  RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.clear_notification_channel_kill(text, uuid, text, uuid) IS
  'N6: the ONE reviewed way to clear a channel kill — service-role/runbook only (un-killing decides that mail resumes, which is an owner-gated class of decision). Demands the exact kill''s request id (a different live kill is a different incident and is refused), audits the clearing beside the original kill, and returns how many pending rows the clear releases so the operator can decide on disposal before mail moves.';
REVOKE ALL ON FUNCTION public.clear_notification_channel_kill(text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_notification_channel_kill(text, uuid, text, uuid) TO service_role;
