-- Fix: Remove overly permissive SELECT policies on profiles table (PII exposure)
-- The profiles_public view should be used for public-facing components

-- Drop the overly permissive policies
DROP POLICY IF EXISTS "Anonymous users can view profiles" ON public.profiles;
DROP POLICY IF EXISTS "Authenticated users can view all profiles" ON public.profiles;