-- Create helper function to check if a trainer belongs to any of the user's academies
-- Uses SECURITY DEFINER to bypass RLS and prevent infinite recursion
CREATE OR REPLACE FUNCTION public.is_academy_trainer(_user_id uuid, _trainer_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM academy_trainers at
    WHERE at.trainer_profile_id = _trainer_profile_id
      AND at.academy_profile_id IN (
        SELECT academy_profile_id 
        FROM academy_managers 
        WHERE user_id = _user_id
      )
  )
$$;

-- Create helper function to check if a trainer is ACTIVE in any of the user's academies
CREATE OR REPLACE FUNCTION public.is_active_academy_trainer(_user_id uuid, _trainer_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM academy_trainers at
    WHERE at.trainer_profile_id = _trainer_profile_id
      AND at.status = 'active'
      AND at.academy_profile_id IN (
        SELECT academy_profile_id 
        FROM academy_managers 
        WHERE user_id = _user_id
      )
  )
$$;

-- Drop the problematic policies that cause infinite recursion
DROP POLICY IF EXISTS "Academy managers can view trainer profiles in their academy" 
  ON public.trainer_profiles;
DROP POLICY IF EXISTS "Academy managers can update trainer profiles in their academy" 
  ON public.trainer_profiles;

-- Recreate SELECT policy using the safe SECURITY DEFINER function
CREATE POLICY "Academy managers can view trainer profiles in their academy"
  ON public.trainer_profiles FOR SELECT
  USING (public.is_academy_trainer(auth.uid(), id));

-- Recreate UPDATE policy using the safe SECURITY DEFINER function (with active status check)
CREATE POLICY "Academy managers can update trainer profiles in their academy"
  ON public.trainer_profiles FOR UPDATE
  USING (public.is_active_academy_trainer(auth.uid(), id));