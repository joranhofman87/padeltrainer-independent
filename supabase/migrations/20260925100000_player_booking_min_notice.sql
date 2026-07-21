-- Player self-booking minimum notice ("booking cutoff").
--
-- Some academies and trainers need to stop players booking too close to the start — e.g. no
-- self-bookings inside 48 hours — while staff can still add someone last minute.
--
-- RULE
--   effective cutoff = max(academy setting, trainer setting), NULLs treated as 0.
--   Default 0 everywhere, so behaviour is unchanged until somebody sets one.
--   The strictest wins: a trainer can TIGHTEN their academy's rule, never loosen it.
--   Applies to PLAYER/PUBLIC SELF-booking only. Staff booking on someone's behalf is exempt.
--
-- WHERE IT IS ENFORCED — deliberately NOT a new trigger.
--   public.can_book_slot(slot, user) is already the single source of truth for "may this player
--   self-book this slot", and it already has three callers covering every registered-player
--   route into public.bookings:
--     * trg_enforce_booking_slot_tier — the authenticated player self-insert path. It ALREADY
--       isolates that case (`NEW.player_id <> caller's profile` returns early), which is
--       exactly the staff exemption we need; a second trigger would have to re-derive that
--       test and could drift from it.
--     * book_slot_for_payment — the service_role RPC, which calls can_book_slot itself
--       precisely because the trigger skips when auth.uid() IS NULL.
--     * create-mollie-payment — the edge pre-check, before a payment is minted.
--   So one new reason token reaches all three, and the cutoff is refused at BOOKING CREATION
--   rather than at payment completion.
--
--   GUESTS are the one gap: book_guest_*_for_payment take no user id, so they never call
--   can_book_slot. They carry the guard themselves (section 5), and that RPC boundary is the
--   ONLY place the guest cutoff is enforced. An edge pre-check was tried and removed: it
--   necessarily sat above the live-hold reuse branch, so a guest who began checkout outside
--   the cutoff was refused their own hold on returning from Mollie. Relocating it would have
--   meant the edge re-deciding "is there a live hold?", duplicating the RPC's own test — the
--   duplication that caused the bug. One boundary decides; the edge maps its refusal tokens.
--
-- TIME SOURCE is the database. availability_slots.start_time is timestamptz, so
-- `start_time - now()` is an absolute interval — no AT TIME ZONE, which would only introduce a
-- DST bug for a rule expressed as a duration rather than a wall clock. Browser time is
-- advisory: the UI hides late slots for usability, the DB decides.

-- ---------------------------------------------------------------------------
-- 1. The settings. 0 = no cutoff (current behaviour). Upper bound 7 days: beyond that a
--    "minimum notice" is really a different product (a registration deadline), and an
--    accidental extra zero would silently close a trainer's whole calendar.
ALTER TABLE public.academy_profiles
  ADD COLUMN IF NOT EXISTS player_booking_min_notice_minutes integer NOT NULL DEFAULT 0;
ALTER TABLE public.trainer_profiles
  ADD COLUMN IF NOT EXISTS player_booking_min_notice_minutes integer NOT NULL DEFAULT 0;

ALTER TABLE public.academy_profiles
  DROP CONSTRAINT IF EXISTS chk_academy_player_booking_min_notice;
ALTER TABLE public.academy_profiles
  ADD CONSTRAINT chk_academy_player_booking_min_notice
  CHECK (player_booking_min_notice_minutes >= 0 AND player_booking_min_notice_minutes <= 10080);

ALTER TABLE public.trainer_profiles
  DROP CONSTRAINT IF EXISTS chk_trainer_player_booking_min_notice;
ALTER TABLE public.trainer_profiles
  ADD CONSTRAINT chk_trainer_player_booking_min_notice
  CHECK (player_booking_min_notice_minutes >= 0 AND player_booking_min_notice_minutes <= 10080);

COMMENT ON COLUMN public.academy_profiles.player_booking_min_notice_minutes IS
  'Booking cutoff: players cannot self-book a session starting less than this many minutes from now. 0 = no cutoff. Staff booking on a player''s behalf is exempt. Combined with the trainer''s own setting by taking the STRICTER of the two.';
