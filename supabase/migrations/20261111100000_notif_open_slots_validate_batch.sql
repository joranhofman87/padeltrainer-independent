-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- OPEN-SLOTS PRODUCER BATCH VALIDATION — the submitted slot set is validated as a WHOLE, or not
-- at all.
--
-- NAMING, because an earlier draft of this file got it wrong and the wrong word is load-bearing.
-- This is NOT the rollout canary. The canary is a one-off, operator-supervised invocation of the
-- digest worker (scripts/rollout/notif-10cb/), gated by its own ceiling and due-work floor. THIS
-- function runs on the ordinary production path, on every single open-slots announcement, for
-- ever — it is part of the PRODUCER contract, not part of the rollout. Filing it under "canary"
-- would suggest it is temporary rollout scaffolding that can be removed once the cutover is done;
-- it cannot.
--
-- The open_slots_player producer is handed a list of slot ids by its caller and then notifies
-- players about them. Before this function the edge path validated that list by SELECTing the
-- slots by id and filtering the RESULT — and a filter over a result set cannot distinguish
-- "everything you sent is yours and public" from "most of what you sent vanished on the way in":
--
--   * an id belonging to ANOTHER trainer was filtered out and the send proceeded on the remainder;
--   * an id that does not exist at all (typo, deleted slot, stale client cache) likewise vanished;
--   * a PRIVATE slot of the caller's own was dropped the same silent way.
--
-- In every case the operator asked to announce N slots and the system announced some subset of N
-- while reporting success. Announcing a subset is not a smaller version of the right thing: the
-- one case where the subset is empty is a send about nothing, and the case where a foreign id was
-- supplied is precisely the case that must be refused loudly rather than trimmed quietly.
--
-- AND THE SECOND, WORSE FAILURE — the one that makes this an RPC instead of a better WHERE clause.
-- A row-returning query through PostgREST is subject to a server-side row cap (`db-max-rows`, and
-- any Range the client did not set). A capped response is BYTE-FOR-BYTE INDISTINGUISHABLE from a
-- short one: the caller sees fewer rows than it sent and cannot tell whether ids were rejected or
-- whether the transport simply stopped early. Under a cap the "safe" reading and the "unsafe"
-- reading of the same response are both defensible, which means the validation proves nothing.
--
-- A SCALAR AGGREGATE CANNOT BE TRUNCATED. This function returns exactly ONE row — always, for a
-- thousand ids, for zero ids, for NULL — carrying counts computed over the entire set inside the
-- database. There is no row cap that can silently remove part of a count. That immunity is the
-- entire reason this RPC exists; it must never be "improved" into something that returns slots.
--
-- HOW THE CALLER USES IT. The three counts are only meaningful together:
--
--   supplied_distinct == matched == public_owned == the number of ids the caller submitted
--
-- Any inequality means the submitted set is not wholly the caller's own public slots, and the send
-- must be REFUSED — not trimmed:
--
--   supplied_distinct > matched      → at least one id does not exist;
--   matched > public_owned           → at least one id exists but is foreign, or private, or both.
--
-- WHY THE AGGREGATES ARE FILTERED TO THE PUBLIC+OWNED SUBSET. max_created_at / min_start_date /
-- max_start_date are computed over ONLY the rows satisfying BOTH trainer_id = p_trainer_id AND
-- is_public — never over "everything that matched". That is what makes the equality above a proof
-- rather than a coincidence: when the three counts agree, the public+owned subset provably COVERS
-- the entire submitted set, so the window those aggregates describe is the window of the whole
-- batch. Had they been computed over all matched rows, a foreign slot could widen the reported
-- window while the counts still looked plausible, and a downstream freshness or horizon check
-- would be reasoning about a slot the trainer does not own.
--
-- THE DATE RANGE IS RETURNED AS CALENDAR DATES, NOT TIMESTAMPS, AND THAT IS THE POINT.
-- `start_time` is timestamptz — an instant. "Which day is this slot on" has no answer until a
-- timezone is named, and the whole defect being repaired here is a day-boundary off-by-one that
-- came from answering it with an implicit one. So the caller passes the trainer's own
-- `trainer_profiles.timezone` (NOT NULL, default 'Europe/Amsterdam') and the conversion happens
-- HERE, in the database, against the tz database — never in JavaScript from a UTC ISO string.
--
-- min/max are taken over the CONVERTED DATES, not over the instants: `min((start_time AT TIME ZONE
-- tz)::date)`, not `(min(start_time) AT TIME ZONE tz)::date`. The first IS the property — "the
-- earliest calendar date this batch covers" — while the second is a different question that
-- happens to share its answer.
--
-- HOW MUCH THEY SHARE IT, stated honestly rather than overstated. `AT TIME ZONE` is genuinely
-- non-monotonic across a DST fall-back (01:00Z maps to local 03:00 while the LATER 01:30Z maps to
-- local 02:30), so at TIMESTAMP granularity the two forms differ. At DATE granularity they do not:
-- an inversion is bounded by the one-hour shift, and no transition in the tz database places the
-- repeated wall-clock hour across midnight, so the converted dates never go backwards. This was
-- checked rather than assumed — 21M instants at 10-minute resolution over 2000-2040 across
-- Amsterdam, Havana, Sao_Paulo, Santiago, Lord_Howe, Chatham, Asuncion, Beirut, Troll and
-- Scoresbysund produced zero date inversions.
--
-- So this form is chosen because it says what it means, not because the other is known to break.
-- The distinction matters for a reader deciding whether it is safe to "simplify": it is, today,
-- for every real zone — and the aggregate-over-dates form is the one that stays correct without
-- depending on that survey.
--
-- A NULL p_timezone falls back to 'Europe/Amsterdam', the app-wide default that the column itself
-- defaults to. An INVALID timezone name raises (invalid_parameter_value) rather than silently
-- picking a substitute — the caller then gets an RPC error, refuses the batch, and enqueues
-- nothing, which is the correct fail-closed outcome for a request we cannot date.
--
-- FAIL-CLOSED, deliberately, in the degenerate inputs:
--
--   * p_slot_ids NULL or empty → one row of zeros and NULLs, no error. The caller's equality holds
--     trivially at 0 == 0 == 0, and refusing an EMPTY batch is the caller's decision to make with
--     a count in hand, not an exception to catch;
--   * p_trainer_id NULL → `trainer_id = NULL` is NULL, so public_owned_count is 0 and every
--     aggregate is NULL. A missing trainer therefore fails the equality for any non-empty batch
--     instead of waving it through;
--   * a NULL element inside p_slot_ids is invisible to count(DISTINCT) and matches no row, so it
--     is not smuggled past the equality as a phantom id — but it is also not reported. Producers
--     must not build the array from a nullable projection.
--
-- SECURITY INVOKER, not DEFINER. The only caller is the notification edge function's service-role
-- client, which already reads availability_slots directly; there is nothing to elevate, and a
-- DEFINER here would hand any future grantee an RLS-free read of every trainer's slots. The grants
-- below keep it to service_role alone: anon and authenticated have no business asking this
-- question about a trainer id they merely typed.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

