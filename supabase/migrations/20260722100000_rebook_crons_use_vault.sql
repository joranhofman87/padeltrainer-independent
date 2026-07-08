-- ============================================================================
-- REBOOK · schedule the two rebook notifier crons via Supabase VAULT (not a GUC)
-- ============================================================================
-- WHY: the earlier rebook cron migrations (20260714110000 notify-rebook-member-open,
-- 20260721100000 auto-rebook-reminder) inline the bearer via
--   current_setting('app.settings.service_role_key')
-- and their comments tell the owner to run `ALTER DATABASE ... SET app.settings...`.
-- On Supabase's MANAGED Postgres that ALTER is rejected — the `postgres` role is not a
-- superuser: `ERROR 42501: permission denied to set parameter`. So the guarded DO blocks
-- always hit "key not set — skipping" and the jobs were NEVER scheduled in production.
--
-- FIX (Supabase-blessed pattern): store the service-role key in Vault and read it from
-- vault.decrypted_secrets AT TICK TIME inside the cron command. No ALTER DATABASE, no
-- session reconnect, and key rotation needs only vault.update_secret (the key is not baked
-- into the stored command). See docs/CRON_SERVICE_KEY_SETUP.md.
--
-- ONE-TIME owner setup (run once in the SQL editor, value never committed):
--   select vault.create_secret('<service_role JWT eyJ… — NOT sb_secret_>', 'service_role_key');
--
-- This migration is idempotent (unschedule-then-schedule) and guarded so a fresh
-- `db reset` / CI (no pg_cron, or Vault secret absent) resets cleanly. It supersedes the
-- scheduling DO blocks in 20260714110000 and 20260721100000; the detection RPCs and edge
-- functions those migrations created are unchanged.
-- ============================================================================

DO $do$
DECLARE
  sr_key text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping rebook cron (re)schedule';
    RETURN;
  END IF;

  -- Read the service-role key from Vault. Wrapped so a DB without the vault extension
  -- (e.g. a bare Postgres in a test harness) skips cleanly instead of erroring.
  BEGIN
    sr_key := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key');
  EXCEPTION WHEN others THEN
    sr_key := NULL;
  END;

  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE NOTICE 'Vault secret service_role_key not set — skipping rebook cron (re)schedule (create it, then re-run this DO block)';
    RETURN;
  END IF;

  -- (1) notify-rebook-member-open — every 15 min. Reads the key from Vault at tick time.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-rebook-member-open') THEN
    PERFORM cron.unschedule('notify-rebook-member-open');
  END IF;
  PERFORM cron.schedule('notify-rebook-member-open', '*/15 * * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/notify-rebook-member-open',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  -- (2) auto-rebook-reminder — hourly across a daytime UTC window (the edge fn's send-window
  --     guard is the exact 09:00–20:00 Amsterdam clamp). Key from Vault at tick time.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-rebook-reminder') THEN
    PERFORM cron.unschedule('auto-rebook-reminder');
  END IF;
  PERFORM cron.schedule('auto-rebook-reminder', '0 6-19 * * *', $cmd$
    SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/auto-rebook-reminder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cmd$);

  RAISE NOTICE 'Rebook crons (re)scheduled via Vault: notify-rebook-member-open (*/15), auto-rebook-reminder (0 6-19)';
END $do$;
