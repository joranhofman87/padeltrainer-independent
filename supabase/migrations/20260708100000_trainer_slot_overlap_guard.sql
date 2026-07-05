-- Trainer double-booking guard: a trainer can be on court ONCE per moment.
--
-- Audit 2026-07-06: availability_slots had ZERO database-level protection against
-- duplicate/overlapping sessions for the same trainer — no unique index, no exclusion
-- constraint, no trigger. Every creation path is a client-side .insert() whose only
-- guards are app-level read-then-insert checks: the quick-generator's exact-start
-- dedup (race-prone, overlap-blind, RLS-limited), the bulk-create page's dedup
-- (broken outright by a timestamp string-format mismatch), and nothing at all on the
-- single-slot dialogs. Running a generator twice — or shifted by half an hour — could
-- silently double-book the trainer, and duplicates are double-SELLABLE downstream
-- (each row carries full capacity; a whole-cyclus guest checkout spanning a
-- duplicated date charges one extra session).
--
-- Fix: an AFTER ROW trigger that rejects any INSERTed/time-moved slot whose
-- [start_time, end_time) half-open range overlaps another slot of the SAME trainer.
-- Design notes (each deliberate):
--   * AFTER (not BEFORE) ROW: apply_slot_edit_to_cycle shifts MANY rows' times in one
--     UPDATE statement; an AFTER trigger sees the statement's FINAL state, so a
--     legitimate whole-cycle shift (e.g. exactly ±1 week, where every row lands on a
--     sibling's OLD time) cannot false-positive on row processing order. Within one
--     batch INSERT it also sees every sibling row, so internal duplicates abort too.
--   * Half-open [start,end): back-to-back sessions (10:00-11:00 then 11:00-12:00)
--     never conflict; the comparison is strict (< / >), mirroring the app's ranges.
--   * pg_advisory_xact_lock per trainer BEFORE the check: two concurrent creation
--     runs serialize; the second acquires the lock only after the first commits and
--     its fresh READ COMMITTED snapshot then sees the committed rows → conflict
--     raised. Same pattern as the slot-capacity locks (20260614110000). Re-acquiring
--     within one transaction is a no-op.
--   * UPDATE trigger fires only when trainer_id/start_time/end_time actually change
--     (WHEN clause), so price/visibility/booking-mode bulk updates never pay the
--     check, and rows involved in PRE-EXISTING overlaps stay editable as long as the
--     edit doesn't keep/create an overlap (moving one of a bad pair AWAY is allowed —
--     the guard helps clean up, it never traps).
--   * No constraint/validation of existing rows: pre-existing prod overlaps keep
--     working untouched (graceful rollout). Detection query for the owner:
--       SELECT a.id, b.id, a.trainer_id, a.start_time, a.end_time, b.start_time, b.end_time
--       FROM public.availability_slots a
--       JOIN public.availability_slots b
--         ON a.trainer_id = b.trainer_id AND a.id < b.id
--        AND a.start_time < b.end_time AND b.start_time < a.end_time;
--   * The error contract mirrors the booking RPCs: message 'trainer_slot_overlap',
--     conflicting slot carried in DETAIL as JSON (id + window) for client display.
--
-- Uses idx_availability_slots_trainer_start (trainer_id, start_time) — already present.

CREATE OR REPLACE FUNCTION public.check_trainer_slot_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conflict record;
BEGIN
  -- Serialize concurrent slot creation per trainer so the overlap check below is
  -- race-free (transaction-scoped; auto-released on commit/rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended('trainer_slot_overlap:' || NEW.trainer_id::text, 0));

  SELECT s.id, s.start_time, s.end_time
    INTO v_conflict
  FROM public.availability_slots s
  WHERE s.trainer_id = NEW.trainer_id
    AND s.id <> NEW.id
    AND s.start_time < NEW.end_time
    AND s.end_time > NEW.start_time
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'trainer_slot_overlap'
      USING DETAIL = json_build_object(
              'conflicting_slot_id', v_conflict.id,
              'conflicting_start', v_conflict.start_time,
              'conflicting_end', v_conflict.end_time
            )::text,
            HINT = 'This trainer already has a session overlapping the requested time.';
  END IF;

  RETURN NULL; -- AFTER trigger: return value ignored
END;
$$;

DROP TRIGGER IF EXISTS trg_trainer_slot_overlap_ins ON public.availability_slots;
CREATE TRIGGER trg_trainer_slot_overlap_ins
  AFTER INSERT ON public.availability_slots
  FOR EACH ROW
  EXECUTE FUNCTION public.check_trainer_slot_overlap();

DROP TRIGGER IF EXISTS trg_trainer_slot_overlap_upd ON public.availability_slots;
CREATE TRIGGER trg_trainer_slot_overlap_upd
  AFTER UPDATE OF trainer_id, start_time, end_time ON public.availability_slots
  FOR EACH ROW
  WHEN (OLD.trainer_id IS DISTINCT FROM NEW.trainer_id
     OR OLD.start_time IS DISTINCT FROM NEW.start_time
     OR OLD.end_time   IS DISTINCT FROM NEW.end_time)
  EXECUTE FUNCTION public.check_trainer_slot_overlap();
