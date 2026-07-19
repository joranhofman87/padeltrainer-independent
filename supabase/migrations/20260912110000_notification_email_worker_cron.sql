-- Notification Foundation v2 — PR 4: schedule the email worker on pg_cron.
-- Mirrors the Vault-key cron pattern (20260722100000_rebook_crons_use_vault.sql):
-- guarded on pg_cron + the Vault 'service_role_key' secret so a fresh db reset / CI
-- (where neither is present) skips cleanly; idempotent unschedule-then-schedule.
-- The posted Bearer service-role JWT is what requireServiceRole() verifies in the fn.
--
-- NOTE: deploy the edge function (supabase functions deploy notification-email-worker)
-- BEFORE this schedule starts firing, or the posts 404 until it exists (harmless, noisy).
DO $do$
DECLARE
  sr_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-email-worker schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — skipping notification-email-worker schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-email-worker') THEN
    PERFORM cron.unschedule('notification-email-worker');
  END IF;

  -- every 2 minutes: responsive for transactional email while the outbox idles cheaply
  PERFORM cron.schedule('notification-email-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-email-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  RAISE NOTICE 'Scheduled notification-email-worker every 2 minutes';
END $do$;
