-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M5 — SEND-ENABLING RECOVERY (contract findings 6, 7, 8; CRITICAL 3) under the pinned
-- rules: the global (actor, request_id) audit-lock ordering everywhere; EVERY recovery verdict
-- — including stale expected-state refusals — durably audited or recorded as a rejected
-- attempt (on the RETURN path, never a RAISE, which would roll the record back); and recovery
-- NEVER bypasses an active channel kill, an unresolved deliberate invocation, or
-- uncertainty/correlation evidence.
--
-- WHAT IS DELIBERATELY ABSENT (CRITICAL 3): there is NO generic outbox/group retry RPC. A
-- stable payload + idempotency key protect only inside the provider's replay window; outside
-- it a "retry" is a duplicate send. Until the ledger can positively classify "definitively
-- rejected before provider acceptance", retry does not exist on this surface.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── the audit vocabulary grows: three recovery actions + their coherence ────────────────────
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT notification_admin_audit_action_check;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT notification_admin_audit_action_check
  CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue'));
ALTER TABLE public.notification_admin_audit DROP CONSTRAINT notification_admin_audit_outcome_check;
ALTER TABLE public.notification_admin_audit ADD CONSTRAINT notification_admin_audit_outcome_check
  CHECK (outcome IN ('applied', 'already_killed', 'already_closed'));
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
    OR (action IN ('orphan_resolve', 'orphan_requeue')
      AND outcome = 'applied'
      AND old_value IN ('quarantined', 'reconciling')
      AND new_value IN ('resolved', 'requeued'))
  );
ALTER TABLE public.notification_admin_rejected_attempts DROP CONSTRAINT notification_admin_rejected_attempts_action_check;
ALTER TABLE public.notification_admin_rejected_attempts ADD CONSTRAINT notification_admin_rejected_attempts_action_check
  CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue'));
ALTER TABLE public.notification_admin_rejected_attempts DROP CONSTRAINT chk_notification_admin_rejected_coherent;
ALTER TABLE public.notification_admin_rejected_attempts ADD CONSTRAINT chk_notification_admin_rejected_coherent
  CHECK (action NOT IN ('channel_kill', 'circuit_reset') OR target IN ('email', 'whatsapp'));

