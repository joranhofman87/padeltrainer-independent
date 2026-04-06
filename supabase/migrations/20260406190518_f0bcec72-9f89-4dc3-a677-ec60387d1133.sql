
DROP POLICY IF EXISTS "Players can view their own invoices" ON public.invoices;

CREATE POLICY "Players can view their own non-draft invoices"
ON public.invoices
FOR SELECT
TO authenticated
USING (
  player_id = public.get_profile_id_for_user(auth.uid())
  AND status != 'draft'
);
