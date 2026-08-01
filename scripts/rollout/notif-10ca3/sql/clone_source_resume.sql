-- ===========================================================================
-- clone_source_resume.sql — ONE atomic transition out of the sealed window.
--
-- Verify -> unfence -> restore -> prove -> drop the marker, all inside a single
-- transaction holding ACCESS EXCLUSIVE on cron.job. Consequences:
--
--   * BEFORE the commit: marker present, every job inactive, fence in force.
--   * AFTER  the commit: marker absent, fence gone, exact prior state restored.
--   * There is NO committed state in which a valid marker coexists with active
--     cron, so no restore point can produce a clone that boots and sends.
--   * A failure at any step rolls the whole thing back: production stays paused
--     and fenced with its marker intact, and the operator retries. Nothing is
--     ever left half-restored.
--
-- Restoration reads rollout_clone.snapshot_job_state — a relation captured by
-- the seal from cron.job itself. No manifest text is ever interpolated into SQL.
--
-- :nonce          the run nonce
-- :allow_unarmed  '1' only for the explicit, reviewed clone-source-abandon path
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql
\ir _cron_fp.sql
\ir _fence.sql
\ir _cron_inflight.sql

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SELECT pg_temp.assert(pg_try_advisory_xact_lock(431097, 626),
  'no other clone-safety quiesce/resume is running');
LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE;

-- (a) the sealed state is exactly this run's, and armed unless recovery was asked for
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM rollout_clone.snapshot_marker
    WHERE nonce = :'nonce' AND (state = 'sealed' OR :'allow_unarmed' = '1'))::bigint,
  1::bigint, 'this run''s marker exists in the expected state');
SELECT pg_temp.assert_fence_effective('resume');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'every job is still inactive at the start of the resume');

-- (b) the configuration is untouched: nothing drifted while the window was open
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(), pg_temp.snapshot_config_fp(),
  'cron configuration matches the sealed snapshot EXACTLY (schedule, database, username, command hash and node all included)');
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(),
  (SELECT cron_config_fp FROM rollout_clone.snapshot_marker),
  'cron configuration matches the fingerprint recorded in the marker');

-- (c) drop the fence — inside this transaction, so no other session ever sees
--     an unfenced cron.job while the marker is still present
DROP TRIGGER rollout_clone_fence_dml ON cron.job;
DROP TRIGGER rollout_clone_fence_truncate ON cron.job;
DROP TRIGGER rollout_clone_fence_netq ON net.http_request_queue;

-- (d) restore EXACTLY the recorded prior state, driven by the captured relation
SELECT cron.alter_job(s.jobid, active := s.prior_active)
FROM rollout_clone.snapshot_job_state s;

-- (e) prove exact set + configuration + state equality. A FULL OUTER JOIN counts
--     missing, extra, renamed, re-id'd and drifted rows in one number.
SELECT pg_temp.assert_eq(
  (SELECT count(*)
     FROM cron.job j
     FULL OUTER JOIN rollout_clone.snapshot_job_state s
       ON s.jobid = j.jobid AND s.jobname = j.jobname
    WHERE j.jobid IS NULL
       OR s.jobid IS NULL
       OR j.schedule                IS DISTINCT FROM s.schedule
       OR j.database                IS DISTINCT FROM s.database
       OR j.username                IS DISTINCT FROM s.username
       OR md5(j.command)            IS DISTINCT FROM s.command_md5
       OR coalesce(j.nodename, '')  IS DISTINCT FROM s.nodename
       OR j.nodeport                IS DISTINCT FROM s.nodeport
       OR j.active                  IS DISTINCT FROM s.prior_active)::bigint,
  0::bigint,
  'production cron restored to its EXACT recorded set, configuration and active state');

-- (f) the marker must not outlive the window; clones keep their own copy
DROP TABLE rollout_clone.snapshot_marker;
DROP TABLE rollout_clone.snapshot_job_state;
DROP FUNCTION rollout_clone.fence_cron_job();
DROP SCHEMA rollout_clone;

SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.schemata WHERE schema_name = 'rollout_clone') = 0,
  'the sealed window is fully removed from production');
SELECT pg_temp.assert(
  (SELECT count(*) FROM pg_trigger
    WHERE tgrelid IN ('cron.job'::regclass, 'net.http_request_queue'::regclass)
      AND NOT tgisinternal AND tgname LIKE 'rollout\_clone\_fence%') = 0,
  'every fence is gone from cron.job and the pg_net queue');

COMMIT;

\pset tuples_only on
\pset format unaligned
\pset footer off
SELECT 'RESUME_OBSERVED_AFTER_COMMIT ' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
