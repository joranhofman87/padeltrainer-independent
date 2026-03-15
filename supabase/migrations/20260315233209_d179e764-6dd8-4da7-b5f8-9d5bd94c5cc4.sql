
CREATE OR REPLACE FUNCTION public.swap_slots(
  _slot_a_id uuid,
  _slot_a_trainer_id uuid,
  _slot_a_start timestamptz,
  _slot_a_end timestamptz,
  _slot_b_id uuid,
  _slot_b_trainer_id uuid,
  _slot_b_start timestamptz,
  _slot_b_end timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Atomic swap: update both slots in one transaction
  UPDATE availability_slots
  SET trainer_id = _slot_a_trainer_id,
      start_time = _slot_a_start,
      end_time = _slot_a_end
  WHERE id = _slot_a_id;

  UPDATE availability_slots
  SET trainer_id = _slot_b_trainer_id,
      start_time = _slot_b_start,
      end_time = _slot_b_end
  WHERE id = _slot_b_id;
END;
$$;
