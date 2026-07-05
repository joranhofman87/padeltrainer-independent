-- Public-booking audit P1-1: the public academy/trainer/club availability pages count
-- occupying bookings with a direct `bookings` SELECT. The bookings table has NO anonymous
-- SELECT RLS policy, so for a LOGGED-OUT visitor the count reads ZERO — every FULL slot
-- renders as bookable, and a guest only discovers it's full after filling the whole form.
--
-- Fix: an anon-callable SECURITY DEFINER RPC that returns occupancy COUNTS only (no PII),
-- scoped to the requested public slots. The frontend uses this instead of the direct read.
-- The count predicate is BYTE-IDENTICAL to the whole-slot capacity enforcement
-- (20260704190000: confirmed/pending/pending_approval + live payment_pending holds) — whose
-- own comment says it applies to the public read-side — so what shows as bookable is exactly
-- what book_guest_slot_for_payment / book_slot_for_payment will allow (no "shows free but is
-- full" window from in-flight guest holds). Restricted to is_public slots so it can never
-- reveal a private slot's occupancy to a prober.

CREATE OR REPLACE FUNCTION public.get_public_slot_occupancy(_slot_ids uuid[])
RETURNS TABLE (slot_id uuid, occupied integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.slot_id, COUNT(*)::integer AS occupied
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.slot_id = ANY(_slot_ids)
    AND s.is_public = true
    AND (
      COALESCE(b.status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
    )
  GROUP BY b.slot_id;
$$;

REVOKE ALL ON FUNCTION public.get_public_slot_occupancy(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_slot_occupancy(uuid[]) TO anon, authenticated;
