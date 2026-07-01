-- Guest single-slot PAY-FIRST: let a public (unauthenticated) visitor's pick reserve a seat while
-- they pay, and auto-release it if they abandon checkout.
--
-- book_guest_slot_for_payment mirrors book_slot_for_payment's advisory-lock + capacity recount
-- VERBATIM, but commits a guest_player_id booking as a short-TTL HOLD (status='payment_pending' +
-- hold_expires_at). The capacity predicate already counts such a hold only while hold_expires_at is
-- in the future, so capacity SELF-HEALS the moment an abandoned checkout's TTL passes, and the
-- mollie-webhook commits a paid hold to confirmed via booking_ids metadata (exactly like the rebook
-- strict pay-first hold). No client ever inserts the seat — this locked RPC is the one mutation
-- boundary (avoids the single-slot double-insert P0 class of bug).

CREATE OR REPLACE FUNCTION public.book_guest_slot_for_payment(
  _slot_id uuid,
  _guest_player_id uuid,
  _payment_amount numeric,
  _hold_minutes integer DEFAULT 20,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max      integer;
  v_taken    integer;
  v_hold_min integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_existing uuid;
  v_id       uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  -- Re-clicking "book" returns this guest's existing LIVE hold on the slot instead of stacking a
  -- second hold + a second Mollie payment.
  SELECT id INTO v_existing
  FROM public.bookings
  WHERE slot_id = _slot_id
    AND guest_player_id = _guest_player_id
    AND status = 'payment_pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at > now()
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT max_participants INTO v_max FROM public.availability_slots WHERE id = _slot_id;

  -- Capacity predicate — identical to book_slot_for_payment: occupied = active bookings OR a still-
  -- live payment_pending hold (expired holds are ignored, so capacity self-heals).
  SELECT count(*) INTO v_taken
  FROM public.bookings
  WHERE slot_id = _slot_id
    AND (
      COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
      OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
    );

  IF v_taken >= COALESCE(v_max, 1) THEN
    RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
  VALUES (
    _slot_id,
    _guest_player_id,
    'pending',
    'payment_pending',
    _payment_amount,
    now() + make_interval(mins => v_hold_min),
    NULLIF(btrim(_notes), '')
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_slot_for_payment(uuid, uuid, numeric, integer, text) TO service_role;

-- Sweep: cancel abandoned guest holds past their TTL. Capacity already self-heals in the count
-- predicate; this is the bookkeeping that frees the stale rows AND closes the resurrection window
-- (a paid webhook arriving after cancellation hits mollie-webhook's paid-on-cancelled refund alert
-- rather than silently reviving an expired seat). Only unpaid (payment_status='pending') guest holds
-- are swept — a paid one is no longer payment_pending.
CREATE OR REPLACE FUNCTION public.release_expired_guest_slot_holds()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_n integer;
BEGIN
  UPDATE public.bookings
     SET status = 'cancelled', updated_at = now()
   WHERE status = 'payment_pending'
     AND guest_player_id IS NOT NULL
     AND payment_status = 'pending'
     AND hold_expires_at IS NOT NULL
     AND hold_expires_at < now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_guest_slot_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_guest_slot_holds() TO service_role;

-- Schedule the 5-min sweep. postgres owns pg_cron; guarded on pg_cron being installed so a stack
-- without it (fresh db reset / CI) resets cleanly. Idempotent (unschedule same-name job first).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE NOTICE 'pg_cron not installed — skipping release-expired-guest-slot-holds schedule';
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-expired-guest-slot-holds') THEN
    PERFORM cron.unschedule('release-expired-guest-slot-holds');
  END IF;
  PERFORM cron.schedule(
    'release-expired-guest-slot-holds',
    '*/5 * * * *',
    'SELECT public.release_expired_guest_slot_holds()'
  );
END $$;
