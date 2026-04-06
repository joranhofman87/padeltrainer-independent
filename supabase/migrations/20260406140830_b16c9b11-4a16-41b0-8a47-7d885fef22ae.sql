DROP POLICY IF EXISTS "Users can insert their own role" ON public.user_roles;

CREATE POLICY "Admins can insert roles"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_admin(auth.uid()));