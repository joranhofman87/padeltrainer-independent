-- ============================================================================
-- REBOOK · two guards from the 2026-07-10 live incident (Eveline, Najaar 26)
-- ============================================================================
-- INCIDENT: a captain accepted on a strict-upfront round at 14:28 — holds + group invoice were
-- created correctly — but her Mollie checkout never completed. The self-heal cancelled her holds
-- (14:43) and the zombie sweep cancelled the invoice, BUT her claims stayed status='claimed'
-- pointing at cancelled bookings: release_expired_rebook_holds only reverts claims for holds it
-- cancels IN THE SAME PASS (the CTE join), and hers were cancelled by a different path (the
-- client-side rollback when the checkout mint failed). Result: her claim link dead-ends
-- ("already_responded", no unpaid invoice to resume), she saw the misleading deferred "reserved —
-- invoice later" copy on revisit, and the academy's manage view showed "Geherboekt" for freed seats.
--
-- FIX 1 — GLOBAL stuck-claim sweep in release_expired_rebook_holds: revert ANY 'claimed' claim
-- whose booking died as an UNPAID strict hold (status='cancelled', payment_status <> 'paid',
-- hold_expires_at IS NOT NULL), regardless of who cancelled it. The hold marker distinguishes these
-- from deliberate cancellations of confirmed seats (freePlayerRebookSeat declines claims itself and
-- paid/deferred bookings carry no hold timestamp), so admin actions and refund trails are never
-- touched. Idempotent; the next cron tick (*/5) self-heals every stuck link.
--
-- FIX 2 — rebook_group_apply refuses UPFRONT cycles: the deferred group-apply path books the whole
-- group as confirmed-but-UNPAID seats and trusted the CLIENT's payment-mode resolution entirely. A
-- stale frontend or the silent mode fallback (cycles_public returns no row once a cycle leaves
-- 'open' → mode defaults to deferred) could book an entire group unpaid on a pay-first round. The
-- server now reads the claim's cycle settings itself and returns {ok:false, reason:'upfront_cycle'}
-- — upfront groups must go through create-group-rebook-invoice (which mints + charges). Slots
-- without a linked cycle keep the legacy deferred behaviour (NULL mode ≠ 'upfront').
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) release_expired_rebook_holds — re-emitted from 20260803100000 verbatim,
--    plus the GLOBAL stuck-claim sweep between the holds CTE and the invoice sweep.
-- ---------------------------------------------------------------------------
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

  -- STUCK-CLAIM SWEEP (incident fix): the CTE above only heals holds cancelled by THIS pass. A
  -- booking cancelled elsewhere (client rollback on a failed checkout mint, an earlier partial
  -- run) leaves its claim 'claimed' forever → dead-end link + false "Geherboekt". Globally revert
  -- claims whose booking died as an UNPAID hold. hold_expires_at IS NOT NULL scopes to strict
  -- holds; payment_status <> 'paid' protects refund trails (the webhook also nulls the hold on
  -- payment, so paid seats are doubly excluded). Separate statement so it sees this run's
  -- cancellations too (harmlessly — their claims are already reverted).
  UPDATE public.slot_priority_claims spc
  SET status = 'pending', booking_id = NULL, responded_at = NULL
  FROM public.bookings b
  WHERE b.id = spc.booking_id
    AND spc.status = 'claimed'
    AND b.status = 'cancelled'
    AND COALESCE(b.payment_status, '') <> 'paid'
    AND b.hold_expires_at IS NOT NULL;

  -- Zombie sweep: an UNPAID rebook invoice whose bookings are ALL cancelled must never
  -- stay payable. (Separate statement so it sees the bookings UPDATE above — CTE
  -- sub-statements share a snapshot and would still see the holds as live.)
  UPDATE public.invoices i
  SET status = 'cancelled'
  WHERE i.status NOT IN ('paid', 'cancelled')
    AND (i.rebook_cyclus_id IS NOT NULL OR i.rebook_group_id IS NOT NULL)
    AND i.booking_ids IS NOT NULL
    AND array_length(i.booking_ids, 1) > 0
    AND NOT EXISTS (
      SELECT 1 FROM public.bookings b
      WHERE b.id = ANY (i.booking_ids)
        AND b.status <> 'cancelled'
    );

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.release_expired_rebook_holds() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_expired_rebook_holds() TO service_role;

