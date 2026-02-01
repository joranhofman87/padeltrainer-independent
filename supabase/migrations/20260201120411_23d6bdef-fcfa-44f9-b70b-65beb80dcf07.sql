-- Update the queue_onboarding_emails function to use awaiting_confirmation for 0-day emails
CREATE OR REPLACE FUNCTION public.queue_onboarding_emails(
  p_user_id uuid, 
  p_email text, 
  p_user_name text, 
  p_user_type text, 
  p_trigger_type text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO onboarding_email_queue (template_id, user_id, email, user_name, user_type, scheduled_for, status)
  SELECT 
    t.id,
    p_user_id,
    p_email,
    p_user_name,
    p_user_type,
    now() + (t.delay_days || ' days')::interval,
    CASE WHEN t.delay_days = 0 THEN 'awaiting_confirmation' ELSE 'pending' END
  FROM onboarding_email_templates t
  WHERE t.user_type = p_user_type
    AND t.trigger_type = p_trigger_type
    AND t.is_active = true;
END;
$function$;