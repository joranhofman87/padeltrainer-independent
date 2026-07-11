-- ============================================================================
-- expired_holds_over_capacity — oversell guard for late payments on lapsed holds (audit Batch 3, §4.1)
-- ============================================================================
-- A payment_pending HOLD stops counting toward occupancy the moment it expires (get_public_slot_
-- occupancy / the capacity trigger only count a hold WHILE hold_expires_at > now()). So between a
-- hold expiring and the sweep cron releasing it, another player can take the seat. If the late
-- Mollie payment then arrives, the webhook would confirm the lapsed hold with NO capacity re-check —
-- overselling the court to max+1 (a padel court physically cannot seat a 5th player).
--
-- This function, given the payment's booking ids, returns exactly those that are EXPIRED holds whose
-- slot is ALREADY full from OTHER occupying bookings (confirmed/pending/pending_approval + other live
-- holds — the canonical hold-aware predicate). The webhook refuses to confirm those and alerts for a
-- manual refund. On-time payments (live hold, still within its window) are never returned — their
-- seat was reserved — so a legitimate payment is never blocked.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.expired_holds_over_capacity(_booking_ids uuid[])
RETURNS TABLE(booking_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT b.id
  FROM public.bookings b
  JOIN public.availability_slots s ON s.id = b.slot_id
  WHERE b.id = ANY(_booking_ids)
    AND b.status = 'payment_pending'
    AND b.hold_expires_at IS NOT NULL
    AND b.hold_expires_at <= now()          -- the hold LAPSED before the payment resolved
    AND (
      SELECT count(*)
      FROM public.bookings o
      WHERE o.slot_id = b.slot_id
        AND o.id <> b.id
        AND (
          o.status IN ('confirmed', 'pending', 'pending_approval')
          OR (o.status = 'payment_pending' AND o.hold_expires_at IS NOT NULL AND o.hold_expires_at > now())
        )
    ) >= COALESCE(s.max_participants, 1);    -- the seat is already taken → confirming would oversell
$$;

REVOKE ALL ON FUNCTION public.expired_holds_over_capacity(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.expired_holds_over_capacity(uuid[]) TO service_role;
