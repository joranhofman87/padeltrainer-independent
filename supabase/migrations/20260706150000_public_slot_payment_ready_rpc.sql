-- Public-booking audit P1-7: the public academy/trainer/club availability pages showed a PRICED
-- slot as bookable even when its payment owner had no working Mollie account — the guest filled
-- in name/email/phone and only then hit a dead-end (create-*-payment refuses / Mollie 422). Now
-- that mollie-callback/check-mollie-connect-status resolve charges_enabled from real KYC (P1-3),
-- gate bookability on it.
--
-- This anon-callable SECURITY DEFINER RPC returns, per requested public slot, a single boolean:
-- is it payment-bookable? — with NO account details leaked. The frontend drops priced slots that
-- are not payment-ready (like it already drops full slots), so the guest never dead-ends.
--
-- Readiness mirrors the CHARGE resolver (_shared/guest-payment.ts resolveSlotRecipient):
--   * a slot with academy_profile_id → money MUST go to that academy (hard-refuse the trainer
--     fallback), so it is bookable iff the ACADEMY's Mollie is charge-ready;
--   * a trainer-owned slot (no academy) → the trainer's Mollie must be charge-ready.
-- Both require onboarding_complete + a live access_token + charges_enabled. (We additionally gate
-- the trainer branch on charges_enabled — stricter than resolveSlotRecipient's token-only trainer
-- check, but correct now that charges_enabled reflects real KYC: a not-charge-ready trainer would
-- 422 mid-flow.) FREE slots (no price) need no online payment and are always bookable.

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
