-- ===========================================================================
-- clone_source_seal.sql — THE SNAPSHOT BOUNDARY, in ONE transaction.
--
-- Everything that makes a snapshot safe must be true AT THE SAME INSTANT, and
-- must stay true until the snapshot is taken. Separate queries cannot give that:
-- public.schedule_enrichment_job / schedule_logo_fetch_job /
-- schedule_invoice_health_check_job call cron.schedule at RUNTIME, so a job can
-- appear between an "all inactive" check and the snapshot point.
--
-- LINEARIZATION: this transaction takes ACCESS EXCLUSIVE on cron.job. cron.schedule
-- and cron.alter_job both write that table, so no session can add, remove or
-- re-activate a job while we verify and mark. The COMMIT of this transaction IS
-- the snapshot boundary; the marker row and every assertion below share it.
--
-- :nonce     unique per-run id, becomes the database-resident provenance proof
-- :expect_fp md5 of the sorted "jobid:jobname" set captured in the manifest
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql

BEGIN;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '60s';

-- serialize against cron.schedule / cron.alter_job for the rest of the tx
LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE;

-- (a) the job set is EXACTLY the one the manifest captured — no runtime arrival
SELECT pg_temp.assert_eq(
  (SELECT md5(string_agg(jobid::text || ':' || jobname, E'\n' ORDER BY jobid)) FROM cron.job),
  :'expect_fp',
  'cron job set at the boundary is EXACTLY the reviewed/captured set (no job created since capture)');

-- (b) every job is inactive
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'zero ACTIVE cron jobs at the boundary');

-- (c) nothing is mid-flight
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job_run_details WHERE status = 'running')::bigint, 0::bigint,
  'zero RUNNING cron executions at the boundary');

-- (d) no queued outbound request would fire in a restore
SELECT pg_temp.assert_eq((SELECT count(*) FROM net.http_request_queue)::bigint, 0::bigint,
  'pg_net request queue is EMPTY at the boundary');

-- (e) the marker: database-resident provenance. A restore taken at/after this
--     COMMIT carries it; any other restore point does not.
CREATE SCHEMA IF NOT EXISTS rollout_clone;
CREATE TABLE IF NOT EXISTS rollout_clone.snapshot_marker (
  nonce            text        PRIMARY KEY,
  sealed_at        timestamptz NOT NULL DEFAULT now(),
  cron_fingerprint text        NOT NULL,
  job_count        integer     NOT NULL
);
DELETE FROM rollout_clone.snapshot_marker;          -- exactly one marker may exist
INSERT INTO rollout_clone.snapshot_marker (nonce, cron_fingerprint, job_count)
SELECT :'nonce',
       md5(string_agg(jobid::text || ':' || jobname, E'\n' ORDER BY jobid)),
       count(*)
FROM cron.job;

SELECT pg_temp.assert_eq((SELECT count(*) FROM rollout_clone.snapshot_marker WHERE nonce = :'nonce')::bigint, 1::bigint,
  'exactly one snapshot marker carrying this run''s nonce');

COMMIT;

-- the boundary instant, for the operator's restore UI (correctness does not
-- depend on reading it correctly: the clone must carry the marker itself)
\pset tuples_only on
\pset format unaligned
SELECT 'SEALED_AT ' || to_char(sealed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
FROM rollout_clone.snapshot_marker WHERE nonce = :'nonce';
