-- Confirmation handle for the guest single-slot pay-first flow: an unguessable token on the guest
-- booking so the (unauthenticated) buyer can poll their booking state after paying, login-free —
-- mirroring the invoices.public_token / /pay/:token pattern. verify-mollie-payment is auth-only and
-- refuses guests, so the guest confirm page reads through this token via a SECURITY DEFINER RPC.
--
-- Additive: nullable, set only for guest holds (create-guest-slot-payment stamps it). Existing
-- bookings stay NULL.

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS public_token uuid;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_public_token_key
  ON public.bookings (public_token)
  WHERE public_token IS NOT NULL;

COMMENT ON COLUMN public.bookings.public_token IS
  'Unguessable token for the login-free guest booking confirmation page. NULL for normal (authed) bookings; set only on guest pay-first holds.';

-- Anon-safe single-row lookup for the guest confirm page (called by the confirm edge fn under
-- service role, like get_invoice_recipient_identity). Returns only what the confirmation screen
-- needs — never PII beyond the slot time + booking state. SECURITY DEFINER + service_role-only so
-- the base bookings RLS (auth-scoped) is not widened.
CREATE OR REPLACE FUNCTION public.get_guest_booking_by_token(_token uuid)
RETURNS TABLE (
  booking_id        uuid,
  mollie_payment_id text,
  payment_status    text,
  status            text,
  payment_amount    numeric,
  hold_expires_at   timestamptz,
  slot_id           uuid,
  start_time        timestamptz,
  end_time          timestamptz,
  cyclus_name       text,
  trainer_id        uuid,
  academy_profile_id uuid
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id, b.mollie_payment_id, b.payment_status, b.status, b.payment_amount, b.hold_expires_at,
    s.id, s.start_time, s.end_time, s.cyclus_name, s.trainer_id, s.academy_profile_id
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.public_token = _token
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_guest_booking_by_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_booking_by_token(uuid) TO service_role;
