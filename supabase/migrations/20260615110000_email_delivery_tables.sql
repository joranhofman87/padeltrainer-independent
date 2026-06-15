-- Email delivery-failure (bounce) tracking — capture foundation.
--
-- Today we send invoice emails via Resend and stamp invoices.sent_at the moment
-- Resend ACCEPTS the message — there is no webhook, so an address that bounces
-- AFTER acceptance leaves no trace, and the academy never learns reminders aren't
-- landing. These two tables are the capture layer:
--
--   email_delivery_events  — append-only log of every delivery signal, from BOTH
--     the synchronous send outcome (source has no resend_event_id) AND async
--     Resend webhook events (idempotent on resend_event_id). Correlates back to an
--     invoice via resend_email_id (the Resend message id captured at send time).
--   email_address_state    — per normalized email ADDRESS rollup + suppression
--     list. Address-keyed (not player-keyed) so one bad shared/parent address
--     flags every linked child + invoice, and so entering a fresh address clears
--     the flag for everyone automatically (fits the FAM-02 shared-email model).
--
-- service_role only (written by the webhook + send edge fns; read only through the
-- SECURITY DEFINER RPCs added in later migrations) so we never expose "did
-- arbitrary email X bounce?" to clients. Lockdown mirrors 20260614210000: RLS on +
-- no anon/authenticated policy + explicit REVOKE (a plain REVOKE FROM PUBLIC does
-- NOT drop Supabase's default anon/authenticated grants).

CREATE TABLE public.email_delivery_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resend_event_id     text,                                  -- Svix webhook id; NULL for synchronous send rows
  resend_email_id     text,                                  -- Resend message id (correlation key); NULL on send_failed
  event_type          text NOT NULL CHECK (event_type IN
                        ('sent','delivered','bounced','complained','delivery_delayed','failed','send_failed')),
  bounce_type         text CHECK (bounce_type IN ('hard','soft')),
  reason              text,
  recipient_email     text NOT NULL,                         -- normalized lowercase
  invoice_id          uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  academy_profile_id  uuid,
  trainer_id          uuid,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- idempotency: a webhook retry shares its Svix id and must not double-process
CREATE UNIQUE INDEX idx_ede_resend_event_id ON public.email_delivery_events (resend_event_id)
  WHERE resend_event_id IS NOT NULL;
CREATE INDEX idx_ede_resend_email_id ON public.email_delivery_events (resend_email_id)
  WHERE resend_email_id IS NOT NULL;
CREATE INDEX idx_ede_recipient_email ON public.email_delivery_events (recipient_email);
CREATE INDEX idx_ede_invoice_id ON public.email_delivery_events (invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_ede_created_at ON public.email_delivery_events (created_at);  -- retention sweep

CREATE TABLE public.email_address_state (
  email           text PRIMARY KEY,                          -- normalized lowercase
  state           text NOT NULL DEFAULT 'ok'
                    CHECK (state IN ('ok','soft_bounced','hard_bounced','complained')),
  last_event_type text,
  last_event_at   timestamptz,
  reason          text,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- the player-level signal + suppression scan path: only the non-ok addresses
CREATE INDEX idx_eas_bad_state ON public.email_address_state (state) WHERE state <> 'ok';

ALTER TABLE public.email_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_address_state  ENABLE ROW LEVEL SECURITY;
-- No anon/authenticated policies → RLS denies them. service_role bypasses RLS;
-- the SECURITY DEFINER read RPCs (later migrations) run as owner and bypass too.

REVOKE ALL ON TABLE public.email_delivery_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.email_address_state  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_delivery_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.email_address_state  TO service_role;

COMMENT ON TABLE public.email_delivery_events IS
  'Email delivery-failure tracking: append-only log of send outcomes + Resend webhook events. Idempotent on resend_event_id; correlates to an invoice via resend_email_id. service_role only.';
COMMENT ON TABLE public.email_address_state IS
  'Email delivery-failure tracking: per-address suppression/bounce state (ok|soft_bounced|hard_bounced|complained). Address-keyed = the player-level signal + send suppression. service_role only; read via SECURITY DEFINER RPCs.';