COMMENT ON COLUMN public.trainer_profiles.player_booking_min_notice_minutes IS
  'Booking cutoff: players cannot self-book a session starting less than this many minutes from now. 0 = no cutoff. Combined with the academy''s setting by taking the STRICTER of the two, so this can only tighten an academy rule, never loosen it.';

-- ---------------------------------------------------------------------------
-- 2. Effective cutoff for a slot: the STRICTER of the two tenants.
--
-- A slot always has a trainer_id and may have an academy_profile_id. greatest() over
-- coalesce(...,0) means an absent academy contributes nothing rather than NULLing the result —
-- an independent trainer's slot therefore uses the trainer's own setting.
CREATE OR REPLACE FUNCTION public.get_slot_player_booking_min_notice_minutes(p_slot_id uuid)
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT greatest(
           coalesce(ap.player_booking_min_notice_minutes, 0),
           coalesce(tp.player_booking_min_notice_minutes, 0)
         )
  FROM public.availability_slots s
  LEFT JOIN public.academy_profiles ap ON ap.id = s.academy_profile_id
  LEFT JOIN public.trainer_profiles tp ON tp.id = s.trainer_id
  WHERE s.id = p_slot_id;
$$;
COMMENT ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) IS
  'Booking cutoff in minutes for a slot: the STRICTER of the academy and trainer settings, NULLs treated as 0. NULL when the slot does not exist — callers coalesce. INTERNAL.';

-- ---------------------------------------------------------------------------
-- 3. Is this slot inside its cutoff right now?
--
-- FALSE when the effective cutoff is 0, which is why the default preserves today's behaviour
-- exactly: with no setting, this can never block anything.
CREATE OR REPLACE FUNCTION public.is_slot_within_player_booking_cutoff(p_slot_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.availability_slots s
    CROSS JOIN LATERAL (
      SELECT coalesce(public.get_slot_player_booking_min_notice_minutes(s.id), 0) AS mins
    ) n
    WHERE s.id = p_slot_id
      AND n.mins > 0
      AND s.start_time - now() < make_interval(mins => n.mins)
  );
$$;
COMMENT ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) IS
  'TRUE when a slot is inside its player booking cutoff and may no longer be SELF-booked. Uses the database clock, never client time. FALSE when the cutoff is 0. INTERNAL — staff paths must not consult it, they are exempt.';

