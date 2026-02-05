
-- Create helper functions for scheduling/unscheduling the logo fetch cron job
-- Using $fn$ delimiters to avoid conflicts with inner $$ in cron.schedule

CREATE OR REPLACE FUNCTION public.check_logo_fetch_job_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  job_id bigint;
  is_enabled boolean;
BEGIN
  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'fetch-location-logos-background';
  is_enabled := job_id IS NOT NULL;
  
  RETURN jsonb_build_object('is_enabled', is_enabled, 'job_id', job_id);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.schedule_logo_fetch_job()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  job_id bigint;
  cron_command text;
BEGIN
  -- Check if admin
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  -- Check if job already exists
  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'fetch-location-logos-background';
  
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  -- Build the cron command
  cron_command := E'SELECT net.http_post(url := \'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/fetch-location-logos\', headers := jsonb_build_object(\'Content-Type\', \'application/json\', \'Authorization\', \'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwa2JoZGlpcWR1c2RlYXRnZGZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTk2NDcsImV4cCI6MjA4NDA3NTY0N30.b7rDXbi4FBNc9rREGCCTmip3LVxH03_hm0DQMMyWio0\'), body := \'{"batch_size": 10}\'::jsonb) as request_id;';

  -- Create the cron job
  SELECT cron.schedule(
    'fetch-location-logos-background',
    '*/15 * * * *',
    cron_command
  ) INTO job_id;

  RETURN job_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.unschedule_logo_fetch_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- Check if admin
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  -- Unschedule the job
  PERFORM cron.unschedule('fetch-location-logos-background');
END;
$fn$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.check_logo_fetch_job_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_logo_fetch_job() TO authenticated;
GRANT EXECUTE ON FUNCTION public.unschedule_logo_fetch_job() TO authenticated;
