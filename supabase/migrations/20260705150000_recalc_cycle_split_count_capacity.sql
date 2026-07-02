-- G5 (Option A): freeze the split-payment divisor to COURT CAPACITY.
--
-- recalc_cycle_split_count previously wrote the LIVE distinct-active-player count as
-- the invoice split_count — the same racy divisor the instant-pay charge used. This
-- CREATE OR REPLACE switches the divisor to the cycle's slot capacity
-- (GREATEST(MAX(max_participants), 1)), matching create-mollie-payment /
-- create-guest-cyclus-payment (which now divide by resolveSplitDivisorFromSlots).
-- Because the divisor is now a pure function of the slot rows, the charge path and
-- the invoice path can never disagree, and it never drifts as the cohort forms.
--
-- Everything else is preserved: the per-cycle advisory lock (serialize concurrent
-- recounts), the split_payment gate, the "divisor <= 1 ⇒ no split" early-return, and
-- the authoritative UPDATE of every unpaid sibling invoice's split_count. The
-- (proven, unit-tested) JS line-item rebuild reads THIS split_count, so its math is
-- unchanged — only the divisor's meaning changed (player count → seat capacity).
-- SECURITY INVOKER: the UPDATE stays under the caller's RLS.

CREATE OR REPLACE FUNCTION public.recalc_cycle_split_count(_cyclus_id uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_is_split boolean;
  v_count    integer;
  v_ids      uuid[];
BEGIN
  IF _cyclus_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Only split-payment cycles have a divisor to recompute.
  SELECT bool_or(COALESCE(split_payment, false)) INTO v_is_split
  FROM public.availability_slots
  WHERE cyclus_id = _cyclus_id;

  IF NOT COALESCE(v_is_split, false) THEN
    RETURN 0;
  END IF;

  -- Serialize concurrent recounts for this cycle (distinct key namespace from
  -- the per-slot booking locks).
  PERFORM pg_advisory_xact_lock(hashtextextended('cycle_split:' || _cyclus_id::text, 0));

  -- G5: divisor = the cycle's COURT CAPACITY (max seats across its booked slots),
  -- NOT the live player count. MAX is order-independent + never overcharges when
  -- slots disagree on capacity (a data anomaly). v_ids are the bookings whose sibling
  -- invoices get the authoritative divisor stamped below.
  SELECT array_agg(b.id),
         GREATEST(COALESCE(MAX(COALESCE(s.max_participants, 1)), 1), 1)
    INTO v_ids, v_count
  FROM public.availability_slots s
  JOIN public.bookings b ON b.slot_id = s.id
  WHERE s.cyclus_id = _cyclus_id
    AND b.status IN ('confirmed', 'pending');

  IF v_count IS NULL OR v_count <= 1 THEN
    RETURN COALESCE(v_count, 0);  -- capacity of 1 (or no bookings) ⇒ no split
  END IF;

  -- Authoritative divisor onto every unpaid sibling invoice overlapping these
  -- bookings (mirrors the client's UNPAID_SYNC_STATUSES + booking_ids overlap).
  UPDATE public.invoices i
     SET split_count = v_count
   WHERE i.status IN ('sent', 'pending', 'draft', 'overdue')
     AND i.booking_ids && v_ids;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recalc_cycle_split_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalc_cycle_split_count(uuid) TO authenticated, service_role;
