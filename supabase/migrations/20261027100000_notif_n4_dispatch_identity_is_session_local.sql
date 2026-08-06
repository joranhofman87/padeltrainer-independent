-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- N4 — THE DISPATCH IDENTITY IS SESSION-LOCAL, NOT A DATABASE LOOKUP (round 6)
--
-- Round 5 made the reviewed command's body name the pending invocation with a SUBQUERY. The
-- review found the interleaving that still defeats it, and it is a scheduler state no lock in
-- this repository can see:
--
--   1. pg_cron SELECTS a due tick while the job is active (the execution is now chosen).
--   2. The job is deactivated — rollback, or the ordinary pre-canary state.
--   3. The artifact passes every precondition (job inactive under its row lock, no run in flight,
--      nothing queued), opens invocation I and COMMITS.
--   4. Only now does the already-selected tick begin executing the stored SQL.
--   5. Its body subquery reads committed state — and sees I.
--   6. If that request reaches the worker first it binds I, and the artifact's own request is
--      refused. Activation would then accept a steady-state tick's run as the canary's evidence.
--
-- The job row lock protects the job DEFINITION, not an execution pg_cron already selected. So the
-- discriminator must not be a database read at all: any state the artifact commits is state a
-- late-starting tick can also read.
--
-- IT IS THE EXECUTING TRANSACTION ITSELF. The artifact publishes the invocation id into a
-- transaction-local GUC and then executes the reviewed command in that same transaction; the
-- command reads the GUC. pg_cron runs its own session and never sets it, so a tick — selected
-- early, started late, in flight, retried, whenever — reads NULL and can name nothing. The
-- command text stays one fixed text executed verbatim by both, so the canary still proves exactly
-- what the schedule will send, and the md5 pin still means what it meant.
--
-- EVERY name in the body is schema-qualified, including this one. A NULLIF wrapper was written
-- first and removed: NULLIF resolves an EQUALITY OPERATOR through search_path, so a planted
-- text = text both moved the parse tree and captured the value the command was building — the
-- rollout harness caught it. current_setting(…, true) already answers NULL when the GUC was never
-- set, which is the only case that mattered; a GUC explicitly set to '' produces an empty string
-- that the worker's uuid check rejects, so it names nothing either way.
--
-- (Unchanged scope, restated: this is evidence about the pipeline's own actors, not a boundary
-- against a caller already holding the service-role key — that caller can set the GUC, call the
-- RPCs and write the tables directly.)
-- ═══════════════════════════════════════════════════════════════════════════════════════════

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
        'invocation_id', pg_catalog.current_setting('notif.dispatch_invocation', true)
      )
    ) AS request_id;
  $cmd$;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — nothing to re-point';
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cron:notification-digest-worker', 0));
  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user;
  IF v_jobid IS NULL THEN
    RAISE NOTICE 'notification-digest-worker is not scheduled for % — 20261012100000 installs it (inactive)', current_user;
    RETURN;
  END IF;
  -- ONLY the command; the active state is left exactly as it was, so this cannot arm anything.
  PERFORM cron.alter_job(v_jobid, command := v_cmd);
  RAISE NOTICE 'notification-digest-worker command re-pointed to the session-local identity (jobid %); active state untouched', v_jobid;
END $do$;
