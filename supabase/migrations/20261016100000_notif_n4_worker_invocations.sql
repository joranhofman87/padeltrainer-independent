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
  -- CALLER-generated identity. An invoker whose COMMIT outcome is ambiguous (connection died)
  -- retries with the SAME request_id and gets the SAME invocation back — without this, a
  -- committed open stranded the operator: "already unresolved" with no way to recover the uuid.
  request_id     uuid NOT NULL UNIQUE,
  purpose        text NOT NULL CHECK (purpose IN ('smoke', 'canary', 'manual')),
  source         text NOT NULL CHECK (length(btrim(source)) BETWEEN 3 AND 200),
  -- 'completed_disabled' is the SMOKE-ONLY terminal for the disabled arm: the worker answered
  -- the exact disabled 200 BEFORE any DB work, so no run exists to bind — 'completed' (which
  -- demands a run) cannot represent it and 'abandoned' would misfile a successful smoke as a
  -- failure. Reached only via resolve_smoke_invocation_disabled, which verifies the pg_net
  -- response evidence.
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'started', 'completed', 'completed_disabled', 'abandoned')),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  worker_run_id  uuid,                       -- bound at worker startup; NO FK (runs are swept)
  -- The pg_net request THIS invocation queued, recorded in the SAME transaction as the reviewed
  -- command's net.http_post (which returns its id before COMMIT) — so the association is
  -- CAUSAL, not correlational. Set once, immutable (guard), unique (index below): one request
  -- can evidence one invocation, and the disabled-smoke resolve demands an exact match.
  net_request_id bigint,
  resolved_at    timestamptz,
  abandon_reason text,
  CONSTRAINT invocation_resolution_coherent CHECK (
    (status IN ('pending', 'started') AND resolved_at IS NULL AND abandon_reason IS NULL)
    OR (status = 'completed' AND resolved_at IS NOT NULL AND abandon_reason IS NULL)
    OR (status = 'completed_disabled' AND resolved_at IS NOT NULL AND abandon_reason IS NULL)
    OR (status = 'abandoned' AND resolved_at IS NOT NULL
        AND length(btrim(coalesce(abandon_reason, ''))) BETWEEN 3 AND 500)
  ),
  CONSTRAINT invocation_started_has_run CHECK (status <> 'started' OR worker_run_id IS NOT NULL),
  -- a pending row has NO run (binding IS the transition), a completed row MUST have one (its
  -- completion evidence is that run's end) — schema-level, not merely RPC discipline
  CONSTRAINT invocation_pending_is_clean CHECK (status <> 'pending' OR worker_run_id IS NULL),
  CONSTRAINT invocation_completed_has_run CHECK (status <> 'completed' OR worker_run_id IS NOT NULL),
  -- the disabled arm exists ONLY for smokes, ONLY runless, and ONLY with its dispatch recorded:
  -- a canary/manual invocation that found the engine disabled is an operational failure, never a
  -- quiet success — and a disabled completion without a recorded request would be causeless
  CONSTRAINT invocation_disabled_is_runless_smoke CHECK (
    status <> 'completed_disabled'
    OR (purpose = 'smoke' AND worker_run_id IS NULL AND net_request_id IS NOT NULL))
);

-- SINGLE-FLIGHT: one unresolved deliberate invocation at a time, full stop. Not per-purpose:
-- a canary while a smoke is unresolved is exactly the overlap the record exists to prevent.
CREATE UNIQUE INDEX uq_notification_worker_invocation_unresolved
  ON public.notification_worker_invocations ((true))
  WHERE status IN ('pending', 'started');

-- one pg_net request evidences at most ONE invocation — the causal tie cannot be shared
CREATE UNIQUE INDEX uq_notification_worker_invocation_net_request
  ON public.notification_worker_invocations (net_request_id)
  WHERE net_request_id IS NOT NULL;

