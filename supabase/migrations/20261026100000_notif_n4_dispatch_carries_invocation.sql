-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 — THE DISPATCH CARRIES ITS OWN INVOCATION IDENTITY (convergence, round 5)
--
-- Round 4 argued that ownership could not live in the transport, because both invoke artifacts
-- execute the REVIEWED CRON COMMAND VERBATIM and a different body would stop the canary proving
-- what the cron sends. The review found the counterexample that breaks the exclusion argument
-- built on that premise — and, decisively, that the premise itself is false.
--
-- THE COUNTEREXAMPLE (all repository-native, no adversary):
--   1. The job is ACTIVE; pg_cron fires a tick and pg_net takes the request out of the queue.
--   2. rollback_disable.sql deactivates the job — its own comment already records that a tick
--      already in flight survives deactivation.
--   3. The operator starts a canary. Every precondition passes: the job is inactive, no run is in
--      flight, and no request is queued (the in-flight one has already left the queue — the
--      invocation gate's own comment says pg_net's queue row disappears on pg_net's schedule).
--   4. Both requests are now travelling. The OLD tick can arrive first, start its dispatch run,
--      and claim the canary's pending invocation, because "the one unresolved invocation" was the
--      only discriminator. The canary's own request then RAISES on conflict_other_run.
--   The damage is not a failed canary. It is that activation's provenance assertion then accepts
--   a STEADY-STATE TICK's run as the canary's evidence — a run under none of the canary's
--   blast-radius bounds.
--
-- THE FIX, and why it keeps the property round 4 was protecting: the scheduled command is a
-- single fixed SQL text, but its BODY is an expression evaluated at execution time. Making that
-- expression name the pending invocation leaves the command byte-identical — the artifact still
-- executes exactly what the schedule will execute, and the md5 assertion still holds — while the
-- two callers produce different bodies for the honest reason that they are in different states:
--
--   * the artifact executes it INSIDE its own transaction, after open(), so the subquery sees its
--     own pending invocation and the request carries that id;
--   * a cron tick executes it when no invocation is pending, so the request carries NULL — and an
--     in-flight tick's body was frozen at execution time, before the invocation existed, so it
--     can never name it no matter when it arrives.
--
-- A tick can only evaluate the subquery non-NULL while an invocation is pending, and an
-- invocation is only ever opened while the job is provably INACTIVE under its row lock
-- (_job_identity_assertions.sql, held to COMMIT) — so that case cannot arise either.
--
-- WHAT THE RECORD DOES NOT CLAIM: it is evidence about the pipeline's own actors — ticks,
-- retries, duplicate dispatch — not an authorization boundary against a caller already holding
-- the service-role key. That caller can call every RPC directly and write these tables; the
-- boundary that matters for it is the key, not this record. Stated so the guarantee is not read
-- as wider than it is.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. the reviewed command, now self-identifying ──────────────────────────────────────────
-- Same url, same Vault-resolved bearer, same pg_catalog-qualified everything (the hostile
-- search_path doctrine from 20261012100000 applies to the new subquery too: its comparison
-- operator is qualified, or a planted text = text could make it answer NULL and silently restore
-- the old ambiguity). Applied with cron.alter_job — NOT unschedule/schedule (which destroys the
-- job) and NOT an UPDATE on cron.job (which the connected role cannot do on hosted Supabase:
-- that is N0's finding). alter_job touches ONLY the command; the job's active state is left
-- exactly as it was, so this migration cannot arm anything.
DO $do$
DECLARE
  v_jobid bigint;
  v_cmd text := $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' OPERATOR(pg_catalog.||) (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name OPERATOR(pg_catalog.=) 'service_role_key')
      ),
      body := pg_catalog.jsonb_build_object(
        'invocation_id', (SELECT i.id FROM public.notification_worker_invocations i WHERE i.status OPERATOR(pg_catalog.=) 'pending' LIMIT 1)
      )
    ) AS request_id;
  $cmd$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — nothing to re-point';
    RETURN;
  END IF;
  -- the same advisory lock the F migration takes, so a concurrent enablement step and this
  -- migration cannot interleave over the same job
  PERFORM pg_advisory_xact_lock(hashtextextended('cron:notification-digest-worker', 0));
  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user;
  IF v_jobid IS NULL THEN
    RAISE NOTICE 'notification-digest-worker is not scheduled for % — 20261012100000 installs it (inactive) with this command', current_user;
    RETURN;
  END IF;
  PERFORM cron.alter_job(v_jobid, command := v_cmd);
  RAISE NOTICE 'notification-digest-worker command re-pointed (jobid %); active state untouched', v_jobid;
