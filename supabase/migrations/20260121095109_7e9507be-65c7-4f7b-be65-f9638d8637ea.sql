-- Create club_stripe_accounts table for club Stripe Connect
CREATE TABLE public.club_stripe_accounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  club_profile_id UUID NOT NULL REFERENCES public.club_profiles(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL,
  onboarding_complete BOOLEAN NOT NULL DEFAULT false,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(club_profile_id)
);

-- Enable RLS
ALTER TABLE public.club_stripe_accounts ENABLE ROW LEVEL SECURITY;

-- Club managers can view their club's Stripe account
CREATE POLICY "Club managers can view their club stripe account"
ON public.club_stripe_accounts
FOR SELECT
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Club managers can insert their club's Stripe account
CREATE POLICY "Club managers can insert their club stripe account"
ON public.club_stripe_accounts
FOR INSERT
WITH CHECK (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Club managers can update their club's Stripe account
CREATE POLICY "Club managers can update their club stripe account"
ON public.club_stripe_accounts
FOR UPDATE
USING (club_profile_id IN (SELECT get_user_club_ids(auth.uid())));

-- Create trigger for updated_at
CREATE TRIGGER update_club_stripe_accounts_updated_at
BEFORE UPDATE ON public.club_stripe_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();