-- LOCKDOWN. This project runs ALTER DEFAULT PRIVILEGES granting EXECUTE on new functions to
-- anon and authenticated, and a bare REVOKE FROM PUBLIC does NOT undo that (see
-- 20260715110000_restrict_slot_tier_helper_grants.sql, which was written after exactly this
-- leaked to an anon key). Both helpers answer questions about arbitrary slots, so they are
-- named-role revoked and service_role only — matching can_book_slot / resolve_slot_booking_tier.
REVOKE ALL ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_slot_player_booking_min_notice_minutes(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_slot_within_player_booking_cutoff(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. The gate itself: one more reason token on can_book_slot.
--
-- Placed LAST, after the tier checks, so visibility still wins: a hidden slot reports
-- 'slot_not_released' rather than leaking that it exists but is merely too late. The cutoff is
-- an additional rule applied after visibility and capacity, not a replacement for either.
--
-- Body is otherwise byte-for-byte the deployed 20260715100000 definition; the signature is
-- unchanged, so no generated-types drift.
CREATE OR REPLACE FUNCTION public.can_book_slot(_slot_id uuid, _user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier    text := public.resolve_slot_booking_tier(_slot_id);
  v_profile uuid := public.get_profile_id_for_user(_user_id);
  v_src     uuid;
BEGIN
  IF v_tier = 'priority' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.slot_priority_claims
      WHERE slot_id = _slot_id
        AND player_id = v_profile
        AND status IN ('pending', 'claimed')
    ) THEN
      RETURN 'priority_restricted';
    END IF;

  ELSIF v_tier = 'members' THEN
    SELECT source_cycle_id INTO v_src FROM public.availability_slots WHERE id = _slot_id;
    IF NOT COALESCE(public.can_book_member_window(_user_id, v_src), false) THEN
      RETURN 'members_only';
    END IF;

  ELSIF v_tier = 'hidden' THEN
    RETURN 'slot_not_released';
  END IF;

  -- Booking cutoff, last: the player may be eligible for this tier and still be too late.
  IF public.is_slot_within_player_booking_cutoff(_slot_id) THEN
    RETURN 'booking_cutoff';
  END IF;

  RETURN '';  -- 'public', or eligible for the current tier
END;
$$;
COMMENT ON FUNCTION public.can_book_slot(uuid, uuid) IS
  'Whether _user_id may book _slot_id right now: '''' = allowed, else priority_restricted|members_only|slot_not_released|booking_cutoff. Tier is checked before the cutoff, so a hidden slot never reveals itself as merely late. service_role only (takes arbitrary _user_id).';

-- ---------------------------------------------------------------------------
-- 5. The cutoff at the GUEST MUTATION BOUNDARY.
--
-- These RPCs are the last thing before a booking row, and they take no user id so they never
-- reach can_book_slot. They are therefore the ONLY place the guest cutoff is enforced: an edge
-- pre-check was tried and removed, because it necessarily sat above the live-hold reuse branch
-- and refused guests finishing a checkout they had begun outside the cutoff. The edge functions
-- map the 'booking_cutoff' token instead, so the refusal still reads cleanly.
--
-- PLACEMENT MATTERS. The guard sits immediately before a NEW hold is created — after the
-- live-hold reuse branches, not at the top of the function. A guest who begins checkout OUTSIDE
-- the cutoff and returns from Mollie INSIDE it must still be able to finish: the rule gates
-- booking CREATION, not payment completion, and guarding at the top silently made it both.
--
-- Bodies are otherwise byte-for-byte their latest deployed definitions — generated by patching
-- that text rather than retyping — and the signatures and grants are unchanged.
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

  -- BOOKING CUTOFF — the HARD boundary for guests, who never reach can_book_slot (these RPCs
  -- take no user id). Placed HERE, immediately before a NEW hold is created, and deliberately
  -- NOT at the top of the function: above this point sits the live-hold reuse branch, and a
  -- guest who started checkout OUTSIDE the cutoff must still be able to return from Mollie and
  -- finish paying INSIDE it. The rule gates booking CREATION, not payment completion.
  IF public.is_slot_within_player_booking_cutoff(_slot_id) THEN
    RAISE EXCEPTION 'booking_cutoff' USING ERRCODE = 'check_violation';
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

CREATE OR REPLACE FUNCTION public.book_guest_cyclus_for_payment(
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
  v_hold_min  integer := GREATEST(5, LEAST(60, COALESCE(_hold_minutes, 20)));
  v_n         integer := array_length(_slot_ids, 1);
  v_sorted    uuid[];
  v_slot      uuid;
  v_idx       integer;
  v_max       integer;
  v_taken     integer;
  v_existing  uuid;
  v_live      uuid[];
  v_ids       uuid[] := ARRAY[]::uuid[];
  v_id        uuid;
  v_is_public boolean;
BEGIN
  IF v_n IS NULL OR v_n = 0 OR v_n <> array_length(_amounts, 1) THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- Lock every slot in a deterministic order to avoid deadlocks between two
  -- concurrent cyclus bookings that touch overlapping slots.
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

    -- Effective capacity (per-seat when split_payment OR allow_single_booking; else whole-slot = 1)
    -- + is_public in one read; refuse a non-public session.
    SELECT
      CASE WHEN COALESCE(split_payment, false) OR COALESCE(allow_single_booking, false)
           THEN COALESCE(max_participants, 1) ELSE 1 END,
      COALESCE(is_public, false)
      INTO v_max, v_is_public FROM public.availability_slots WHERE id = v_slot;
    IF NOT v_is_public THEN
      RAISE EXCEPTION 'slot_not_public' USING ERRCODE = 'check_violation';
    END IF;

    SELECT count(*) INTO v_taken
    FROM public.bookings
    WHERE slot_id = v_slot
      AND (
        COALESCE(status, 'confirmed') IN ('confirmed', 'pending', 'pending_approval')
        OR (status = 'payment_pending' AND hold_expires_at IS NOT NULL AND hold_expires_at > now())
      );
    IF v_taken >= COALESCE(v_max, 1) THEN
      RAISE EXCEPTION 'slot_full' USING ERRCODE = 'check_violation';
    END IF;

    -- BOOKING CUTOFF — see book_guest_slot_for_payment. Inside the loop, immediately before a
    -- NEW hold, so both reuse paths above (whole-purchase live hold, and this slot's existing
    -- hold) are reached first: finishing a checkout started outside the cutoff still works.
    -- Any slot needing a NEW hold inside its cutoff raises, and since this is one transaction
    -- the whole cycle/cart is refused — which is the intended all-or-nothing rule.
    IF public.is_slot_within_player_booking_cutoff(v_slot) THEN
      RAISE EXCEPTION 'booking_cutoff' USING ERRCODE = 'check_violation';
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
  v_whole_slot   boolean;
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
      COALESCE(whole_slot_booking, false),
      COALESCE(split_payment, false)
      INTO v_max, v_is_public, v_cyclus_id, v_allow_single, v_whole_slot, v_split
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
    IF v_cyclus_id IS NOT NULL AND NOT v_allow_single AND NOT v_whole_slot THEN
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

    -- BOOKING CUTOFF — see book_guest_slot_for_payment. Inside the loop, immediately before a
    -- NEW hold, so both reuse paths above (whole-purchase live hold, and this slot's existing
    -- hold) are reached first: finishing a checkout started outside the cutoff still works.
    -- Any slot needing a NEW hold inside its cutoff raises, and since this is one transaction
    -- the whole cycle/cart is refused — which is the intended all-or-nothing rule.
    IF public.is_slot_within_player_booking_cutoff(v_slot) THEN
      RAISE EXCEPTION 'booking_cutoff' USING ERRCODE = 'check_violation';
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

-- ---------------------------------------------------------------------------
-- 6. The PUBLIC, anon-safe read of the cutoff.
--
-- Both public surfaces need "is this slot past its cutoff?", and neither can read the settings
-- columns: `trainer_profiles` is not readable by anon (public reads go through
-- trainer_profiles_safe, which deliberately exposes a narrow column set), and academy settings
-- are not public either. Selecting the raw columns from a page therefore either 400s on a view
-- that lacks them or silently returns 0 for anonymous visitors — leaving too-late slots on sale.
--
-- So the cutoff is published the same way occupancy is: a SECURITY DEFINER function scoped to
-- PUBLIC slots, granted to anon, returning only the derived answer. The settings columns
-- themselves stay unreadable, which is the right exposure — a visitor needs to know that a slot
-- is closed, not what any tenant's policy is.
--
-- booking_closed is computed with the DATABASE clock, so the "advisory" client view now agrees
-- with the authority instead of approximating it from browser time.
CREATE OR REPLACE FUNCTION public.get_public_slot_booking_cutoff(_slot_ids uuid[])
RETURNS TABLE (slot_id uuid, cutoff_minutes int, booking_closed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT s.id AS slot_id,
         coalesce(public.get_slot_player_booking_min_notice_minutes(s.id), 0) AS cutoff_minutes,
         public.is_slot_within_player_booking_cutoff(s.id) AS booking_closed
  FROM public.availability_slots s
  WHERE s.id = ANY(_slot_ids)
    AND s.is_public = true;
$$;
COMMENT ON FUNCTION public.get_public_slot_booking_cutoff(uuid[]) IS
  'Notification-free public read: for PUBLIC slots only, the effective player booking cutoff and whether the slot is past it, using the database clock. Anon-safe by design — it exposes the derived answer, never the tenants'' settings. The single source both the booking page and the shared public calendars use.';
REVOKE ALL ON FUNCTION public.get_public_slot_booking_cutoff(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_slot_booking_cutoff(uuid[]) TO anon, authenticated, service_role;
