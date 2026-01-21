-- Allow admins to view all user roles
CREATE POLICY "Admins can view all user roles"
  ON public.user_roles
  FOR SELECT
  TO authenticated
  USING (is_admin(auth.uid()));