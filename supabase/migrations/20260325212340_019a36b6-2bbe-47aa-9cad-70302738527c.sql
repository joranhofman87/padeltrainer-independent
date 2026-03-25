-- Trigger function: auto-follow trainer when a booking is created
CREATE OR REPLACE FUNCTION public.auto_follow_trainer_on_booking()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_trainer_id uuid;
BEGIN
  IF NEW.player_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT trainer_id INTO v_trainer_id
  FROM availability_slots
  WHERE id = NEW.slot_id;

  IF v_trainer_id IS NOT NULL THEN
    INSERT INTO trainer_followers (player_id, trainer_id, notify_new_availability)
    VALUES (NEW.player_id, v_trainer_id, true)
    ON CONFLICT (player_id, trainer_id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_auto_follow_trainer_on_booking
  AFTER INSERT ON public.bookings
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_follow_trainer_on_booking();

-- Backfill: auto-follow for all existing bookings
INSERT INTO trainer_followers (player_id, trainer_id, notify_new_availability)
SELECT DISTINCT b.player_id, s.trainer_id, true
FROM bookings b
JOIN availability_slots s ON s.id = b.slot_id
WHERE b.player_id IS NOT NULL
  AND s.trainer_id IS NOT NULL
ON CONFLICT (player_id, trainer_id) DO NOTHING;