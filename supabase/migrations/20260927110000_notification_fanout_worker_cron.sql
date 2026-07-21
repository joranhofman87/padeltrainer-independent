-- PR 10b: schedule the fan-out worker on pg_cron. Same Vault-key guarded pattern as the email
-- worker (20260912110000): skips cleanly on a fresh db reset / CI where pg_cron or the Vault
-- secret is absent, and is idempotent (unschedule-then-schedule).
--
-- NOTE: deploy the edge function (supabase functions deploy notification-fanout-worker) BEFORE
-- this schedule fires, or the posts 404 until it exists (harmless, noisy).
--
-- Cadence: every 2 minutes, matching the email worker. A fan-out job is created when a trainer
-- publishes availability and the producer kicks one drain immediately; the cron exists to
-- FINISH large jobs and to RESUME any job whose worker crashed (its lease expires within
-- 2 minutes). It is the durability backstop, not the primary latency path.
DO $do$
DECLARE
  sr_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-fanout-worker schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — skipping notification-fanout-worker schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-fanout-worker') THEN
    PERFORM cron.unschedule('notification-fanout-worker');
  END IF;

  PERFORM cron.schedule('notification-fanout-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-fanout-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  RAISE NOTICE 'Scheduled notification-fanout-worker every 2 minutes';
END $do$;
