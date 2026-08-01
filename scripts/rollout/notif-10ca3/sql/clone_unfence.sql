-- ===========================================================================
-- clone_unfence.sql — CLONE-ONLY. Remove the fence from a disposable clone so a
-- rehearsal whose migrations create cron jobs can proceed.
--
-- Never run against production: production leaves the window through
-- clone_source_resume.sql, which restores prior state atomically. Here the
-- marker is deliberately KEPT so provenance stays provable after unfencing;
-- only the write barrier is lifted. The caller has already proven this URL is a
-- clone (CLONE_REF != EXPECTED_REF and the URL addresses CLONE_REF exactly).
-- ===========================================================================
\set ON_ERROR_STOP on
\ir _assert.sql
BEGIN;
SET LOCAL lock_timeout = '15s';
LOCK TABLE cron.job IN ACCESS EXCLUSIVE MODE;
SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'the clone is still inert (no active cron) before the fence is lifted');
DROP TRIGGER IF EXISTS rollout_clone_fence_dml ON cron.job;
DROP TRIGGER IF EXISTS rollout_clone_fence_truncate ON cron.job;
DROP TRIGGER IF EXISTS rollout_clone_fence_netq ON net.http_request_queue;
COMMIT;
SELECT pg_temp.note('clone unfenced (marker retained; cron remains inactive)');
