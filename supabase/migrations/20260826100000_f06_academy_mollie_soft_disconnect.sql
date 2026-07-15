-- F06 (audit, CRITICAL): disconnecting an academy's Mollie account hard-DELETEd the
-- academy_mollie_accounts row while checkouts could still be live. A customer paying a
-- still-open checkout link afterwards hit mollie-webhook's token resolution with NO row,
-- and the webhook deliberately answers 200 (no retry) when no org token resolves — so the
-- payment was captured at Mollie but never settled here: booking hold stranded until the
-- TTL sweep resold the seat, invoice left unpaid, manual refund per incident.
--
-- Soft-disconnect instead: a disconnected_at stamp. The row (and its still-valid OAuth
-- tokens) survives, so a late webhook still resolves the org and settles in-flight
-- payments. Every CHARGE path refuses a disconnected academy (mollie-payment-ready,
-- guest-payment, create-mollie-payment, generate-invoice pay links, and the public
-- payment-ready RPC below), mollie-disconnect-academy refuses while open Mollie-linked
-- invoices or live payment holds exist, and mollie-callback clears the stamp on reconnect.
ALTER TABLE public.academy_mollie_accounts
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

COMMENT ON COLUMN public.academy_mollie_accounts.disconnected_at IS
  'Soft-disconnect stamp (F06): set instead of deleting the row so late Mollie webhooks can still settle in-flight payments. Charge paths refuse when set; mollie-callback clears it on reconnect.';

-- Public payment-ready RPC: a disconnected academy must not advertise its priced slots as
-- payment-bookable (mirrors the charge resolvers, which refuse disconnected rows — a guest
-- would otherwise dead-end at create-*-payment). Only the academy branch gains the
-- predicate: trainer_mollie_accounts has no soft-disconnect (trainer disconnect is a
-- separate finding).
CREATE OR REPLACE FUNCTION public.get_public_slot_payment_ready(_slot_ids uuid[])
RETURNS TABLE (slot_id uuid, payment_ready boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id AS slot_id,
    CASE
      WHEN COALESCE(s.price_per_session, 0) <= 0 AND COALESCE(s.total_price, 0) <= 0 THEN true
      WHEN s.academy_profile_id IS NOT NULL THEN EXISTS (
        SELECT 1 FROM public.academy_mollie_accounts a
        WHERE a.academy_profile_id = s.academy_profile_id
          AND a.onboarding_complete = true
          AND a.charges_enabled = true
          AND a.access_token IS NOT NULL
          AND a.disconnected_at IS NULL
      )
      ELSE EXISTS (
        SELECT 1 FROM public.trainer_mollie_accounts t
        WHERE t.trainer_id = s.trainer_id
          AND t.onboarding_complete = true
          AND t.charges_enabled = true
          AND t.access_token IS NOT NULL
      )
    END AS payment_ready
  FROM public.availability_slots s
  WHERE s.id = ANY(_slot_ids) AND s.is_public = true;
$$;

REVOKE ALL ON FUNCTION public.get_public_slot_payment_ready(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_slot_payment_ready(uuid[]) TO anon, authenticated;
