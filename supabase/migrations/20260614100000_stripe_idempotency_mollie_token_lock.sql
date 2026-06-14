-- Phase 0 (scale audit): harden the revenue webhooks that the Mollie-focused
-- audit never covered — Stripe subscription events (platform→trainer revenue)
-- and the Mollie Connect OAuth token refresh.
--
-- (A) STRIPE WEBHOOK IDEMPOTENCY + ORDERING
-- stripe-subscription-webhook had no event dedup (Stripe retries deliver the
-- same event again → reprocessing + duplicate Slack) and no ordering guard (a
-- delayed customer.subscription.deleted, arriving AFTER a renewal, would set the
-- tenant inactive and lock out a paying customer).

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  subscription_id text,
  event_created bigint,                 -- Stripe event.created (unix seconds)
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_sub
  ON public.stripe_webhook_events (subscription_id, event_created DESC);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role webhook (which bypasses RLS) touches it.

-- Atomic claim: returns true the FIRST time an event id is seen, false on a
-- duplicate delivery — so the webhook can short-circuit retries.
CREATE OR REPLACE FUNCTION public.claim_stripe_event(
  _event_id text,
  _event_type text,
  _subscription_id text,
  _event_created bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.stripe_webhook_events (event_id, event_type, subscription_id, event_created)
  VALUES (_event_id, _event_type, _subscription_id, _event_created)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_stripe_event(text, text, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_stripe_event(text, text, text, bigint) TO service_role;

-- Ordering guard: has a NEWER activating event (renewal / checkout) already been
-- processed for this subscription? If so, a stale delete must NOT deactivate it.
CREATE OR REPLACE FUNCTION public.stripe_subscription_has_newer_activation(
  _subscription_id text,
  _event_created bigint
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.stripe_webhook_events
    WHERE subscription_id = _subscription_id
      AND _subscription_id IS NOT NULL
      AND event_created > _event_created
      AND event_type IN ('invoice.paid', 'checkout.session.completed')
  );
$$;

REVOKE ALL ON FUNCTION public.stripe_subscription_has_newer_activation(text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.stripe_subscription_has_newer_activation(text, bigint) TO service_role;

-- (B) MOLLIE CONNECT TOKEN REFRESH MUTEX
-- refreshTokenIfNeeded did an unlocked read → POST refresh_token → write. Mollie
-- refresh tokens are single-use/rotating, so two concurrent webhooks consume the
-- same token; the loser's refresh fails. A claim column lets exactly one webhook
-- perform the refresh while others skip and reuse the (still valid for 5 min)
-- current token.
ALTER TABLE public.trainer_mollie_accounts
  ADD COLUMN IF NOT EXISTS token_refreshing_at timestamptz;
ALTER TABLE public.academy_mollie_accounts
  ADD COLUMN IF NOT EXISTS token_refreshing_at timestamptz;
