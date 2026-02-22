
-- Function to schedule the enrichment background job
CREATE OR REPLACE FUNCTION public.schedule_enrichment_job()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  job_id bigint;
  cron_command text;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'enrich-locations-background';
  
  IF job_id IS NOT NULL THEN
    RETURN job_id;
  END IF;

  cron_command := E'SELECT net.http_post(url := \'https://ppkbhdiiqdusdeatgdft.supabase.co/functions/v1/enrich-clubs\', headers := jsonb_build_object(\'Content-Type\', \'application/json\', \'Authorization\', \'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwa2JoZGlpcWR1c2RlYXRnZGZ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTk2NDcsImV4cCI6MjA4NDA3NTY0N30.b7rDXbi4FBNc9rREGCCTmip3LVxH03_hm0DQMMyWio0\'), body := \'{"batch_size": 5, "fill_missing_only": true}\'::jsonb) as request_id;';

  SELECT cron.schedule(
    'enrich-locations-background',
    '*/2 * * * *',
    cron_command
  ) INTO job_id;

  RETURN job_id;
END;
$function$;

-- Function to unschedule the enrichment job
CREATE OR REPLACE FUNCTION public.unschedule_enrichment_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  PERFORM cron.unschedule('enrich-locations-background');
END;
$function$;

-- Function to check enrichment job status
CREATE OR REPLACE FUNCTION public.check_enrichment_job_status()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  job_id bigint;
  is_enabled boolean;
BEGIN
  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'enrich-locations-background';
  is_enabled := job_id IS NOT NULL;
  
  RETURN jsonb_build_object('is_enabled', is_enabled, 'job_id', job_id);
END;
$function$;
