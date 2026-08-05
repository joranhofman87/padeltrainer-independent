-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M1 — the durable pending-invocation record (Stage-3.5 acceptance criterion 6; N4 design
-- contract CRITICAL 1, thread 019fd1e0-0979-7132-b5b3-081a49517231).
--
-- THE GAP THIS CLOSES. A dispatch run only appears in notification_worker_runs once the worker
-- STARTS. Between an invoker's COMMIT (which is when pg_net first dispatches) and that moment,
-- the pipeline has no durable record that an invocation is travelling — pg_net owns the
-- http_request_queue row's lifetime, so a request already dispatched but not yet recorded is
-- INVISIBLE. "Nothing is in flight" then reads clean over a canary already in the air: a second
-- invocation can start, and activate can arm the cron on the PREVIOUS canary's evidence.
--
-- THE MODEL. Every deliberate invoker writes an invocation row BEFORE its pg_net enqueue, in
-- the SAME transaction — so the record exists from the instant the request can exist, with no
-- window. The worker binds its run to the invocation at startup. States:
--
--   pending    → written by the invoker, pre-dispatch. THE BLOCKING STATE.
--   started    → the worker bound a run to it (worker_run_id set).
--   completed  → the bound run ended (resolution is the invoker/reconciler's read of run state).
--   abandoned  → an operator gave up on it — audited, age-gated, reason-mandatory.
--
-- SINGLE-FLIGHT: a partial unique index allows ONE unresolved (pending|started) invocation per
-- purpose. canary_invoke/activate REFUSE while any unresolved row exists (the _invocation_gate
-- include), and their own open() call would collide with the index anyway — belt and braces.
--
-- The cron-driven schedule does NOT write invocations: its runs are the steady state the
-- liveness monitor owns; the record exists for DELIBERATE one-shot invocations (smoke, canary)
-- whose evidence feeds gating decisions. Stated so the absence of cron rows is never read as
-- the gap this table closes having reopened.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.notification_worker_invocations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose        text NOT NULL CHECK (purpose IN ('smoke', 'canary', 'manual')),
  source         text NOT NULL CHECK (length(btrim(source)) BETWEEN 3 AND 200),
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'started', 'completed', 'abandoned')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  worker_run_id  uuid,                       -- bound at worker startup; NO FK (runs are swept)
  resolved_at    timestamptz,
  abandon_reason text,
  CONSTRAINT invocation_resolution_coherent CHECK (
    (status IN ('pending', 'started') AND resolved_at IS NULL AND abandon_reason IS NULL)
    OR (status = 'completed' AND resolved_at IS NOT NULL AND abandon_reason IS NULL)
    OR (status = 'abandoned' AND resolved_at IS NOT NULL
        AND length(btrim(coalesce(abandon_reason, ''))) >= 3)
  ),
  CONSTRAINT invocation_started_has_run CHECK (status <> 'started' OR worker_run_id IS NOT NULL)
);

-- SINGLE-FLIGHT: one unresolved deliberate invocation at a time, full stop. Not per-purpose:
-- a canary while a smoke is unresolved is exactly the overlap the record exists to prevent.
CREATE UNIQUE INDEX uq_notification_worker_invocation_unresolved
  ON public.notification_worker_invocations ((true))
  WHERE status IN ('pending', 'started');

COMMENT ON TABLE public.notification_worker_invocations IS
  'Stage-3.5 AC-6: the durable record that a DELIBERATE worker invocation (smoke/canary/manual) is in flight, written in the invoker''s own transaction BEFORE the pg_net enqueue — closing the dispatched-but-not-yet-running blind spot. Single unresolved row allowed (partial unique). canary_invoke/activate refuse while one exists. Cron steady-state runs do not write here.';

-- ── ACLs: definer RPCs only (S1 doctrine: service_role default-ALL must be revoked) ─────────
REVOKE ALL ON public.notification_worker_invocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.notification_worker_invocations TO service_role;  -- worker + admin reads

-- ── open: the invoker's pre-dispatch write ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.open_notification_worker_invocation(
  p_purpose text,
  p_source text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  -- The unique index is the real gate; this RAISE just turns a collision into a message the
  -- runbook operator can act on. RAISING (not returning NULL) is the point: an invoker that
  -- cannot record itself must not dispatch.
  IF EXISTS (SELECT 1 FROM public.notification_worker_invocations
              WHERE status IN ('pending', 'started')) THEN
    RAISE EXCEPTION 'open_notification_worker_invocation: an invocation is already unresolved — resolve or abandon it first (single-flight)';
  END IF;
  INSERT INTO public.notification_worker_invocations (purpose, source)
  VALUES (p_purpose, btrim(p_source))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_notification_worker_invocation(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_notification_worker_invocation(text, text) TO service_role;

-- ── bind: the worker stamps its run onto the invocation at startup ──────────────────────────
CREATE OR REPLACE FUNCTION public.bind_notification_worker_invocation(
  p_invocation_id uuid,
  p_worker_run_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_updated int;
BEGIN
  IF p_invocation_id IS NULL OR p_worker_run_id IS NULL THEN
    RAISE EXCEPTION 'bind_notification_worker_invocation: both ids are required';
  END IF;
  UPDATE public.notification_worker_invocations
     SET status = 'started', worker_run_id = p_worker_run_id
   WHERE id = p_invocation_id AND status = 'pending';
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  -- FALSE (not an error): the worker may be a cron tick carrying no invocation id, or a retry
  -- against an already-bound row — both are the caller's signal to proceed without claiming
  -- the deliberate-invocation evidence.
  RETURN v_updated = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) TO service_role;

-- ── resolve: completed (run ended) or abandoned (operator, age-gated, reasoned) ─────────────
CREATE OR REPLACE FUNCTION public.resolve_notification_worker_invocation(
  p_invocation_id uuid,
  p_outcome text,          -- 'completed' | 'abandoned'
  p_reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.notification_worker_invocations%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('completed', 'abandoned') THEN
    RAISE EXCEPTION 'resolve_notification_worker_invocation: outcome must be completed|abandoned';
  END IF;
  SELECT * INTO v FROM public.notification_worker_invocations
   WHERE id = p_invocation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF v.status IN ('completed', 'abandoned') THEN RETURN 'already_resolved'; END IF;

  IF p_outcome = 'completed' THEN
    -- Completion requires the EVIDENCE: a bound run that has ended. An unbound or still-running
    -- invocation cannot be waved through as complete — that would reopen the blind spot.
    IF v.worker_run_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.notification_worker_runs r
          WHERE r.id = v.worker_run_id AND r.ended_at IS NOT NULL) THEN
      RETURN 'rejected_run_not_ended';
    END IF;
    UPDATE public.notification_worker_invocations
       SET status = 'completed', resolved_at = now() WHERE id = v.id;
    RETURN 'completed';
  END IF;

  -- ABANDON is the operator's escape hatch and is deliberately hard: reason-mandatory and
  -- age-gated — an invocation younger than the worker's own wall-clock ceiling might still
  -- land, and abandoning it would let a second invocation overlap the first.
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'resolve_notification_worker_invocation: abandoning requires a reason';
  END IF;
  IF v.requested_at > now() - interval '10 minutes' THEN
    RETURN 'rejected_too_young';
  END IF;
  UPDATE public.notification_worker_invocations
     SET status = 'abandoned', resolved_at = now(), abandon_reason = btrim(p_reason)
   WHERE id = v.id;
  RETURN 'abandoned';
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_notification_worker_invocation(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_notification_worker_invocation(uuid, text, text) TO service_role;
