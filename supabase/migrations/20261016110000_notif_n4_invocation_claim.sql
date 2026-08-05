-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 M1 part 3 — the worker's CLAIM of the pending invocation.
--
-- WHY CLAIM-FROM-DB rather than an id in the request body: the canary executes the REVIEWED
-- cron command VERBATIM (canary_invoke.sql refuses a command that is not exactly the reviewed
-- one), so the request body cannot carry a per-invocation id without breaking the command-hash
-- gate. Instead the invoker's open() row is the handshake: the worker, having begun its own
-- dispatch run, claims THE single unresolved pending invocation (single-flight guarantees at
-- most one). A run that claims nothing is a steady-state cron tick — the explicit
-- no-invocation branch, not a failure.
--
-- All validation lives in bind_notification_worker_invocation (M1, Codex-clear): worker
-- identity, phase, channel, unfinished-at-binding, lock order invocation → run. This wrapper
-- only supplies "which invocation": the oldest pending one, locked.
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
  v_verdict text;
BEGIN
  SELECT id INTO v_inv FROM public.notification_worker_invocations
   WHERE status = 'pending'
   ORDER BY requested_at
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;   -- steady-state tick: no deliberate invocation to own
  END IF;
  v_verdict := public.bind_notification_worker_invocation(v_inv, p_worker_run_id);
  IF v_verdict IN ('bound', 'replayed') THEN
    RETURN v_inv;
  END IF;
  -- A pending invocation exists but THIS run cannot own it (wrong kind, missing, ended…).
  -- That is a worker-side bug or stale evidence — LOUD, never a silent steady-state downgrade:
  -- the operator is waiting on this invocation's evidence.
  RAISE EXCEPTION 'claim_pending_worker_invocation: invocation % refused this run (%) — verdict %',
    v_inv, p_worker_run_id, v_verdict;
END;
$$;

COMMENT ON FUNCTION public.claim_pending_worker_invocation(uuid) IS
  'N4: the dispatch worker''s startup claim of THE pending deliberate invocation (single-flight guarantees at most one). NULL = steady-state cron tick, the explicit no-invocation branch. A pending invocation this run cannot own RAISES — the operator is waiting on its evidence, so a silent downgrade would strand them. All evidence validation is bind''s.';

REVOKE ALL ON FUNCTION public.claim_pending_worker_invocation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_worker_invocation(uuid) TO service_role;
