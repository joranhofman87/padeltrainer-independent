-- Refactor cron-scheduling wrapper functions to:
--   * read the service-role bearer from a GUC (app.settings.service_role_key)
--     instead of hard-coding the anon key in source.
--   * raise a clear error if the GUC is unset.
-- The GUC value itself is set out-of-band (never committed to git).

CREATE OR REPLACE FUNCTION public.schedule_enrichment_job()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_id bigint;
  sr_key text;
  cron_command text;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  sr_key := current_setting('app.settings.service_role_key', true);
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE EXCEPTION 'app.settings.service_role_key is not configured. Run: ALTER DATABASE postgres SET app.settings.service_role_key = ''<key>''; then SELECT pg_reload_conf();';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'enrich-locations-background';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/enrich-clubs',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{"batch_size": 5, "fill_missing_only": true}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  SELECT cron.schedule('enrich-locations-background', '*/2 * * * *', cron_command) INTO job_id;
  RETURN job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.schedule_logo_fetch_job()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_id bigint;
  sr_key text;
  cron_command text;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  sr_key := current_setting('app.settings.service_role_key', true);
  IF sr_key IS NULL OR sr_key = '' THEN
    RAISE EXCEPTION 'app.settings.service_role_key is not configured. Run: ALTER DATABASE postgres SET app.settings.service_role_key = ''<key>''; then SELECT pg_reload_conf();';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'fetch-location-logos-background';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/fetch-location-logos',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{"batch_size": 10}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  SELECT cron.schedule('fetch-location-logos-background', '*/15 * * * *', cron_command) INTO job_id;
  RETURN job_id;
END;
$$;