-- ── the REQUEST REGISTRY — one id, one COMPLETE decision input, one first verdict ───────────
-- The audit table records decisions; the registry records ID CONSUMPTION — including refusals.
-- Without it, a stale-confirmation refusal left the id unconsumed, and a 'corrected' retry
-- under the SAME id passed the replay gate and reset the circuit: request-id-per-decision
-- defeated on the one send-enabling control. The fingerprint is the deterministic canonical
-- form of EVERY action-specific input (expected state/reason/version included), so a retry
-- that changed ANY confirmation field is conflicting reuse, never a replay.
CREATE TABLE public.notification_admin_requests (
  actor       uuid NOT NULL,
  request_id  uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('channel_kill', 'circuit_reset', 'group_cancel', 'orphan_resolve', 'orphan_requeue')),
  -- ALWAYS a sha-256 digest of the canonical jsonb input — never raw operator/provider text
  -- (raw concatenation was delimiter-collidable, sentinel-collidable, unbounded, and leaked
  -- circuit reasons through conflict messages)
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  verdict     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor, request_id),
  -- schema-level verdict coherence: an owner-direct row cannot bind an impossible first
  -- verdict (say, circuit_reset → 'killed') that an exact replay would then return forever
  CONSTRAINT chk_notification_admin_requests_verdict CHECK (
    (action = 'channel_kill'   AND verdict IN ('killed', 'already_killed', 'rejected_request_reuse'))
    OR (action = 'circuit_reset' AND verdict IN ('reset', 'already_closed', 'rejected_channel_killed', 'rejected_invocation_open', 'rejected_correlation_mismatch', 'rejected_stale_state'))
    OR (action = 'group_cancel'  AND verdict IN ('cancelled', 'rejected_not_found', 'rejected_not_pre_dispatch', 'rejected_stale_state'))
    OR (action = 'orphan_resolve' AND verdict IN ('resolved', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_not_permanent', 'rejected_not_resolvable'))
    OR (action = 'orphan_requeue' AND verdict IN ('requeued', 'rejected_not_found', 'rejected_not_quarantined', 'rejected_permanent_reason', 'rejected_not_requeueable'))
  )
);

-- the ONE canonical fingerprint: jsonb (key-order canonical, real JSON nulls — no sentinel to
-- collide with a literal string) rendered to text and digested
CREATE OR REPLACE FUNCTION public.notif_admin_fingerprint(p_input jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(p_input::text, 'UTF8')), 'hex');
$$;
REVOKE ALL ON FUNCTION public.notif_admin_fingerprint(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_admin_fingerprint(jsonb) TO service_role;
CREATE TRIGGER trg_notif_admin_requests_guard
  BEFORE UPDATE OR DELETE ON public.notification_admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.notif_admin_audit_guard();
CREATE TRIGGER trg_notif_admin_requests_no_truncate
  BEFORE TRUNCATE ON public.notification_admin_requests
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_admin_audit_guard();
COMMENT ON TABLE public.notification_admin_requests IS
  'N4 M5: the immutable request registry — (actor, request_id) bound to the COMPLETE canonical decision input (fingerprint) and its FIRST verdict, refusals included. Exact retries replay that verdict; any changed input is conflicting reuse and can never proceed.';
REVOKE ALL ON public.notification_admin_requests FROM PUBLIC, anon, authenticated, service_role;

-- Returns NULL → the id is fresh, the caller proceeds (global lock now HELD to commit) and
-- MUST record its verdict via notif_admin_record_verdict on every exit path.
-- Returns the FIRST verdict → exact replay (fingerprint match), no new records.
-- Returns 'rejected_request_reuse' → the id is bound to a DIFFERENT input, recorded.
CREATE OR REPLACE FUNCTION public.notif_admin_replay_gate(
  p_actor uuid, p_request_id uuid, p_action text, p_target text, p_reason text, p_fingerprint text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE r public.notification_admin_requests%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-admin-req:' || p_actor::text || ':' || p_request_id::text, 0));
  SELECT * INTO r FROM public.notification_admin_requests
   WHERE actor = p_actor AND request_id = p_request_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.action = p_action AND r.fingerprint = p_fingerprint THEN
    RETURN r.verdict;
  END IF;
  INSERT INTO public.notification_admin_rejected_attempts (actor, request_id, action, target, reason, conflict_with)
  VALUES (p_actor, p_request_id, p_action, p_target, btrim(p_reason),
          format('id already bound to a %s decision with first verdict %s — a request id names ONE decision', r.action, r.verdict));
  RETURN 'rejected_request_reuse';
END;
$$;
REVOKE ALL ON FUNCTION public.notif_admin_replay_gate(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_admin_replay_gate(uuid, uuid, text, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.notif_admin_record_verdict(
  p_actor uuid, p_request_id uuid, p_action text, p_fingerprint text, p_verdict text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict)
  VALUES (p_actor, p_request_id, p_action, p_fingerprint, p_verdict);
  RETURN p_verdict;
END;
$$;
REVOKE ALL ON FUNCTION public.notif_admin_record_verdict(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_admin_record_verdict(uuid, uuid, text, text, text) TO service_role;

-- a recovery REFUSAL is a verdict too: record it, on the return path (the M3 lesson)
CREATE OR REPLACE FUNCTION public.notif_admin_record_refusal(
  p_actor uuid, p_request_id uuid, p_action text, p_target text, p_reason text, p_conflict text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notification_admin_rejected_attempts (actor, request_id, action, target, reason, conflict_with)
  VALUES (p_actor, p_request_id, p_action, p_target, btrim(p_reason), left(p_conflict, 500));
END;
$$;
REVOKE ALL ON FUNCTION public.notif_admin_record_refusal(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_admin_record_refusal(uuid, uuid, text, text, text, text) TO service_role;

-- ── 1. circuit reset (finding 6) — the ONE send-enabling control, maximally guarded ─────────
CREATE OR REPLACE FUNCTION public.admin_reset_notification_circuit(
  p_channel text,
  p_expected_state text,
  p_expected_reason text,
  p_expected_tripped_at timestamptz,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cb public.notification_provider_circuit%ROWTYPE;
  v text;
  v_fp text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_reset_notification_circuit: platform admin only';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_reset_notification_circuit: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_reset_notification_circuit: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_reset_notification_circuit: a reason (3-500 chars) is required';
  END IF;

  -- the fingerprint carries EVERY confirmation input: a retry that changed the expected
  -- state/reason/version is a DIFFERENT decision, never a replay
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'circuit_reset', 'channel', p_channel, 'reason', btrim(p_reason),
    'expected_state', p_expected_state, 'expected_reason', p_expected_reason,
    'expected_tripped_at', to_char(p_expected_tripped_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'circuit_reset', p_channel, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  -- NEVER past a kill: closing a circuit on a killed channel would queue send authority
  -- behind a single runbook DELETE. The kill lock orders this against an in-flight kill.
  IF public.notif_channel_kill_gate(p_channel) THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'circuit_reset', p_channel, p_reason, 'channel is killed');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'rejected_channel_killed');
  END IF;
  -- NEVER inside a deliberate invocation's evidence window — under M1's OWN single-flight lock,
  -- held through the reset: a plain EXISTS could pass while an invoker's open() was mid-flight
  -- (lock held, row uncommitted) and close the circuit inside the window it never saw.
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));
  IF EXISTS (SELECT 1 FROM public.notification_worker_invocations i WHERE i.status IN ('pending', 'started')) THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'circuit_reset', p_channel, p_reason, 'a deliberate worker invocation is unresolved');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'rejected_invocation_open');
  END IF;

  SELECT * INTO cb FROM public.notification_provider_circuit WHERE channel = p_channel FOR UPDATE;
  IF NOT FOUND OR cb.state = 'closed' THEN
    -- a no-op decision, audited as such (the circuit row may simply not exist yet)
    INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
    VALUES (auth.uid(), p_request_id, 'circuit_reset', p_channel, 'closed', 'closed', 'already_closed', btrim(p_reason));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'already_closed');
  END IF;
  -- correlation_mismatch is a MANUAL HOLD over evidence, not a tripped breaker: the provider
  -- accepted a message the group is not bound to, and closing the circuit cannot make that
  -- true. Categorical refusal (roadmap:284) — resolve the evidence first.
  IF cb.reason = 'correlation_mismatch' THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'circuit_reset', p_channel, p_reason,
      format('correlation_mismatch hold (tripped %s) — evidence must be resolved, a reset cannot make it true', cb.tripped_at));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'rejected_correlation_mismatch');
  END IF;
  -- the TYPED confirmation: the caller must name exactly the trip it is clearing — a stale UI
  -- that saw an earlier trip must not clear a NEWER one (tripped_at is the version)
  IF cb.state IS DISTINCT FROM p_expected_state
     OR cb.reason IS DISTINCT FROM p_expected_reason
     OR cb.tripped_at IS DISTINCT FROM p_expected_tripped_at THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'circuit_reset', p_channel, p_reason,
      format('stale confirmation: circuit is %s/%s tripped %s, caller expected %s/%s tripped %s',
             cb.state, cb.reason, cb.tripped_at, p_expected_state, p_expected_reason, p_expected_tripped_at));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'rejected_stale_state');
  END IF;

  UPDATE public.notification_provider_circuit
     SET state = 'closed', reason = NULL, tripped_at = NULL, retry_at = NULL,
         probe_group_id = NULL, probe_attempt_id = NULL, probe_locked_at = NULL
   WHERE channel = p_channel;
  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'circuit_reset', p_channel, cb.state, 'closed', 'applied', btrim(p_reason));
  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'circuit_reset', v_fp, 'reset');
