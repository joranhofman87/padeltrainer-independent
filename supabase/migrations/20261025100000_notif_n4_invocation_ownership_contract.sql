-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 — DELIBERATE INVOCATION OWNERSHIP: the complete contract (convergence, thread 019fd319)
--
-- Three consecutive review rounds found defects in ONE invariant family — which run owns which
-- deliberate invocation (round 1: the gate could not see an uncommitted opener; round 2: the fix
-- inverted open()'s lock order; round 3: bind could not tell a causing run from a coincidental
-- one). Per the repository's convergence protocol this is not a fourth patch: the model was
-- incomplete, so the model is written out here and the subsystem is reduced to what it can
-- actually prove.
--
-- ── ACTORS ─────────────────────────────────────────────────────────────────────────────────
--   INVOKER   smoke_invoke.sql / canary_invoke.sql — one psql transaction, run by an operator.
--   pg_net    dispatches the queued HTTP request AFTER that transaction commits.
--   WORKER    the edge function; one dispatch run per HTTP request it receives.
--   pg_cron   dispatches the same request on a schedule — but ONLY while the job is ACTIVE.
--
-- ── WHY OWNERSHIP CANNOT BE PROVEN IN THE TRANSPORT ────────────────────────────────────────
-- The obvious design is to put the invocation id in the request body and have the worker bind
-- exactly that. It is not available here: both invoke artifacts execute THE REVIEWED CRON
-- COMMAND VERBATIM, under a md5 assertion, from the locked cron.job row. That is the property
-- that makes the canary evidence about the cron — a canary that posted a different body would
-- prove nothing about what the schedule will send. So the request the worker receives is
-- byte-identical whether it came from an operator or from a tick, and no DB-side comparison can
-- recover the difference: timestamps cannot (an unrelated run starting after the request is
-- indistinguishable from the caused one), and the run ledger carries no causal token.
--
-- ── SO OWNERSHIP IS PROVEN BY EXCLUSION, and every part is enforced somewhere ───────────────
--   E1  No tick can be dispatched during the window. _job_identity_assertions.sql LOCKS the
--       reviewed cron.job row and asserts active = false BEFORE the invocation gate and open(),
--       and holds that lock to COMMIT. pg_cron does not fire an inactive job, and the only thing
--       that arms it — activate.sql — must take the same row lock and additionally refuses while
--       any invocation is unresolved (_invocation_gate.sql).
--   E2  No other deliberate invocation exists: the single-flight partial unique index, plus the
--       'notif-worker-invocation-open' advisory lock shared by open(), both gates and the claim.
--   E3  No dispatch run is already in flight: asserted by the invoke artifacts before they open.
--   E4  The dispatch is causally recorded: record_invocation_net_request writes the pg_net
--       request id in the SAME transaction that queued it.
--   Together: after the open commits, the only worker request that can exist is the one this
--   invocation queued, so the only dispatch run that can start is the one it caused.
--
-- ── WHAT THIS FORBIDS: purpose 'manual' ────────────────────────────────────────────────────
-- An ad-hoc invocation opened outside an artifact has NONE of E1-E3: the cron may be armed, a
-- tick may already be in flight, and nothing holds the job row. Its ownership rested entirely on
-- comparing started_at with requested_at, which is not a proof — an unrelated tick starting after
-- the request satisfies it exactly as the caused run does. Round 3 patched that comparison;
-- round 4 removes the case instead. 'manual' is dropped from the schema, from open() and from
-- the claim's reasoning. If an ad-hoc invocation is ever wanted, it needs its own artifact with
-- E1-E3, not a looser predicate here.
--
-- ── INVARIANTS (each one is enforced, and each one has a test) ──────────────────────────────
--   I1  at most one unresolved invocation                    (partial unique index)
--   I2  a run evidences at most one invocation               (partial unique index)
--   I3  a bound run is THIS pipeline's unfinished email dispatch under a digest-worker token
--   I4  only 'smoke' and 'canary' exist                      (CHECK + open() refusal)
--   I5  a run proceeds past the claim ONLY as the invocation's owner (bound|replayed) or when
--       NO deliberate invocation is unresolved; every other verdict RAISES — so a duplicate
--       HTTP request can never execute a second, unverified pass
--   I6  an invocation is opened only while the reviewed cron job is INACTIVE and its row is held
--       (artifact-enforced; pinned structurally and behaviourally by the rollout suites)
--   I7  arming refuses while any invocation is unresolved    (_invocation_gate.sql)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── I4: 'manual' leaves the schema ─────────────────────────────────────────────────────────
-- No artifact, runbook step or code path has ever opened one; if a row exists, this ALTER fails
-- loudly and that row is the thing to explain.
ALTER TABLE public.notification_worker_invocations
  DROP CONSTRAINT notification_worker_invocations_purpose_check;
