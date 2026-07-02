-- Custom email subject line for invoice emails. Mirrors the existing
-- academy_profiles.invoice_email_message default: academies can save a default
-- subject that pre-fills the send/bulk-send invoice dialogs. Additive + nullable
-- (NULL ⇒ send-invoice-email composes its default "Factuur <number> - <business>").
ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS invoice_email_subject text;

COMMENT ON COLUMN public.academy_profiles.invoice_email_subject IS
  'Academy default subject line for invoice emails (mirrors invoice_email_message). NULL = use the composed default.';
