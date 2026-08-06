-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M1 part 3 — the worker's CLAIM of the pending invocation, the disabled-smoke completion
-- arm, the strict canary reconciliation, and the admin health reader.
--
-- WHY CLAIM-FROM-DB rather than an id in the request body: the canary executes the REVIEWED
-- cron command VERBATIM (canary_invoke.sql refuses a command that is not exactly the reviewed
-- one), so the request body cannot carry a per-invocation id without breaking the command-hash
-- gate. Instead the invoker's open() row is the handshake: the worker, having begun its own
-- dispatch run, claims THE single unresolved invocation (single-flight guarantees at most one).
--
-- All run-evidence validation lives in bind_notification_worker_invocation (M1): worker
-- identity, phase, channel, unfinished-at-binding, lock order invocation → run. This wrapper
-- supplies "which invocation" and the REFUSAL semantics around it.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

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
  -- SERIALIZE THE CLASSIFICATION — the same advisory lock open() takes, so a claim never reads
  -- a half-committed picture, two concurrent claims order deterministically, and a claim never
  -- interleaves with an open. Held to transaction end.
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));

  -- ANY unresolved invocation — NOT just pending. The bug this closes: a duplicate HTTP request
  -- (pg_net retry, double dispatch) whose sibling had already bound the invocation saw "no
  -- pending row", returned NULL, and proceeded as a full steady-state pass — claiming groups
  -- and materializing in a second, unverified run while the operator believed exactly one
  -- verified run was executing. A run may proceed past this point ONLY as the invocation's
  -- owner (new binding or provably-identical same-run replay) or when NO deliberate invocation
  -- exists at all. FOR UPDATE holds the row so a concurrent resolve orders after us; the
  -- single-flight partial unique index means at most one row can match.
  SELECT id, status INTO v_inv, v_status
    FROM public.notification_worker_invocations
   WHERE status IN ('pending', 'started')
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;   -- steady-state tick: ZERO unresolved invocations is the ONLY silent arm
  END IF;

  v_verdict := public.bind_notification_worker_invocation(v_inv, p_worker_run_id);
  IF v_verdict IN ('bound', 'replayed') THEN
    RETURN v_inv;
  END IF;
  -- An unresolved invocation exists and THIS run cannot own it: another run holds it
  -- ('conflict_other_run' — the duplicate-execution case), or the evidence refused the run.
  -- LOUD, never a silent steady-state downgrade — the operator is waiting on this invocation's
  -- evidence, and a second run working the same queue would corrupt it.
  RAISE EXCEPTION 'claim_pending_worker_invocation: invocation % (status %) refused this run (%) — verdict %',
    v_inv, v_status, p_worker_run_id, v_verdict;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_worker_invocation(uuid) IS
  'N4: the dispatch worker''s startup claim of THE unresolved deliberate invocation (single-flight guarantees at most one). NULL ONLY when zero unresolved invocations exist — the steady-state cron tick. A pending invocation binds; a started one is accepted only as this run''s own replay; anything else RAISES, so a duplicate HTTP request can never proceed as a second unverified pass. Classification is serialized under the open() advisory lock.';

