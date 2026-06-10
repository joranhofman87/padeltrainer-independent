-- Phase 5: atomic onboarding email idempotency + ficwb cron URL targets.
-- Does not rewrite historical migrations; replaces schedule_* RPC bodies only.

-- Prevent duplicate "sent" logs for the same queue row under concurrent invocations.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_email_logs_queue_sent_unique
  ON public.onboarding_email_logs (queue_id)
  WHERE status = 'sent' AND queue_id IS NOT NULL;

-- Atomic claim: only one caller can move queue row from expected status -> sent.
CREATE OR REPLACE FUNCTION public.claim_onboarding_email_queue_item(
  p_queue_id uuid,
  p_from_status text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed uuid;
BEGIN
  UPDATE public.onboarding_email_queue
  SET
    status = 'sent',
    sent_at = now()
  WHERE id = p_queue_id
    AND status = p_from_status
  RETURNING id INTO claimed;

  RETURN claimed IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_onboarding_email_queue_item(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_onboarding_email_queue_item(uuid, text) TO service_role;

-- Point pg_cron schedule helpers at ficwb (fallback when admin schedules via UI).
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
    RAISE EXCEPTION 'app.settings.service_role_key is not configured';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'enrich-locations-background';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/enrich-clubs',
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
    RAISE EXCEPTION 'app.settings.service_role_key is not configured';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'fetch-location-logos-background';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/fetch-location-logos',
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
    RAISE EXCEPTION 'app.settings.service_role_key is not configured';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'invoice-health-check-daily';
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := format(
    $cmd$SELECT net.http_post(
      url := 'https://ficwbdrzefmblkbkomzw.supabase.co/functions/v1/invoice-health-check',
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

-- Unschedule pg_cron background jobs (use after Vercel Cron is active).
CREATE OR REPLACE FUNCTION public.unschedule_all_background_pg_cron_jobs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  PERFORM cron.unschedule('enrich-locations-background');
  PERFORM cron.unschedule('fetch-location-logos-background');
  PERFORM cron.unschedule('invoice-health-check-daily');
END;
$$;

GRANT EXECUTE ON FUNCTION public.unschedule_all_background_pg_cron_jobs() TO authenticated;