END $do$;

-- ── 2. the claim binds ONLY what the request names ─────────────────────────────────────────
-- The old signature took a run and searched for "the one unresolved invocation". That search is
-- what let an unrelated request bind someone else's evidence, so it is gone — dropped rather than
-- kept beside the new one, because a caller that can still reach it can still do the wrong thing.
DROP FUNCTION IF EXISTS public.claim_pending_worker_invocation(uuid);

CREATE OR REPLACE FUNCTION public.claim_worker_invocation(
  p_worker_run_id uuid,
  p_invocation_id uuid
) RETURNS TABLE (status text, invocation_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_verdict text;
  v_other uuid;
  v_other_status text;
BEGIN
  IF p_worker_run_id IS NULL THEN
    RAISE EXCEPTION 'claim_worker_invocation: the dispatch run id is required';
  END IF;
  -- the same advisory lock open() and both gates take: a claim never reads a half-committed
  -- picture, and two claims order deterministically
  PERFORM pg_advisory_xact_lock(hashtextextended('notif-worker-invocation-open', 0));

  IF p_invocation_id IS NOT NULL THEN
    -- THIS request was dispatched by that invocation's own transaction. Bind it or STOP loudly:
    -- a duplicate HTTP request carrying the same id finds it 'started' under another run and
    -- raises, exactly as before — that protection is unchanged.
    v_verdict := public.bind_notification_worker_invocation(p_invocation_id, p_worker_run_id);
    IF v_verdict IN ('bound', 'replayed') THEN
      status := 'owned'; invocation_id := p_invocation_id; RETURN NEXT; RETURN;
    END IF;
    RAISE EXCEPTION 'claim_worker_invocation: invocation % refused this run (%) — verdict %',
      p_invocation_id, p_worker_run_id, v_verdict;
  END IF;

  -- No identity in the request: this is a cron tick, or a request whose body predates the
  -- invocation. It CANNOT own anything. If a deliberate invocation is unresolved, the request it
  -- belongs to is still travelling (or its run is already working), and a second full pass inside
  -- that evidence window is exactly what the invocation record exists to prevent — so this run
  -- does NO pipeline work and says so. Not an error: nothing is wrong, and nothing is stranded.
  -- qualified through an alias: the OUT parameter `status` shadows the column otherwise, and
  -- Postgres refuses the reference as ambiguous rather than guessing
  SELECT i.id, i.status INTO v_other, v_other_status
    FROM public.notification_worker_invocations i
   WHERE i.status IN ('pending', 'started')
   LIMIT 1;
  IF FOUND THEN
    status := 'deferred'; invocation_id := NULL; RETURN NEXT; RETURN;
  END IF;

  status := 'none'; invocation_id := NULL; RETURN NEXT;
END;
$$;
COMMENT ON FUNCTION public.claim_worker_invocation(uuid, uuid) IS
  'N4 (round 5): the dispatch worker''s startup claim, keyed by the invocation id THE REQUEST ITSELF carries (the scheduled command''s body names the pending invocation at execution time). owned = this run owns that invocation and may do deliberate work; deferred = the request carries no identity while a deliberate invocation is unresolved, so this run must do NO pipeline work; none = ordinary steady-state tick. A named invocation this run cannot own RAISES, so a duplicate HTTP request never executes a second unverified pass.';
REVOKE ALL ON FUNCTION public.claim_worker_invocation(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_worker_invocation(uuid, uuid) TO service_role;
