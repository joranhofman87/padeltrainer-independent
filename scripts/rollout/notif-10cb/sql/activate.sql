-- 10c-b RU3 — VERIFY AND ARM, atomically. The last automated step before a live digest send.
--
-- WHY THIS IS ONE TRANSACTION AND ONE ARTIFACT. The first version ran the preflight in one psql
-- process and then armed the cron by name in another. Everything the preflight proved — the
-- reviewed schedule, node, database, owner, endpoint, and the whole-command hash — described the
-- job as it was at check time. Between the two statements the job could be altered, replaced, or
-- unscheduled, and the arm-by-name would match whatever was there instead. Worse, if it had been
-- deleted the arm's `SELECT ... WHERE` would match ZERO rows, succeed, and the script would report
-- the cron as ARMED over a job that no longer exists.
--
-- So: one transaction, and the row is LOCKED before it is inspected. The job that satisfied every
-- assertion is by construction the job that gets armed, and the arm is count-checked rather than
-- assumed.
--
-- Takes :run_id — the uuid the CANARY invocation itself returned.
\set ON_ERROR_STOP on

BEGIN;

\i ../../notif-10ca3/sql/_assert.sql

-- LOCK FIRST, THEN LOOK. FOR UPDATE on the exact (jobname, username) row — pg_cron scopes named-job
-- uniqueness that way, so a bare jobname lookup can see another role's job. Nothing else can alter
-- this row until we commit or abort. A missing row locks nothing, which is why the assertions below
-- (which fail closed on a NULL) still have to run.
SELECT jobid FROM cron.job
 WHERE jobname = 'notification-digest-worker' AND username = current_user
   FOR UPDATE;

\i _activation_assertions.sql

-- ARM — by the jobid of the row we just locked and verified, never by a fresh name lookup, and
-- count-checked: `UPDATE ... WHERE` matching nothing is a successful no-op, and "arming" nothing
-- while printing success is exactly the failure this artifact exists to prevent.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM (
     SELECT cron.alter_job(j.jobid, active := true)
       FROM cron.job j
      WHERE j.jobname = 'notification-digest-worker' AND j.username = current_user) s), 1,
  'exactly one job was armed');

-- POSTCONDITION, read back inside the same transaction: it really is active now.
SELECT pg_temp.assert(
  (SELECT j.active FROM cron.job j
    WHERE j.jobname = 'notification-digest-worker' AND j.username = current_user),
  'the digest cron is now ACTIVE');

-- ...and it is STILL the reviewed job. Under the row lock this cannot have changed; asserting it
-- anyway means the transaction's final word is about the job that will actually tick.
SELECT pg_temp.assert_eq(
  (SELECT md5(btrim(regexp_replace(command, '\s+', ' ', 'g')))::text FROM cron.job
    WHERE jobname = 'notification-digest-worker' AND username = current_user),
  '0c693083584cffe135e52115ec56c2f0'::text,
  'the armed job is still EXACTLY the reviewed command');

COMMIT;