-- This migration has never been applied outside this branch, and an earlier revision of it
-- declared a two-argument form. Dropping that form keeps a re-applied or already-rehearsed
-- database from ending up with two overloads, where PostgREST would have to guess which one a
-- three-key body meant.
DROP FUNCTION IF EXISTS public.notif_open_slots_validate_batch(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.notif_open_slots_validate_batch(
  p_trainer_id uuid,
  p_slot_ids   uuid[],
  p_timezone   text
) RETURNS TABLE (
  supplied_distinct_count integer,
  matched_count           integer,
  public_owned_count      integer,
  max_created_at          timestamptz,
  min_start_date          date,
  max_start_date          date
)
LANGUAGE sql
STABLE
SECURITY INVOKER
-- pinned to pg_catalog alone: every reference below is schema-qualified, so nothing here can be
-- captured by a search_path the caller controls.
SET search_path = pg_catalog
AS $$
  SELECT
    -- the size of the QUESTION, measured on the input itself and not on anything the database
    -- happened to find. Duplicates collapse (asking twice about one slot is one slot).
    (SELECT count(DISTINCT e.slot_id)::integer
       FROM pg_catalog.unnest(coalesce(p_slot_ids, ARRAY[]::uuid[])) AS e(slot_id))
      AS supplied_distinct_count,
    -- deliberately UNSCOPED: any trainer, any visibility. supplied_distinct > matched is how a
    -- non-existent id is detected, and a scoped count could not tell that from a foreign one.
    count(*)::integer AS matched_count,
    count(*) FILTER (
      WHERE s.trainer_id = p_trainer_id AND s.is_public IS TRUE
    )::integer AS public_owned_count,
    -- the three aggregates below see ONLY the public+owned subset — see the header. Repeat the
    -- filter on each rather than hoisting it into the WHERE clause: matched_count must keep
    -- counting the rows these deliberately ignore.
    max(s.created_at) FILTER (
      WHERE s.trainer_id = p_trainer_id AND s.is_public IS TRUE
    ) AS max_created_at,
    -- min/max over the CONVERTED DATES — see the DST note in the header.
    min((s.start_time AT TIME ZONE coalesce(p_timezone, 'Europe/Amsterdam'))::date) FILTER (
      WHERE s.trainer_id = p_trainer_id AND s.is_public IS TRUE
    ) AS min_start_date,
    max((s.start_time AT TIME ZONE coalesce(p_timezone, 'Europe/Amsterdam'))::date) FILTER (
      WHERE s.trainer_id = p_trainer_id AND s.is_public IS TRUE
    ) AS max_start_date
  FROM public.availability_slots s
  -- an ungrouped aggregate over zero matching rows still yields exactly one row (0, 0, 0, NULL,
  -- NULL, NULL), which is what makes the empty/NULL-array case answerable without a special path.
  WHERE s.id = ANY (coalesce(p_slot_ids, ARRAY[]::uuid[]));
$$;

COMMENT ON FUNCTION public.notif_open_slots_validate_batch(uuid, uuid[], text) IS
  'Open-slots PRODUCER batch validation (not the rollout canary): one scalar-aggregate row describing a submitted slot batch, immune to PostgREST row caps because it never returns slot rows. The caller must require supplied_distinct_count = matched_count = public_owned_count = the number of ids it submitted, and REFUSE the send otherwise (an inequality means a missing, foreign, or private id) — never trim the batch to the authorized subset. max_created_at/min_start_date/max_start_date are computed over ONLY the trainer-owned public rows, which is what makes that equality prove the subset covers the whole batch. The date range is returned as calendar dates converted in p_timezone (the trainer''s own trainer_profiles.timezone; NULL falls back to Europe/Amsterdam), because a timestamptz has no calendar date until a timezone is named.';

REVOKE ALL ON FUNCTION public.notif_open_slots_validate_batch(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notif_open_slots_validate_batch(uuid, uuid[], text) TO service_role;
