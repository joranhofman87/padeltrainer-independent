-- FIX CRITICAL SECURITY ISSUES

-- 1. Fix profiles RLS - restrict SELECT to owner only for sensitive data
-- The profiles_public view should be used for public data access
DROP POLICY IF EXISTS "Anyone can view public profile data" ON public.profiles;

-- Only allow users to view their own profile (with PII like email, phone)
CREATE POLICY "Users can view own profile"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() = user_id);

-- Allow service role and authenticated users to query by id/user_id for internal operations
-- This is needed for edge functions using service role
CREATE POLICY "Service role can view all profiles"
  ON public.profiles
  FOR SELECT
  TO service_role
  USING (true);

-- 2. Fix club_managers INSERT policy - the self-referential bug
DROP POLICY IF EXISTS "Club owners can manage club managers" ON public.club_managers;

-- Correct policy: check against the NEW row's club_profile_id, not self-referential
CREATE POLICY "Club owners can add managers"
  ON public.club_managers
  FOR INSERT
  WITH CHECK (
    -- Either user is an owner of the target club
    EXISTS (
      SELECT 1 FROM public.club_managers cm
      WHERE cm.club_profile_id = club_managers.club_profile_id
        AND cm.user_id = auth.uid()
        AND cm.role = 'owner'
    )
    -- OR this is the first manager (owner claiming the club)
    OR NOT EXISTS (
      SELECT 1 FROM public.club_managers cm
      WHERE cm.club_profile_id = club_managers.club_profile_id
    )
  );