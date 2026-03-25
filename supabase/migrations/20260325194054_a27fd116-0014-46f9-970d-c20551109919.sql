CREATE POLICY "Admins can delete invoices"
ON public.invoices FOR DELETE
TO authenticated
USING (public.is_admin(auth.uid()));