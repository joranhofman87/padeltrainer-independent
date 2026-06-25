-- Group-captain rebooking (RL Padel): let ONE group member re-book the WHOLE group from
-- their claim page — keep/remove existing members, add new ones, and (later) pay once for
-- all. This migration is the backend foundation:
--   (0) columns to record who a claim was booked BY (the captain) + confirmation idempotency
--   (1) get_priority_claim_by_token: also expose booked_by_captain_name (the "X re-booked
--       your group" state for the other members)
--   (2) get_rebook_group_by_token: PII-trimmed roster (first name + status only) for the editor
--   (3) create_rebook_group_guest: token-gated guest mint (the anon captain can't write
--       guest_players directly, so a SECURITY DEFINER helper scopes + dedups + inserts)
--   (4) rebook_group_apply: the atomic roster-diff + book-the-whole-group action, forked from
--       respond_to_priority_claim's capacity-locked accept path (same advisory-lock key).
--
-- Money-safety: every booking insert is per-slot advisory-locked + capacity-counted (reusing
-- hashtextextended(slot_id::text,0)); removed members only have their PENDING claims declined
-- (a claimed/booked seat is never silently cancelled); re-running is idempotent.

-- (0) Columns ---------------------------------------------------------------------------------
ALTER TABLE public.slot_priority_claims
  ADD COLUMN IF NOT EXISTS booked_by_player_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS booked_by_guest_player_id uuid REFERENCES public.guest_players(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS confirmation_sent_at timestamptz;

COMMENT ON COLUMN public.slot_priority_claims.booked_by_player_id IS
  'When set, this claim was booked by another group member (the captain, a registered player) on this member''s behalf. NULL = self-booked.';
COMMENT ON COLUMN public.slot_priority_claims.booked_by_guest_player_id IS
  'As booked_by_player_id, but when the captain is a guest player.';
COMMENT ON COLUMN public.slot_priority_claims.confirmation_sent_at IS
  'When the "you were re-booked by the captain" confirmation email was sent (idempotency guard).';

-- (1) get_priority_claim_by_token — add booked_by_captain_name --------------------------------
CREATE OR REPLACE FUNCTION public.get_priority_claim_by_token(_token text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
    'claim', jsonb_build_object(
      'id', c.id,
      'status', c.status,
      'claim_token', c.claim_token
    ),
    'slot', jsonb_build_object(
      'id', s.id,
      'start_time', s.start_time,
      'end_time', s.end_time,
      'cyclus_id', s.cyclus_id,
      'cyclus_name', s.cyclus_name,
      'location_id', s.location_id,
      'price_per_session', s.price_per_session,
      'total_price', s.total_price,
      'max_participants', s.max_participants,
      'priority_window_ends_at', s.priority_window_ends_at,
      'trainer_id', s.trainer_id,
      'academy_profile_id', s.academy_profile_id
    ),
    'sessions', GREATEST(1, (
      SELECT count(*)
      FROM public.slot_priority_claims c2
      WHERE c2.rebook_group_id = c.rebook_group_id
        AND c2.player_id IS NOT DISTINCT FROM c.player_id
        AND c2.guest_player_id IS NOT DISTINCT FROM c.guest_player_id
    )),
    'player_name', COALESCE(p.full_name, gp.full_name),
    -- First name of the group member ("captain") who re-booked this claim on the viewer's
    -- behalf, else NULL. Drives the "X already re-booked your group" read-only state.
    'booked_by_captain_name', CASE
      WHEN c.booked_by_player_id IS NOT NULL OR c.booked_by_guest_player_id IS NOT NULL
      THEN COALESCE(NULLIF(bp.first_name, ''), NULLIF(split_part(bp.full_name, ' ', 1), ''),
                    NULLIF(bgp.first_name, ''), NULLIF(split_part(bgp.full_name, ' ', 1), ''))
      ELSE NULL
    END
  )
  INTO result
  FROM public.slot_priority_claims c
  JOIN public.availability_slots s ON s.id = c.slot_id
  LEFT JOIN public.profiles p ON p.id = c.player_id
  LEFT JOIN public.guest_players gp ON gp.id = c.guest_player_id
  LEFT JOIN public.profiles bp ON bp.id = c.booked_by_player_id
  LEFT JOIN public.guest_players bgp ON bgp.id = c.booked_by_guest_player_id
  WHERE c.claim_token = _token
  LIMIT 1;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_priority_claim_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_priority_claim_by_token(text) TO anon, authenticated;

-- (2) get_rebook_group_by_token — PII-trimmed roster for the captain editor -------------------
-- Returns first name + collapsed status per distinct member of the token's rebook group,
-- keyed by an "p:<uuid>"/"g:<uuid>" member key the apply RPC parses back. No emails / last
-- names (the link is forwardable; mirror the existing get_priority_claim_by_token trim).
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
BEGIN
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN
    RETURN NULL; -- legacy single claim or bad token → no group UI
  END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;

  v_self_key := CASE WHEN c.player_id IS NOT NULL THEN 'p:' || c.player_id::text
                     ELSE 'g:' || c.guest_player_id::text END;

  SELECT jsonb_agg(m ORDER BY m->>'first_name')
  INTO v_members
  FROM (
    SELECT jsonb_build_object(
      'key', CASE WHEN g.player_id IS NOT NULL THEN 'p:' || g.player_id::text
                  ELSE 'g:' || g.guest_player_id::text END,
      'first_name', COALESCE(NULLIF(p.first_name, ''), NULLIF(split_part(p.full_name, ' ', 1), ''),
                             NULLIF(gp.first_name, ''), NULLIF(split_part(gp.full_name, ' ', 1), ''), '—'),
      -- strongest status across this member's weekly claims
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
    -- a member can drive the group only while their own claim is still actionable
    'can_rebook_group', (c.status = 'pending'
      AND (s.priority_window_ends_at IS NULL OR s.priority_window_ends_at > now())),
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

-- (3) create_rebook_group_guest — token-gated guest mint for a new group member --------------
-- The anon captain holds a valid group claim token but cannot write guest_players (RLS). This
-- SECURITY DEFINER helper validates the token, scopes the guest to the slot's academy/trainer,
-- dedups by email within that scope, and returns the guest_players.id to pass to rebook_group_apply.
CREATE OR REPLACE FUNCTION public.create_rebook_group_guest(
  _token text,
  _first_name text,
  _last_name text DEFAULT NULL,
  _email text DEFAULT NULL,
  _phone text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c public.slot_priority_claims;
  s public.availability_slots;
  v_email text := NULLIF(lower(trim(_email)), '');
  v_first text := NULLIF(trim(_first_name), '');
  v_last  text := NULLIF(trim(_last_name), '');
  v_full  text;
  v_id uuid;
BEGIN
  IF v_first IS NULL THEN RAISE EXCEPTION 'first_name_required'; END IF;
  SELECT * INTO c FROM public.slot_priority_claims WHERE claim_token = _token LIMIT 1;
  IF c.id IS NULL OR c.rebook_group_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;
  SELECT * INTO s FROM public.availability_slots WHERE id = c.slot_id;
  IF s.academy_profile_id IS NULL AND s.trainer_id IS NULL THEN RAISE EXCEPTION 'slot_unscoped'; END IF;

  v_full := btrim(concat_ws(' ', v_first, v_last));

  -- Dedup by email within the same owner scope (mirrors resolveOrCreateGuestPlayer's core).
  IF v_email IS NOT NULL THEN
    SELECT id INTO v_id FROM public.guest_players
    WHERE lower(email) = v_email
      AND ((s.academy_profile_id IS NOT NULL AND academy_profile_id = s.academy_profile_id)
        OR (s.academy_profile_id IS NULL AND trainer_id = s.trainer_id))
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  INSERT INTO public.guest_players (academy_profile_id, trainer_id, first_name, last_name, full_name, email, phone, source)
  VALUES (s.academy_profile_id, CASE WHEN s.academy_profile_id IS NULL THEN s.trainer_id ELSE NULL END,
          v_first, v_last, v_full, v_email, NULLIF(trim(_phone), ''), 'rebook_group')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_rebook_group_guest(text, text, text, text, text) TO anon, authenticated;

-- (4) rebook_group_apply — roster diff + book the whole group --------------------------------
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
  v_added integer := 0;
  v_is_own boolean;
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
    SELECT count(*) INTO v_seats FROM public.bookings
      WHERE slot_id = rec.slot_id AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
    IF v_seats >= COALESCE(rec.max_participants, 1) THEN v_skipped_full := v_skipped_full + 1; CONTINUE; END IF;

    v_is_own := (rec.player_id IS NOT DISTINCT FROM v_cap_player
                 AND rec.guest_player_id IS NOT DISTINCT FROM v_cap_guest);

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
        IF EXISTS (SELECT 1 FROM public.slot_priority_claims
                   WHERE slot_id = slotrec.slot_id AND guest_player_id = gid) THEN
          CONTINUE; -- already a member of this slot
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended(slotrec.slot_id::text, 0));
        SELECT count(*) INTO v_seats FROM public.bookings
          WHERE slot_id = slotrec.slot_id AND COALESCE(status, 'confirmed') NOT IN ('cancelled', 'cancelled_swap');
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
    'ok', v_booked > 0,
    'group', true,
    'rebook_group_id', v_group,
    'booked', v_booked,
    'declined', v_declined,
    'added', v_added,
    'skipped_full', v_skipped_full,
    'booking_ids', to_jsonb(v_booking_ids)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebook_group_apply(text, jsonb, uuid[]) TO anon, authenticated;
