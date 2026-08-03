-- 10c-b F — the digest worker's cron, INSTALLED INACTIVE, plus a liveness signal for the
-- external monitor ADR 0008 says is the only durable safety net.
--
-- Two things ship here and NEITHER of them sends anything:
--
--   1. the pg_cron job, created and immediately DISABLED. Enabling it is an owner gate
--      (`cron.alter_job(jobid, active := true)`), performed only after the switch is on and one
--      controlled canary has been reconciled — see the ADR's 10c-a3 runbook, step 5.
--   2. `notif_digest_worker_liveness()`, a pure read that answers the one question the in-worker
--      alert structurally cannot: "was it invoked at all?"
--
-- WHY A LIVENESS READ EXISTS AT ALL. The worker's own Slack alert needs the worker to run. A
-- function that is never invoked — an unscheduled job, a disabled job, a Vault secret that went
-- missing, a paused project — produces silence, and silence is indistinguishable from health.
-- ADR 0008 states this explicitly: "the durable safety net for 'the function is broken /
-- misconfigured' is EXTERNAL cron/uptime monitoring on the scheduled invocation (a non-200, or no
-- invocation at all), NOT the in-worker alert. This must be wired when the cron is scheduled in
-- 10c-b." Wiring the external monitor is an operator action; what the database can do is expose a
-- single, cheap, PII-free row for it to read, which is this function.

-- ===========================================================================
-- 1. THE JOB — created inactive, and never re-armed or disarmed by a re-run.
DO $do$
DECLARE
  sr_key text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-digest-worker schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  -- NO VAULT GUARD, and that is a difference from the other worker crons on purpose. They are
  -- created ARMED, so a missing secret would mean ticking with no bearer; skipping is right for
  -- them. This job is created DISABLED, its stored command reads the Vault secret at TICK time,
  -- and the owner only arms it after the runbook's checks. Skipping here would be worse than
  -- pointless: on a restore where migrations run before out-of-band secrets, the migration would
  -- be recorded as applied and adding the key later would never create the job — the rollout
  -- would report "installed inactive" over nothing at all.
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — installing notification-digest-worker INACTIVE anyway (the command reads Vault at tick time)';
  END IF;

  -- IDEMPOTENT, AND NON-DESTRUCTIVE. The other worker crons in this repo unschedule-then-schedule,
  -- which is fine for a job that is meant to be running. It is NOT fine here: the whole point of
  -- this job is that an OWNER decides when it becomes active, and an unschedule/reschedule would
  -- silently disarm a job the owner had already enabled — the rollout would look complete while
  -- nothing ran. So an existing job is left exactly as the owner left it, active or not.
  -- OWNER-SCOPED. Real pg_cron scopes named-job uniqueness by (jobname, username), so a bare
  -- jobname lookup can see — and act on — another role's job of the same name.
  SELECT jobid INTO v_jobid
    FROM cron.job WHERE jobname = 'notification-digest-worker' AND username = current_user;
  IF v_jobid IS NOT NULL THEN
    RAISE NOTICE 'notification-digest-worker already scheduled (jobid %) — leaving its active state untouched', v_jobid;
    RETURN;
  END IF;

  -- Every 5 minutes once enabled: a digest boundary is hourly at worst, so this is responsive
  -- without being chatty, and the worker is bounded per invocation anyway.
  -- Take the jobid from cron.schedule's OWN return value. Re-looking it up by name afterwards
  -- could select a different role's job created in between, disable THAT one, and leave the job
  -- this migration just created armed — the exact opposite of what this migration is for.
  v_jobid := cron.schedule('notification-digest-worker', '*/5 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-digest-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  -- INERT BY CONSTRUCTION: disabled in the same transaction that created it, so there is no
  -- window in which a scheduler tick could fire it.
  PERFORM cron.alter_job(v_jobid, active := false);
  RAISE NOTICE 'Scheduled notification-digest-worker every 5 minutes, INACTIVE (jobid %)', v_jobid;
END $do$;

-- ===========================================================================
-- 2. THE LIVENESS READ.
--
-- One row, no PII, cheap enough for a monitor to poll. It answers three separate questions that
-- an operator otherwise has to infer from silence:
--
--   * is the job even there, and is it armed?               (job_present, job_active)
--   * when did a dispatch run last FINISH SUCCESSFULLY?     (last_success_at, seconds_since_success)
--   * when did one last finish at all, and how?             (last_finished_at, last_status)
--
-- `last_success_at` is deliberately about a SUCCEEDED run, not merely a started one: a worker
-- that is invoked on schedule and fails every time is exactly as undelivered as one that is never
-- invoked, and a monitor watching "did it run" would see a green light through it.
CREATE OR REPLACE FUNCTION public.notif_digest_worker_liveness()
RETURNS TABLE (
  job_present            boolean,
  job_active             boolean,
  last_success_at        timestamptz,
  seconds_since_success  numeric,
  last_finished_at       timestamptz,
  last_status            text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_present boolean := false;
  v_active  boolean := false;
BEGIN
  -- pg_cron is absent in local/CI databases; a liveness read must still answer there rather than
  -- raising, so the job half degrades to "not present" instead of taking the whole call down.
  BEGIN
    SELECT true, j.active INTO v_present, v_active
      FROM cron.job j
     WHERE j.jobname = 'notification-digest-worker' AND j.username = current_user;
  EXCEPTION WHEN others THEN
    v_present := false; v_active := false;
  END;
  IF v_present IS NULL THEN v_present := false; v_active := false; END IF;

  RETURN QUERY
  WITH runs AS (
    -- `ended_at`, not `finished_at`: the ledger's own column name
    -- (20261002100000_notification_digest_schema_foundation.sql). A run is born unfinished with
    -- status NULL and finish is the only update, so "finished at all" is ended_at IS NOT NULL.
    SELECT r.ended_at, r.status
      FROM public.notification_worker_runs r
     WHERE r.phase = 'dispatch' AND r.channel = 'email' AND r.ended_at IS NOT NULL
  ),
  ok AS (SELECT max(ended_at) AS at FROM runs WHERE status = 'succeeded'),
  last AS (SELECT ended_at, status FROM runs ORDER BY ended_at DESC LIMIT 1)
  SELECT
    v_present,
    coalesce(v_active, false),
    ok.at,
    CASE WHEN ok.at IS NULL THEN NULL ELSE round(extract(epoch FROM (now() - ok.at))::numeric, 0) END,
    last.ended_at,
    last.status
  FROM ok LEFT JOIN last ON true;
END $$;

COMMENT ON FUNCTION public.notif_digest_worker_liveness() IS
  '10c-b F: PII-free liveness row for EXTERNAL cron/uptime monitoring of notification-digest-worker — whether the job exists and is armed, and when a dispatch run last SUCCEEDED. The in-worker Slack alert cannot cover "never invoked"; this is what a monitor reads instead.';

REVOKE ALL ON FUNCTION public.notif_digest_worker_liveness() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_digest_worker_liveness() TO service_role;