REVOKE ALL ON FUNCTION public.claim_pending_worker_invocation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_worker_invocation(uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The dispatch-evidence recorder. The invoke artifacts run open() and net.http_post in ONE
-- transaction, and net.http_post returns its request id before COMMIT — so the request THIS
-- invocation queued can be recorded on the invocation row causally, not correlated after the
-- fact. Atomicity is the recovery oracle: an ambiguous commit either committed invocation +
-- binding + queue row together, or none of them. On a replay the re-executed command mints a
-- SECOND request id, this recorder refuses to overwrite the first — and that RAISE rolls the
-- whole replay transaction back, un-queueing the second request. The operator is told the
-- ORIGINAL request id to go read: the replay cannot double-dispatch.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_invocation_net_request(
  p_invocation_id uuid,
  p_net_request_id bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.notification_worker_invocations%ROWTYPE;
BEGIN
  IF p_net_request_id IS NULL THEN
    RAISE EXCEPTION 'record_invocation_net_request: a pg_net request id is required';
  END IF;
  SELECT * INTO v FROM public.notification_worker_invocations
   WHERE id = p_invocation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_invocation_net_request: invocation % does not exist', p_invocation_id;
  END IF;
  IF v.net_request_id IS NOT NULL THEN
    IF v.net_request_id = p_net_request_id THEN RETURN; END IF;   -- same binding, idempotent
    RAISE EXCEPTION 'record_invocation_net_request: invocation % ALREADY dispatched pg_net request % — refusing to record request %. The earlier commit was real: this transaction will roll back (un-queueing the duplicate). Read net._http_response for id % instead of re-dispatching',
      p_invocation_id, v.net_request_id, p_net_request_id, v.net_request_id;
  END IF;
  IF v.status <> 'pending' THEN
    RAISE EXCEPTION 'record_invocation_net_request: invocation % is % — dispatch evidence is recorded in the invoker''s own transaction, before any worker could bind', p_invocation_id, v.status;
  END IF;
  UPDATE public.notification_worker_invocations
     SET net_request_id = p_net_request_id
   WHERE id = v.id;
END;
$$;

COMMENT ON FUNCTION public.record_invocation_net_request(uuid, bigint) IS
  'N4 AC-6: binds the pg_net request an invocation queued to its row, in the SAME transaction as the net.http_post (causal, not correlational). Set-once + unique + immutable; a replay that re-executed the command RAISES naming the original request — the raise rolls the replay back, un-queueing its duplicate request.';

REVOKE ALL ON FUNCTION public.record_invocation_net_request(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invocation_net_request(uuid, bigint) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- The DISABLED-SMOKE completion arm. When DIGEST_SEND_ENABLED is off the worker answers the
-- exact disabled 200 BEFORE any DB work: no run starts, so the smoke's invocation stays pending
-- and the generic resolve — which demands a bound, ended run — correctly refuses it forever.
-- This arm closes that gap WITHOUT weakening the generic path: it demands the pg_net response
-- evidence instead of a run — for EXACTLY the request this invocation recorded at dispatch
-- (record_invocation_net_request, same transaction as the http_post), answered clean, with the
-- byte-for-byte documented disabled body.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_smoke_invocation_disabled(
  p_invocation_id uuid,
  p_net_request_id bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.notification_worker_invocations%ROWTYPE;
  r record;
BEGIN
  SELECT * INTO v FROM public.notification_worker_invocations
   WHERE id = p_invocation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: invocation % does not exist', p_invocation_id;
  END IF;
  IF v.status = 'completed_disabled' THEN RETURN 'already_resolved'; END IF;
  IF v.purpose <> 'smoke' THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: invocation % is a %, not a smoke — a % that found the engine disabled is an operational failure, not a success',
      p_invocation_id, v.purpose, v.purpose;
  END IF;
  IF v.status <> 'pending' THEN
    -- started = the worker RAN (engine was NOT disabled): the run-based resolve owns it.
    -- completed/abandoned = a different terminal already holds the truth.
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: invocation % is %, not pending — the disabled arm applies only when the worker never started a run',
      p_invocation_id, v.status;
  END IF;
  -- CAUSAL binding, not correlation: the response must answer the exact request THIS invocation
  -- recorded in its own dispatch transaction. Timestamps and single-flight only narrow; a later
  -- qualifying response from some other request must never complete this smoke.
  IF v.net_request_id IS NULL THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: invocation % never recorded its pg_net request — no causal evidence exists to complete it', p_invocation_id;
  END IF;
  IF v.net_request_id <> p_net_request_id THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: invocation % dispatched pg_net request %, not % — that is another request''s response',
      p_invocation_id, v.net_request_id, p_net_request_id;
  END IF;

  SELECT status_code, content, timed_out, error_msg, created INTO r
    FROM net._http_response WHERE id = p_net_request_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: pg_net response % does not exist — the smoke''s evidence is not readable', p_net_request_id;
  END IF;
  IF r.created < v.requested_at THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: pg_net response % (created %) PREDATES invocation % (requested %) — that is another request''s evidence',
      p_net_request_id, r.created, p_invocation_id, v.requested_at;
  END IF;
  IF r.timed_out IS TRUE OR r.error_msg IS NOT NULL THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: pg_net response % carries a transport failure (timed_out=%, error=%) — not disabled-smoke evidence',
      p_net_request_id, coalesce(r.timed_out, false), coalesce(r.error_msg, '<none>');
  END IF;
  -- the EXACT documented body — whole-value jsonb equality, not a field probe. A body with a
  -- missing/other reason or ANY extra field ("status":"disabled","error":…) is not the disabled
  -- answer, and the shell's own check is deliberately not trusted here.
  IF r.status_code IS DISTINCT FROM 200
     OR r.content::jsonb IS DISTINCT FROM '{"status":"disabled","reason":"disabled"}'::jsonb THEN
    RAISE EXCEPTION 'resolve_smoke_invocation_disabled: response % answered HTTP % with body % — only the exact disabled 200 {"status":"disabled","reason":"disabled"} completes this arm',
      p_net_request_id, r.status_code, left(coalesce(r.content, '<absent>'), 200);
  END IF;

  UPDATE public.notification_worker_invocations
     SET status = 'completed_disabled', resolved_at = now()
   WHERE id = v.id;
  RETURN 'completed_disabled';
END;
$$;

COMMENT ON FUNCTION public.resolve_smoke_invocation_disabled(uuid, bigint) IS
  'N4: completes a SMOKE invocation whose worker answered the exact disabled 200 before any DB work (no run exists to bind, so the generic evidence-demanding resolve correctly refuses it). Evidence is CAUSAL: the response must answer exactly the pg_net request this invocation recorded at dispatch (record_invocation_net_request), postdate the open, be a clean 200, and equal the documented disabled body byte-for-byte as jsonb. Smoke-only and pending-only — every other shape raises.';

REVOKE ALL ON FUNCTION public.resolve_smoke_invocation_disabled(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_smoke_invocation_disabled(uuid, bigint) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- STRICT canary reconciliation. The artifact used to resolve "the invocation WHERE
-- worker_run_id = run AND status = 'started'" — zero matches produced zero rows and the shell
-- sailed on to verification with the invocation still pending. Resolution by exact run id,
-- no status filter, exactly one row or an exception naming what actually happened.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_invocation_for_canary_run(
  p_worker_run_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
  v_id uuid;
  v_status text;
  v_purpose text;
  v_source text;
  v_net bigint;
  v_pending int;
BEGIN
  SELECT count(*), min(id::text)::uuid INTO v_count, v_id
    FROM public.notification_worker_invocations
   WHERE worker_run_id = p_worker_run_id;
  IF v_count = 0 THEN
    SELECT count(*) INTO v_pending
      FROM public.notification_worker_invocations WHERE status = 'pending';
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: NO invocation is bound to run % — the canary opened one before dispatch, so either the worker never claimed it (% still pending: the run you reconciled is NOT the invocation''s run) or the run id is wrong',
      p_worker_run_id, v_pending;
  END IF;
  IF v_count > 1 THEN
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: % invocations claim run % — evidence is ambiguous, stop and inspect', v_count, p_worker_run_id;
  END IF;

  -- LOCKED before classification, held through the generic resolve (same row, same lock order
  -- as bind/resolve: invocation first). Without this, a concurrent ABANDON landing between the
  -- read and the generic resolve surfaced as its 'already_resolved' — and this wrapper would
  -- have reported a successful reconciliation over an abandoned verdict.
  SELECT status, purpose, source, net_request_id INTO v_status, v_purpose, v_source, v_net
    FROM public.notification_worker_invocations WHERE id = v_id
    FOR UPDATE;
  -- CANARY PROVENANCE, before any state change. The gate-bypass this closes: a SMOKE whose
  -- switch assertion was wrong actually sends; its dispatch run later gets handed to the canary
  -- command, this function completes the SMOKE invocation, and activation treats an accidental
  -- send as the reviewed canary. A run may only be reconciled AS a canary when its invocation
  -- IS the canary artifact's — and recorded which pg_net request it dispatched.
  IF v_purpose <> 'canary' OR v_source <> 'canary_invoke.sql' THEN
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: run % is bound to a % invocation (source %), not the canary — an accidental send by another step can NEVER be reconciled as the reviewed canary',
      p_worker_run_id, v_purpose, v_source;
  END IF;
  IF v_net IS NULL THEN
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: invocation % never recorded its pg_net request — dispatch provenance is missing', v_id;
  END IF;
  IF v_status = 'abandoned' THEN
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: invocation % for run % was ABANDONED — reconciling over it would overwrite that verdict', v_id, p_worker_run_id;
  END IF;
  -- 'completed' → already_resolved (idempotent re-run); 'started' → the evidence-demanding
  -- resolve completes it. Its TYPED REFUSALS (rejected_run_not_ended, …) must FAIL the artifact
  -- rather than print as a quiet marker — only the two success verdicts pass.
  v_status := public.resolve_notification_worker_invocation(v_id, 'completed');
  IF v_status NOT IN ('completed', 'already_resolved') THEN
    RAISE EXCEPTION 'resolve_invocation_for_canary_run: invocation % for run % refused completion — verdict % (the run has not provably ended; reconcile it first)',
      v_id, p_worker_run_id, v_status;
  END IF;
  -- 'already_resolved' deliberately conflates every terminal in the generic resolve; THIS
  -- caller may only report success over 'completed'. Belt to the FOR UPDATE above: even if a
  -- future refactor loosened the lock, an abandoned row could not read as reconciled.
  IF v_status = 'already_resolved' THEN
    SELECT status INTO v_status FROM public.notification_worker_invocations WHERE id = v_id;
    IF v_status <> 'completed' THEN
      RAISE EXCEPTION 'resolve_invocation_for_canary_run: invocation % for run % is terminally % — that is not a completed canary', v_id, p_worker_run_id, v_status;
    END IF;
    RETURN 'already_resolved';
  END IF;
  RETURN v_status;
END;
$$;

COMMENT ON FUNCTION public.resolve_invocation_for_canary_run(uuid) IS
  'N4: canary_reconcile''s closing step. Finds THE invocation bound to the given run — zero or many RAISE (zero means the worker never claimed the operator''s invocation, so the reconciled run is not the one the canary caused) — REQUIRES canary provenance (purpose=canary, source=canary_invoke.sql, recorded pg_net request: a smoke that accidentally sent can never be reconciled as the canary) and completes it through the evidence-demanding generic resolve. Idempotent: already-completed returns already_resolved.';

REVOKE ALL ON FUNCTION public.resolve_invocation_for_canary_run(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_invocation_for_canary_run(uuid) TO service_role;


-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- HEALTH EXPOSURE — pending/stale invocations must be VISIBLE, not just enforced (AC-6).
-- Fixed columns only (N4 doctrine: no payloads, no free-form projections beyond the
-- operator-supplied source label); admin-checked fail-closed; bounded.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_worker_invocations(
  p_limit int DEFAULT 50
) RETURNS TABLE (
  id uuid,
  purpose text,
  source text,
  status text,
  requested_at timestamptz,
  age_seconds bigint,
  worker_run_id uuid,
  net_request_id bigint,
  run_status text,
  run_phase text,
  stale boolean,
  actionable boolean,
  resolved_at timestamptz,
  abandon_reason text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'admin_list_worker_invocations: platform admin only';
  END IF;
  RETURN QUERY
  SELECT i.id, i.purpose, i.source, i.status, i.requested_at,
         GREATEST(0, extract(epoch FROM (now() - i.requested_at)))::bigint AS age_seconds,
         i.worker_run_id, i.net_request_id, r.status AS run_status, r.phase AS run_phase,
         -- stale is an AGE signal only: unresolved past the abandon age-gate
         (i.status IN ('pending', 'started')
          AND i.requested_at < now() - interval '10 minutes') AS stale,
         -- actionable = an operator verb exists RIGHT NOW: an old pending can be abandoned; a
         -- started one whose run has ENDED can be resolved. A started invocation over a live
         -- run is NOT actionable however old — abandon rightly refuses it while the run runs.
         ((i.status = 'pending' AND i.requested_at < now() - interval '10 minutes')
          OR (i.status = 'started' AND r.ended_at IS NOT NULL)) AS actionable,
         i.resolved_at, i.abandon_reason
    FROM public.notification_worker_invocations i
    LEFT JOIN public.notification_worker_runs r ON r.run_id = i.worker_run_id
   ORDER BY (i.status IN ('pending', 'started')) DESC, i.requested_at DESC
   LIMIT LEAST(GREATEST(coalesce(p_limit, 50), 1), 200);
END;
$$;

COMMENT ON FUNCTION public.admin_list_worker_invocations(int) IS
  'N4 AC-6 health: unresolved-first bounded list of deliberate worker invocations with their bound run''s status, a stale flag (pure age signal: unresolved past the 10-minute gate) and an actionable flag (an operator verb exists now: old pending is abandonable, started-with-ended-run is resolvable; started over a live run is not actionable at any age). Fixed columns only; platform-admin fail-closed; limit clamped 1..200.';

REVOKE ALL ON FUNCTION public.admin_list_worker_invocations(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_worker_invocations(int) TO authenticated, service_role;
