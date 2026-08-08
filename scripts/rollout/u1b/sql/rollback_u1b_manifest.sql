-- U1b ROLLBACK (schema) — remove the empty additive backfill logbook.
--
-- Forward rollback for `supabase/migrations/20261114100000_u1b_membership_backfill_manifest.sql`.
-- The logbook ships EMPTY and inert, so removing it is safe *while it is still empty*. Once a run has
-- written into it, dropping it destroys the record of which membership rows that run owns — which is
-- precisely what a later rollback needs in order to delete its rows and nothing else. Hence the
-- emptiness guard: this script REFUSES rather than deletes.
--
-- ORDER MATTERS. `membership_backfill_items` is dropped first because it references
-- `membership_backfill_runs`; dropping the parent first would need CASCADE, and CASCADE is exactly
-- the silent destruction this programme rules out. If some later slice added a dependency, the drop
-- must fail loudly so a human decides.
--
-- Both counts are taken under ACCESS EXCLUSIVE, held to the end of the block, so the guard cannot be
-- defeated by a concurrent INSERT landing between the count and the drop.
--
-- The seed deny-list entries in `supabase/seed.sql` need no change — they are existence-guarded
-- (`to_regclass`), so a reset after this rollback succeeds with the tables absent.
--
-- After running this: regenerate `src/integrations/supabase/types.ts` so the types-drift gate matches
-- the rolled-back schema.

DO $$
DECLARE
  v_runs bigint := 0;
  v_items bigint := 0;
  v_runs_present boolean := to_regclass('public.membership_backfill_runs') IS NOT NULL;
  v_items_present boolean := to_regclass('public.membership_backfill_items') IS NOT NULL;
BEGIN
  IF NOT v_runs_present AND NOT v_items_present THEN
    RAISE NOTICE 'U1b logbook is already absent — nothing to roll back.';
    RETURN;
  END IF;

  -- Lock both BEFORE counting either, and hold to the end of the block (a DO block is one
  -- transaction). Counting one table while the other is still writable would leave the same TOCTOU
  -- window the guard exists to close.
  IF v_items_present THEN
    LOCK TABLE public.membership_backfill_items IN ACCESS EXCLUSIVE MODE;
    EXECUTE 'SELECT count(*) FROM public.membership_backfill_items' INTO v_items;
  END IF;
  IF v_runs_present THEN
    LOCK TABLE public.membership_backfill_runs IN ACCESS EXCLUSIVE MODE;
    EXECUTE 'SELECT count(*) FROM public.membership_backfill_runs' INTO v_runs;
  END IF;

  IF v_runs <> 0 OR v_items <> 0 THEN
    RAISE EXCEPTION
      'REFUSING to roll back the U1b logbook: % run(s) and % item(s) recorded. Dropping it would destroy the record of which membership rows those runs own, leaving their rows unattributable and un-rollbackable. Roll the DATA back first (rollback_u1b_backfill_rows.sql), then retry.',
      v_runs, v_items
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_items_present THEN
    EXECUTE 'DROP TABLE public.membership_backfill_items';
  END IF;
  IF v_runs_present THEN
    EXECUTE 'DROP TABLE public.membership_backfill_runs';
  END IF;

  RAISE NOTICE 'U1b rolled back: backfill logbook dropped (was empty).';
END $$;

-- Post-conditions a rehearsal asserts:
--   * public.membership_backfill_items / _runs   → absent
--   * public.academy_player_memberships          → still present (U1a is a separate rollback)
--   * public.update_updated_at_column()          → still present (shared by other tables)
