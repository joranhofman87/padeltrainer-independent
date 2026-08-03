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

-- FREEZE THE EVIDENCE. Every canary assertion below is a predicate over notification_worker_runs —
-- "this is the newest dispatch run, nothing is in flight". Without a lock a service-role invocation
-- can start a new dispatch run immediately after that predicate is evaluated and be mid-send by the
-- time this transaction commits the cron as active, so activation would have succeeded on evidence
-- that was already stale. SHARE conflicts with the ROW EXCLUSIVE an INSERT takes, so no new run can
-- begin until this transaction ends — and it is a short transaction taken once, under an owner gate,
-- against a cron that is still inactive.
--
-- HONEST RESIDUAL: this does not freeze webhook-driven transitions. A Resend callback can still
-- advance a group's provider status while this runs. It cannot start a SEND (that needs a dispatch
-- run, which this blocks), and rollback remains available; the alternative — locking the group,
-- circuit and orphan tables too — would block the live email path for the whole activation.
LOCK TABLE public.notification_worker_runs IN SHARE MODE;

-- LOCK FIRST, THEN LOOK, AND KEEP THE ROW. FOR UPDATE on the exact (jobname, username) row —
-- pg_cron scopes named-job uniqueness that way, so a bare jobname lookup can see another role's job.
--
-- The result is MATERIALISED here rather than re-looked-up per assertion. Under READ COMMITTED each
-- statement takes a fresh snapshot, so if the job was ABSENT the FOR UPDATE locked nothing, and
-- another session could insert one that every later name-based assertion would then happily read —
-- and a job altered between two assertions would be checked in one and armed by the other. Capturing
-- the jobid once means every assertion, the arm, and the postcondition all refer to the same row.
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user
     FOR UPDATE;

-- FREEZE THE CANARY'S OWN GROUPS TOO. The run-ledger lock stops a new dispatch run, but a Resend
-- CALLBACK needs no run: apply_notification_provider_event passes a null run id, so a bounce or a
-- suppression arriving mid-activation can move the canary's group out of `sent` into
-- `failed_terminal` AFTER the "this canary delivered" assertion has passed and before this
-- transaction commits the cron as active. That assertion is load-bearing — it is the only evidence
-- that the provider path works — so the groups THIS canary attempted are locked FOR SHARE, which
-- blocks those rows only and leaves the rest of the live email path alone.
SELECT g.id FROM public.notification_digest_groups g
 WHERE EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                WHERE a.digest_group_id = g.id AND a.worker_run_id = :'run_id'::uuid)
   FOR SHARE;

\i _activation_assertions.sql

-- ARM — by the jobid of the row we just locked and verified, never by a fresh name lookup, and
-- count-checked: `UPDATE ... WHERE` matching nothing is a successful no-op, and "arming" nothing
-- while printing success is exactly the failure this artifact exists to prevent.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM (
     SELECT cron.alter_job(j.jobid, active := true)
       FROM cron.job j
      WHERE j.jobid = (SELECT jobid FROM pg_temp._gate_job)) s), 1,
  'exactly one job was armed');

-- POSTCONDITION, read back inside the same transaction: THAT row really is active now.
SELECT pg_temp.assert(
  (SELECT j.active FROM cron.job j WHERE j.jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'the digest cron is now ACTIVE');

-- ...and it is STILL the reviewed job. Under the row lock this cannot have changed; asserting it
-- anyway means the transaction's final word is about the job that will actually tick.
SELECT pg_temp.assert_eq(
  (SELECT md5(btrim(regexp_replace(command, '\s+', ' ', 'g')))::text FROM cron.job
    WHERE jobid = (SELECT jobid FROM pg_temp._gate_job)),
  '0c693083584cffe135e52115ec56c2f0'::text,
  'the armed job is still EXACTLY the reviewed command');

DROP TABLE pg_temp._gate_job;

COMMIT;
