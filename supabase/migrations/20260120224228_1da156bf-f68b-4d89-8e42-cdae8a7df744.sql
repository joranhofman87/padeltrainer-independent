-- Fix search_path for set_club_trial function
CREATE OR REPLACE FUNCTION public.set_club_trial()
RETURNS TRIGGER AS $$
BEGIN
  NEW.subscription_status := 'trial';
  NEW.subscription_tier := 'starter';
  NEW.trial_ends_at := NOW() + interval '14 days';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;