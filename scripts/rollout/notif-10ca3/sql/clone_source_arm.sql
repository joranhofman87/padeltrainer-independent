-- ===========================================================================
-- clone_source_arm.sql — promote 'sealing' -> 'sealed' once in-flight cron
-- executions have drained. Only an ARMED window may be restored from.
--
-- The fence has been in force since the seal committed, so nothing can have been
-- created or re-activated in between; this transaction re-proves that rather
-- than assuming it.
-- :nonce  the run nonce
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql
\ir _cron_fp.sql
\ir _fence.sql

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';
SELECT pg_temp.assert(pg_try_advisory_xact_lock(431097, 626),
  'no other clone-safety quiesce/resume is running');
LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE;

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM rollout_clone.snapshot_marker WHERE nonce = :'nonce' AND state = 'sealing')::bigint,
  1::bigint, 'this run''s marker exists and is still un-armed');

SELECT pg_temp.assert_fence_effective('arm');

-- the fence held: nothing was created, removed or reconfigured since the seal
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(), pg_temp.snapshot_config_fp(),
  'cron configuration is UNCHANGED since the seal (the fence held)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'zero ACTIVE cron jobs');
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job_run_details WHERE status = 'running')::bigint, 0::bigint,
  'zero RUNNING cron executions (drained)');
SELECT pg_temp.assert_eq((SELECT count(*) FROM net.http_request_queue)::bigint, 0::bigint,
  'pg_net request queue is EMPTY');

UPDATE rollout_clone.snapshot_marker
   SET state = 'sealed', armed_at = clock_timestamp()
 WHERE nonce = :'nonce';

COMMIT;

\pset tuples_only on
\pset format unaligned
\pset footer off
SELECT 'ARM_OBSERVED_AFTER_COMMIT ' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
