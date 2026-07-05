-- Multi-session cart booking (guest "winkelwagen") — the cart's ONLY mutation boundary.
-- Design: docs/audits/MULTI_SESSION_CART_BOOKING_AUDIT.md §6.1.
--
-- book_guest_cart_for_payment holds an ARBITRARY client-selected slot set atomically for one guest,
-- one Mollie payment. Structure is a clone of book_guest_cyclus_for_payment (20260706160000):
-- sorted advisory locks, live-hold idempotent re-click, partial-hold reuse, occupancy predicate that
-- counts live payment_pending holds, all-or-nothing rollback, TTL-clamped holds, per-slot amounts.
--
-- Two deliberate deltas from the cyclus RPC:
--
-- (1) Per-ITEM capacity/guards use the SINGLE-SLOT rules, not the cyclus rules. A cart item is an
--     individually-booked full-price session, so:
--       capacity  = allow_single_booking ? max_participants : 1   (whole-slot when not per-seat)
--       guards    = slot_not_public
--                   single_booking_not_allowed  (cyclus session without allow_single_booking —
--                                                must go through the whole-cyclus path)
--                   split_not_supported         (split_payment sessions are per-seat total÷N and
--                                                excluded from cart v1 — a full-price cart hold on
--                                                one would over-collect, same class as the
--                                                single-slot guard in 20260706160000 (B))
--     The split/cyclus guards also run in create-guest-cart-payment; here is belt-and-suspenders at
--     the mutation boundary, where verify_jwt=false traffic cannot bypass them.
--
-- (2) Error contract: every per-slot refusal carries the offending slot id in DETAIL so the cart UI
--     can mark/prune exactly the stale item and let the guest retry the rest. The pre-existing RPCs
--     raise bare 'slot_full' — fine for a single slot, useless for a cart of 8.
--
-- Also hardened vs the template (cheap, cart-relevant):
--   - duplicate ids in _slot_ids  → invalid_input (a dupe would silently reuse one hold and desync
--     the amounts distribution)
--   - unknown slot id             → slot_unavailable + DETAIL (the template's NULL-row fallthrough
--     skips the is_public guard entirely because IF NOT NULL is not true)

CREATE OR REPLACE FUNCTION public.book_guest_cart_for_payment(
  _guest_player_id uuid,
  _slot_ids uuid[],
  _amounts numeric[],
  _hold_minutes integer DEFAULT 20,
  _notes text DEFAULT NULL
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hold_min     integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_n            integer := array_length(_slot_ids, 1);
  v_sorted       uuid[];
  v_slot         uuid;
  v_idx          integer;
  v_max          integer;
  v_taken        integer;
  v_existing     uuid;
  v_live         uuid[];
  v_ids          uuid[] := ARRAY[]::uuid[];
  v_id           uuid;
  v_is_public    boolean;
  v_cyclus_id    uuid;
  v_allow_single boolean;
  v_split        boolean;
BEGIN
  IF v_n IS NULL OR v_n = 0 OR v_n <> array_length(_amounts, 1) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  -- Duplicate slot ids would reuse one hold twice and desync the amounts distribution.
  IF (SELECT count(DISTINCT s) FROM unnest(_slot_ids) AS s) <> v_n THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Lock every slot in a deterministic order to avoid deadlocks between two
  -- concurrent carts that touch overlapping slots.
  SELECT array_agg(s ORDER BY s) INTO v_sorted FROM unnest(_slot_ids) AS s;
  FOREACH v_slot IN ARRAY v_sorted LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(v_slot::text, 0));
  END LOOP;

  -- Idempotent re-click: if this guest already holds a LIVE seat on EVERY slot,
  -- return those instead of stacking a second set of holds + a second payment.
  SELECT array_agg(id) INTO v_live
  FROM public.bookings
  WHERE slot_id = ANY(_slot_ids)
    AND guest_player_id = _guest_player_id
    AND status = 'payment_pending'
    AND hold_expires_at IS NOT NULL
    AND hold_expires_at > now();
  IF v_live IS NOT NULL AND array_length(v_live, 1) = v_n THEN
    RETURN v_live;
  END IF;

  -- Otherwise create the missing holds (reusing any live partial holds), all in
  -- this one transaction. Preserve input order so amounts line up with slots.
  FOR v_idx IN 1 .. v_n LOOP
    v_slot := _slot_ids[v_idx];

    SELECT id INTO v_existing
    FROM public.bookings
    WHERE slot_id = v_slot
      AND guest_player_id = _guest_player_id
      AND status = 'payment_pending'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at > now()
    LIMIT 1;
    IF v_existing IS NOT NULL THEN
      v_ids := array_append(v_ids, v_existing);
      CONTINUE;
    END IF;

    -- Single-slot capacity semantics (whole-slot = 1 unless per-seat) + all guard
    -- inputs in one read.
    SELECT
      CASE WHEN COALESCE(allow_single_booking, false) THEN COALESCE(max_participants, 1) ELSE 1 END,
      COALESCE(is_public, false),
      cyclus_id,
      COALESCE(allow_single_booking, false),
      COALESCE(split_payment, false)
      INTO v_max, v_is_public, v_cyclus_id, v_allow_single, v_split
      FROM public.availability_slots WHERE id = v_slot;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'slot_unavailable' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF NOT v_is_public THEN
      RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF v_split THEN
      RAISE EXCEPTION 'split_not_supported' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;
    IF v_cyclus_id IS NOT NULL AND NOT v_allow_single THEN
      RAISE EXCEPTION 'single_booking_not_allowed' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;

    SELECT count(*) INTO v_taken
    FROM public.bookings
    WHERE slot_id = v_slot
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_taken >= COALESCE(v_max, 1) THEN
      RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation', DETAIL = v_slot::text;
    END IF;

    INSERT INTO public.bookings (slot_id, guest_player_id, payment_status, status, payment_amount, hold_expires_at, notes)
    VALUES (
      v_slot,
      _guest_player_id,
      'pending',
      'payment_pending',
      _amounts[v_idx],
      now() + make_interval(mins => v_hold_min),
      NULLIF(btrim(_notes), '')
    )
    RETURNING id INTO v_id;
    v_ids := array_append(v_ids, v_id);
  END LOOP;

  RETURN v_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.book_guest_cart_for_payment(uuid, uuid[], numeric[], integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.book_guest_cart_for_payment(uuid, uuid[], numeric[], integer, text) TO service_role;
