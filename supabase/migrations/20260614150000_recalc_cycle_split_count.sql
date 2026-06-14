-- Phase 2 (scale audit) RC-002/RC-005: the split-payment divisor (1/N) was
-- counted client-side without a lock, and the optimistic-retry reused the stale
-- captured count — so on league-signup day, concurrent joins each captured a
-- different N and stamped a wrong divisor onto the shared sibling invoices.
--
-- This RPC takes a per-CYCLE advisory lock, recounts the unique active players,
-- and writes the authoritative split_count onto every unpaid sibling invoice.
-- The (proven, unit-tested) JS rebuild then reads THAT split_count instead of a
-- racy client count, so the line-item math is unchanged — only the divisor is
-- now serialized. Two concurrent syncs serialize on the lock; the later one sees
-- all committed bookings, so split_count converges to the correct N. SECURITY
-- INVOKER: the UPDATE stays under the caller's RLS (same as the old client write).
--
-- Count semantics mirror the client EXACTLY: bookings with status IN
-- ('confirmed','pending') (NULL status excluded, as `.in(...)` does), keyed by
-- player_id with guest_player_id as the fallback.

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

  SELECT array_agg(b.id),
         count(DISTINCT COALESCE(b.player_id::text, b.guest_player_id::text))
    INTO v_ids, v_count
  FROM public.availability_slots s
  JOIN public.bookings b ON b.slot_id = s.id
  WHERE s.cyclus_id = _cyclus_id
    AND b.status IN ('confirmed', 'pending');

  IF v_count IS NULL OR v_count <= 1 THEN
    RETURN COALESCE(v_count, 0);  -- no split needed
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