END;
$$;

COMMENT ON FUNCTION public.admin_reset_notification_circuit(text, text, text, timestamptz, text, uuid) IS
  'N4 M5 (finding 6): the send-enabling circuit reset. Ordering: global request lock → replay/reject → kill gate (never past a kill) → invocation gate (never inside an evidence window) → row lock → categorical correlation_mismatch refusal → exact typed confirmation (state+reason+tripped_at: a stale UI cannot clear a re-trip) → reset + audit. EVERY refusal is recorded as a rejected attempt on the return path.';
REVOKE ALL ON FUNCTION public.admin_reset_notification_circuit(text, text, text, timestamptz, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reset_notification_circuit(text, text, text, timestamptz, text, uuid) TO authenticated, service_role;

-- the finding-6 preview: what a reset would RELEASE — read-only, admin-gated, saturating
CREATE OR REPLACE FUNCTION public.admin_preview_circuit_release(p_channel text) RETURNS TABLE (
  metric text, value bigint, capped boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE CAP constant int := 10000; v bigint;
BEGIN
  PERFORM public.notif_admin_gate();
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM public.notification_digest_groups g
     WHERE g.channel = p_channel AND g.state = 'request_ready' AND g.terminal_at IS NULL LIMIT CAP + 1) b;
  metric := 'digest_groups_request_ready'; value := least(v, CAP); capped := v > CAP; RETURN NEXT;
  SELECT count(*) INTO v FROM (
    SELECT 1 FROM public.notification_outbox o
     WHERE o.channel = p_channel AND o.status = 'pending'
       AND o.delivery_mode IS DISTINCT FROM 'digest' LIMIT CAP + 1) b;
  metric := 'instant_rows_pending'; value := least(v, CAP); capped := v > CAP; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.admin_preview_circuit_release(text) IS
  'N4 M5: what closing the circuit would release — request_ready digest groups and pending instant rows on the channel. Read-only, saturating, admin fail-closed.';
REVOKE ALL ON FUNCTION public.admin_preview_circuit_release(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_circuit_release(text) TO authenticated, service_role;

-- ── 2. group cancel (finding 7) — pre-dispatch only, evidence always wins ───────────────────
CREATE OR REPLACE FUNCTION public.admin_cancel_digest_group(
  p_group_id uuid,
  p_expected_state text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  g public.notification_digest_groups%ROWTYPE;
  v text;
  v_fp text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_cancel_digest_group: platform admin only';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_cancel_digest_group: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_cancel_digest_group: a reason (3-500 chars) is required';
  END IF;

  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'group_cancel', 'group_id', p_group_id, 'reason', btrim(p_reason),
    'expected_state', p_expected_state));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'group_cancel', p_group_id::text, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  SELECT * INTO g FROM public.notification_digest_groups WHERE id = p_group_id FOR UPDATE;
  IF NOT FOUND THEN
    -- a valid, authenticated post-validation decision — it CONSUMES the id like every other
    -- verdict (a raise here would leave the id fresh and reusable, the round-2 defect shape)
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'group_cancel', p_group_id::text, p_reason, 'group does not exist');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'group_cancel', v_fp, 'rejected_not_found');
  END IF;
  -- ENUMERATED pre-dispatch states, and EVERY piece of send/uncertainty evidence refuses —
  -- a cancel must never overwrite what may already have reached a provider
  IF g.state NOT IN ('pending', 'leased', 'prepared', 'request_ready')
     OR g.first_send_at IS NOT NULL
     OR g.provider_attempts_started > 0
     OR g.provider_message_id IS NOT NULL
     OR g.uncertain_since IS NOT NULL THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'group_cancel', p_group_id::text, p_reason,
      format('not pre-dispatch: state %s, attempts %s, provider id %s, first send %s, uncertain since %s',
             g.state, g.provider_attempts_started, coalesce(g.provider_message_id, '<none>'), g.first_send_at, g.uncertain_since));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'group_cancel', v_fp, 'rejected_not_pre_dispatch');
  END IF;
  IF g.state IS DISTINCT FROM p_expected_state THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'group_cancel', p_group_id::text, p_reason,
      format('stale confirmation: group is %s, caller expected %s', g.state, p_expected_state));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'group_cancel', v_fp, 'rejected_stale_state');
  END IF;

  -- the state machine's OWN terminalization — members are skipped with the reason, attempt
  -- and provider history preserved (nothing is deleted)
  PERFORM notif_digest_finalize_group(p_group_id, 'retry_stopped', 'admin_cancel', now());
  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'group_cancel', p_group_id::text, g.state, 'retry_stopped', 'applied', btrim(p_reason));
  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'group_cancel', v_fp, 'cancelled');
