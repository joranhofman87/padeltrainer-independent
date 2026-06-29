-- ============================================================================
-- REBOOK GO-LIVE · Workstream A, Slice A2 — strict accept (creates a HOLD) + release
-- ============================================================================
-- Builds on A1 (20260703140000: bookings.hold_expires_at + payment_pending status +
-- capacity counts an active hold). This slice makes the accept SERVER-AUTHORITATIVE-ly
-- strict and adds the hold lifecycle:
--
--   (1) respond_to_priority_claim — read the slot's cycle settings.rebook_strict_mollie
--       (server-side; the client cannot bypass strict). When STRICT, the accept inserts a
--       payment_pending HOLD (hold_expires_at = now()+15min) instead of a confirmed booking;
--       the claim still flips to 'claimed' (the webhook A4 commits the hold to confirmed/paid
--       on payment; the release cron re-offers it on expiry). When NOT strict, the INSERT is
--       byte-identical to A1 (confirmed, NULL hold_expires_at) — so every non-strict cycle is
--       unchanged. The only edit vs A1 is the two booking INSERTs + the v_strict lookup.
--
--   (2) release_rebook_hold(_booking_id) — client-callable: when the player's Mollie checkout
--       could not be STARTED (strict has NO bank fallback), the client releases its own hold
--       (cancel + reset the claim back to pending so it can be re-offered). Verified to belong
--       to the caller.
--
--   (3) release_expired_rebook_holds() + a 5-min cron — bookkeeping: cancel holds past their
--       TTL and reset their claims to pending. Capacity already self-heals in real time (the A1
--       predicate ignores expired holds), so this is not time-critical; a direct-SQL cron (no
--       edge fn) keeps it simple + reliable. Guarded on status='payment_pending' so it can never
--       clobber a hold the webhook just committed to confirmed in a racing transaction.
-- ============================================================================

-- (1) respond_to_priority_claim — strict-aware booking insert (reproduced from 20260703140000;
--     ONLY adds v_strict + the two CASE inserts).
CREATE OR REPLACE FUNCTION public.respond_to_priority_claim(_token text, _action text, _reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_seats_taken integer;
  v_booking_id uuid;
  v_first_booking uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_skipped_full integer := 0;
  v_strict boolean := false;
  rec record;
BEGIN
  IF _action NOT IN ('decline', 'accept') THEN
    RAISE EXCEPTION 'Unsupported action: %', _action;
  END IF;

  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;

  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  -- Strict pay-first is opt-in per cycle (settings.rebook_strict_mollie). Read server-side so a
  -- client can never downgrade a strict cycle. A rebook_group is one cycle, so this one lookup
  -- governs both the legacy single accept and the multi-week group accept below.
  v_strict := COALESCE(
    (SELECT (cy.settings->>'rebook_strict_mollie')::boolean FROM public.cycles cy WHERE cy.id = s.cyclus_id),
    false
  );

  IF c.status NOT IN ('pending') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded', 'status', c.status);
  END IF;

  IF s.priority_window_ends_at IS NOT NULL AND s.priority_window_ends_at < now() THEN
    UPDATE public.slot_priority_claims
      SET status = 'expired', responded_at = now()
      WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'window_expired');
  END IF;

  -- ================= LEGACY single-claim path (rebook_group_id IS NULL) =====
  IF c.rebook_group_id IS NULL THEN
    IF _action = 'decline' THEN
      UPDATE public.slot_priority_claims
        SET status = 'declined', responded_at = now(), decline_reason = _reason
        WHERE id = c.id;
      RETURN jsonb_build_object('ok', true, 'status', 'declined');
    END IF;

    -- Serialize concurrent accepts on this slot before counting seats.
    PERFORM pg_advisory_xact_lock(hashtextextended(c.slot_id::text, 0));

    SELECT count(*) INTO v_seats_taken
    FROM public.bookings
    WHERE slot_id = c.slot_id
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_seats_taken >= COALESCE(s.max_participants, 1) THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'slot_full');
    END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, hold_expires_at, created_at, updated_at)
    VALUES (
      c.slot_id, c.player_id, c.guest_player_id,
      CASE WHEN v_strict THEN 'payment_pending' ELSE 'confirmed' END,
      'pending',
      CASE WHEN v_strict THEN now() + interval '15 minutes' ELSE NULL END,
      now(), now()
    )
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id
      WHERE id = c.id;

    RETURN jsonb_build_object('ok', true, 'status', 'claimed', 'booking_id', v_booking_id, 'strict', v_strict);
  END IF;

  -- ================= GROUP path (whole series in one click) ================
  IF _action = 'decline' THEN
    FOR rec IN
      SELECT id FROM public.slot_priority_claims
      WHERE rebook_group_id = c.rebook_group_id
        AND status = 'pending'
        AND player_id IS NOT DISTINCT FROM c.player_id
        AND guest_player_id IS NOT DISTINCT FROM c.guest_player_id
      FOR UPDATE
    LOOP
      UPDATE public.slot_priority_claims
        SET status = 'declined', responded_at = now(), decline_reason = _reason
        WHERE id = rec.id;
      v_declined := v_declined + 1;
    END LOOP;
    RETURN jsonb_build_object('ok', true, 'status', 'declined', 'group', true, 'declined', v_declined);
  END IF;

  -- accept: book every pending slot in the group, capacity-guarding each.
  FOR rec IN
    SELECT spc.id, spc.slot_id, spc.player_id, spc.guest_player_id,
           av.max_participants
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots av ON av.id = spc.slot_id
    WHERE spc.rebook_group_id = c.rebook_group_id
      AND spc.status = 'pending'
      AND spc.player_id IS NOT DISTINCT FROM c.player_id
      AND spc.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    ORDER BY av.start_time
    FOR UPDATE OF spc
  LOOP
    -- Serialize concurrent accepts on this slot before counting seats.
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));

    SELECT count(*) INTO v_seats_taken
    FROM public.bookings
    WHERE slot_id = rec.slot_id
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_seats_taken >= COALESCE(rec.max_participants, 1) THEN
      v_skipped_full := v_skipped_full + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, hold_expires_at, created_at, updated_at)
    VALUES (
      rec.slot_id, rec.player_id, rec.guest_player_id,
      CASE WHEN v_strict THEN 'payment_pending' ELSE 'confirmed' END,
      'pending',
      CASE WHEN v_strict THEN now() + interval '15 minutes' ELSE NULL END,
      now(), now()
    )
    RETURNING id INTO v_booking_id;
    IF v_first_booking IS NULL THEN v_first_booking := v_booking_id; END IF;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id
      WHERE id = rec.id;
    v_booked := v_booked + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_booked > 0,
    'status', CASE WHEN v_booked > 0 THEN 'claimed' ELSE 'slot_full' END,
    'group', true,
    'booked', v_booked,
    'skipped_full', v_skipped_full,
    'booking_id', v_first_booking,
    'strict', v_strict
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.respond_to_priority_claim(text, text, text) TO anon, authenticated;

