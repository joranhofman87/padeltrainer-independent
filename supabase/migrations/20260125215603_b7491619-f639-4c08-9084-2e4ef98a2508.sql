-- Fix: Remove public SELECT access to profiles table (PII exposure)
-- The profiles_public view should be used for public-facing components

-- Drop the overly permissive anonymous access policy
DROP POLICY IF EXISTS "Anyone can view profiles" ON public.profiles;

-- Ensure owners can view their own profile
CREATE POLICY "Users can view their own profile" 
ON public.profiles 
FOR SELECT 
USING (auth.uid() = user_id);

-- Ensure admins can view all profiles
CREATE POLICY "Admins can view all profiles" 
ON public.profiles 
FOR SELECT 
USING (is_admin(auth.uid()));