-- OWNER-EFFECTIVE STATE MACHINE (contract finding: ACLs stop API roles, but definer functions
-- and future migrations run as the owner — the guard must bind THEM too, exactly like the
-- digest ledger's). Inserts arrive only as clean pending; transitions are monotonic
-- (pending→started, started→completed|abandoned, pending→abandoned); identity fields and a
-- bound run id are immutable; nothing reopens; nothing is deleted outside a future reviewed
-- retention policy.
CREATE OR REPLACE FUNCTION public.notif_worker_invocation_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'notification_worker_invocations is append-only evidence — no % (retention is a future reviewed policy)', TG_OP;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.worker_run_id IS NOT NULL OR NEW.net_request_id IS NOT NULL
       OR NEW.resolved_at IS NOT NULL OR NEW.abandon_reason IS NOT NULL THEN
      RAISE EXCEPTION 'notification_worker_invocations: rows are born clean pending — binding, dispatch evidence and resolution are TRANSITIONS, never birth states';
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: identity is immutable
  IF NEW.id <> OLD.id OR NEW.request_id <> OLD.request_id
     OR NEW.purpose <> OLD.purpose OR NEW.source <> OLD.source
     OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'notification_worker_invocations: identity fields are immutable';
  END IF;
  IF OLD.worker_run_id IS NOT NULL AND NEW.worker_run_id IS DISTINCT FROM OLD.worker_run_id THEN
    RAISE EXCEPTION 'notification_worker_invocations: a bound run id is immutable — evidence does not change owners';
  END IF;
  IF OLD.net_request_id IS NOT NULL AND NEW.net_request_id IS DISTINCT FROM OLD.net_request_id THEN
    RAISE EXCEPTION 'notification_worker_invocations: the recorded pg_net request is immutable — dispatch evidence does not change';
  END IF;
  -- and it can only APPEAR while pending stays pending: the invoker records it in its own
  -- transaction, before any worker could bind — evidence is never attached retroactively to a
  -- started or resolved invocation, by ANY code path including the owner's
  IF OLD.net_request_id IS NULL AND NEW.net_request_id IS NOT NULL
     AND NOT (OLD.status = 'pending' AND NEW.status = 'pending') THEN
    RAISE EXCEPTION 'notification_worker_invocations: dispatch evidence is recorded by the invoker while pending — never attached to a % invocation', OLD.status;
  END IF;
  IF NOT (
       (OLD.status = 'pending' AND NEW.status IN ('started', 'completed_disabled', 'abandoned'))
    OR (OLD.status = 'started' AND NEW.status IN ('completed', 'abandoned'))
    OR (OLD.status = NEW.status)
  ) THEN
    RAISE EXCEPTION 'notification_worker_invocations: % -> % is not a legal transition', OLD.status, NEW.status;
  END IF;
  IF OLD.status IN ('completed', 'completed_disabled', 'abandoned') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'notification_worker_invocations: resolved rows never reopen';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_notif_worker_invocation_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.notification_worker_invocations
  FOR EACH ROW EXECUTE FUNCTION public.notif_worker_invocation_guard();
CREATE TRIGGER trg_notif_worker_invocation_no_truncate
  BEFORE TRUNCATE ON public.notification_worker_invocations
  FOR EACH STATEMENT EXECUTE FUNCTION public.notif_worker_invocation_guard();

COMMENT ON TABLE public.notification_worker_invocations IS
  'Stage-3.5 AC-6: the durable record that a DELIBERATE worker invocation (smoke/canary/manual) is in flight, written in the invoker''s own transaction BEFORE the pg_net enqueue — closing the dispatched-but-not-yet-running blind spot. Single unresolved row allowed (partial unique). canary_invoke/activate refuse while one exists. Cron steady-state runs do not write here.';

-- ── ACLs: definer RPCs only (S1 doctrine: service_role default-ALL must be revoked) ─────────
REVOKE ALL ON public.notification_worker_invocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.notification_worker_invocations TO service_role;  -- worker + admin reads

-- ── open: the invoker's pre-dispatch write — REQUEST-ID IDEMPOTENT ──────────────────────────
-- The lock order mirrors N3's request→state pattern: the REQUEST lock first (concurrent exact
-- replays serialize and converge on one row), then the OPEN lock (concurrent DIFFERENT requests
-- serialize on the single-flight check, so exactly one can open; the partial unique index stays
-- as the backstop underneath both).
CREATE OR REPLACE FUNCTION public.open_notification_worker_invocation(
  p_purpose text,
  p_source text,
  p_request_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.notification_worker_invocations%ROWTYPE;
        v_id uuid;
BEGIN
  IF p_request_id IS NULL THEN
    RAISE EXCEPTION 'open_notification_worker_invocation: a caller-generated request_id is required — it is what makes an ambiguous commit recoverable';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-worker-invocation-req:' || p_request_id::text, 0));

  SELECT * INTO v FROM public.notification_worker_invocations WHERE request_id = p_request_id;
  IF FOUND THEN
    -- EXACT replay of a committed open (whatever its current status): hand back the SAME
    -- invocation — this is the ambiguous-commit recovery path. A reused id carrying a
    -- DIFFERENT request is a caller bug and is refused: a request id names one request.
    IF v.purpose = p_purpose AND v.source = btrim(p_source) THEN
      RETURN v.id;
    END IF;
    RAISE EXCEPTION 'open_notification_worker_invocation: request % was already used for a different invocation', p_request_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));
  -- Re-checked UNDER the open lock: two concurrent DIFFERENT requests serialize here, and the
  -- loser sees the winner's unresolved row. RAISING (not returning NULL) is the point: an
  -- invoker that cannot record itself must not dispatch.
  IF EXISTS (SELECT 1 FROM public.notification_worker_invocations
              WHERE status IN ('pending', 'started')) THEN
    RAISE EXCEPTION 'open_notification_worker_invocation: an invocation is already unresolved — resolve or abandon it first (single-flight)';
  END IF;
  INSERT INTO public.notification_worker_invocations (request_id, purpose, source)
  VALUES (p_request_id, p_purpose, btrim(p_source))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.open_notification_worker_invocation(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_notification_worker_invocation(text, text, uuid) TO service_role;

-- ── bind: the worker stamps its run onto the invocation at startup — TYPED VERDICTS ─────────
-- The first version returned one boolean for every non-pending state, and its comment invited
-- the caller to proceed on false — so a retried HTTP request could run a SECOND worker pass
-- without owning the invocation. The contract is now explicit, and the worker-side rule is:
-- ONLY 'bound' and 'replayed' may proceed with deliberate work; every other verdict STOPS
-- before any provider call. A cron tick carries NO invocation id and NEVER calls bind — the
-- no-invocation path is the caller's own branch, not a bind verdict.
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
    -- THE RUN IS EVIDENCE, so it must actually be one (contract finding: any uuid used to
    -- bind — a nonexistent run, a materializer's, an already-ended historical one — and
    -- completion could then accept unrelated evidence). Validated under the invocation lock:
    -- it exists, it is THIS pipeline's dispatch work on the email channel, and it is
    -- UNFINISHED at binding time. (A replay stays valid after the owned run ends — but only
    -- via the 'replayed' arm below, which demands the exact bound run id.)
    -- LOCKED (invocation row → run row, the order every future caller keeps): a concurrent
    -- finish_notification_worker_run could otherwise end the run between the unfinished check
    -- and the invocation becoming started — binding over stale evidence. Same device as the
    -- state machine's own canonical run assertion (20261004100000:177).
    SELECT * INTO v_run FROM public.notification_worker_runs r
     WHERE r.run_id = p_worker_run_id
     FOR UPDATE;
    IF NOT FOUND THEN RETURN 'run_missing'; END IF;              -- STOP
    IF v_run.phase <> 'dispatch' OR v_run.channel <> 'email'
       -- the WORKER identity too: start_notification_worker_run accepts arbitrary worker text,
       -- so without this any service-role code could mint an email/dispatch run and bind it as
       -- deliberate digest evidence. The digest worker's tokens carry the canonical prefix.
       OR v_run.worker NOT LIKE 'notification-digest-worker:%' THEN
      RETURN 'run_wrong_kind';                                   -- STOP
    END IF;
    IF v_run.ended_at IS NOT NULL THEN
      RETURN 'run_already_ended';                                -- STOP: stale evidence
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
  IF v.status IN ('completed', 'completed_disabled', 'abandoned') THEN RETURN 'already_resolved'; END IF;

  IF p_outcome = 'completed' THEN
    -- Completion requires the EVIDENCE: a bound run that has ended. An unbound or still-running
    -- invocation cannot be waved through as complete — that would reopen the blind spot.
    IF v.worker_run_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.notification_worker_runs r
          WHERE r.run_id = v.worker_run_id AND r.ended_at IS NOT NULL) THEN
      RETURN 'rejected_run_not_ended';
    END IF;
    UPDATE public.notification_worker_invocations
       SET status = 'completed', resolved_at = now() WHERE id = v.id;
    RETURN 'completed';
  END IF;

  -- ABANDON is the operator's escape hatch and is deliberately hard, with DIFFERENT rules per
  -- state (contract finding: age alone does not prove a started worker is dead):
  --   pending  → age-gated. The 10-minute constant = the maximum pg_net delivery window plus
  --              the edge runtime ceiling (~150s) plus generous margin; younger might still
  --              land, and abandoning it would let a second invocation overlap the first.
  --   started  → the bound run must have ENDED. An unfinished run is the durable evidence the
  --              system has NOT closed it; abandoning over it would race a live worker. Stale
  --              stuck runs are first terminalized through the run ledger's own recovery.
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'resolve_notification_worker_invocation: abandoning requires a reason (3-500 chars)';
  END IF;
  IF v.status = 'started' AND NOT EXISTS (
       SELECT 1 FROM public.notification_worker_runs r
        WHERE r.run_id = v.worker_run_id AND r.ended_at IS NOT NULL) THEN
    RETURN 'rejected_run_still_running';
  END IF;
  IF v.status = 'pending' AND v.requested_at > now() - interval '10 minutes' THEN
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
