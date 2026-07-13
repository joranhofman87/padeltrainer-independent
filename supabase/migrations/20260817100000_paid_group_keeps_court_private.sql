-- ============================================================================
-- REBOOK · a PAID group keeps its whole court PRIVATE
-- ============================================================================
-- In the upfront group-captain model the captain pays the FULL court price once
-- (price_per_session × sessions, never × N) — so the court is bought regardless of how many
-- members actually fill seats. But capacity was a literal per-booking COUNT(*) everywhere, so
-- when a member declined (or never rostered), the freed seat read as empty and was offered to
-- academy members (the "sessions have opened" blast) and then to the PUBLIC when the slot
-- auto-released — a stranger could book the 4th seat on a court the group already paid for.
--
-- Fix: a paid rebook group holds its FULL max_participants toward OUTSIDERS only. Empty seats
-- are never offered to members or the public — only an admin can fill them (reinstate / roster).
-- The group's own management paths (rebook_group_manage / _apply, respond_to_priority_claim
-- accept, the reinstate RPC) count RAW bookings and are untouched, so the captain/admin can
-- still seat the group's remaining seats while outsiders see the court full.
--
-- Scope: "paid group" = an UPFRONT full-court group whose group invoice is paid, detected via
-- invoices.rebook_group_id = 'paid'. Only create-group-rebook-invoice ever tags that column;
-- deferred/per-share invoices carry rebook_cyclus_id instead, so a deferred round's empty seat
-- (an uncollected share) stays resellable — deliberately out of scope.
-- ============================================================================

-- (1) The shared predicate: does a paid rebook group hold this court?
--     No status filter on the claim on purpose — even an EMPTY paid group keeps its court.
--     SECURITY DEFINER + service_role grant: the outsider functions below are themselves
--     SECURITY DEFINER (owned by postgres), so their internal calls resolve as the owner.
CREATE OR REPLACE FUNCTION public.slot_held_by_paid_group(_slot_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.slot_priority_claims spc
    JOIN public.invoices i ON i.rebook_group_id = spc.rebook_group_id
    WHERE spc.slot_id = _slot_id
      AND spc.rebook_group_id IS NOT NULL
      AND i.status = 'paid'
  );