-- (2) release_rebook_hold — client releases its OWN hold when Mollie checkout couldn't start
--     (strict has no bank fallback). Verifies the booking is the caller's payment_pending hold,
--     cancels it, and resets the claim to pending so the seat is re-offerable. Idempotent.
CREATE OR REPLACE FUNCTION public.release_rebook_hold(_booking_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile uuid;
  v_booking public.bookings;
BEGIN
  v_profile := public.get_profile_id_for_user(auth.uid());
  IF v_profile IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_profile');
  END IF;

  SELECT * INTO v_booking FROM public.bookings WHERE id = _booking_id FOR UPDATE;
  IF v_booking.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_found');
  END IF;

  -- Only the caller's own hold (player_id-keyed; strict accept requires an authed player).
  IF v_booking.player_id IS DISTINCT FROM v_profile THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_yours');
  END IF;

  -- Already committed/cancelled → nothing to release (idempotent no-op).
  IF v_booking.status <> 'payment_pending' THEN
    RETURN jsonb_build_object('ok', true, 'released', false, 'status', v_booking.status);
  END IF;

  UPDATE public.bookings SET status = 'cancelled', updated_at = now() WHERE id = _booking_id;
  UPDATE public.slot_priority_claims
    SET status = 'pending', booking_id = NULL, responded_at = NULL
    WHERE booking_id = _booking_id AND status = 'claimed';

  RETURN jsonb_build_object('ok', true, 'released', true);
END;
$$;

REVOKE ALL ON FUNCTION public.release_rebook_hold(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_rebook_hold(uuid) TO authenticated;

-- (3) release_expired_rebook_holds — cron bookkeeping. Cancels holds past their TTL and resets
--     their claims to pending. Guarded on status='payment_pending' so a hold the webhook just
--     committed to confirmed in a racing txn is never clobbered.
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
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_rebook_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_rebook_holds() TO service_role;

-- (4) admin-gated cron scheduling (mirror schedule_invoice_health_check_job; pg_cron calls the
--     SQL function directly — no edge fn, since the cleanup is pure SQL + self-healing).
CREATE OR REPLACE FUNCTION public.schedule_release_rebook_holds_job()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  job_id bigint;
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;

  SELECT jobid INTO job_id FROM cron.job WHERE jobname = 'release-expired-rebook-holds';
  IF job_id IS NOT NULL THEN
    PERFORM cron.unschedule('release-expired-rebook-holds');
  END IF;

  -- Every 5 minutes: free seats held by abandoned strict checkouts + re-offer the claim.
  SELECT cron.schedule('release-expired-rebook-holds', '*/5 * * * *',
                       'SELECT public.release_expired_rebook_holds()')
  INTO job_id;
  RETURN job_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.unschedule_release_rebook_holds_job()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Only admins can manage cron jobs';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'release-expired-rebook-holds') THEN
    PERFORM cron.unschedule('release-expired-rebook-holds');
  END IF;
END;
$$;