END;
$$;

COMMENT ON FUNCTION public.admin_cancel_digest_group(uuid, text, text, uuid) IS
  'N4 M5 (finding 7): cancel a digest group from the ENUMERATED pre-dispatch states only (pending/leased/prepared/request_ready) with zero send/uncertainty evidence — any attempt count, provider id, first_send_at or uncertainty refuses (recorded). Locked, expected-state compared, terminalized through the state machine''s own finalize (history preserved), audited.';
REVOKE ALL ON FUNCTION public.admin_cancel_digest_group(uuid, text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_cancel_digest_group(uuid, text, text, uuid) TO authenticated, service_role;

-- ── 3. the orphan wrappers (finding 8) — the existing audited recovery fns, admin-keyed ─────
CREATE OR REPLACE FUNCTION public.admin_resolve_notification_orphan(
  p_resend_event_id text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v text; v_fp text; v_old text; v_code text; v_ok boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_resolve_notification_orphan: platform admin only';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_resolve_notification_orphan: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_resolve_notification_orphan: a reason (3-500 chars) is required';
  END IF;
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'orphan_resolve', 'resend_event_id', p_resend_event_id, 'reason', btrim(p_reason)));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  SELECT CASE WHEN s.quarantined THEN 'quarantined' ELSE 'reconciling' END, s.last_error_code
    INTO v_old, v_code
    FROM public.notification_orphan_reconcile_state s WHERE s.resend_event_id = p_resend_event_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, p_reason, 'no orphan state exists for this event');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_resolve', v_fp, 'rejected_not_found');
  END IF;
  -- classification PRE-CHECKS mirror the inner fn's rules so every refusal is a RECORDED typed
  -- verdict — the inner fn's own RAISEs remain as belt, but a raise would roll the record back
  IF v_old <> 'quarantined' THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, p_reason, 'not quarantined — active/transient work cannot be resolved');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_resolve', v_fp, 'rejected_not_quarantined');
  END IF;
  IF public.notification_orphan_reconcile_permanent_reason(v_code) IS NOT TRUE THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, p_reason,
      format('reason %s is not a KNOWN permanent reason — use requeue for transient', coalesce(v_code, '<null>')));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_resolve', v_fp, 'rejected_not_permanent');
  END IF;
  -- the EXISTING audited recovery fn does the work (its own action log rows included);
  -- evidence is retained — resolve never deletes provider history
  v_ok := public.notification_orphan_reconcile_resolve(p_resend_event_id, 'admin:' || auth.uid()::text, btrim(p_reason));
  IF NOT v_ok THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, p_reason, 'the recovery function refused');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_resolve', v_fp, 'rejected_not_resolvable');
  END IF;
  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'orphan_resolve', p_resend_event_id, v_old, 'resolved', 'applied', btrim(p_reason));
  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_resolve', v_fp, 'resolved');
