-- Add RLS policy for admins to insert academy managers
CREATE POLICY "Admins can insert academy managers"
ON academy_managers FOR INSERT
WITH CHECK (is_admin(auth.uid()));

-- Add RLS policy for admins to update academy managers
CREATE POLICY "Admins can update academy managers"
ON academy_managers FOR UPDATE
USING (is_admin(auth.uid()));