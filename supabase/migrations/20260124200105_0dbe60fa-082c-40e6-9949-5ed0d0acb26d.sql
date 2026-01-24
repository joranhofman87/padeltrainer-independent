-- Fix the security definer view issue by setting security invoker
ALTER VIEW public.club_profiles_public SET (security_invoker = on);