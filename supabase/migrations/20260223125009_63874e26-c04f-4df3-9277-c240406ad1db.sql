
-- Create user_discounts table
CREATE TABLE public.user_discounts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  discount_percent INTEGER NOT NULL CHECK (discount_percent >= 1 AND discount_percent <= 100),
  duration_months INTEGER NOT NULL CHECK (duration_months >= 1),
  months_remaining INTEGER NOT NULL CHECK (months_remaining >= 0),
  source TEXT NOT NULL DEFAULT 'referral',
  is_active BOOLEAN NOT NULL DEFAULT true,
  first_payment_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

-- Enable RLS
ALTER TABLE public.user_discounts ENABLE ROW LEVEL SECURITY;

-- Admins can do everything
CREATE POLICY "Admins can manage all discounts"
  ON public.user_discounts
  FOR ALL
  USING (public.is_admin(auth.uid()));

-- Users can read their own discount
CREATE POLICY "Users can read own discount"
  ON public.user_discounts
  FOR SELECT
  USING (auth.uid() = user_id);