END;
$$;

COMMENT ON FUNCTION public.admin_resolve_notification_orphan(text, text, uuid) IS
  'N4 M5 (finding 8): admin wrapper over the EXISTING audited orphan resolve — keyed by resend_event_id, replay-gated, every refusal recorded, evidence never deleted.';
REVOKE ALL ON FUNCTION public.admin_resolve_notification_orphan(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_notification_orphan(text, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_requeue_notification_orphan(
  p_resend_event_id text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v text; v_fp text; v_old text; v_code text; v_ok boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_requeue_notification_orphan: platform admin only';
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_requeue_notification_orphan: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_requeue_notification_orphan: a reason (3-500 chars) is required';
  END IF;
  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'orphan_requeue', 'resend_event_id', p_resend_event_id, 'reason', btrim(p_reason)));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  SELECT CASE WHEN s.quarantined THEN 'quarantined' ELSE 'reconciling' END, s.last_error_code
    INTO v_old, v_code
    FROM public.notification_orphan_reconcile_state s WHERE s.resend_event_id = p_resend_event_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, p_reason, 'no orphan state exists for this event');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_requeue', v_fp, 'rejected_not_found');
  END IF;
  IF v_old <> 'quarantined' THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, p_reason, 'not quarantined — the worker still owns it');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_requeue', v_fp, 'rejected_not_quarantined');
  END IF;
  IF public.notification_orphan_reconcile_permanent_reason(v_code) IS TRUE THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, p_reason,
      format('reason %s is PERMANENT — a requeue would loop forever; resolve it instead', v_code));
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_requeue', v_fp, 'rejected_permanent_reason');
  END IF;
  v_ok := public.notification_orphan_reconcile_requeue(p_resend_event_id, 'admin:' || auth.uid()::text, btrim(p_reason));
  IF NOT v_ok THEN
    PERFORM public.notif_admin_record_refusal(auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, p_reason, 'the recovery function refused (not quarantined or not requeueable)');
    RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_requeue', v_fp, 'rejected_not_requeueable');
  END IF;
  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'orphan_requeue', p_resend_event_id, v_old, 'requeued', 'applied', btrim(p_reason));
  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'orphan_requeue', v_fp, 'requeued');
