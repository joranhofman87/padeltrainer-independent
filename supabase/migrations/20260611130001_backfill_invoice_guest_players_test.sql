-- Assert: no actionable unlinked invoices remain after the backfill.
-- Trivially passes on the empty CI database (supabase db reset);
-- acts as a hard production invariant during db push.
DO $$
DECLARE
  v_remaining integer;
BEGIN
  SELECT count(*) INTO v_remaining
  FROM public.invoices i
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND (i.academy_profile_id IS NOT NULL OR i.trainer_id IS NOT NULL);

  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'backfill_invoice_guest_players left % unlinked invoices', v_remaining;
  END IF;
END $$;