$$;
REVOKE ALL ON FUNCTION public.slot_held_by_paid_group(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.slot_held_by_paid_group(uuid) TO service_role;

-- (2) Public occupancy read (re-emit of 20260706140000): a slot held by a paid group reads as
--     FULL (occupied = max_participants) even with zero live bookings, so every anon + member
--     listing surface drops it (spots_left → 0). Row-set contract preserved: a row is emitted
--     only for a requested public slot that HAS occupying bookings OR is held by a paid group —
--     an empty, non-held slot stays absent exactly as before (the frontend defaults missing → 0).
CREATE OR REPLACE FUNCTION public.get_public_slot_occupancy(_slot_ids uuid[])
RETURNS TABLE (slot_id uuid, occupied integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH booked AS (
    SELECT b.slot_id, COUNT(*)::integer AS occupied
    FROM public.bookings b
    JOIN public.availability_slots s ON s.id = b.slot_id
    WHERE b.slot_id = ANY(_slot_ids)
      AND s.is_public = true
      AND (
        COALESCE(b.status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
      )
    GROUP BY b.slot_id
  )
  SELECT s.id AS slot_id,
    CASE
      WHEN public.slot_held_by_paid_group(s.id) THEN COALESCE(s.max_participants, 1)
      ELSE COALESCE(booked.occupied, 0)
    END::integer AS occupied
  FROM public.availability_slots s
  LEFT JOIN booked ON booked.slot_id = s.id
  WHERE s.id = ANY(_slot_ids)
    AND s.is_public = true
    AND (booked.slot_id IS NOT NULL OR public.slot_held_by_paid_group(s.id));
$$;
REVOKE ALL ON FUNCTION public.get_public_slot_occupancy(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_slot_occupancy(uuid[]) TO anon, authenticated;

-- (3) Authenticated pay-first booking (re-emit of 20260715100000): refuse an outsider taking a
--     paid group's freed seat. Byte-for-byte the same body, plus one guard after the lock.
CREATE OR REPLACE FUNCTION public.book_slot_for_payment(
  _slot_id uuid,
  _player_id uuid,
  _payment_amount numeric,
  _notes text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_max    integer;
  v_taken  integer;
  v_uid    uuid;
  v_reason text;
  v_id     uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  -- A paid rebook group keeps its whole court private — outsiders (the public/member pay-first
  -- path) may never take a freed seat; only an admin fills it (reinstate / roster).
  IF public.slot_held_by_paid_group(_slot_id) THEN
    RAISE EXCEPTION 'reserved_group' USING ERRCODE = 'check_violation';
  END IF;

  -- Effective capacity: a whole-slot (allow_single_booking=false) holds ONE booking.
  SELECT CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END
    INTO v_max FROM public.availability_slots WHERE id = _slot_id;

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

  -- RB01: service_role runs this, so the enforce_booking_slot_tier trigger skips
  -- (auth.uid() IS NULL). Enforce the tier HERE. Authenticated-players only —
  -- a profile with no linked auth user must not slip past the gate.
  SELECT user_id INTO v_uid FROM public.profiles WHERE id = _player_id;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'player_not_linked' USING ERRCODE = 'check_violation';
  END IF;
  v_reason := public.can_book_slot(_slot_id, v_uid);
  IF v_reason <> '' THEN
    RAISE EXCEPTION USING MESSAGE = v_reason, ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.bookings (slot_id, player_id, payment_status, status, payment_amount, notes)
  VALUES (_slot_id, _player_id, 'pending', 'pending', _payment_amount, NULLIF(btrim(_notes), ''))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_slot_for_payment(uuid, uuid, numeric, text) TO service_role;

-- (4) Guest pay-first booking (re-emit of 20260707140000): same guard on the anon guest path.
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
  v_max          integer;
  v_taken        integer;
  v_hold_min     integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_existing     uuid;
  v_id           uuid;
  v_is_public    boolean;
  v_cyclus_id    uuid;
  v_allow_single boolean;
  v_whole_slot   boolean;
  v_split        boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(_slot_id::text, 0));

  -- A paid rebook group keeps its whole court private — an anon guest may never take a freed seat.
  IF public.slot_held_by_paid_group(_slot_id) THEN
    RAISE EXCEPTION 'reserved_group' USING ERRCODE = 'check_violation';
  END IF;

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

  -- Effective capacity (whole-slot = 1) + is_public + the cyclus/booking-mode flags in one read.
  SELECT
    CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
    COALESCE(is_public, false),
    cyclus_id,
    COALESCE(allow_single_booking, false),
    COALESCE(whole_slot_booking, false),
    COALESCE(split_payment, false)
    INTO v_max, v_is_public, v_cyclus_id, v_allow_single, v_whole_slot, v_split
    FROM public.availability_slots WHERE id = _slot_id;
  IF NOT v_is_public THEN
    RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
  END IF;

  -- A single session of a CYCLUS may be booked on its own when the owner enabled per-seat
  -- booking (allow_single_booking) OR whole-slot selling (whole_slot_booking, non-split: one
  -- booking claims the entire session at the full price — capacity stays 1 via the CASE above).
  -- Split sessions are NEVER single-bookable at full price (per-seat total÷N via the cyclus
  -- path) — that would over-collect (20260706160000 (B)).
  IF v_cyclus_id IS NOT NULL AND NOT v_allow_single AND NOT (v_whole_slot AND NOT v_split) THEN
    RAISE EXCEPTION 'single_booking_not_allowed' USING ERRCODE = 'check_violation';
  END IF;

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

-- (5) Member-open notifier detection (re-emit of the function from 20260714110000): a paid
--     group's freed seat must NOT trigger the "sessions have opened" blast to members. The
--     signature/return are unchanged → notify-rebook-member-open needs no redeploy. The two
--     idempotency-claim RPCs + the cron schedule in 20260714110000 are unchanged and untouched.
CREATE OR REPLACE FUNCTION public.rebook_cycles_needing_member_open_notice()
RETURNS TABLE (cycle_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT c.id
  FROM public.cycles c
  WHERE c.owner_type = 'academy'
    AND (c.settings->>'rebook_payment_mode') IS NOT NULL          -- a rebook round
    AND (c.settings->>'rebook_member_open_notified_at') IS NULL    -- not yet notified
    AND EXISTS (
      SELECT 1
      FROM public.availability_slots s
      WHERE s.source_cycle_id = c.id
        AND s.member_window_ends_at IS NOT NULL
        AND s.priority_window_ends_at < now()                      -- priority window closed
        AND s.member_window_ends_at > now()                        -- member window still open
        AND NOT public.slot_held_by_paid_group(s.id)               -- a paid group's seats are private
        AND (
          SELECT count(*)
          FROM public.bookings b
          WHERE b.slot_id = s.id
            AND (
              COALESCE(b.status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
              OR (b.status = 'payment_pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at > now())
            )
        ) < COALESCE(s.max_participants, 1)                        -- a freed seat exists
    );
$$;
REVOKE ALL ON FUNCTION public.rebook_cycles_needing_member_open_notice() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebook_cycles_needing_member_open_notice() TO service_role;
