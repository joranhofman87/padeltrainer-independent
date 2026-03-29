
-- Make trainer_id nullable on invoices
ALTER TABLE public.invoices ALTER COLUMN trainer_id DROP NOT NULL;

-- Add INSERT policy for academy managers creating custom invoices
CREATE POLICY "Academy managers can insert custom invoices"
ON public.invoices
FOR INSERT
TO authenticated
WITH CHECK (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
);
