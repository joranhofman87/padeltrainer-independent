ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS public_token_revoked_at timestamptz;

CREATE OR REPLACE FUNCTION public.revoke_invoice_public_token()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status IN ('paid','cancelled')
     AND COALESCE(OLD.status,'') NOT IN ('paid','cancelled')
     AND NEW.public_token_revoked_at IS NULL THEN
    NEW.public_token_revoked_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revoke_invoice_public_token ON public.invoices;
CREATE TRIGGER trg_revoke_invoice_public_token
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.revoke_invoice_public_token();

UPDATE public.invoices
SET public_token_revoked_at = COALESCE(paid_at, updated_at, now())
WHERE status IN ('paid','cancelled') AND public_token_revoked_at IS NULL;