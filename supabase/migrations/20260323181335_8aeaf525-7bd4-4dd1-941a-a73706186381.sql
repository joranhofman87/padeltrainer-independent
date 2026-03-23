
-- Add academy_profile_id and Mollie payment columns to invoices
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS academy_profile_id uuid REFERENCES public.academy_profiles(id),
  ADD COLUMN IF NOT EXISTS mollie_payment_id text,
  ADD COLUMN IF NOT EXISTS mollie_payment_url text;

-- Index for academy lookups
CREATE INDEX IF NOT EXISTS idx_invoices_academy_profile_id ON public.invoices(academy_profile_id);

-- RLS: academy managers can SELECT their invoices
CREATE POLICY "Academy managers can view invoices"
ON public.invoices
FOR SELECT
TO authenticated
USING (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
);

-- RLS: academy managers can UPDATE their invoices (status changes, payment links)
CREATE POLICY "Academy managers can update invoices"
ON public.invoices
FOR UPDATE
TO authenticated
USING (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
)
WITH CHECK (
  academy_profile_id IS NOT NULL
  AND public.is_academy_manager(auth.uid(), academy_profile_id)
);
