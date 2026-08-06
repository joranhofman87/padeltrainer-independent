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

BEGIN;

-- EVERY LOCK WAIT IS BOUNDED. This transaction takes a table lock and then several row locks, so a
-- slow holder — a webhook mid-transaction on a canary group, a reconcile batch holding groups
-- across its loop — would otherwise make activation wait indefinitely WHILE its own table lock
-- blocks every worker-run insert and finish. It also removes the deadlock as a hang: activation and
-- reconcile_orphan_provider_events can acquire overlapping group sets in different orders, and this
-- turns that into a fast, clean refusal instead. Activation is an owner-driven step that is always
-- safe to re-run, so failing closed is strictly better than holding the line.
--
-- BOTH bounds are needed, and the reason is that lock_timeout applies to EACH lock acquisition
-- separately. The ordered FOR SHARE can take many group locks (the worker's per-invocation cap is
-- in the hundreds), so a series of blockers that each release inside five seconds would keep
-- activation waiting far longer than five seconds while it holds the SHARE lock on the run ledger.
-- statement_timeout caps that whole statement, so the TOTAL stall is bounded, not just each wait.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

\i ../../notif-10ca3/sql/_assert.sql

-- FREEZE THE EVIDENCE. Every canary assertion below is a predicate over notification_worker_runs —
-- "this is the newest dispatch run, nothing is in flight". Without a lock a service-role invocation
-- can start a new dispatch run immediately after that predicate is evaluated and be mid-send by the
-- time this transaction commits the cron as active, so activation would have succeeded on evidence
-- that was already stale. SHARE conflicts with the ROW EXCLUSIVE an INSERT takes, so no new run can
-- begin until this transaction ends — and it is a short transaction taken once, under an owner gate,
-- against a cron that is still inactive.
--
-- HONEST RESIDUAL, as it now stands: the canary's OWN groups are locked below, so a callback cannot
-- unmake this canary's evidence mid-transaction. What is still unfrozen is transitions on UNRELATED
-- groups, and any callback that arrives AFTER this commits — neither of which says anything about
-- whether the canary delivered. Locking the circuit and orphan tables as well would block the live
-- email path for the whole activation, which is a worse trade than the residual.
LOCK TABLE public.notification_worker_runs IN SHARE MODE;

-- LOCK FIRST, THEN LOOK, AND KEEP THE ROW — via _gate_job_lock.sql. The hosted role cannot
-- FOR UPDATE the supabase_admin-owned cron.job (SELECT only), so the row lock is a guarded no-op
-- cron.alter_job(active := false) — the same owner-authorized API the arm below uses — whose SPI
-- update takes the tuple lock every cron writer queues behind (measured semantics + honest
-- residuals in the include). The row is resolved on the owner-scoped (jobname, username) pair —
-- pg_cron scopes named-job uniqueness that way, so a bare jobname lookup can see another role's job.
--
-- The result is MATERIALISED once rather than re-looked-up per assertion. Under READ COMMITTED each
-- statement takes a fresh snapshot, so if the job was ABSENT the lock matched nothing and refused,
-- and a job altered between two assertions would otherwise be checked in one and armed by the
-- other. Capturing the jobid once means every assertion, the arm, and the postcondition all refer
-- to the same row.
\i _gate_job_lock.sql

-- FREEZE THE CANARY'S OWN GROUPS TOO. The run-ledger lock stops a new dispatch run, but a Resend
-- CALLBACK needs no run: apply_notification_provider_event passes a null run id, so a bounce or a
-- suppression arriving mid-activation can move the canary's group out of `sent` into
-- `failed_terminal` AFTER the "this canary delivered" assertion has passed and before this
-- transaction commits the cron as active. That assertion is load-bearing — it is the only evidence
-- that the provider path works — so the groups THIS canary attempted are locked FOR SHARE, which
-- blocks those rows only and leaves the rest of the live email path alone.
-- CHEAPEST REFUSAL FIRST: if a dispatch run is already in flight, this activation is going to be
-- refused by the canary assertions anyway, so refuse BEFORE taking group locks rather than queueing
-- behind the very run that will invalidate it.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM public.notification_worker_runs
    WHERE phase = 'dispatch' AND channel = 'email' AND ended_at IS NULL
      AND status IS DISTINCT FROM 'abandoned'), 0,
  'no dispatch run is in flight (wait for it to finish, then re-run the canary)');

-- ORDERED BY id so activation always acquires these rows in the same sequence. Two transactions
-- taking overlapping group sets in opposite orders is the classic deadlock, and the orphan
-- reconciler holds group locks across a multi-row loop.
SELECT g.id FROM public.notification_digest_groups g
 WHERE EXISTS (SELECT 1 FROM public.notification_digest_attempts a
                WHERE a.digest_group_id = g.id AND a.worker_run_id = :'run_id'::uuid)
 ORDER BY g.id
   FOR SHARE;

\i _activation_assertions.sql
-- N4 M1 (AC-6): arming must never ride over an unverified deliberate invocation.
\i _invocation_gate.sql

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
  '69204549e8cb81680e492e49ef08fdd6'::text,
  'the armed job is still EXACTLY the reviewed command');

DROP TABLE pg_temp._gate_job;

COMMIT;
