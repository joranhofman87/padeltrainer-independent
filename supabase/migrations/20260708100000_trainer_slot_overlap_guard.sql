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
-- Fix: AFTER ROW triggers that reject a slot write which puts the trainer on court
-- twice. Design notes (each deliberate; the adversarial review shaped 2 of them):
--   * AFTER (not BEFORE) ROW: apply_slot_edit_to_cycle shifts MANY rows' times in one
--     UPDATE statement; an AFTER trigger sees the statement's FINAL state, so a
--     legitimate whole-cycle shift (e.g. exactly ±1 week, where every row lands on a
--     sibling's OLD time) cannot false-positive on row processing order. Within one
--     batch INSERT it also sees every sibling row, so internal duplicates abort too.
--   * INSERT is strict; UPDATE only refuses NEW overlaps ("no new double-bookings,
--     but an edit doesn't have to fix an old one"): a moved row is refused only when
--     it overlaps a slot its OLD range did NOT already overlap. Pre-existing prod
--     duplicates (created by the broken dedups this guard replaces) therefore stay
--     editable as a pair — a whole-cycle time shift moves both twins in lockstep and
--     each still only overlaps its already-overlapping twin → allowed. Moving a slot
--     onto a slot it wasn't overlapping is refused; moving one of a bad pair AWAY is
--     always allowed (the guard helps clean up, it never traps).
--   * Half-open [start,end): back-to-back sessions (10:00-11:00 then 11:00-12:00)
--     never conflict; the comparison is strict (< / >), mirroring the app's ranges.
--   * pg_advisory_xact_lock per trainer BEFORE the check: two concurrent creation
--     runs serialize; the second acquires the lock only after the first commits and
--     its fresh READ COMMITTED snapshot then sees the committed rows → conflict
--     raised. Same pattern as the slot-capacity locks (20260614110000). Re-acquiring
--     within one transaction is a no-op. Two concurrent MULTI-trainer batches with
--     different trainer orders can in theory AB/BA-deadlock; Postgres resolves it by
--     aborting one (clean error, no corruption) and the client write points insert
--     rows in a canonical (trainer, start) order to make lock order deterministic.
--   * UPDATE trigger fires only when trainer_id/start_time/end_time actually change
--     (WHEN clause), so price/visibility/booking-mode bulk updates never pay the check.
--   * No constraint/validation of existing rows: pre-existing prod overlaps keep
--     working untouched (graceful rollout; see the grandfather rule above).
--     Detection query for the owner (recommended before OR after applying):
--       SELECT a.id, b.id, a.trainer_id, a.start_time, a.end_time, b.start_time, b.end_time
--       FROM public.availability_slots a
--       JOIN public.availability_slots b
--         ON a.trainer_id = b.trainer_id AND a.id < b.id
--        AND a.start_time < b.end_time AND b.start_time < a.end_time;
--   * The error contract mirrors the booking RPCs: message 'trainer_slot_overlap',
--     conflicting slot carried in DETAIL as JSON (id + window) for client display.
--   * swap_slots is recreated below with its two sequential UPDATEs merged into ONE
--     statement: the proposal-grid drag-swap targets an occupied same-trainer window
--     by construction, so after the first of two statements slot A sits on slot B's
--     unmoved window and the trigger would (correctly, per statement) refuse — the
--     single-statement swap exposes only the final swapped state, which is conflict-
--     free whenever the two source windows didn't overlap each other.
--
-- Uses idx_availability_slots_trainer_start (trainer_id, start_time) — already present.

CREATE OR REPLACE FUNCTION public.check_trainer_slot_overlap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conflict    record;
  v_old_trainer uuid;
  v_old_start   timestamptz;
  v_old_end     timestamptz;
BEGIN
  -- Serialize concurrent slot creation per trainer so the overlap check below is
  -- race-free (transaction-scoped; auto-released on commit/rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended('trainer_slot_overlap:' || NEW.trainer_id::text, 0));

  IF TG_OP = 'UPDATE' THEN
    v_old_trainer := OLD.trainer_id;
    v_old_start   := OLD.start_time;
    v_old_end     := OLD.end_time;
  END IF;

  SELECT s.id, s.start_time, s.end_time
    INTO v_conflict
  FROM public.availability_slots s
  WHERE s.trainer_id = NEW.trainer_id
    AND s.id <> NEW.id
    AND s.start_time < NEW.end_time
    AND s.end_time > NEW.start_time
    -- Grandfather rule (UPDATE only): tolerate a conflict the row's OLD range already
    -- had with this same slot — refuse only NEWLY created double-bookings.
    AND NOT (
      TG_OP = 'UPDATE'
      AND v_old_trainer = NEW.trainer_id
      AND s.start_time < v_old_end
      AND s.end_time > v_old_start
    )
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

-- swap_slots: identical signature, guards, and grants (CREATE OR REPLACE preserves the
-- ACLs set in 20260706120000) — ONLY the two sequential UPDATEs become one statement,
-- for the trigger-visibility reason documented above. Behavior for callers is unchanged.
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
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'swap_slots: authentication required';
  END IF;

  -- Both target slots must exist and the caller must be allowed to manage EACH of them,
  -- exactly as the availability_slots RLS UPDATE policies would allow (or be an admin).
  IF NOT public.can_manage_slot(_uid, _slot_a_id) THEN
    RAISE EXCEPTION 'swap_slots: not authorized to modify slot %', _slot_a_id
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.can_manage_slot(_uid, _slot_b_id) THEN
    RAISE EXCEPTION 'swap_slots: not authorized to modify slot %', _slot_b_id
      USING ERRCODE = '42501';
  END IF;

  -- Atomic swap in ONE statement: the overlap trigger sees only the final swapped
  -- state (two sequential UPDATEs would trip it on the intermediate double-booking).
  UPDATE availability_slots s
  SET trainer_id = v.trainer_id,
      start_time = v.start_time,
      end_time   = v.end_time
  FROM (VALUES
    (_slot_a_id, _slot_a_trainer_id, _slot_a_start, _slot_a_end),
    (_slot_b_id, _slot_b_trainer_id, _slot_b_start, _slot_b_end)
  ) AS v(id, trainer_id, start_time, end_time)
  WHERE s.id = v.id;
END;
$$;
