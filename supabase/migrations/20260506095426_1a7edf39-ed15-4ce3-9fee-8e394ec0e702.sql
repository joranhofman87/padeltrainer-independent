-- Tiered rebooking: add member window + public release control to slots
ALTER TABLE public.availability_slots
  ADD COLUMN IF NOT EXISTS member_window_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS member_window_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_release_status text NOT NULL DEFAULT 'auto_release_scheduled',
  ADD COLUMN IF NOT EXISTS source_cycle_id uuid;

-- Validate allowed values via trigger (CHECK could break restores)
CREATE OR REPLACE FUNCTION public.validate_public_release_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.public_release_status NOT IN ('pending_admin_review','auto_release_scheduled','released','held') THEN
    RAISE EXCEPTION 'Invalid public_release_status: %', NEW.public_release_status;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_public_release_status_trg ON public.availability_slots;
CREATE TRIGGER validate_public_release_status_trg
BEFORE INSERT OR UPDATE OF public_release_status ON public.availability_slots
FOR EACH ROW EXECUTE FUNCTION public.validate_public_release_status();

CREATE INDEX IF NOT EXISTS idx_availability_slots_source_cycle ON public.availability_slots(source_cycle_id);
CREATE INDEX IF NOT EXISTS idx_availability_slots_member_window ON public.availability_slots(member_window_ends_at) WHERE member_window_ends_at IS NOT NULL;

-- RPC: check if a user is a "member" of a source cycle (had a non-cancelled booking)
CREATE OR REPLACE FUNCTION public.is_cycle_member(_user_id uuid, _cycle_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM bookings b
    JOIN availability_slots s ON s.id = b.slot_id
    JOIN profiles p ON p.id = b.player_id
    WHERE p.user_id = _user_id
      AND s.cyclus_id = _cycle_id
      AND COALESCE(b.status, 'confirmed') NOT IN ('cancelled','cancelled_swap')
  );
$$;

-- RPC: atomic member booking swap
CREATE OR REPLACE FUNCTION public.swap_member_booking(_old_booking_id uuid, _new_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_booking bookings;
  v_new_slot availability_slots;
  v_user_profile_id uuid;
  v_new_booking_id uuid;
BEGIN
  -- Resolve caller profile
  SELECT id INTO v_user_profile_id FROM profiles WHERE user_id = auth.uid() LIMIT 1;
  IF v_user_profile_id IS NULL THEN
    RAISE EXCEPTION 'No profile for caller';
  END IF;

  SELECT * INTO v_old_booking FROM bookings WHERE id = _old_booking_id FOR UPDATE;
  IF v_old_booking.id IS NULL OR v_old_booking.player_id IS DISTINCT FROM v_user_profile_id THEN
    RAISE EXCEPTION 'Booking not found or not yours';
  END IF;

  SELECT * INTO v_new_slot FROM availability_slots WHERE id = _new_slot_id FOR UPDATE;
  IF v_new_slot.id IS NULL THEN
    RAISE EXCEPTION 'Slot not found';
  END IF;

  -- Capacity check
  IF (SELECT COUNT(*) FROM bookings WHERE slot_id = _new_slot_id AND COALESCE(status,'confirmed') NOT IN ('cancelled','cancelled_swap')) >= COALESCE(v_new_slot.max_participants, 1) THEN
    RAISE EXCEPTION 'Slot is full';
  END IF;

  UPDATE bookings SET status = 'cancelled_swap', updated_at = now() WHERE id = _old_booking_id;

  INSERT INTO bookings (slot_id, player_id, status, created_at, updated_at)
  VALUES (_new_slot_id, v_user_profile_id, 'confirmed', now(), now())
  RETURNING id INTO v_new_booking_id;

  RETURN jsonb_build_object('ok', true, 'new_booking_id', v_new_booking_id);
END;
$$;
