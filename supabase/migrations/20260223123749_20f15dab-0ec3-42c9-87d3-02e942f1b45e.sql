
-- Create subscription_payments audit table
CREATE TABLE public.subscription_payments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_type TEXT NOT NULL CHECK (profile_type IN ('trainer', 'academy', 'club')),
  profile_id UUID NOT NULL,
  mollie_payment_id TEXT NOT NULL UNIQUE,
  mollie_subscription_id TEXT,
  mollie_customer_id TEXT,
  amount NUMERIC(10,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  status TEXT NOT NULL,
  plan_id TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscription_payments ENABLE ROW LEVEL SECURITY;

-- No public policies needed - only service role writes/reads
-- Admins can read via edge functions using service role key

-- Index for common queries
CREATE INDEX idx_subscription_payments_profile ON public.subscription_payments (profile_type, profile_id);
CREATE INDEX idx_subscription_payments_status ON public.subscription_payments (status);
