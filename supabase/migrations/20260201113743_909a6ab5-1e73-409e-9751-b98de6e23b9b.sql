-- Create onboarding_email_templates table
CREATE TABLE public.onboarding_email_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  user_type TEXT NOT NULL CHECK (user_type IN ('player', 'trainer', 'club', 'academy')),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('signup', 'paid_plan')),
  delay_days INTEGER NOT NULL DEFAULT 0 CHECK (delay_days >= 0 AND delay_days <= 365),
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create onboarding_email_queue table
CREATE TABLE public.onboarding_email_queue (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES public.onboarding_email_templates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_type TEXT NOT NULL,
  scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Create onboarding_email_logs table
CREATE TABLE public.onboarding_email_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  template_id UUID NOT NULL REFERENCES public.onboarding_email_templates(id) ON DELETE SET NULL,
  queue_id UUID REFERENCES public.onboarding_email_queue(id) ON DELETE SET NULL,
  user_id UUID NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed'))
);

-- Create indexes for performance
CREATE INDEX idx_onboarding_email_queue_status_scheduled ON public.onboarding_email_queue(status, scheduled_for) WHERE status = 'pending';
CREATE INDEX idx_onboarding_email_queue_user_id ON public.onboarding_email_queue(user_id);
CREATE INDEX idx_onboarding_email_templates_active ON public.onboarding_email_templates(user_type, trigger_type) WHERE is_active = true;
CREATE INDEX idx_onboarding_email_logs_user_id ON public.onboarding_email_logs(user_id);

-- Enable RLS
ALTER TABLE public.onboarding_email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_email_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_email_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for templates (admin only)
CREATE POLICY "Admins can view all templates"
  ON public.onboarding_email_templates FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Admins can create templates"
  ON public.onboarding_email_templates FOR INSERT
  WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update templates"
  ON public.onboarding_email_templates FOR UPDATE
  USING (is_admin(auth.uid()));

CREATE POLICY "Admins can delete templates"
  ON public.onboarding_email_templates FOR DELETE
  USING (is_admin(auth.uid()));

-- RLS Policies for queue (admin only for viewing, service role for processing)
CREATE POLICY "Admins can view email queue"
  ON public.onboarding_email_queue FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Admins can update email queue"
  ON public.onboarding_email_queue FOR UPDATE
  USING (is_admin(auth.uid()));

CREATE POLICY "Service role can insert to queue"
  ON public.onboarding_email_queue FOR INSERT
  WITH CHECK (true);

-- RLS Policies for logs (admin only)
CREATE POLICY "Admins can view email logs"
  ON public.onboarding_email_logs FOR SELECT
  USING (is_admin(auth.uid()));

CREATE POLICY "Service role can insert logs"
  ON public.onboarding_email_logs FOR INSERT
  WITH CHECK (true);

