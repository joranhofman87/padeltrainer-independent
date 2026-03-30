CREATE POLICY "Academy managers can delete their draft invoices"
ON public.invoices FOR DELETE
TO authenticated
USING (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
  AND status = 'draft'
);