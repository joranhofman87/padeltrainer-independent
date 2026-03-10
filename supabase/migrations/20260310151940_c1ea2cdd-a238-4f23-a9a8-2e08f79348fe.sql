-- Allow authenticated users to insert their own role
CREATE POLICY "Users can insert their own role"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- Allow authenticated users to delete their own role (for role switching)
CREATE POLICY "Users can delete their own role"
  ON public.user_roles
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);