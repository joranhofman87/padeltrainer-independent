
-- Fix: Review tag manipulation - restrict INSERT/DELETE to review owner or admin

DROP POLICY IF EXISTS "Authenticated users can insert tag selections" ON public.review_tag_selections;

CREATE POLICY "Review owner can insert tags"
  ON public.review_tag_selections FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.reviews r
      WHERE r.id = review_id
        AND (r.player_id = public.get_profile_id_for_user(auth.uid())
             OR public.is_admin(auth.uid()))
    )
  );

DROP POLICY IF EXISTS "Authenticated users can delete tag selections" ON public.review_tag_selections;

CREATE POLICY "Review owner can delete tags"
  ON public.review_tag_selections FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.reviews r
      WHERE r.id = review_id
        AND (r.player_id = public.get_profile_id_for_user(auth.uid())
             OR public.is_admin(auth.uid()))
    )
  );
