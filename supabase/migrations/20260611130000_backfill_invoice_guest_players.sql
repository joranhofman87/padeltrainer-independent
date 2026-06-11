-- Backfill: create/link guest_players for historical invoices with no player link
-- (player_id IS NULL AND guest_player_id IS NULL) so recipients appear in the
-- academy/trainer players lists. Idempotent: re-run is a no-op.
--
-- Matching: lower(btrim(full_name)) = lower(btrim(player_name)) within the same
-- scope (academy_profile_id, or trainer_id when academy_profile_id IS NULL).
-- Existing-guest pick is deterministic (oldest by created_at, id).
-- New guests are emailless; the partial unique email indexes exclude NULL email,
-- and trg_link_guest_data_on_guest_player_change no-ops on NULL email inserts.
-- Business invoices (player_business_name set) are included: player_name is the
-- contact person, matching CreateCustomInvoiceDialog's going-forward behavior.

DO $$
DECLARE
  v_before integer;
  v_acad_linked_existing integer := 0;
  v_acad_guests_created  integer := 0;
  v_acad_linked_new      integer := 0;
  v_trainer_linked_existing integer := 0;
  v_trainer_guests_created  integer := 0;
  v_trainer_linked_new      integer := 0;
  v_after integer;
BEGIN
  SELECT count(*) INTO v_before
  FROM public.invoices i
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND (i.academy_profile_id IS NOT NULL OR i.trainer_id IS NOT NULL);
  RAISE NOTICE 'backfill_invoice_guest_players: % actionable unlinked invoices before', v_before;

  ------------------------------------------------------------------
  -- Pass 1: academy-scoped invoices (academy_profile_id IS NOT NULL)
  ------------------------------------------------------------------

  -- 1a. Link to existing academy guests by normalized name (oldest wins)
  UPDATE public.invoices i
  SET guest_player_id = g.id
  FROM (
    SELECT DISTINCT ON (gp.academy_profile_id, lower(btrim(gp.full_name)))
      gp.id, gp.academy_profile_id, lower(btrim(gp.full_name)) AS norm_name
    FROM public.guest_players gp
    WHERE gp.academy_profile_id IS NOT NULL
      AND btrim(coalesce(gp.full_name, '')) <> ''
    ORDER BY gp.academy_profile_id, lower(btrim(gp.full_name)), gp.created_at, gp.id
  ) g
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND i.academy_profile_id IS NOT NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND g.academy_profile_id = i.academy_profile_id
    AND g.norm_name = lower(btrim(i.player_name));
  GET DIAGNOSTICS v_acad_linked_existing = ROW_COUNT;

  -- 1b. Create one emailless academy guest per remaining (academy, normalized name).
  --     full_name from the earliest invoice in each group; first/last split
  --     replicated from 20260530180000 (first token / remainder).
  INSERT INTO public.guest_players (academy_profile_id, full_name, first_name, last_name)
  SELECT
    s.academy_profile_id,
    btrim(s.player_name),
    CASE
      WHEN position(' ' IN btrim(s.player_name)) = 0 THEN btrim(s.player_name)
      ELSE split_part(btrim(s.player_name), ' ', 1)
    END,
    CASE
      WHEN position(' ' IN btrim(s.player_name)) = 0 THEN NULL
      ELSE btrim(substring(btrim(s.player_name) FROM position(' ' IN btrim(s.player_name)) + 1))
    END
  FROM (
    SELECT DISTINCT ON (i.academy_profile_id, lower(btrim(i.player_name)))
      i.academy_profile_id, i.player_name
    FROM public.invoices i
    WHERE i.player_id IS NULL
      AND i.guest_player_id IS NULL
      AND i.academy_profile_id IS NOT NULL
      AND btrim(coalesce(i.player_name, '')) <> ''
    ORDER BY i.academy_profile_id, lower(btrim(i.player_name)), i.created_at, i.id
  ) s;
  GET DIAGNOSTICS v_acad_guests_created = ROW_COUNT;

  -- 1c. Link remaining academy invoices to the just-created guests (same as 1a)
  UPDATE public.invoices i
  SET guest_player_id = g.id
  FROM (
    SELECT DISTINCT ON (gp.academy_profile_id, lower(btrim(gp.full_name)))
      gp.id, gp.academy_profile_id, lower(btrim(gp.full_name)) AS norm_name
    FROM public.guest_players gp
    WHERE gp.academy_profile_id IS NOT NULL
      AND btrim(coalesce(gp.full_name, '')) <> ''
    ORDER BY gp.academy_profile_id, lower(btrim(gp.full_name)), gp.created_at, gp.id
  ) g
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND i.academy_profile_id IS NOT NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND g.academy_profile_id = i.academy_profile_id
    AND g.norm_name = lower(btrim(i.player_name));
  GET DIAGNOSTICS v_acad_linked_new = ROW_COUNT;

  RAISE NOTICE 'academy pass: linked_existing=%, guests_created=%, linked_new=%',
    v_acad_linked_existing, v_acad_guests_created, v_acad_linked_new;

  ------------------------------------------------------------------
  -- Pass 2: trainer-scoped invoices (academy_profile_id IS NULL, trainer_id set)
  ------------------------------------------------------------------

  -- 2a. Link to existing trainer guests by normalized name (oldest wins)
  UPDATE public.invoices i
  SET guest_player_id = g.id
  FROM (
    SELECT DISTINCT ON (gp.trainer_id, lower(btrim(gp.full_name)))
      gp.id, gp.trainer_id, lower(btrim(gp.full_name)) AS norm_name
    FROM public.guest_players gp
    WHERE gp.trainer_id IS NOT NULL
      AND btrim(coalesce(gp.full_name, '')) <> ''
    ORDER BY gp.trainer_id, lower(btrim(gp.full_name)), gp.created_at, gp.id
  ) g
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND i.academy_profile_id IS NULL
    AND i.trainer_id IS NOT NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND g.trainer_id = i.trainer_id
    AND g.norm_name = lower(btrim(i.player_name));
  GET DIAGNOSTICS v_trainer_linked_existing = ROW_COUNT;

  -- 2b. Create one emailless trainer guest per remaining (trainer, normalized name)
  INSERT INTO public.guest_players (trainer_id, full_name, first_name, last_name)
  SELECT
    s.trainer_id,
    btrim(s.player_name),
    CASE
      WHEN position(' ' IN btrim(s.player_name)) = 0 THEN btrim(s.player_name)
      ELSE split_part(btrim(s.player_name), ' ', 1)
    END,
    CASE
      WHEN position(' ' IN btrim(s.player_name)) = 0 THEN NULL
      ELSE btrim(substring(btrim(s.player_name) FROM position(' ' IN btrim(s.player_name)) + 1))
    END
  FROM (
    SELECT DISTINCT ON (i.trainer_id, lower(btrim(i.player_name)))
      i.trainer_id, i.player_name
    FROM public.invoices i
    WHERE i.player_id IS NULL
      AND i.guest_player_id IS NULL
      AND i.academy_profile_id IS NULL
      AND i.trainer_id IS NOT NULL
      AND btrim(coalesce(i.player_name, '')) <> ''
    ORDER BY i.trainer_id, lower(btrim(i.player_name)), i.created_at, i.id
  ) s;
  GET DIAGNOSTICS v_trainer_guests_created = ROW_COUNT;

  -- 2c. Link remaining trainer invoices to the just-created guests (same as 2a)
  UPDATE public.invoices i
  SET guest_player_id = g.id
  FROM (
    SELECT DISTINCT ON (gp.trainer_id, lower(btrim(gp.full_name)))
      gp.id, gp.trainer_id, lower(btrim(gp.full_name)) AS norm_name
    FROM public.guest_players gp
    WHERE gp.trainer_id IS NOT NULL
      AND btrim(coalesce(gp.full_name, '')) <> ''
    ORDER BY gp.trainer_id, lower(btrim(gp.full_name)), gp.created_at, gp.id
  ) g
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND i.academy_profile_id IS NULL
    AND i.trainer_id IS NOT NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND g.trainer_id = i.trainer_id
    AND g.norm_name = lower(btrim(i.player_name));
  GET DIAGNOSTICS v_trainer_linked_new = ROW_COUNT;

  RAISE NOTICE 'trainer pass: linked_existing=%, guests_created=%, linked_new=%',
    v_trainer_linked_existing, v_trainer_guests_created, v_trainer_linked_new;

  SELECT count(*) INTO v_after
  FROM public.invoices i
  WHERE i.player_id IS NULL
    AND i.guest_player_id IS NULL
    AND btrim(coalesce(i.player_name, '')) <> ''
    AND (i.academy_profile_id IS NOT NULL OR i.trainer_id IS NOT NULL);
  RAISE NOTICE 'backfill_invoice_guest_players: % actionable unlinked invoices after (was %)', v_after, v_before;
END $$;
