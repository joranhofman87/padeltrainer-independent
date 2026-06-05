-- Daily invoice-health-check cron (admin-triggered schedule, same pattern as enrichment/logo jobs).
-- Requires app.settings.service_role_key GUC (set out-of-band, never committed to git).

CREATE OR REPLACE FUNCTION public.schedule_invoice_health_check_job()
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

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'invoice-health-check-daily';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/invoice-health-check',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer %s'
      ),
      body := '{}'::jsonb
    ) AS request_id;$cmd$,
    sr_key
  );

  SELECT cron.schedule('invoice-health-check-daily', '0 6 * * *', cron_command) INTO job_id;
  RETURN job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unschedule_invoice_health_check_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  PERFORM cron.unschedule('invoice-health-check-daily');
END;
$$;

GRANT EXECUTE ON FUNCTION public.schedule_invoice_health_check_job() TO authenticated;
GRANT EXECUTE ON FUNCTION public.unschedule_invoice_health_check_job() TO authenticated;
