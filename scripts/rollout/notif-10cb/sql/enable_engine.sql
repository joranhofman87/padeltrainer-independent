-- 10c-b — turn the digest engine ON for the cutover event, and ONLY that event.
--
-- This replaced a raw `UPDATE notification_event_types SET digest_engine_enabled = true WHERE
-- key = 'open_slots_player';` pasted into the runbook. Explicit owner intent is what `--yes` is
-- for; it was never a reason for the single most consequential statement in the sequence to run
-- unqualified, without EXPECTED_REF, without the PG* stripping, and without anything checking that
-- it hit exactly one row.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- PRECONDITION: the cron must still be INACTIVE. Enabling the engine while an armed job exists is
-- exactly the window `assert-inert` exists to close, and this is the last moment to catch it.
SELECT pg_temp.assert(NOT (SELECT job_active FROM public.notif_digest_worker_liveness()),
  'the digest cron is still INACTIVE (enabling the engine while it is armed would send to the whole population on the next tick)');

-- ...and only the cutover event may be turned on.
SELECT pg_temp.assert(
  (SELECT digest_cutover FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'open_slots_player is the cutover event');

-- A data-modifying CTE, not an UPDATE in a subquery: PostgreSQL does not allow the latter, and
-- this suite has now hit that twice.
WITH u AS (
  UPDATE public.notification_event_types
     SET digest_engine_enabled = true, updated_at = now()
   WHERE key = 'open_slots_player' AND NOT digest_engine_enabled
  RETURNING 1
)
SELECT pg_temp.assert_eq((SELECT count(*)::int FROM u), 1,
  'exactly one event row was enabled (zero means it was already on — re-read status rather than assuming)');

-- POSTCONDITION, inside the same transaction: this event on, nothing else.
SELECT pg_temp.assert(
  (SELECT digest_engine_enabled FROM public.notification_event_types WHERE key = 'open_slots_player'),
  'the digest engine is now enabled for open_slots_player');
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types
    WHERE digest_engine_enabled AND key <> 'open_slots_player'), 0,
  'no other event was enabled');

COMMIT;