ALTER TABLE public.notification_worker_invocations
  ADD CONSTRAINT notification_worker_invocations_purpose_check
  CHECK (purpose IN ('smoke', 'canary'));

COMMENT ON COLUMN public.notification_worker_invocations.purpose IS
  'smoke | canary — the two ARTIFACT-driven deliberate invocations. Ownership of the run they cause is proven by exclusion (cron inactive under a row lock, no run in flight, single-flight), which only an artifact can establish; an ad-hoc "manual" invocation had none of it and was removed in the round-4 convergence.';

-- open() names the reason rather than letting the CHECK speak for it: a caller reaching for a
-- purpose that no artifact provides is asking for a guarantee this subsystem cannot give.
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
  IF p_purpose NOT IN ('smoke', 'canary') THEN
    RAISE EXCEPTION 'open_notification_worker_invocation: purpose % is not available — a deliberate invocation must come from smoke_invoke.sql or canary_invoke.sql, whose job-row lock, inactive-cron assertion and no-run-in-flight check are what make the run it causes provably its own', p_purpose;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('notif-worker-invocation-req:' || p_request_id::text, 0));

  SELECT * INTO v FROM public.notification_worker_invocations WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v.purpose = p_purpose AND v.source = btrim(p_source) THEN
      RETURN v.id;
    END IF;
    RAISE EXCEPTION 'open_notification_worker_invocation: request % was already used for a different invocation', p_request_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));
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
COMMENT ON FUNCTION public.open_notification_worker_invocation(text, text, uuid) IS
  'N4 M1 (round 4): the invoker''s pre-dispatch write, request-id idempotent. smoke|canary only — see the ownership contract at the head of 20261025100000.';
REVOKE ALL ON FUNCTION public.open_notification_worker_invocation(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_notification_worker_invocation(text, text, uuid) TO service_role;

-- ── I3: bind, with round 3's timestamp comparison REMOVED ──────────────────────────────────
-- It was introduced to protect the 'manual' case and it never proved what it claimed: a run that
-- merely started after the request is not thereby the run the request caused. With 'manual' gone
-- the exclusion argument (E1-E4) carries ownership, and a predicate that cannot fail correctly is
-- worse than none — it reads like a guarantee.
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
    -- LOCKED (invocation row → run row, the order every caller keeps): a concurrent
    -- finish_notification_worker_run could otherwise end the run between the unfinished check
    -- and the invocation becoming started — binding over stale evidence.
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
  'N4 M1 (round 4): the worker stamps its run onto the invocation. Typed verdicts; ONLY bound|replayed may proceed. The run must be this pipeline''s unfinished email dispatch under a digest-worker token. Causality is established by the artifact-side exclusion contract (20261025100000), not inferred from timestamps.';
REVOKE ALL ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bind_notification_worker_invocation(uuid, uuid) TO service_role;

-- ── I5: the claim goes back to two arms — own it, or nothing is unresolved ─────────────────
-- Round 3 added a third arm returning NULL for 'run_predates_invocation'. NULL is the worker's
-- signal to run a FULL steady-state pass, so that arm authorised exactly the overlapping
-- unverified execution the loud arm exists to prevent. The verdict it handled cannot occur now.
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
    RETURN NULL;   -- steady-state tick: ZERO unresolved invocations is the ONLY silent arm
  END IF;

  v_verdict := public.bind_notification_worker_invocation(v_inv, p_worker_run_id);
  IF v_verdict IN ('bound', 'replayed') THEN
    RETURN v_inv;
  END IF;
  RAISE EXCEPTION 'claim_pending_worker_invocation: invocation % (status %) refused this run (%) — verdict %',
    v_inv, v_status, p_worker_run_id, v_verdict;
END;
$$;
COMMENT ON FUNCTION public.claim_pending_worker_invocation(uuid) IS
  'N4 (round 4): the dispatch worker''s startup claim. NULL means ZERO unresolved deliberate invocations — the steady-state cron tick — and nothing else. Any unresolved invocation this run cannot own RAISES, so a duplicate HTTP request can never proceed as a second unverified pass. Serialized under the open() advisory lock.';
REVOKE ALL ON FUNCTION public.claim_pending_worker_invocation(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_pending_worker_invocation(uuid) TO service_role;
