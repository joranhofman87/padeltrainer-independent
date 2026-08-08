-- U1b ROLLBACK (data) — remove ONLY the membership rows one run inserted.
--
-- Usage:  SET u1b.run_id = '00000000-0000-0000-0000-000000000000';
--         \i scripts/rollout/u1b/sql/rollback_u1b_backfill_rows.sql
--
-- The run id arrives as a session GUC rather than a psql variable so that this file is executable
-- VERBATIM by any client — the rehearsal runs these exact bytes. A script whose real form only exists
-- after the harness rewrites it is a script nothing has actually tested.
--
-- THE RULE THIS ENCODES. `academy_player_memberships` may hold rows from several sources: this run,
-- an earlier run, or a later unit that writes memberships directly. So a rollback may never clear the
-- table and may never delete "everything that looks like it came from a backfill". It deletes exactly
-- the rows whose manifest line says outcome = 'inserted' FOR THIS RUN — the only rows this run
-- created and therefore the only rows it owns.
--
-- Lines recorded as 'already_present' are deliberately skipped: the pair was in the plan, but some
-- other writer put the row there, and deleting it would destroy evidence this run never created.
--
-- `TRUNCATE` appears nowhere on purpose.
--
-- The manifest lines themselves are RETAINED after the delete, with the run marked 'aborted'. The
-- logbook's value is that it records what happened, including what was undone; erasing the lines
-- would leave no trace that the rows had ever existed.

DO $$
DECLARE
  v_raw text := current_setting('u1b.run_id', true);
  v_run_id uuid;
  v_status text;
  v_owned bigint;
  v_deleted bigint;
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN
    RAISE EXCEPTION
      'Set the run first:  SET u1b.run_id = ''<uuid>'';  — refusing to guess which rows to delete.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_run_id := v_raw::uuid;

  SELECT status INTO v_status
  FROM public.membership_backfill_runs WHERE id = v_run_id
  FOR UPDATE;                       -- serialize against a concurrent applier resuming this run

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No backfill run % — refusing to guess which rows to delete.', v_run_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Lock the membership table before counting, and hold it through the DELETE: without this a
  -- concurrent resume of the same run could insert more owned rows between the count and the delete,
  -- so the reported number would understate what was removed.
  LOCK TABLE public.academy_player_memberships IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO v_owned
  FROM public.membership_backfill_items
  WHERE run_id = v_run_id AND outcome = 'inserted';

  WITH owned AS (
    SELECT membership_id
    FROM public.membership_backfill_items
    WHERE run_id = v_run_id AND outcome = 'inserted' AND membership_id IS NOT NULL
  )
  DELETE FROM public.academy_player_memberships m
  USING owned o
  WHERE m.id = o.membership_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- The run is terminal now: its rows are gone, so resuming it would re-insert them under a plan that
  -- may no longer describe the data. 'aborted' is what makes the applier refuse to continue it.
  UPDATE public.membership_backfill_runs
  SET status = 'aborted', completed_at = COALESCE(completed_at, now())
  WHERE id = v_run_id;

  -- v_deleted may be LESS than v_owned when a membership row was already removed by some other path
  -- (an academy deletion cascade, for instance). That is reported, not treated as failure: the
  -- post-condition this script guarantees is "none of this run's inserted rows remain", and a row
  -- someone else already deleted satisfies it.
  RAISE NOTICE 'U1b data rollback for run %: % owned row(s) recorded, % deleted, manifest retained, run marked aborted.',
    v_run_id, v_owned, v_deleted;
END $$;

-- Post-conditions a rehearsal asserts:
--   * no academy_player_memberships row remains whose id appears as an 'inserted' item of this run
--   * rows recorded 'already_present' for this run are STILL present
--   * membership_backfill_items rows for this run are still present (the log is retained)
--   * the run's status is 'aborted'
