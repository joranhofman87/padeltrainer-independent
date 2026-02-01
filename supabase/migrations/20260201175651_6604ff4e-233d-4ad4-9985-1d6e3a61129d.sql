-- Add RLS policy to allow admins to update any trainer profile
CREATE POLICY "Admins can update any trainer profile"
ON trainer_profiles FOR UPDATE
USING (is_admin(auth.uid()));