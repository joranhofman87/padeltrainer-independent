-- ===========================================================================
-- clone_source_seal.sql — capture, pause, FENCE and mark, in ONE transaction.
--
-- WHY A FENCE AND NOT JUST A LOCK. An ACCESS EXCLUSIVE lock ends at COMMIT.
-- Production stays paused while restores are requested, and during that interval
-- public.schedule_enrichment_job / schedule_logo_fetch_job /
-- schedule_invoice_health_check_job — all SECURITY DEFINER, so they run as their
-- OWNER and ignore role-level REVOKEs — or a direct cron.schedule can create an
-- ACTIVE job. A clone restored after that point boots and runs it. The commit
-- lock therefore protects nothing after the commit, and this file never claims
-- that it does.
--
-- The fence is a statement-level BEFORE INSERT/UPDATE/DELETE/TRUNCATE trigger on
-- cron.job. A trigger fires regardless of the calling role, regardless of
-- SECURITY DEFINER, and regardless of table privileges, so it rejects the write
-- AT THE SOURCE. It is ordinary database state, so a restore copies it into the
-- clone, and it needs no long-lived local shell to stay in force.
--
-- ORDER MATTERS: capture prior state -> pause -> install fence -> prove the fence
-- -> mark. Pausing after the fence is installed would be blocked by our own fence.
--
-- :nonce      per-run provenance id (32+ hex)
-- :expect_fp  the cron CONFIGURATION fingerprint from the reviewed inventory
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql
\ir _cron_fp.sql
\ir _fence.sql

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';

-- (0) run-level exclusion: two operators must never seal concurrently
SELECT pg_temp.assert(pg_try_advisory_xact_lock(431097, 626),
  'no other clone-safety quiesce/resume is running (advisory lock acquired)');

-- (1) never overwrite or silently reuse a prior window. A stale marker is an
--     operator decision, not something this script may resolve on its own.
SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'rollout_clone') = 0,
  'no prior sealed window exists (if this fails: a previous run was not resumed — use clone-source-abandon with its nonce)');

-- (2) serialize against cron.schedule / cron.alter_job for the rest of the tx
LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE;

-- (3) the live CONFIGURATION is exactly the one the read-only review classified
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(), :'expect_fp',
  'cron configuration is EXACTLY the reviewed set (id, name, schedule, database, username, command hash, node)');

-- (4) provenance + expected-state objects. CREATE SCHEMA without IF NOT EXISTS:
--     a concurrent or stale window makes this fail rather than be overwritten.
CREATE SCHEMA rollout_clone;

CREATE TABLE rollout_clone.snapshot_marker (
  only_row        boolean     PRIMARY KEY DEFAULT true CHECK (only_row),   -- at most one row, structurally
  nonce           text        NOT NULL CHECK (nonce ~ '^[0-9a-f]{32,}$'),
  state           text        NOT NULL CHECK (state IN ('sealing', 'sealed')),
  cron_config_fp  text        NOT NULL,
  job_count       integer     NOT NULL,
  sealed_tx_start timestamptz NOT NULL,     -- now() = TRANSACTION START, not the commit instant
  armed_at        timestamptz               -- clock_timestamp() in the arm tx; informational only
);

CREATE TABLE rollout_clone.snapshot_job_state (
  jobid        bigint  PRIMARY KEY,
  jobname      text    NOT NULL UNIQUE,
  schedule     text    NOT NULL,
  database     text    NOT NULL,
  username     text    NOT NULL,
  command_md5  text    NOT NULL,            -- never the command itself
  nodename     text    NOT NULL,
  nodeport     integer NOT NULL,
  prior_active boolean NOT NULL
);

-- owner only. These objects decide whether a clone is trusted, so they must not
-- inherit ambient defaults (this project has been bitten by default grants).
REVOKE ALL ON SCHEMA rollout_clone FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA rollout_clone FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rollout_clone FROM PUBLIC;
DO $acl$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA rollout_clone FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA rollout_clone FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rollout_clone FROM %I', r);
    END IF;
  END LOOP;
END $acl$;

-- (5) capture the EXACT prior state BEFORE pausing. This relation — not a file
--     and not shell text — is the authority for restoration.
INSERT INTO rollout_clone.snapshot_job_state
SELECT jobid, jobname, schedule, database, username, md5(command),
       coalesce(nodename, ''), nodeport, active
FROM cron.job;

-- (6) pause. Reversible by construction: never cron.unschedule.
SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active;

-- (7) the fence. Installed AFTER the pause because it blocks our own writes too.
CREATE OR REPLACE FUNCTION rollout_clone.fence_cron_job() RETURNS trigger
LANGUAGE plpgsql AS $fence$
BEGIN
  RAISE EXCEPTION
    'clone-safety fence: cron.job is FROZEN for the sealed snapshot window (nonce %). No cron job may be created, altered, removed or truncated until clone-source-resume runs.',
    coalesce((SELECT nonce FROM rollout_clone.snapshot_marker LIMIT 1), '<pending>')
    USING ERRCODE = '42501';
END $fence$;
REVOKE ALL ON FUNCTION rollout_clone.fence_cron_job() FROM PUBLIC;

CREATE TRIGGER rollout_clone_fence_dml
  BEFORE INSERT OR UPDATE OR DELETE ON cron.job
  FOR EACH STATEMENT EXECUTE FUNCTION rollout_clone.fence_cron_job();
CREATE TRIGGER rollout_clone_fence_truncate
  BEFORE TRUNCATE ON cron.job
  FOR EACH STATEMENT EXECUTE FUNCTION rollout_clone.fence_cron_job();

-- (8) PROVE the fence — presence is not effectiveness
SELECT pg_temp.assert_fence_effective('seal');

-- (9) inert at the boundary
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'zero ACTIVE cron jobs');
SELECT pg_temp.assert_eq((SELECT count(*) FROM net.http_request_queue)::bigint, 0::bigint,
  'pg_net request queue is EMPTY');

-- (10) the marker. state='sealing' until in-flight executions have drained and
--      clone_source_arm.sql promotes it — a clone may only come from an ARMED
--      window, so a restore taken during the drain is refused.
INSERT INTO rollout_clone.snapshot_marker (nonce, state, cron_config_fp, job_count, sealed_tx_start)
SELECT :'nonce', 'sealing', pg_temp.cron_config_fp(), count(*), now() FROM cron.job;

SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(), pg_temp.snapshot_config_fp(),
  'the captured expected-state relation describes exactly the live cron configuration');

COMMIT;

\pset tuples_only on
\pset format unaligned
\pset footer off
-- Informational ONLY. now() inside the tx is transaction-start time and this
-- reading is taken after the commit returned, so neither is the commit instant.
-- Provenance is established by the nonce in the database, never by a timestamp.
SELECT 'SEAL_OBSERVED_AFTER_COMMIT ' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
