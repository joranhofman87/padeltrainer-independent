-- Guest whole-cyclus support for the confirmation token.
--
-- 20260704160000 made bookings.public_token a UNIQUE index, which is right for a
-- single-slot booking but WRONG for a cyclus: create-guest-cyclus-payment stamps
-- ONE shared token across all N session bookings (so the guest has a single
-- confirmation handle for the whole series). A shared token is the intended design
-- — the token only needs to be an unguessable lookup key, not unique — so relax the
-- index to non-unique.
DROP INDEX IF EXISTS public.bookings_public_token_key;
CREATE INDEX IF NOT EXISTS bookings_public_token_idx
  ON public.bookings (public_token)
  WHERE public_token IS NOT NULL;

-- Make the anon confirm lookup cyclus-aware: a token can now match N bookings, so
-- return ONE representative row (the EARLIEST session) but with the TOTAL paid and
-- the session count, so the confirm page can show "Cyclus X — N sessions, from …".
-- For a single-slot booking N=1, so this is identical to before.
--
-- Adding session_count changes the RETURNS TABLE signature, which CREATE OR REPLACE
-- cannot do (42P13) — DROP the prior (20260704160000) definition first.
DROP FUNCTION IF EXISTS public.get_guest_booking_by_token(uuid);
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
  academy_profile_id uuid,
  session_count     integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    b.id, b.mollie_payment_id, b.payment_status, b.status,
    (SELECT sum(b2.payment_amount) FROM public.bookings b2 WHERE b2.public_token = _token) AS payment_amount,
    b.hold_expires_at,
    s.id, s.start_time, s.end_time, s.cyclus_name, s.trainer_id, s.academy_profile_id,
    (SELECT count(*)::int FROM public.bookings b3 WHERE b3.public_token = _token) AS session_count
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.public_token = _token
  ORDER BY s.start_time ASC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_guest_booking_by_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_guest_booking_by_token(uuid) TO service_role;