END;
$$;

COMMENT ON FUNCTION public.admin_requeue_notification_orphan(text, text, uuid) IS
  'N4 M5 (finding 8): admin wrapper over the EXISTING audited orphan requeue (transient classifications back to the worker''s reconcile queue) — keyed by resend_event_id, replay-gated, every refusal recorded.';
REVOKE ALL ON FUNCTION public.admin_requeue_notification_orphan(text, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_requeue_notification_orphan(text, text, uuid) TO authenticated, service_role;

-- ── admin_activate_channel_kill joins the registry — ONE id authority across the surface ────
-- (Forward-only replace of the M3 definition: external behavior identical, but the id is now
-- consumed in the same registry as every recovery decision, so a kill id can never be reused
-- for a recovery — or vice versa — without the typed reuse refusal.)
CREATE OR REPLACE FUNCTION public.admin_activate_channel_kill(
  p_channel text,
  p_reason text,
  p_request_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
  v_fp text;
  v_outcome text;
  v_old text;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: platform admin only';
  END IF;
  IF p_channel NOT IN ('email', 'whatsapp') THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: unknown channel %', p_channel;
  END IF;
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a caller-generated request_id is required';
  END IF;
  IF length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'admin_activate_channel_kill: a reason (3-500 chars) is required';
  END IF;

  v_fp := public.notif_admin_fingerprint(jsonb_build_object(
    'action', 'channel_kill', 'channel', p_channel, 'reason', btrim(p_reason)));
  v := public.notif_admin_replay_gate(auth.uid(), p_request_id, 'channel_kill', p_channel, p_reason, v_fp);
  IF v IS NOT NULL THEN RETURN v; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('notif-channel-kill:' || p_channel, 0));
  IF EXISTS (SELECT 1 FROM public.notification_channel_kill_switches k WHERE k.channel = p_channel) THEN
    v_old := 'killed'; v_outcome := 'already_killed';
  ELSE
    v_old := 'live'; v_outcome := 'applied';
    INSERT INTO public.notification_channel_kill_switches (channel, activated_by, reason, request_id)
    VALUES (p_channel, auth.uid(), btrim(p_reason), p_request_id);
  END IF;

  INSERT INTO public.notification_admin_audit (actor, request_id, action, target, old_value, new_value, outcome, reason)
  VALUES (auth.uid(), p_request_id, 'channel_kill', p_channel, v_old, 'killed', v_outcome, btrim(p_reason));

  RETURN public.notif_admin_record_verdict(auth.uid(), p_request_id, 'channel_kill', v_fp,
    CASE v_outcome WHEN 'applied' THEN 'killed' ELSE 'already_killed' END);
END;
$$;

COMMENT ON FUNCTION public.admin_activate_channel_kill(text, text, uuid) IS
  'N4 M2+M3+M5: the ONLY write on the kill surface — registry-consumed id (one id, one decision, across kills AND recoveries), audited, request-id idempotent, reason mandatory. There is deliberately NO clearing counterpart.';


-- ── migration continuity: M3-era channel-kill decisions join the registry ───────────────────
-- Without this, a kill request id issued before this migration is absent from the registry:
-- its replay would pass the gate as FRESH and then hit the audit unique constraint (an
-- unrecorded raise), or worse be bindable to a recovery. The backfill is deterministic from
-- the audit's own fields, using the SAME canonical fingerprint the RPC now computes.
INSERT INTO public.notification_admin_requests (actor, request_id, action, fingerprint, verdict, created_at)
SELECT a.actor, a.request_id, 'channel_kill',
       public.notif_admin_fingerprint(jsonb_build_object(
         'action', 'channel_kill', 'channel', a.target, 'reason', a.reason)),
       CASE a.outcome WHEN 'applied' THEN 'killed' ELSE 'already_killed' END,
       a.created_at
  FROM public.notification_admin_audit a
 WHERE a.action = 'channel_kill'
ON CONFLICT (actor, request_id) DO NOTHING;
