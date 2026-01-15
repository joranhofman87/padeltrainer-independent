-- Add Stripe fields to bookings table
ALTER TABLE public.bookings
ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text,
ADD COLUMN IF NOT EXISTS stripe_session_id text;

-- Create trainer_stripe_accounts table for Stripe Connect
CREATE TABLE IF NOT EXISTS public.trainer_stripe_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  trainer_id uuid NOT NULL REFERENCES public.trainer_profiles(id) ON DELETE CASCADE,
  stripe_account_id text NOT NULL,
  onboarding_complete boolean NOT NULL DEFAULT false,
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(trainer_id),
  UNIQUE(stripe_account_id)
);

-- Enable RLS
ALTER TABLE public.trainer_stripe_accounts ENABLE ROW LEVEL SECURITY;

-- Trainers can view their own Stripe account
CREATE POLICY "Trainers can view their own stripe account"
ON public.trainer_stripe_accounts
FOR SELECT
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

-- Trainers can insert their own Stripe account
CREATE POLICY "Trainers can insert their own stripe account"
ON public.trainer_stripe_accounts
FOR INSERT
WITH CHECK (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

-- Trainers can update their own Stripe account
CREATE POLICY "Trainers can update their own stripe account"
ON public.trainer_stripe_accounts
FOR UPDATE
USING (trainer_id IN (
  SELECT id FROM trainer_profiles WHERE user_id = auth.uid()
));

-- Add trigger for updated_at
CREATE TRIGGER update_trainer_stripe_accounts_updated_at
BEFORE UPDATE ON public.trainer_stripe_accounts
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();