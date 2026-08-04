-- 10c-b — turn the digest engine ON for the cutover event, and ONLY that event.
--
-- This replaced a raw `UPDATE notification_event_types SET digest_engine_enabled = true WHERE
-- key = 'open_slots_player';` pasted into the runbook. Explicit owner intent is what `--yes` is
-- for; it was never a reason for the single most consequential statement in the sequence to run
-- unqualified, without EXPECTED_REF, without the PG* stripping, and without anything checking that
-- it hit exactly one row.
\set ON_ERROR_STOP on
-- NAME RESOLUTION IS PINNED FOR THE WHOLE SESSION, before any include and before any statement.
--
-- Every unqualified function, operator, aggregate, cast and relation in this file — and in the
-- shared includes it pulls in — is resolved through search_path, which is settable per role and per
-- database and which the client-side PG* stripping cannot reach. Ordering the path is NOT a defence:
-- function resolution prefers an exact-arity, exact-type candidate over pg_catalog's VARIADIC "any"
-- wherever that schema sits, even after an explicit pg_catalog. A hostile `count(text)` reports zero;
-- a hostile `md5(text)` matches any command; a hostile `=` ignores a queued canary. Only EXCLUDING
-- such a schema works, so every artifact in this directory pins the path and
-- src/test/notif10cbActivationPreflight.test.ts fails if one stops.
--
-- SESSION-WIDE, not SET LOCAL: a transaction-scoped setting is reverted by COMMIT, and these files
-- keep asserting and reporting afterwards. pg_temp is deliberately absent — it is never searched for
-- functions or operators, and every temp object here is written as pg_temp.x.
SET search_path = pg_catalog;

\i ../../notif-10ca3/sql/_assert.sql

BEGIN;
-- Bounded, as in activate.sql: this transaction takes a table lock and a row lock, so an unbounded
-- wait would hold the event catalog against every writer.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- LOCK THE JOB ROW FIRST. Reading `job_active` and then enabling the event in a later statement is
-- a verify-then-act race: a concurrent `cron.alter_job(active := true)` can commit in between, and
-- the engine goes live over an armed cron — exactly the pre-canary send window `assert-inert`
-- exists to close. assert-inert cannot protect a LATER transaction; only this lock can.
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user
     FOR UPDATE;

-- ...and the event catalog too, so "nothing else is enabled" is a real transactional postcondition
-- rather than a snapshot someone can invalidate before this commits.
LOCK TABLE public.notification_event_types IN SHARE ROW EXCLUSIVE MODE;

-- The full identity + inactivity check, against the LOCKED row — the same assertions the activation
-- gate runs, not a weaker local copy.
\i _job_identity_assertions.sql

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

DROP TABLE pg_temp._gate_job;

COMMIT;
