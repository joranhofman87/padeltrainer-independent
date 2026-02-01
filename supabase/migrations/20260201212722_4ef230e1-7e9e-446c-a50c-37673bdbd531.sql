-- Fix function search path for is_any_academy_manager
CREATE OR REPLACE FUNCTION public.is_any_academy_manager(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.academy_managers
    WHERE user_id = _user_id
  );
$$;