-- ---------------------------------------------------------------------------
-- 2) rebook_group_apply — re-emitted from 20260705100000 verbatim, plus the
--    upfront-cycle refusal right after the window check.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebook_group_apply(
  _token text,
  _keep_keys jsonb DEFAULT '[]'::jsonb,
  _new_guest_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_group uuid;
  v_cap_player uuid;
  v_cap_guest uuid;
  v_keep_player uuid[] := '{}';
  v_keep_guest uuid[] := '{}';
  v_seats integer;
  v_max integer;
  v_booking_id uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_skipped_full integer := 0;
  v_skipped_existing integer := 0;
  v_added integer := 0;
  v_is_own boolean;
  v_existing_booking uuid;
  v_booking_ids uuid[] := '{}';
  k text;
  rec record;
  gid uuid;
  slotrec record;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'Claim not found'; END IF;
  IF c.rebook_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_group');
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;
  IF c.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'already_responded', 'status', c.status);
  END IF;
  IF s.priority_window_ends_at IS NOT NULL AND s.priority_window_ends_at < now() THEN
    UPDATE public.slot_priority_claims SET status = 'expired', responded_at = now() WHERE id = c.id;
    RETURN jsonb_build_object('ok', false, 'reason', 'window_expired');
  END IF;

  -- UPFRONT GUARD (incident fix): this deferred path books confirmed-but-UNPAID seats. On an
  -- upfront cycle the whole-group payment must go through create-group-rebook-invoice instead —
  -- refuse server-side rather than trusting the client's mode resolution (a stale frontend or the
  -- silent cycles_public fallback could route an upfront group here and seat it without payment).
  IF (SELECT cy.settings->>'rebook_payment_mode' FROM public.cycles cy WHERE cy.id = s.cyclus_id) = 'upfront' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'upfront_cycle');
  END IF;

  v_group := c.rebook_group_id;
  v_cap_player := c.player_id;
  v_cap_guest := c.guest_player_id;

  -- Serialize the whole group so two captains can't both apply concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 1));

  -- Parse keep keys; the captain is ALWAYS kept.
  FOR k IN SELECT jsonb_array_elements_text(_keep_keys) LOOP
    IF k LIKE 'p:%' THEN v_keep_player := array_append(v_keep_player, substring(k from 3)::uuid);
    ELSIF k LIKE 'g:%' THEN v_keep_guest := array_append(v_keep_guest, substring(k from 3)::uuid);
    END IF;
  END LOOP;
  IF v_cap_player IS NOT NULL THEN v_keep_player := array_append(v_keep_player, v_cap_player); END IF;
  IF v_cap_guest IS NOT NULL THEN v_keep_guest := array_append(v_keep_guest, v_cap_guest); END IF;

  -- 1) Decline removed members' PENDING claims only (never cancel a booked/paid seat).
  FOR rec IN
    SELECT id FROM public.slot_priority_claims
    WHERE rebook_group_id = v_group AND status = 'pending'
      AND NOT (
        (player_id IS NOT NULL AND player_id = ANY(v_keep_player))
        OR (guest_player_id IS NOT NULL AND guest_player_id = ANY(v_keep_guest))
      )
    FOR UPDATE
  LOOP
    UPDATE public.slot_priority_claims
      SET status = 'declined', responded_at = now(), decline_reason = 'captain_removed'
      WHERE id = rec.id;
    v_declined := v_declined + 1;
  END LOOP;

  -- 2) Book kept members' PENDING claims, capacity-guarded per slot (reuse the lock key).
  FOR rec IN
    SELECT spc.id, spc.slot_id, spc.player_id, spc.guest_player_id, av.max_participants
    FROM public.slot_priority_claims spc
    JOIN public.availability_slots av ON av.id = spc.slot_id
    WHERE spc.rebook_group_id = v_group AND spc.status = 'pending'
      AND (
        (spc.player_id IS NOT NULL AND spc.player_id = ANY(v_keep_player))
        OR (spc.guest_player_id IS NOT NULL AND spc.guest_player_id = ANY(v_keep_guest))
      )
    ORDER BY av.start_time
    FOR UPDATE OF spc
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(rec.slot_id::text, 0));
    v_is_own := (rec.player_id IS NOT DISTINCT FROM v_cap_player
                 AND rec.guest_player_id IS NOT DISTINCT FROM v_cap_guest);

    -- If this member already holds an ACTIVE booking on the slot — matched to the M-17
    -- unique-active-booking index set ('pending'/'confirmed'/'completed') — never INSERT a
    -- duplicate (it would raise 23505 and abort the whole group). Just mark their claim
    -- claimed against the existing booking + keep it in the group's booking set.
    SELECT id INTO v_existing_booking FROM public.bookings
      WHERE slot_id = rec.slot_id
        AND player_id IS NOT DISTINCT FROM rec.player_id
        AND guest_player_id IS NOT DISTINCT FROM rec.guest_player_id
        AND status IN ('pending', 'confirmed', 'completed')
      LIMIT 1;
    IF v_existing_booking IS NOT NULL THEN
      UPDATE public.slot_priority_claims
        SET status = 'claimed', responded_at = now(), booking_id = v_existing_booking,
            booked_by_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_player END,
            booked_by_guest_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_guest END
        WHERE id = rec.id;
      v_booking_ids := array_append(v_booking_ids, v_existing_booking);
      v_skipped_existing := v_skipped_existing + 1;
      CONTINUE;
    END IF;

    -- Capacity: count only seats actually occupied (the canonical occupying set).
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id AND (status IN ('confirmed', 'pending', 'pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
    IF v_seats >= COALESCE(rec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, created_at, updated_at)
    VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'pending', now(), now())
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id,
          booked_by_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_player END,
          booked_by_guest_player_id = CASE WHEN v_is_own THEN NULL ELSE v_cap_guest END
      WHERE id = rec.id;
    v_booking_ids := array_append(v_booking_ids, v_booking_id);
    v_booked := v_booked + 1;
  END LOOP;

  -- 3) Add new guests: one claim + booking per distinct slot in the group, capacity-guarded.
  --    Skip a slot for a guest who already has a claim there (treated by the keep/remove logic).
  IF array_length(_new_guest_ids, 1) IS NOT NULL THEN
    FOREACH gid IN ARRAY _new_guest_ids LOOP
      IF gid IS NULL THEN CONTINUE; END IF;
      FOR slotrec IN
        SELECT DISTINCT spc.slot_id, av.max_participants
        FROM public.slot_priority_claims spc
        JOIN public.availability_slots av ON av.id = spc.slot_id
        WHERE spc.rebook_group_id = v_group
        ORDER BY 1
      LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended(slotrec.slot_id::text, 0));
        -- Already a member (claim) OR already actively booked on this slot → don't duplicate.
        -- The active-booking check matches the M-17 unique index set, preventing 23505.
        IF EXISTS (SELECT 1 FROM public.slot_priority_claims
                   WHERE slot_id = slotrec.slot_id AND guest_player_id = gid)
           OR EXISTS (SELECT 1 FROM public.bookings
                   WHERE slot_id = slotrec.slot_id AND guest_player_id = gid
                     AND status IN ('pending', 'confirmed', 'completed')) THEN
          CONTINUE;
        END IF;
        SELECT count(*) INTO v_seats FROM public.bookings
          WHERE slot_id = slotrec.slot_id AND (status IN ('confirmed', 'pending', 'pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
        IF v_seats >= COALESCE(slotrec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

        INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, created_at, updated_at)
        VALUES (slotrec.slot_id, gid, 'confirmed', 'pending', now(), now())
        RETURNING id INTO v_booking_id;

        INSERT INTO public.slot_priority_claims
          (slot_id, guest_player_id, rebook_group_id, status, responded_at, booking_id,
           booked_by_player_id, booked_by_guest_player_id)
        VALUES (slotrec.slot_id, gid, v_group, 'claimed', now(), v_booking_id, v_cap_player, v_cap_guest);

        v_booking_ids := array_append(v_booking_ids, v_booking_id);
        v_booked := v_booked + 1;
        v_added := v_added + 1;
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'ok', (v_booked > 0 OR v_skipped_existing > 0),
    'group', true,
    'rebook_group_id', v_group,
    'booked', v_booked,
    'declined', v_declined,
    'added', v_added,
    'skipped_existing', v_skipped_existing,
    'skipped_full', v_skipped_full,
    'booking_ids', to_jsonb(v_booking_ids)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebook_group_apply(text, jsonb, uuid[]) TO anon, authenticated;
