-- Add subscription columns to club_profiles
ALTER TABLE public.club_profiles
ADD COLUMN IF NOT EXISTS subscription_status text DEFAULT 'trial',
ADD COLUMN IF NOT EXISTS subscription_tier text DEFAULT 'starter',
ADD COLUMN IF NOT EXISTS stripe_customer_id text,
ADD COLUMN IF NOT EXISTS subscription_id text,
ADD COLUMN IF NOT EXISTS trial_ends_at timestamp with time zone,
ADD COLUMN IF NOT EXISTS subscription_ends_at timestamp with time zone;

-- Set trial_ends_at to 14 days from claimed_at for existing clubs
UPDATE public.club_profiles
SET trial_ends_at = claimed_at + interval '14 days'
WHERE trial_ends_at IS NULL;

-- Create function to auto-set trial on new club claims
CREATE OR REPLACE FUNCTION public.set_club_trial()
RETURNS TRIGGER AS $$
BEGIN
  NEW.subscription_status := 'trial';
  NEW.subscription_tier := 'starter';
  NEW.trial_ends_at := NOW() + interval '14 days';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to auto-set trial on insert
DROP TRIGGER IF EXISTS set_club_trial_trigger ON public.club_profiles;
CREATE TRIGGER set_club_trial_trigger
BEFORE INSERT ON public.club_profiles
FOR EACH ROW
EXECUTE FUNCTION public.set_club_trial();