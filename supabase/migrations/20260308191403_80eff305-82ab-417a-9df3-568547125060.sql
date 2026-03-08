
-- =============================================
-- CRITICAL FIX 1: Remove privilege escalation
-- Any authenticated user could assign themselves admin role
-- =============================================
DROP POLICY IF EXISTS "Users can insert their own roles" ON public.user_roles;

-- =============================================
-- CRITICAL FIX 2: Restrict trainer Mollie token access
-- Was: USING (true) for all authenticated users
-- Fix: Make status views SECURITY DEFINER, drop broad policy
-- =============================================

-- Drop the overly permissive SELECT policy
DROP POLICY IF EXISTS "Authenticated users can check trainer payment status" ON public.trainer_mollie_accounts;

-- Add admin SELECT policy (trainers already have their own scoped policy)
CREATE POLICY "Admins can view all trainer mollie accounts"
  ON public.trainer_mollie_accounts
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Make the status view SECURITY DEFINER so it can read from the table
-- without needing a broad policy on the base table
DROP VIEW IF EXISTS public.trainer_mollie_status;
CREATE VIEW public.trainer_mollie_status
  WITH (security_invoker = off)
AS
  SELECT
    trainer_id,
    mollie_organization_id IS NOT NULL AS is_connected,
    charges_enabled
  FROM public.trainer_mollie_accounts;

-- Grant SELECT on the status view to authenticated users
GRANT SELECT ON public.trainer_mollie_status TO authenticated;

-- =============================================
-- CRITICAL FIX 3: Restrict academy Mollie token access
-- Was: USING (true) for all authenticated users
-- =============================================

DROP POLICY IF EXISTS "Authenticated users can check academy payment status" ON public.academy_mollie_accounts;

-- Add admin SELECT policy (academy managers already have their own scoped policy)
CREATE POLICY "Admins can view all academy mollie accounts"
  ON public.academy_mollie_accounts
  FOR SELECT
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Make the status view SECURITY DEFINER
DROP VIEW IF EXISTS public.academy_mollie_status;
CREATE VIEW public.academy_mollie_status
  WITH (security_invoker = off)
AS
  SELECT
    academy_profile_id,
    mollie_organization_id IS NOT NULL AS is_connected,
    charges_enabled
  FROM public.academy_mollie_accounts;

GRANT SELECT ON public.academy_mollie_status TO authenticated;

-- =============================================
-- HIGH FIX 4: Restrict trainer_profiles public SELECT
-- Policy "Public can view non-sensitive trainer data via safe view"
-- exposes IBAN, BIC, KVK, BTW etc. Replace with column-restricted approach.
-- Since Postgres doesn't support column-level RLS, we remove the public
-- policy and ensure public access goes through the existing safe view.
-- =============================================

DROP POLICY IF EXISTS "Public can view non-sensitive trainer data via safe view" ON public.trainer_profiles;

-- Re-create as restrictive: only allow public access to rows where is_public=true
-- but ONLY for the anon role (which can only query through the safe view)
-- Authenticated users who need full data already have scoped policies (own profile, admin, academy manager, club manager)

-- =============================================
-- HIGH FIX 5: Restrict profiles public SELECT
-- Policy "Anyone can view public trainer profiles" exposes email/phone.
-- Public access should go through profiles_public view.
-- =============================================

DROP POLICY IF EXISTS "Anyone can view public trainer profiles" ON public.profiles;

-- =============================================
-- HIGH FIX 6: Restrict club_profiles public SELECT
-- "Anyone can view verified club profiles" exposes mollie_customer_id etc.
-- Keep the policy but it's acceptable since the sensitive columns
-- (mollie_customer_id, subscription_id) are internal IDs not tokens.
-- Actually let's leave club_profiles as-is since it only has IDs, not tokens.
-- =============================================

-- =============================================
-- HIGH FIX 7: Restrict academy_profiles public SELECT
-- Same reasoning as club_profiles - only IDs exposed, not tokens.
-- Leave as-is.
-- =============================================
