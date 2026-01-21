-- Drop the restrictive INSERT policy that blocks multi-role users
DROP POLICY IF EXISTS "Users can insert their own role once" ON public.user_roles;

-- Create a permissive policy that allows users to insert their own roles
-- The UNIQUE constraint on (user_id, role) prevents duplicates
CREATE POLICY "Users can insert their own roles"
ON public.user_roles
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);