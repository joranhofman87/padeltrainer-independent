-- ============================================================================
-- REBOOK · admin reinstates an accidentally-DECLINED player ("Toch herboeken")
-- ============================================================================
-- A player who accidentally declined a rebook invitation ("I won't continue") ends up with a
-- 'declined' claim and no seat, and the manage page has no way to put them back — the only lever
-- is "free seat" (the reverse). This RPC lets an academy manager reinstate a declined player's
-- whole series: flip their declined claims to 'claimed' and (re)book each seat.
--
-- Payment mirrors the covered model exactly (rebook_group_manage step 2): when the group paid the
-- FULL court upfront (its rebook_group_id invoice is 'paid'), the reinstated seat is booked
-- 'confirmed'/'paid', paid_by = captain — NO new charge, the court price is fixed regardless of
-- roster. When the round is per-player or the group hasn't paid, the seat is re-booked UNPAID
-- (they still owe). Genuine "no" answers are untouched — manager-freed seats and player declines
-- that the owner wants gone stay declined unless explicitly reinstated here.
--
-- Capacity is guarded per slot (advisory lock + raw occupying count, the same key/predicate as
-- respond_to_priority_claim and book_slot_for_payment) so reinstating never oversells; if the
-- seat was meanwhile taken, that claim returns 'seat_full' and is left declined. M-17 dup-active
-- bookings are reused, not re-inserted (avoids 23505). Manager-authorized (SECURITY DEFINER +
-- academy IDOR check), keyed by the claim ids the manage page already holds per player.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reinstate_rebook_claims(_claim_ids uuid[])
RETURNS TABLE (claim_id uuid, outcome text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec          record;
  v_group      uuid;
  v_cap_player uuid;
  v_cap_guest  uuid;
  v_paid       boolean;
  v_invoice_id uuid;
  v_is_own     boolean;
  v_seats      integer;
  v_max        integer;
  v_existing   uuid;
  v_booking_id uuid;
BEGIN
  IF _claim_ids IS NULL OR array_length(_claim_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  -- IDOR: every target claim's slot must belong to an academy the caller manages
  -- (get_academy_cyclus_groups precedent). SECURITY DEFINER bypasses RLS, so gate here.
  IF EXISTS (
    SELECT 1
    FROM public.slot_priority_claims c
    JOIN public.availability_slots s ON s.id = c.slot_id
    WHERE c.id = ANY(_claim_ids)
      AND (s.academy_profile_id IS NULL
           OR s.academy_profile_id NOT IN (SELECT public.get_user_academy_ids(auth.uid())))
  ) THEN
    RAISE EXCEPTION 'not_authorized_for_academy' USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR rec IN
    SELECT c.id, c.slot_id, c.player_id, c.guest_player_id, c.rebook_group_id, c.status,
           s.max_participants
    FROM public.slot_priority_claims c
    JOIN public.availability_slots s ON s.id = c.slot_id
    WHERE c.id = ANY(_claim_ids)
    FOR UPDATE OF c
  LOOP
    IF rec.status <> 'declined' THEN
      claim_id := rec.id; outcome := 'not_declined'; RETURN NEXT; CONTINUE;
    END IF;

    v_group := rec.rebook_group_id;
    v_max := COALESCE(rec.max_participants, 1);
    v_cap_player := NULL; v_cap_guest := NULL; v_paid := false; v_invoice_id := NULL;

    -- Paying captain + paid state = the group's UPFRONT paid invoice (also the covered signal).
    IF v_group IS NOT NULL THEN
      SELECT i.id, i.player_id, i.guest_player_id, true
        INTO v_invoice_id, v_cap_player, v_cap_guest, v_paid
      FROM public.invoices i
      WHERE i.rebook_group_id = v_group AND i.status = 'paid'
      LIMIT 1;
      v_paid := COALESCE(v_paid, false);
    END IF;
    v_is_own := (v_cap_player IS NOT DISTINCT FROM rec.player_id
                 AND v_cap_guest IS NOT DISTINCT FROM rec.guest_player_id);

    -- Serialize with every other seat-writer on this slot (same lock key).
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));

    -- M-17 reuse: already has an active booking → link the claim to it, don't insert.
    SELECT id INTO v_existing FROM public.bookings
      WHERE slot_id = rec.slot_id
        AND player_id IS NOT DISTINCT FROM rec.player_id
        AND guest_player_id IS NOT DISTINCT FROM rec.guest_player_id
        AND status IN ('pending','confirmed','completed')
      LIMIT 1;
    IF v_existing IS NOT NULL THEN
      UPDATE public.slot_priority_claims
        SET status = 'claimed', responded_at = now(), booking_id = v_existing, decline_reason = NULL,
            booked_by_player_id       = CASE WHEN v_paid AND NOT v_is_own THEN v_cap_player ELSE NULL END,
            booked_by_guest_player_id = CASE WHEN v_paid AND NOT v_is_own THEN v_cap_guest  ELSE NULL END
        WHERE id = rec.id;
      claim_id := rec.id; outcome := 'already_active'; RETURN NEXT; CONTINUE;
    END IF;

    -- Capacity via RAW occupying count — never oversell (mirrors book_slot_for_payment).
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id
        AND (status IN ('confirmed','pending','pending_approval')
             OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
    IF v_seats >= v_max THEN
      claim_id := rec.id; outcome := 'seat_full'; RETURN NEXT; CONTINUE;
    END IF;

    IF v_paid THEN
      -- COVERED re-seat: no new charge, paid by the captain (mirrors rebook_group_manage step 2).
      INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, paid_at,
                                   paid_by_player_id, paid_by_guest_player_id, created_at, updated_at)
      VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'paid', now(),
              v_cap_player, v_cap_guest, now(), now())
      RETURNING id INTO v_booking_id;

      UPDATE public.slot_priority_claims
        SET status = 'claimed', responded_at = now(), booking_id = v_booking_id, decline_reason = NULL,
            booked_by_player_id       = CASE WHEN v_is_own THEN NULL ELSE v_cap_player END,
            booked_by_guest_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_guest  END
        WHERE id = rec.id;

      -- Record-only: link the covered booking onto the group's own paid invoice (amount unchanged).
      IF v_invoice_id IS NOT NULL THEN
        UPDATE public.invoices
          SET booking_ids = (SELECT array(SELECT DISTINCT unnest(COALESCE(booking_ids, '{}'::uuid[]) || v_booking_id)))
          WHERE id = v_invoice_id AND status = 'paid' AND rebook_group_id = v_group;
      END IF;

      claim_id := rec.id; outcome := 'reinstated'; RETURN NEXT;
    ELSE
      -- FALLBACK: per-player round OR group not (yet) paid → re-seat UNPAID (they still owe).
      INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
      VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'pending', now(), now())
      RETURNING id INTO v_booking_id;

      UPDATE public.slot_priority_claims
        SET status = 'claimed', responded_at = now(), booking_id = v_booking_id, decline_reason = NULL,
            booked_by_player_id       = CASE WHEN v_group IS NOT NULL AND NOT v_is_own THEN v_cap_player ELSE NULL END,
            booked_by_guest_player_id = CASE WHEN v_group IS NOT NULL AND NOT v_is_own THEN v_cap_guest  ELSE NULL END
        WHERE id = rec.id;

      claim_id := rec.id; outcome := 'reinstated_unpaid'; RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.reinstate_rebook_claims(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reinstate_rebook_claims(uuid[]) TO authenticated;
