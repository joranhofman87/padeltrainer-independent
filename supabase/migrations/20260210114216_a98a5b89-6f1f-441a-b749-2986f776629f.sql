-- Allow admins to insert into player_rating_history
CREATE POLICY "Admins can insert player rating history"
ON public.player_rating_history
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin(auth.uid()));

-- Allow admins to update player_rating_history
CREATE POLICY "Admins can update player rating history"
ON public.player_rating_history
FOR UPDATE
TO authenticated
USING (public.is_admin(auth.uid()));

-- Allow admins to select all player_rating_history
CREATE POLICY "Admins can view all player rating history"
ON public.player_rating_history
FOR SELECT
TO authenticated
USING (public.is_admin(auth.uid()));