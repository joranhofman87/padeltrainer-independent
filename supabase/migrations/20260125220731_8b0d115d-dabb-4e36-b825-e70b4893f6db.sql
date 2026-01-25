-- Fix: Remove overly permissive SELECT policies on trainer_profiles table
-- Financial data (stripe_account_id, iban, bic, kvk_number, btw_number) is exposed

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "Anonymous can view trainer profiles" ON public.trainer_profiles;
DROP POLICY IF EXISTS "Anyone can view trainer profiles" ON public.trainer_profiles;

-- Update the trainer_profiles_safe view to include subscription_status and trial_ends_at
-- for visibility filtering (these are not sensitive financial data)
DROP VIEW IF EXISTS public.trainer_profiles_safe;
CREATE VIEW public.trainer_profiles_safe
WITH (security_invoker = on) AS
SELECT
  id, user_id, hourly_rate, experience_years, certifications,
  specializations, is_verified, knltb_rating, trainer_rating_system,
  coaching_method, favourite_quote, video_url, 
  social_instagram, social_tiktok, social_youtube, social_linkedin,
  preferred_min_rating, preferred_max_rating, preferred_rating_system,
  is_public, slot_duration_minutes, schedule_weeks_ahead, 
  subscription_status, trial_ends_at, require_booking_approval, use_manual_invoicing,
  created_at, updated_at
FROM public.trainer_profiles;

-- Create policy for anon/authenticated to access the base table through the view
-- The view uses security_invoker so we need a policy that allows SELECT for visibility filtering
CREATE POLICY "Public can view non-sensitive trainer data via safe view" 
ON public.trainer_profiles 
FOR SELECT 
USING (is_public = true);

-- Trainers can always view their own profile (full access)
CREATE POLICY "Trainers can view their own profile" 
ON public.trainer_profiles 
FOR SELECT 
USING (auth.uid() = user_id);

-- Admins can view all profiles
CREATE POLICY "Admins can view all trainer profiles" 
ON public.trainer_profiles 
FOR SELECT 
USING (is_admin(auth.uid()));