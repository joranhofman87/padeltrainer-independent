
CREATE TABLE public.payment_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  function_name TEXT NOT NULL,
  invoice_id UUID NULL,
  booking_id UUID NULL,
  recipient_type TEXT NULL,
  mollie_org_id TEXT NULL,
  amount NUMERIC NULL,
  currency TEXT DEFAULT 'EUR',
  status TEXT NOT NULL,
  error_message TEXT NULL,
  mollie_payment_id TEXT NULL,
  metadata JSONB NULL
);

ALTER TABLE public.payment_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role only" ON public.payment_audit_log
  FOR ALL USING (false);

CREATE INDEX idx_payment_audit_log_created_at ON public.payment_audit_log (created_at DESC);
CREATE INDEX idx_payment_audit_log_status ON public.payment_audit_log (status);
