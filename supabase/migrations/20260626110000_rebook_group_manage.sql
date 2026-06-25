-- Group-captain rebooking, Phase 3 (UPFRONT pay-first): after the captain has PAID the fixed
-- group/court price (one Mollie checkout over their own bookings via create-group-rebook-invoice),
-- they assign/change the roster. Those members are COVERED by the captain's payment, so their
-- bookings are created already-paid (payment_status='paid') + stamped paid_by_* = the captain,
-- and linked onto the captain's group invoice. This is a SEPARATE path from rebook_group_apply
-- (the deferred, roster-first, billed-per-player flow) because here the captain's own claim is
-- already 'claimed'+paid, not 'pending'.

-- (0) paid_by markers: who actually paid for a booking (the captain), for "who paid for whom"
--     + refunds. NULL = self-paid / the usual per-player path.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS paid_by_player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS paid_by_guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bookings.paid_by_player_id IS
  'When set, this booking was paid FOR by another group member (the captain) — group upfront payment. NULL = self/normal.';

-- (1) get_rebook_group_by_token — add can_manage_group (the captain has paid and may now
--     assign/change the roster, even though their own claim is already 'claimed').
CREATE OR REPLACE FUNCTION public.get_rebook_group_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_self_key text;
  v_members jsonb;
  v_paid boolean;
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  v_self_key := CASE WHEN c.player_id IS NOT NULL THEN 'p:' || c.player_id::text
                     ELSE 'g:' || c.guest_player_id::text END;

  -- Has the captain already paid for their group seat? (drives can_manage_group)
  SELECT EXISTS (
    SELECT 1 FROM public.bookings b
    WHERE b.id = c.booking_id AND b.payment_status = 'paid'
  ) INTO v_paid;

  SELECT jsonb_agg(m ORDER BY m->>'first_name')
  INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'key', CASE WHEN g.player_id IS NOT NULL THEN 'p:' || g.player_id::text
                  ELSE 'g:' || g.guest_player_id::text END,
      'first_name', COALESCE(NULLIF(p.first_name, ''), NULLIF(split_part(p.full_name, ' ', 1), ''),
                             NULLIF(gp.first_name, ''), NULLIF(split_part(gp.full_name, ' ', 1), ''), '—'),
      'status', CASE WHEN bool_or(g.status = 'claimed') THEN 'claimed'
                     WHEN bool_or(g.status = 'pending') THEN 'pending'
                     ELSE 'declined' END,
      'is_self', (CASE WHEN g.player_id IS NOT NULL THEN 'p:' || g.player_id::text
                       ELSE 'g:' || g.guest_player_id::text END) = v_self_key,
      'has_email', COALESCE(NULLIF(p.email, '') IS NOT NULL OR NULLIF(gp.email, '') IS NOT NULL, false)
    ) AS m
    FROM public.slot_priority_claims g
    LEFT JOIN public.profiles p ON p.id = g.player_id
    LEFT JOIN public.guest_players gp ON gp.id = g.guest_player_id
    WHERE g.rebook_group_id = c.rebook_group_id
    GROUP BY g.player_id, g.guest_player_id, p.first_name, p.full_name, p.email, gp.first_name, gp.full_name, gp.email
  ) sub;

  RETURN jsonb_build_object(
    'rebook_group_id', c.rebook_group_id,
    'can_rebook_group', (c.status = 'pending'
      AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())),
    -- The captain paid up front → may keep managing the roster even though their claim is 'claimed'.
    'can_manage_group', (c.status = 'claimed' AND v_paid),
    'self_key', v_self_key,
    'slot', jsonb_build_object(
      'id', s.id, 'start_time', s.start_time, 'end_time', s.end_time,
      'cyclus_id', s.cyclus_id, 'cyclus_name', s.cyclus_name,
      'price_per_session', s.price_per_session, 'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id, 'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*) FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    'members', COALESCE(v_members, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_rebook_group_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rebook_group_by_token(text) TO anon, authenticated;

-- (2) rebook_group_manage — post-payment roster management. The captain (claim already
--     'claimed'+paid) keeps/removes/adds members; booked members are marked PAID (covered by
--     the captain's group payment) + paid_by the captain, and linked onto the group invoice.
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
      WHERE slot_id = rec.slot_id AND status IN ('confirmed','pending','pending_approval');
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
          WHERE slot_id = slotrec.slot_id AND status IN ('confirmed','pending','pending_approval');
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
