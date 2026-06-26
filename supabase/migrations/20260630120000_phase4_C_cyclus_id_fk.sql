-- ============================================================================
-- PHASE 4 · ITEM C — Foreign key: availability_slots.cyclus_id -> cycles.id
-- ============================================================================
--
-- WHY
--   availability_slots.cyclus_id has only an INDEX, never a foreign key
--   (added column-only in 20260116203655). So a slot can point cyclus_id at a
--   cycles row that does not exist -> an "orphan slot group" the academy
--   overview renders as a cycle row, but clicking it opens a slot and the
--   end-date / cycle-scope editors cannot act on it. This is the concrete
--   mechanism behind "I clicked a cycle and it opened a slot" (audit DF6 /
--   Codex P0). The classifier src/lib/cyclusPricingRoute.ts and the backfill
--   20260612230000_rebook01_backfill_calendar_cycles.sql both exist *because*
--   of this missing constraint.
--
-- WHAT THIS MIGRATION DOES
--   Adds the FK as **NOT VALID**:
--     * NOT VALID skips the one-time scan of existing rows, so the migration
--       applies instantly and CANNOT fail even if orphan rows still exist. It
--       takes only a brief SHARE ROW EXCLUSIVE lock (no full-table rewrite).
--     * Even while NOT VALID, the constraint is fully enforced for every
--       INSERT and UPDATE from now on -> it is IMPOSSIBLE to create a NEW
--       orphan slot group. This closes the recurrence today.
--     * ON DELETE SET NULL: if a cycles row is ever deleted, its slots'
--       cyclus_id becomes NULL (they become standalone slots) instead of
--       silently re-orphaning. Matches the locked Phase-1 decision.
--   Pre-existing orphan rows are LEFT UNTOUCHED (non-destructive rule #8). They
--   are repaired + the constraint VALIDATEd as a separate, owner-paced step
--   (see "STEP 2" below) so the cleanup happens deliberately, not inside a
--   routine deploy.
--
-- IDEMPOTENT: guarded on pg_constraint; re-running is a no-op.
--
-- ----------------------------------------------------------------------------
-- STEP 1 (this file) — add the constraint NOT VALID. Safe to apply now.
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'availability_slots_cyclus_id_fkey'
      AND conrelid = 'public.availability_slots'::regclass
  ) THEN
    ALTER TABLE public.availability_slots
      ADD CONSTRAINT availability_slots_cyclus_id_fkey
      FOREIGN KEY (cyclus_id) REFERENCES public.cycles(id)
      ON DELETE SET NULL
      NOT VALID;
    RAISE NOTICE 'phase4_C: availability_slots_cyclus_id_fkey added (NOT VALID)';
  ELSE
    RAISE NOTICE 'phase4_C: availability_slots_cyclus_id_fkey already present, skipping';
  END IF;
END
$$;

-- ----------------------------------------------------------------------------
-- STEP 2 (owner-run, AFTER repair) — promote NOT VALID -> VALID.
-- ----------------------------------------------------------------------------
-- Run these THREE statements by hand in the Supabase SQL editor, in order,
-- once you are ready to clean up the historical orphans. Do NOT add them to a
-- migration file (the repair touches real data and should be reviewed live).
--
--   -- 2a. PRE-FLIGHT (read-only): how many orphan slot groups exist?
--   SELECT count(DISTINCT s.cyclus_id) AS orphan_cycle_count,
--          count(*)                    AS orphan_slot_count
--   FROM public.availability_slots s
--   WHERE s.cyclus_id IS NOT NULL
--     AND NOT EXISTS (SELECT 1 FROM public.cycles c WHERE c.id = s.cyclus_id);
--
--   -- 2b. REPAIR: if orphan_cycle_count > 0, run the prepared, owner-approved,
--   --     idempotent backfill that mints a real cycles row for each orphan:
--   --        supabase/migrations/20260612230000_rebook01_backfill_calendar_cycles.sql
--   --     Re-run 2a afterwards and confirm orphan_cycle_count = 0.
--
--   -- 2c. VALIDATE: once 2a returns 0, validate the constraint. This scans the
--   --     table once (a brief SHARE UPDATE EXCLUSIVE lock, reads only) and flips
--   --     it to fully VALID so the integrity guarantee covers existing rows too.
--   ALTER TABLE public.availability_slots
--     VALIDATE CONSTRAINT availability_slots_cyclus_id_fkey;
--
-- ============================================================================
