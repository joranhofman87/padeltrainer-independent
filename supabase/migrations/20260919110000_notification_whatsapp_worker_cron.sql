-- Notification Foundation v2 — PR 9: schedule the WhatsApp worker on pg_cron.
-- Mirrors 20260912110000_notification_email_worker_cron.sql exactly: guarded on pg_cron + the
-- Vault 'service_role_key' secret so a fresh db reset / CI (where neither exists) skips
-- cleanly; idempotent unschedule-then-schedule.
--
-- SAFE TO SCHEDULE WHILE DISABLED, and deliberately scheduled now rather than later: with
-- WHATSAPP_SEND_ENABLED unset the worker returns {skipped:"disabled"} before claiming
-- anything, so the tick is a no-op. Wiring it here means going live is a single env-var flip
-- rather than "flip the flag AND remember to also schedule the drainer" — the second half of
-- which is exactly the step that gets forgotten, leaving rows pending forever with no error.
--
-- NOTE: deploy the edge function (supabase functions deploy notification-whatsapp-worker)
-- BEFORE this schedule starts firing, or the posts 404 until it exists (harmless, noisy).
DO $do$
DECLARE
  sr_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping notification-whatsapp-worker schedule';
    RETURN;
  END IF;

  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — skipping notification-whatsapp-worker schedule';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-whatsapp-worker') THEN
    PERFORM cron.unschedule('notification-whatsapp-worker');
  END IF;

  -- every 2 minutes, matching the email worker: reminders are time-sensitive, and while the
  -- kill switch is off each tick is a single early-return.
  PERFORM cron.schedule('notification-whatsapp-worker', '*/2 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notification-whatsapp-worker',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  RAISE NOTICE 'Scheduled notification-whatsapp-worker every 2 minutes';
END $do$;
