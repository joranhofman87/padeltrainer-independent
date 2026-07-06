-- P0 payments observability: let the SERVICE ROLE run reconcile_payments so the
-- nightly invoice-health-check can execute it and Slack-alert the findings.
-- reconcile_payments was built for a daily operator check (20260705140000) but its
-- has_role(auth.uid(),'admin') gate refuses NULL uids — the service role — so nothing
-- ever ran it automatically. Gate change ONLY (next_invoice_sequence pattern); the
-- checks themselves are byte-identical to 20260705140000.

CREATE OR REPLACE FUNCTION public.reconcile_payments(_since interval DEFAULT interval '30 days')
RETURNS TABLE (check_name text, severity text, entity_kind text, entity_id uuid, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Admin for user JWTs; a NULL uid is the service role (edge functions — the
  -- nightly invoice-health-check runs this), which no end-user key can produce.
  IF auth.uid() IS NOT NULL AND NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  -- 1) Stranded invoice: has a Mollie payment id but never reached a terminal status (should be final).
  SELECT 'stranded_invoice'::text, 'P1'::text, 'invoice'::text, i.id,
         jsonb_build_object('status', i.status, 'mollie_payment_id', i.mollie_payment_id, 'total', i.total, 'created_at', i.created_at)
  FROM public.invoices i
  WHERE i.mollie_payment_id IS NOT NULL
    AND i.status NOT IN ('paid', 'cancelled')
    AND i.created_at < now() - interval '1 hour'
    AND i.created_at > now() - _since

  UNION ALL
  -- 2) A PAID invoice whose linked booking is still unpaid + not cancelled (writeback lost).
  SELECT 'invoice_paid_bookings_unpaid'::text, 'P1', 'invoice', i.id,
         jsonb_build_object('booking_id', b.id, 'booking_payment_status', b.payment_status, 'booking_status', b.status)
  FROM public.invoices i
  JOIN public.bookings b ON b.id = ANY(i.booking_ids)
  WHERE i.status = 'paid' AND b.payment_status IS DISTINCT FROM 'paid' AND b.status <> 'cancelled'
    AND COALESCE(i.paid_at, i.created_at) > now() - _since

  UNION ALL
  -- 3) A CANCELLED booking still billed by a PAID invoice (money taken, seat gone).
  SELECT 'cancelled_booking_on_paid_invoice'::text, 'P1', 'booking', b.id,
         jsonb_build_object('invoice_id', i.id)
  FROM public.invoices i
  JOIN public.bookings b ON b.id = ANY(i.booking_ids)
  WHERE i.status = 'paid' AND b.status = 'cancelled'
    AND COALESCE(i.paid_at, i.created_at) > now() - _since

  UNION ALL
  -- 4) Two ACTIVE (non-cancelled) invoices billing the SAME booking (double-pay risk).
  SELECT 'overlapping_active_invoices'::text, 'P0', 'invoice', i1.id,
         jsonb_build_object('other_invoice_id', i2.id,
           'overlap', (SELECT array_agg(x) FROM unnest(i1.booking_ids) x WHERE x = ANY(i2.booking_ids)))
  FROM public.invoices i1
  JOIN public.invoices i2 ON i1.id < i2.id AND i1.booking_ids && i2.booking_ids
  WHERE i1.status <> 'cancelled' AND i2.status <> 'cancelled'

  UNION ALL
  -- 5) More than one ACTIVE invoice for one rebook group (the unique index should prevent this).
  SELECT 'duplicate_rebook_group_invoice'::text, 'P0', 'invoice', i.id,
         jsonb_build_object('rebook_group_id', i.rebook_group_id, 'active_count', cnt.n)
  FROM public.invoices i
  JOIN (
    SELECT rebook_group_id, count(*) AS n FROM public.invoices
    WHERE rebook_group_id IS NOT NULL AND status <> 'cancelled'
    GROUP BY rebook_group_id HAVING count(*) > 1
  ) cnt ON cnt.rebook_group_id = i.rebook_group_id
  WHERE i.status <> 'cancelled'

  UNION ALL
  -- 6) An expired payment_pending hold still occupying capacity (release sweep lagging).
  SELECT 'stale_hold'::text, 'P1', 'booking', b.id,
         jsonb_build_object('slot_id', b.slot_id, 'hold_expires_at', b.hold_expires_at)
  FROM public.bookings b
  WHERE b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL
    AND b.hold_expires_at < now() - interval '10 minutes'

  UNION ALL
  -- 7) A SENT, payable invoice with no public_token → it cannot be paid.
  SELECT 'sent_invoice_no_token'::text, 'P1', 'invoice', i.id,
         jsonb_build_object('status', i.status, 'total', i.total)
  FROM public.invoices i
  WHERE i.status = 'sent' AND i.public_token IS NULL AND i.total > 0

  UNION ALL
  -- 8) A PAID invoice whose total drifts from the sum of its booked amounts (beyond tolerance).
  SELECT 'invoice_total_booking_sum_mismatch'::text, 'P1', 'invoice', s.invoice_id,
         jsonb_build_object('invoice_total', s.total, 'booking_sum', s.booking_sum, 'booking_count', s.n)
  FROM (
    SELECT i.id AS invoice_id, i.total, count(b.id) AS n, COALESCE(sum(b.payment_amount), 0) AS booking_sum
    FROM public.invoices i
    JOIN public.bookings b ON b.id = ANY(i.booking_ids)
    WHERE i.status = 'paid' AND COALESCE(i.paid_at, i.created_at) > now() - _since
    GROUP BY i.id, i.total
  ) s
  WHERE abs(s.total - s.booking_sum) > greatest(0.01, s.n * 0.01)

  UNION ALL
  -- 9) A booking marked paid > 1 day ago that no ACTIVE invoice bills (missing payment trail).
  SELECT 'booking_paid_no_invoice'::text, 'P2', 'booking', b.id,
         jsonb_build_object('slot_id', b.slot_id, 'paid_at', b.paid_at, 'payment_amount', b.payment_amount)
  FROM public.bookings b
  WHERE b.payment_status = 'paid' AND b.paid_at IS NOT NULL
    AND b.paid_at < now() - interval '1 day' AND b.paid_at > now() - _since
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices i WHERE b.id = ANY(i.booking_ids) AND i.status <> 'cancelled'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_payments(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reconcile_payments(interval) TO authenticated;
