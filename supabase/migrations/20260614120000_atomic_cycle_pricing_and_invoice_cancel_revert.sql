-- Phase 1 (scale audit):
--
-- MULTI-004 — updateCyclePricing wrote the cycle row and then, in a SEPARATE
-- statement, the linked availability_slots. A failure/tab-close between them
-- left the cycle at the new price while billing (which reads the slot column)
-- kept the old price — permanent drift. update_cycle_pricing does both writes in
-- ONE transaction (the function body), so they commit together or not at all.
-- SECURITY INVOKER: the internal writes stay under the caller's RLS exactly like
-- the client did before — no privilege escalation.
CREATE OR REPLACE FUNCTION public.update_cycle_pricing(
  _cycle_id uuid,
  _price_per_session numeric,
  _extra_costs jsonb,
  _split_payment boolean,
  _prices_include_vat boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_settings jsonb;
BEGIN
  SELECT COALESCE(settings, '{}'::jsonb) INTO v_settings
  FROM public.cycles WHERE id = _cycle_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cycle_not_found';
  END IF;

  v_settings := v_settings
    || jsonb_build_object('extra_costs', COALESCE(_extra_costs, '[]'::jsonb))
    || jsonb_build_object('split_payment', _split_payment)
    || jsonb_build_object('prices_include_vat', _prices_include_vat);

  UPDATE public.cycles
     SET price_per_session = _price_per_session,
         settings = v_settings
   WHERE id = _cycle_id;

  UPDATE public.availability_slots
     SET price_per_session = _price_per_session,
         extra_costs = CASE
           WHEN _extra_costs IS NOT NULL
                AND jsonb_typeof(_extra_costs) = 'array'
                AND jsonb_array_length(_extra_costs) > 0
           THEN _extra_costs ELSE NULL END,
         split_payment = _split_payment,
         prices_include_vat = _prices_include_vat
   WHERE cyclus_id = _cycle_id;
END;
$$;

REVOKE ALL ON FUNCTION public.update_cycle_pricing(uuid, numeric, jsonb, boolean, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_cycle_pricing(uuid, numeric, jsonb, boolean, boolean) TO authenticated, service_role;

-- M-07 — voiding (status→cancelled) a PAID invoice left its linked bookings
-- stuck payment_status='paid', so earnings tiles and player badges reported
-- voided revenue as collected, undetected. This reverts those bookings to
-- unpaid — the reverse of markInvoicePaidAndSyncBookings. It does NOT block the
-- void (legitimate), only the stale paid flags; status is left intact (the
-- session may still happen), and already-cancelled bookings are skipped.
CREATE OR REPLACE FUNCTION public.revert_bookings_on_invoice_cancel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'cancelled'
     AND OLD.status IS DISTINCT FROM 'cancelled'
     AND NEW.booking_ids IS NOT NULL
     AND array_length(NEW.booking_ids, 1) > 0 THEN
    UPDATE public.bookings
       SET payment_status = 'pending', paid_at = NULL
     WHERE id = ANY(NEW.booking_ids)
       AND payment_status = 'paid'
       AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_revert_bookings_on_invoice_cancel ON public.invoices;
CREATE TRIGGER trg_revert_bookings_on_invoice_cancel
  AFTER UPDATE OF status ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.revert_bookings_on_invoice_cancel();
