-- Add admin RLS policies for academy_locations table
CREATE POLICY "Admins can insert academy locations"
ON public.academy_locations
FOR INSERT
TO authenticated
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update academy locations"
ON public.academy_locations
FOR UPDATE
TO authenticated
USING (is_admin(auth.uid()));

-- Add admin RLS policies for academy_trainers table
CREATE POLICY "Admins can insert academy trainers"
ON public.academy_trainers
FOR INSERT
TO authenticated
WITH CHECK (is_admin(auth.uid()));

CREATE POLICY "Admins can update academy trainers"
ON public.academy_trainers
FOR UPDATE
TO authenticated
USING (is_admin(auth.uid()));