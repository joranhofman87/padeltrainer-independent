-- Create security definer function to check if user is club owner
CREATE OR REPLACE FUNCTION public.is_club_owner(_user_id uuid, _club_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_managers
    WHERE user_id = _user_id
      AND club_profile_id = _club_profile_id
      AND role = 'owner'
  )
$$;

-- Create function to check if club has any managers
CREATE OR REPLACE FUNCTION public.club_has_managers(_club_profile_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.club_managers
    WHERE club_profile_id = _club_profile_id
  )
$$;

-- Drop the problematic INSERT policy
DROP POLICY IF EXISTS "Club owners can add managers" ON public.club_managers;

-- Create new INSERT policy using security definer functions
CREATE POLICY "Club owners can add managers" ON public.club_managers
FOR INSERT
WITH CHECK (
  public.is_club_owner(auth.uid(), club_profile_id)
  OR NOT public.club_has_managers(club_profile_id)
);

-- Also fix UPDATE and DELETE policies to use security definer function
DROP POLICY IF EXISTS "Club owners can update club managers" ON public.club_managers;
CREATE POLICY "Club owners can update club managers" ON public.club_managers
FOR UPDATE
USING (public.is_club_owner(auth.uid(), club_profile_id));

DROP POLICY IF EXISTS "Club owners can delete club managers" ON public.club_managers;
CREATE POLICY "Club owners can delete club managers" ON public.club_managers
FOR DELETE
USING (public.is_club_owner(auth.uid(), club_profile_id));