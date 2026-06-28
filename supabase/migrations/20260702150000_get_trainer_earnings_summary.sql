-- ============================================================================
-- SCALE — get_trainer_earnings_summary (server-side earnings aggregation)
-- ============================================================================
--
-- TrainerEarnings today loads a trainer's ENTIRE lifetime booking history to the
-- browser (no limit/range) purely to compute the four headline tiles (total
-- earned, this/last month, pending) in JS. That grows with every trainer's
-- career. This RPC does the aggregation in the DB and returns the (constant) set
-- of summary numbers; the page then loads only a bounded recent window for the
-- displayed lists.
--
-- FAITHFUL to the shared src/lib/trainerEarnings.ts rules (asserted bit-for-bit by
-- the golden test src/test/trainerEarningsSummary.pglite.test.ts):
--   * amount per booking = payment_amount, falling back to the slot price when
--     payment_amount is 0/NULL: COALESCE(NULLIF(payment_amount,0), price_per_session, 0)
--     (mirrors the JS `payment_amount || slot.price_per_session || 0`).
--   * "received" = payment_status='paid' AND paid_at IS NOT NULL.
--   * the candidate set is the SAME the page loads: bookings whose status is in
--     ('completed','confirmed','cancelled') on the trainer's own slots.
--   * total_earnings = sum(amount) over received; this/last month = the same,
--     restricted to paid_at within the (caller-supplied, browser-local) month
--     bounds, inclusive both ends (mirrors sumReceivedInRange).
--   * pending = status IN ('completed','confirmed') AND payment_status IN
--     ('pending','invoiced').
--
-- The month bounds are passed by the caller (the browser owns the user's tz, so
-- startOfMonth/endOfMonth stay in JS and are not re-derived in SQL).
--
-- The caller can only ever read THEIR OWN trainer's summary — the trainer is
-- derived from auth.uid(), there is no id parameter, so there is no IDOR surface.
-- Owner-applied; INERT until TrainerEarnings adopts it (with a client fallback).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_trainer_earnings_summary(
  p_this_month_start timestamptz,
  p_this_month_end   timestamptz,
  p_last_month_start timestamptz,
  p_last_month_end   timestamptz
)
RETURNS TABLE (
  total_earnings       numeric,
  this_month           numeric,
  last_month           numeric,
  pending_amount       numeric,
  pending_count        integer,
  completed_paid_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_trainer_id uuid;
BEGIN
  SELECT id INTO v_trainer_id FROM public.trainer_profiles WHERE user_id = auth.uid();
  IF v_trainer_id IS NULL THEN
    RETURN QUERY SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0, 0;
    RETURN;
  END IF;

  RETURN QUERY
  WITH b AS (
    SELECT
      bk.status,
      bk.payment_status,
      bk.paid_at,
      COALESCE(NULLIF(bk.payment_amount, 0), s.price_per_session, 0) AS amount
    FROM public.bookings bk
    JOIN public.availability_slots s ON s.id = bk.slot_id
    WHERE s.trainer_id = v_trainer_id
      AND bk.status IN ('completed', 'confirmed', 'cancelled')
  )
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE payment_status = 'paid' AND paid_at IS NOT NULL), 0)::numeric,
    COALESCE(SUM(amount) FILTER (
      WHERE payment_status = 'paid' AND paid_at IS NOT NULL
        AND paid_at >= p_this_month_start AND paid_at <= p_this_month_end), 0)::numeric,
    COALESCE(SUM(amount) FILTER (
      WHERE payment_status = 'paid' AND paid_at IS NOT NULL
        AND paid_at >= p_last_month_start AND paid_at <= p_last_month_end), 0)::numeric,
    COALESCE(SUM(amount) FILTER (
      WHERE status IN ('completed', 'confirmed') AND payment_status IN ('pending', 'invoiced')), 0)::numeric,
    COUNT(*) FILTER (
      WHERE status IN ('completed', 'confirmed') AND payment_status IN ('pending', 'invoiced'))::integer,
    COUNT(*) FILTER (WHERE status = 'completed' AND payment_status = 'paid')::integer
  FROM b;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trainer_earnings_summary(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated;
