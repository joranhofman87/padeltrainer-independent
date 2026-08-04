-- 10c-b RU3 — prove the rollback actually landed. Run AFTER switching the engine off and
-- deactivating the cron; it asserts the two things that must both be true, because either one
-- alone still sends.
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

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_event_types WHERE digest_engine_enabled), 0,
  'the digest engine is OFF for every event');

SELECT pg_temp.assert(NOT (SELECT job_active FROM public.notif_digest_worker_liveness()),
  'the digest cron is INACTIVE');

-- The job must still EXIST. Unscheduling to "pause" is the failure this asserts against: it
-- destroys the reviewed, Vault-backed command, and re-creating it by hand is how a wrong
-- endpoint or a missing bearer gets introduced under time pressure.
SELECT pg_temp.assert((SELECT job_present FROM public.notif_digest_worker_liveness()),
  'the digest cron job still EXISTS (deactivate it — never unschedule it to pause)');

-- QUIESCENCE. Both switches being off says nothing about the invocation that was ALREADY running
-- when they were thrown: it keeps sending the groups it has claimed for the rest of its run. A
-- rollback that reports success over a live dispatch run is reporting the wrong thing.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL), 0,
  'no dispatch run is still in flight (wait for it to finish, then re-run this)');

SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_digest_groups
    WHERE state IN ('sending', 'awaiting_evidence')), 0,
  'no digest group is mid-send or awaiting evidence');
