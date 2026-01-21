-- Create subscription_plans table for admin-managed pricing
CREATE TABLE public.subscription_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  monthly_price NUMERIC NOT NULL DEFAULT 0,
  yearly_price NUMERIC NOT NULL DEFAULT 0,
  platform_fee_percent NUMERIC NOT NULL DEFAULT 10,
  stripe_price_id_monthly TEXT,
  stripe_price_id_yearly TEXT,
  stripe_product_id_monthly TEXT,
  stripe_product_id_yearly TEXT,
  max_lessons INTEGER, -- NULL for unlimited
  features JSONB DEFAULT '[]'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_highlighted BOOLEAN NOT NULL DEFAULT false,
  badge TEXT,
  plan_type TEXT NOT NULL DEFAULT 'trainer', -- 'trainer' or 'club'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

-- Anyone can view active plans
CREATE POLICY "Anyone can view active plans"
ON public.subscription_plans
FOR SELECT
USING (is_active = true);

-- Admins can view all plans
CREATE POLICY "Admins can view all plans"
ON public.subscription_plans
FOR SELECT
USING (is_admin(auth.uid()));

-- Admins can insert plans
CREATE POLICY "Admins can insert plans"
ON public.subscription_plans
FOR INSERT
WITH CHECK (is_admin(auth.uid()));

-- Admins can update plans
CREATE POLICY "Admins can update plans"
ON public.subscription_plans
FOR UPDATE
USING (is_admin(auth.uid()));

-- Admins can delete plans
CREATE POLICY "Admins can delete plans"
ON public.subscription_plans
FOR DELETE
USING (is_admin(auth.uid()));

-- Create updated_at trigger
CREATE TRIGGER update_subscription_plans_updated_at
BEFORE UPDATE ON public.subscription_plans
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Seed initial trainer plans
INSERT INTO public.subscription_plans (tier, name, description, monthly_price, yearly_price, platform_fee_percent, stripe_price_id_monthly, stripe_price_id_yearly, stripe_product_id_monthly, stripe_product_id_yearly, max_lessons, features, display_order, is_highlighted, badge, plan_type) VALUES
('starter', 'Starter', 'Perfect for getting started', 0, 0, 10, NULL, NULL, NULL, NULL, 3, '["3 lessons per month", "Basic profile", "Standard support"]'::jsonb, 0, false, NULL, 'trainer'),
('professional', 'Professional', 'For serious trainers', 29, 278, 5, 'price_1Spz9VPxAlHS6UZH9wmgdECd', 'price_1Spz9uPxAlHS6UZHMaZfUTBY', 'prod_TnaKMqklQL0csZ', 'prod_TnaK7n69g3z1go', NULL, '["Unlimited lessons", "Priority support", "Analytics dashboard", "Custom branding"]'::jsonb, 1, true, 'Most Popular', 'trainer'),
('academy', 'Academy', 'For training academies', 79, 758, 2.5, 'price_1SpzA8PxAlHS6UZHKsoY94qK', 'price_1SpzAdPxAlHS6UZHKjhjq8Ey', 'prod_TnaKlteqteiFWb', 'prod_TnaLKqo3OnQCOd', NULL, '["Everything in Professional", "Multi-trainer support", "Team management", "White-label options"]'::jsonb, 2, false, 'Best Value', 'trainer'),
('club', 'Club', 'For padel clubs', 199, 2388, 5, 'price_1SqSZBPxAlHS6UZHJHw1xUFB', NULL, 'prod_TobiJfC96Jjf3h', NULL, NULL, '["Unlimited trainers", "Court management", "Member portal", "Revenue tracking", "Priority support"]'::jsonb, 0, false, NULL, 'club');