-- Create updated_at trigger for templates
CREATE TRIGGER update_onboarding_email_templates_updated_at
  BEFORE UPDATE ON public.onboarding_email_templates
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Function to queue onboarding emails for a user
CREATE OR REPLACE FUNCTION public.queue_onboarding_emails(
  p_user_id UUID,
  p_email TEXT,
  p_user_name TEXT,
  p_user_type TEXT,
  p_trigger_type TEXT
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO onboarding_email_queue (template_id, user_id, email, user_name, user_type, scheduled_for)
  SELECT 
    t.id,
    p_user_id,
    p_email,
    p_user_name,
    p_user_type,
    now() + (t.delay_days || ' days')::interval
  FROM onboarding_email_templates t
  WHERE t.user_type = p_user_type
    AND t.trigger_type = p_trigger_type
    AND t.is_active = true;
END;
$$;

-- Trigger function for trainer profile creation (signup)
CREATE OR REPLACE FUNCTION public.trigger_trainer_onboarding_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
BEGIN
  -- Get user email and name from profiles
  SELECT p.email, p.full_name INTO v_email, v_name
  FROM profiles p
  WHERE p.user_id = NEW.user_id;
  
  IF v_email IS NOT NULL THEN
    PERFORM queue_onboarding_emails(NEW.user_id, v_email, COALESCE(v_name, 'Trainer'), 'trainer', 'signup');
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for trainer subscription activation
CREATE OR REPLACE FUNCTION public.trigger_trainer_paid_plan_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
BEGIN
  -- Only trigger if subscription_status changed to active
  IF (OLD.subscription_status IS DISTINCT FROM 'active' AND NEW.subscription_status = 'active') THEN
    SELECT p.email, p.full_name INTO v_email, v_name
    FROM profiles p
    WHERE p.user_id = NEW.user_id;
    
    IF v_email IS NOT NULL THEN
      PERFORM queue_onboarding_emails(NEW.user_id, v_email, COALESCE(v_name, 'Trainer'), 'trainer', 'paid_plan');
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for player profile creation (signup)
CREATE OR REPLACE FUNCTION public.trigger_player_onboarding_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    PERFORM queue_onboarding_emails(NEW.user_id, NEW.email, COALESCE(NEW.full_name, 'Player'), 'player', 'signup');
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for club profile creation (signup)
CREATE OR REPLACE FUNCTION public.trigger_club_onboarding_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
  v_location_name TEXT;
BEGIN
  -- Get the location name for the club
  SELECT l.name INTO v_location_name
  FROM locations l
  WHERE l.id = NEW.location_id;
  
  -- Get the creator's email
  IF NEW.created_by IS NOT NULL THEN
    SELECT p.email, p.full_name INTO v_email, v_name
    FROM profiles p
    WHERE p.user_id = NEW.created_by;
    
    IF v_email IS NOT NULL THEN
      PERFORM queue_onboarding_emails(NEW.created_by, v_email, COALESCE(v_location_name, v_name, 'Club Owner'), 'club', 'signup');
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for club subscription activation
CREATE OR REPLACE FUNCTION public.trigger_club_paid_plan_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
  v_location_name TEXT;
BEGIN
  IF (OLD.subscription_status IS DISTINCT FROM 'active' AND NEW.subscription_status = 'active') THEN
    SELECT l.name INTO v_location_name
    FROM locations l
    WHERE l.id = NEW.location_id;
    
    IF NEW.created_by IS NOT NULL THEN
      SELECT p.email, p.full_name INTO v_email, v_name
      FROM profiles p
      WHERE p.user_id = NEW.created_by;
      
      IF v_email IS NOT NULL THEN
        PERFORM queue_onboarding_emails(NEW.created_by, v_email, COALESCE(v_location_name, v_name, 'Club Owner'), 'club', 'paid_plan');
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for academy profile creation (signup)
CREATE OR REPLACE FUNCTION public.trigger_academy_onboarding_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
BEGIN
  IF NEW.created_by IS NOT NULL THEN
    SELECT p.email, p.full_name INTO v_email, v_name
    FROM profiles p
    WHERE p.user_id = NEW.created_by;
    
    IF v_email IS NOT NULL THEN
      PERFORM queue_onboarding_emails(NEW.created_by, v_email, COALESCE(NEW.name, v_name, 'Academy Owner'), 'academy', 'signup');
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Trigger function for academy subscription activation
CREATE OR REPLACE FUNCTION public.trigger_academy_paid_plan_emails()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_name TEXT;
BEGIN
  IF (OLD.subscription_status IS DISTINCT FROM 'active' AND NEW.subscription_status = 'active') THEN
    IF NEW.created_by IS NOT NULL THEN
      SELECT p.email, p.full_name INTO v_email, v_name
      FROM profiles p
      WHERE p.user_id = NEW.created_by;
      
      IF v_email IS NOT NULL THEN
        PERFORM queue_onboarding_emails(NEW.created_by, v_email, COALESCE(NEW.name, v_name, 'Academy Owner'), 'academy', 'paid_plan');
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the triggers
CREATE TRIGGER on_trainer_profile_created
  AFTER INSERT ON public.trainer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_trainer_onboarding_emails();

CREATE TRIGGER on_trainer_subscription_activated
  AFTER UPDATE ON public.trainer_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_trainer_paid_plan_emails();

CREATE TRIGGER on_player_profile_created
  AFTER INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_player_onboarding_emails();

CREATE TRIGGER on_club_profile_created
  AFTER INSERT ON public.club_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_club_onboarding_emails();

CREATE TRIGGER on_club_subscription_activated
  AFTER UPDATE ON public.club_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_club_paid_plan_emails();

CREATE TRIGGER on_academy_profile_created
  AFTER INSERT ON public.academy_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_academy_onboarding_emails();

CREATE TRIGGER on_academy_subscription_activated
  AFTER UPDATE ON public.academy_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_academy_paid_plan_emails();