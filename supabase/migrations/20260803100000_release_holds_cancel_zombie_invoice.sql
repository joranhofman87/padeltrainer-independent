-- ============================================================================
-- REBOOK · zombie-invoice kill: releasing expired holds also cancels their invoice
-- ============================================================================
-- WHY (audit finding, confirmed independently by two audits): release_expired_rebook_holds
-- cancels expired payment_pending holds and resets their claims, but left the linked
-- rebook invoice 'sent'/'open' with a LIVE Mollie checkout. Every re-serve surface —
-- the double-pay guard, the resume RPC (#447), a bookmarked /pay link — would then
-- happily charge the player for seats that no longer exist (webhook refuses to
-- resurrect cancelled bookings → money taken, no seat, manual refund).
--
-- FIX: after releasing holds, cancel every UNPAID rebook-tagged invoice whose bookings
-- are now ALL cancelled. Scoped to rebook invoices (rebook_cyclus_id / rebook_group_id
-- tagged) so manual/event invoices over cancelled sessions are never touched, and to
-- unpaid ones so a paid-on-cancelled invoice (the manual-refund case) keeps its money
-- trail. The sweep is global-per-run (not just this run's releases), so it also
-- self-heals any zombie left by an earlier partial failure. Cancelled status blocks
-- /pay (invoice_locked), the resume RPC, and both double-pay guards.
--
-- Re-emits release_expired_rebook_holds from 20260703150000 verbatim + the invoice
-- sweep. Return value stays the released-holds count (cron contract unchanged).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.release_expired_rebook_holds()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
BEGIN
  WITH cancelled AS (
    UPDATE public.bookings
    SET status = 'cancelled', updated_at = now()
    WHERE status = 'payment_pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= now()
    RETURNING id
  )
  UPDATE public.slot_priority_claims spc
  SET status = 'pending', booking_id = NULL, responded_at = NULL
  FROM cancelled
  WHERE spc.booking_id = cancelled.id AND spc.status = 'claimed';

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Zombie sweep: an UNPAID rebook invoice whose bookings are ALL cancelled must never
  -- stay payable. (Separate statement so it sees the bookings UPDATE above — CTE
  -- sub-statements share a snapshot and would still see the holds as live.)
  UPDATE public.invoices i
  SET status = 'cancelled'
  WHERE i.status NOT IN ('paid', 'cancelled')
    AND (i.rebook_cyclus_id IS NOT NULL OR i.rebook_group_id IS NOT NULL)
    AND i.booking_ids IS NOT NULL
    AND array_length(i.booking_ids, 1) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = ANY (i.booking_ids)
        AND b.status <> 'cancelled'
    );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_rebook_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_rebook_holds() TO service_role;
