
-- Secure view: exposes only non-sensitive payment status for trainers
CREATE VIEW public.trainer_mollie_status
WITH (security_invoker = on) AS
SELECT 
  trainer_id,
  charges_enabled,
  onboarding_complete,
  (mollie_organization_id IS NOT NULL 
   AND mollie_organization_id NOT LIKE 'pending_%') AS is_connected
FROM public.trainer_mollie_accounts;

-- Secure view: exposes only non-sensitive payment status for academies
CREATE VIEW public.academy_mollie_status
WITH (security_invoker = on) AS
SELECT 
  academy_profile_id,
  charges_enabled,
  onboarding_complete,
  (mollie_organization_id IS NOT NULL 
   AND mollie_organization_id NOT LIKE 'pending_%') AS is_connected
FROM public.academy_mollie_accounts;

-- Allow any authenticated user to read these views via RLS on underlying tables
-- We need SELECT policies that allow authenticated users to read the status fields
-- Since the views use security_invoker, we need policies on the base tables

-- Add SELECT policy for authenticated users on trainer_mollie_accounts (limited by view columns)
CREATE POLICY "Authenticated users can check trainer payment status"
ON public.trainer_mollie_accounts
FOR SELECT
TO authenticated
USING (true);

-- Add SELECT policy for authenticated users on academy_mollie_accounts
CREATE POLICY "Authenticated users can check academy payment status"
ON public.academy_mollie_accounts
FOR SELECT
TO authenticated
USING (true);
