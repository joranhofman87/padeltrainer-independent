-- Reusable default invoice-email message ("Save as default" in the send composer).
-- Nullable free text; the academy's saved default pre-fills the single + bulk
-- invoice-email composers so they don't start from zero each time.
--
-- Additive + backward-compatible: existing rows are NULL (treated as "no default",
-- i.e. blank). The frontend reads it tolerantly and degrades to blank if this
-- column isn't present yet, so deploy order does not matter.

ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS invoice_email_message text;

COMMENT ON COLUMN public.academy_profiles.invoice_email_message IS
  'Academy default message body pre-filled into the invoice-email composer (single + bulk). NULL = none.';
