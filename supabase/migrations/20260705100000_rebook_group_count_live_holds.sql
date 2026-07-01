-- F5 (Codex audit): rebook-group capacity must count LIVE payment_pending holds.
--
-- rebook_group_apply + rebook_group_manage counted occupancy as
--   status IN ('confirmed','pending','pending_approval')
-- but ignored a still-live payment_pending TTL hold — the seat a public pay-first booker holds
-- mid-Mollie-checkout. The pay-first RPCs (book_slot_for_payment / book_guest_slot_for_payment)
-- DO count that hold. So the two mutation paths that can insert into the same slot used different
-- definitions of "occupied", leaving a latent overbook if a rebook and a public hold ever touch
-- the same slot concurrently (reachable once the public booking widget lets these slots be booked
-- on the same timeline as rebooking). This aligns both rebook-group RPCs with the pay-first
-- predicate: occupied = active booking OR a live (non-expired) payment_pending hold.
--
-- Re-defines both RPCs BYTE-IDENTICAL to 20260626100000 / 20260626110000 except the capacity
-- count predicate (4 sites total). No behaviour change today; a hold-aware occupancy check only.

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

CREATE OR REPLACE FUNCTION public.rebook_group_manage(
  _token text,
  _keep_keys jsonb DEFAULT '[]'::jsonb,
  _new_guest_ids uuid[] DEFAULT '{}'::uuid[],
  _invoice_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  v_group uuid;
  v_cap_player uuid;
  v_cap_guest uuid;
  v_cap_paid boolean;
  v_keep_player uuid[] := '{}';
  v_keep_guest uuid[] := '{}';
  v_seats integer;
  v_booking_id uuid;
  v_booked integer := 0;
  v_declined integer := 0;
  v_added integer := 0;
  v_skipped_full integer := 0;
  v_skipped_existing integer := 0;
  v_new_ids uuid[] := '{}';
  k text;
  rec record;
  gid uuid;
  slotrec record;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token FOR UPDATE;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_group');
  END IF;

  -- Gate: the captain must have already PAID (claim 'claimed' + a paid booking). This path
  -- never charges — it only assigns covered seats — so it must not run before payment.
  SELECT EXISTS (SELECT 1 FROM public.bookings b WHERE b.id = c.booking_id AND b.payment_status = 'paid')
    INTO v_cap_paid;
  IF c.status <> 'claimed' OR NOT v_cap_paid THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_paid');
  END IF;

  v_group := c.rebook_group_id;
  v_cap_player := c.player_id;
  v_cap_guest := c.guest_player_id;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_group::text, 1));

  FOR k IN SELECT jsonb_array_elements_text(_keep_keys) LOOP
    IF k LIKE 'p:%' THEN v_keep_player := array_append(v_keep_player, substring(k from 3)::uuid);
    ELSIF k LIKE 'g:%' THEN v_keep_guest := array_append(v_keep_guest, substring(k from 3)::uuid);
    END IF;
  END LOOP;
  IF v_cap_player IS NOT NULL THEN v_keep_player := array_append(v_keep_player, v_cap_player); END IF;
  IF v_cap_guest IS NOT NULL THEN v_keep_guest := array_append(v_keep_guest, v_cap_guest); END IF;

  -- 1) Decline removed members' PENDING claims (never touch a booked/paid seat).
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

  -- 2) Book kept members' PENDING claims as COVERED (paid by the captain), capacity-guarded.
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
    -- Already actively booked (M-17 index set) → don't duplicate; just claim it.
    IF EXISTS (SELECT 1 FROM public.bookings WHERE slot_id = rec.slot_id
                 AND player_id IS NOT DISTINCT FROM rec.player_id
                 AND guest_player_id IS NOT DISTINCT FROM rec.guest_player_id
                 AND status IN ('pending','confirmed','completed')) THEN
      UPDATE public.slot_priority_claims SET status = 'claimed', responded_at = now(),
        booked_by_player_id = v_cap_player, booked_by_guest_player_id = v_cap_guest
        WHERE id = rec.id;
      v_skipped_existing := v_skipped_existing + 1;
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id AND (status IN ('confirmed','pending','pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
    IF v_seats >= COALESCE(rec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

    INSERT INTO public.bookings (slot_id, player_id, guest_player_id, status, payment_status, paid_at,
                                 paid_by_player_id, paid_by_guest_player_id, created_at, updated_at)
    VALUES (rec.slot_id, rec.player_id, rec.guest_player_id, 'confirmed', 'paid', now(),
            v_cap_player, v_cap_guest, now(), now())
    RETURNING id INTO v_booking_id;

    UPDATE public.slot_priority_claims
      SET status = 'claimed', responded_at = now(), booking_id = v_booking_id,
          booked_by_player_id = v_cap_player, booked_by_guest_player_id = v_cap_guest
      WHERE id = rec.id;
    v_new_ids := array_append(v_new_ids, v_booking_id);
    v_booked := v_booked + 1;
  END LOOP;

  -- 3) Add new guests as COVERED bookings, one per slot, capacity-guarded.
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
        IF EXISTS (SELECT 1 FROM public.slot_priority_claims
                     WHERE slot_id = slotrec.slot_id AND guest_player_id = gid)
           OR EXISTS (SELECT 1 FROM public.bookings WHERE slot_id = slotrec.slot_id
                        AND guest_player_id = gid AND status IN ('pending','confirmed','completed')) THEN
          CONTINUE;
        END IF;
        SELECT count(*) INTO v_seats FROM public.bookings
          WHERE slot_id = slotrec.slot_id AND (status IN ('confirmed','pending','pending_approval') OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now()));
        IF v_seats >= COALESCE(slotrec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

        INSERT INTO public.bookings (slot_id, guest_player_id, status, payment_status, paid_at,
                                     paid_by_player_id, paid_by_guest_player_id, created_at, updated_at)
        VALUES (slotrec.slot_id, gid, 'confirmed', 'paid', now(), v_cap_player, v_cap_guest, now(), now())
        RETURNING id INTO v_booking_id;

        INSERT INTO public.slot_priority_claims
          (slot_id, guest_player_id, rebook_group_id, status, responded_at, booking_id,
           booked_by_player_id, booked_by_guest_player_id)
        VALUES (slotrec.slot_id, gid, v_group, 'claimed', now(), v_booking_id, v_cap_player, v_cap_guest);

        v_new_ids := array_append(v_new_ids, v_booking_id);
        v_booked := v_booked + 1;
        v_added := v_added + 1;
      END LOOP;
    END LOOP;
  END IF;

  -- 4) Link the newly-covered bookings onto the captain's already-paid group invoice (record
  --    only — the amount is the fixed court price and does not change with the roster).
  IF _invoice_id IS NOT NULL AND array_length(v_new_ids, 1) IS NOT NULL THEN
    UPDATE public.invoices
      SET booking_ids = (
        SELECT array(SELECT DISTINCT unnest(COALESCE(booking_ids, '{}'::uuid[]) || v_new_ids))
      )
      WHERE id = _invoice_id AND status = 'paid';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'group', true,
    'rebook_group_id', v_group,
    'booked', v_booked,
    'declined', v_declined,
    'added', v_added,
    'skipped_full', v_skipped_full,
    'skipped_existing', v_skipped_existing,
    'booking_ids', to_jsonb(v_new_ids)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebook_group_manage(text, jsonb, uuid[], uuid) TO anon, authenticated;
