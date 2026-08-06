-- 10c-b — RESOLVE, THEN LOCK, THE DIGEST CRON JOB ROW — with the privileges the hosted role
-- actually holds. Shared by the four TRANSACTIONAL artifacts (smoke_invoke, canary_invoke,
-- enable_engine, activate). The read-only gates (assert_inert, activation_preflight) deliberately
-- do NOT include this file: outside a transaction the lock write below would autocommit, and a
-- dry run must not write anything at all.
--
-- WHY NOT `FOR UPDATE`. On hosted Supabase `cron.job` is owned by `supabase_admin`; the role this
-- tooling connects as holds SELECT and nothing else, and every row-locking clause — and every
-- conflicting LOCK TABLE mode — requires a write privilege on the table. The first production run
-- of `smoke-disabled` was refused on exactly that, before anything was invoked. Granting UPDATE on
-- cron.job is not the fix: writes to that catalog are what arm a credential-bearing tick, so
-- widening write access in order to CHECK it would be backwards.
--
-- WHAT LOCKS INSTEAD. `cron.alter_job` is the one write API the connected role is authorized to
-- use on its own jobs (activate.sql's arm already relies on it). Measured on pg_cron 1.6.4 on the
-- real supabase image: an all-default call is refused ('no updates specified'), so the minimal
-- honest call re-asserts the one state every artifact here requires anyway — `active := false` —
-- and pg_cron implements that as an SPI UPDATE of the job row, run under the extension owner's
-- context after pg_cron's own ownership check. An UPDATE writes a new tuple version even when the
-- value is unchanged, and that tuple write is a genuine transactional row lock: a concurrent
-- alter, a same-name schedule upsert, and a job removal all queue behind it until this transaction
-- ends, while plain readers are unaffected. A missing or foreign jobid RAISES
-- ('Job N does not exist or you don''t own it') — fail closed.
--
-- THE GATE IS IN THE SAME STATEMENT AS THE LOCK. The alter runs only for a row that is already
-- INACTIVE in this statement's snapshot, so an armed job locks nothing and the count-check
-- refuses. Zero rows also covers a job deleted, or replaced — a re-created job has a NEW jobid —
-- between the resolve above and this statement.
--
-- HONEST RESIDUALS, in the order they matter:
--   * `active` is the ONE attribute this lock writes, so it is the one attribute whose drift the
--     write can mask instead of refuse: an out-of-band arm that commits inside this statement's
--     own execution window is overwritten back to inactive rather than detected. Every OTHER
--     attribute (command, schedule, database, node, port, owner, name) is untouched by the write
--     and is re-asserted under the held lock by _job_identity_assertions.sql, so drift there —
--     whenever it was committed — still fails closed.
--   * Until COMMIT only the OLD committed version is visible to plain readers — the pg_cron
--     launcher included. So this write does not retroactively stop a tick that a concurrently
--     armed job already launched; it disarms at commit. Concurrent out-of-band arming is an
--     UNSUPPORTED precondition of this runbook (single operator, one terminal, no hand alters) —
--     not a race this file claims to win. The old FOR UPDATE would have REFUSED in that window;
--     this construct disarms and proceeds. That is the trade the privilege model forces, recorded
--     here rather than hidden.
--   * The SPI update takes ROW EXCLUSIVE on cron.job at table level where FOR UPDATE took
--     ROW SHARE, so it can additionally conflict with table-wide maintenance. The callers'
--     lock_timeout / statement_timeout bound that, and every calling step is safe to re-run.
--
-- Requires pg_temp.assert / assert_eq (the caller includes _assert.sql first) and MUST run inside
-- the caller's BEGIN, after its SET LOCAL timeouts. This file never touches search_path — it
-- inherits the caller's session-wide pg_catalog pin.

-- The primitive above is a MEASURED property of pg_cron 1.6.x, not an API contract. The
-- write-proof at the end catches the dangerous change on any future version (no write means no
-- lock); this pin additionally stops the rollout for re-review the moment the extension is not the
-- reviewed line at all.
SELECT pg_temp.assert(
  (SELECT extversion = '1.6' OR extversion LIKE '1.6.%'
     FROM pg_extension WHERE extname = 'pg_cron'),
  'pg_cron is a reviewed 1.6.x (this lock leans on measured alter_job internals — re-review them against the new version before proceeding)');

DROP TABLE IF EXISTS pg_temp._gate_job;
CREATE TEMP TABLE _gate_job AS
  SELECT jobid FROM cron.job
   WHERE jobname = 'notification-digest-worker' AND username = current_user;

-- Deliberately duplicated from _job_identity_assertions.sql so THIS file is independently safe:
-- the lock statement below must never run against a jobid that resolved to no rows, and losing or
-- reordering the identity include must not turn it into one that does.
SELECT pg_temp.assert_eq((SELECT count(*)::int FROM pg_temp._gate_job), 1,
  'the digest cron job exists (exactly one, owned by the current user)');

-- THE LOCK. One statement: the gate and the alter share a snapshot, and the alter runs only if the
-- gate holds. The value written is the value the gate requires, so a success changes nothing.
SELECT pg_temp.assert_eq(
  (SELECT count(*)::int FROM (
     SELECT cron.alter_job(j.jobid, active := false)
       FROM cron.job j
      WHERE j.jobid = (SELECT jobid FROM pg_temp._gate_job)
        AND j.active IS FALSE) locked), 1,
  'exactly one INACTIVE job row was locked through cron.alter_job (zero means the job vanished, was replaced under a new jobid, or is ARMED — stop and investigate: nothing was altered)');

-- THE WRITE-PROOF. The count above proves alter_job was INVOKED, not that it wrote: a future
-- pg_cron that quietly skips a value-identical update would leave every later assertion running
-- with no lock at all, and the alter-between-assert-and-arm race would be back while every check
-- stayed green. The row's xmin carrying THIS transaction's id is direct evidence that the tuple
-- write — and therefore the lock — really happened.
SELECT pg_temp.assert(
  (SELECT j.xmin = pg_current_xact_id()::xid FROM cron.job j
    WHERE j.jobid = (SELECT jobid FROM pg_temp._gate_job)),
  'this transaction really wrote (and therefore holds the row lock on) the job row');
