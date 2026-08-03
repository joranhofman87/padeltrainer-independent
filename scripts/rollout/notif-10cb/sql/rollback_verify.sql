-- 10c-b RU3 — prove the rollback actually landed. Run AFTER switching the engine off and
-- deactivating the cron; it asserts the two things that must both be true, because either one
-- alone still sends.
\set ON_ERROR_STOP on
\i ../notif-10ca3/sql/_assert.sql

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
