-- Online payment for event registrations.
--
-- When a player registers for an event whose payment method is online, we mint a
-- standard (booking-less, academy-owned) invoice at submit time and reuse the
-- existing Mollie pay → webhook → PDF stack. These columns wire the registration
-- to that invoice and record the player's payment choice.
--
--   intake_requests.payment_method  the choice the player made ('online' | 'cash')
--   intake_requests.invoice_id      the minted invoice (so the registrations list
--                                   can show paid/unpaid per registrant)
--   invoices.cycle_id               which cycle a booking-less event invoice is for
--                                   (reporting / reverse lookup; webhook+PDF ignore it)

ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS payment_method text
    CONSTRAINT intake_requests_payment_method_check
    CHECK (payment_method IS NULL OR payment_method IN ('online', 'cash')),
  ADD COLUMN IF NOT EXISTS invoice_id uuid
    REFERENCES public.invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_intake_requests_invoice_id
  ON public.intake_requests(invoice_id) WHERE invoice_id IS NOT NULL;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS cycle_id uuid
    REFERENCES public.cycles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_invoices_cycle_id
  ON public.invoices(cycle_id) WHERE cycle_id IS NOT NULL;

-- Schema sanity (mirrors the project's *_schema_test convention).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'intake_requests' AND column_name = 'payment_method'
  ) THEN RAISE EXCEPTION 'intake_requests.payment_method missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'intake_requests' AND column_name = 'invoice_id'
  ) THEN RAISE EXCEPTION 'intake_requests.invoice_id missing'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'invoices' AND column_name = 'cycle_id'
  ) THEN RAISE EXCEPTION 'invoices.cycle_id missing'; END IF;
END $$;
