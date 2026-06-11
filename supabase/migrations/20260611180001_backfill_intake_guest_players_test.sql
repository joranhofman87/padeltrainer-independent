-- Assert: every actionable trainer/academy intake (named applicant) is linked
-- to a guest player after the backfill. Trivially passes on the empty CI
-- database; hard production invariant during db push.
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.intake_requests i
  JOIN public.cycles c ON c.id = i.cycle_id
  WHERE i.guest_player_id IS NULL
    AND c.owner_type IN ('trainer','academy')
    AND btrim(coalesce(i.full_name,'')) <> '';

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'backfill_intake_guest_players left % unlinked intakes', v_remaining;
  END IF;
END $$;
