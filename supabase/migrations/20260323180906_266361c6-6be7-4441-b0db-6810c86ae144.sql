ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS business_name text,
  ADD COLUMN IF NOT EXISTS business_address text,
  ADD COLUMN IF NOT EXISTS kvk_number text,
  ADD COLUMN IF NOT EXISTS btw_number text,
  ADD COLUMN IF NOT EXISTS iban text,
  ADD COLUMN IF NOT EXISTS bic text,
  ADD COLUMN IF NOT EXISTS payment_terms_days integer DEFAULT 14,
  ADD COLUMN IF NOT EXISTS default_vat_rate numeric DEFAULT 21,
  ADD COLUMN IF NOT EXISTS invoice_forward_emails text[],
  ADD COLUMN IF NOT EXISTS invoice_logo_url text,
  ADD COLUMN IF NOT EXISTS invoice_prefix text DEFAULT 'INV',
  ADD COLUMN IF NOT EXISTS invoice_next_number integer DEFAULT 1;