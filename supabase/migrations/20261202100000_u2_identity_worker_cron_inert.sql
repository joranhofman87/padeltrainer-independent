-- SLICE A part 3 — the identity sender's invocation mechanism, REGISTERED BUT INACTIVE.
--
-- Codex round 1 of slice A: the sender was request-driven only. Nothing invoked it, so once the
-- challenge-producing entrypoints shipped, verification rows would have sat `pending` forever while
-- the runbook said "activate the sender" with no executable action attached. A queue with no drainer
-- is a slower version of the bug this slice exists to fix.
--
-- WHY IT IS CREATED INACTIVE. Turning on a worker that sends real email to real customers is an
-- explicit owner gate in this repository, and this migration is not the moment to cross it. So the
-- job is registered with its real schedule and then immediately deactivated, which means:
--
--   * the mechanism EXISTS and is reviewable now, in the same change as the worker it drives;
--   * activation is one auditable statement at the cutover, not a hunt for the right cron syntax at
--     the point of highest pressure;
--   * applying this migration sends nothing, so it is safe to ship ahead of the window.
--
-- ACTIVATION (owner-gated, at the cutover, AFTER the secrets are set):
--     SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'notification-identity-worker'),
--                           active => true);
-- DEACTIVATION (the rollback):
--     SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'notification-identity-worker'),
--                           active => false);
--
-- Every two minutes matches the generic email worker: a verification challenge is the one email a
-- person is actively waiting on with a booking half-finished, so latency here is the product.
DO $do$
DECLARE
  sr_key text;
  v_jobid bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-identity-worker registration';
    RETURN;
  END IF;

  BEGIN
    SELECT decrypted_secret INTO sr_key
      FROM vault.decrypted_secrets WHERE name = 'service_role_key';
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — skipping notification-identity-worker schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-identity-worker') THEN
    PERFORM cron.unschedule('notification-identity-worker');
  END IF;

  PERFORM cron.schedule('notification-identity-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-identity-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  -- ...and immediately OFF. The schedule above is a definition, not a decision.
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'notification-identity-worker';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.alter_job(v_jobid, active => false);
    RAISE NOTICE 'Registered notification-identity-worker (every 2 minutes) — INACTIVE, activation is an owner gate';
  END IF;
END $do$;
