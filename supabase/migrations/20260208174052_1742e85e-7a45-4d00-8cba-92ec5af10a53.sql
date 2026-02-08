
-- Fix the trainer_profiles_safe view to use security_invoker
ALTER VIEW public.trainer_profiles_safe SET (security_invoker = on);
