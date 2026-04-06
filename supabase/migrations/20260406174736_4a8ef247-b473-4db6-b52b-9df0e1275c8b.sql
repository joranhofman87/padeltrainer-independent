
-- Fix club_managers: remove the "no managers" bypass from INSERT
DROP POLICY IF EXISTS "Users can join unmanaged clubs" ON club_managers;
DROP POLICY IF EXISTS "Club managers can be created" ON club_managers;
DROP POLICY IF EXISTS "Authenticated users can insert club managers" ON club_managers;

-- Recreate: only existing managers (owners) or admins can add new managers
CREATE POLICY "Managers or admins can insert club managers"
  ON public.club_managers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_club_manager(auth.uid(), club_profile_id)
    OR public.is_admin(auth.uid())
  );

-- Fix academy_managers: remove the "no managers" bypass from INSERT
DROP POLICY IF EXISTS "Users can join unmanaged academies" ON academy_managers;
DROP POLICY IF EXISTS "Academy managers can be created" ON academy_managers;
DROP POLICY IF EXISTS "Authenticated users can insert academy managers" ON academy_managers;

-- Recreate: only existing managers (owners) or admins can add new managers
CREATE POLICY "Managers or admins can insert academy managers"
  ON public.academy_managers
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_academy_manager(auth.uid(), academy_profile_id)
    OR public.is_admin(auth.uid())
  );
