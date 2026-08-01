-- ===========================================================================
-- cron_quiet_sample.sql — ONE quiescence sample, read-only.
--
-- The drain loop lives in the shell but its DEFINITION must not: this artifact
-- includes the same _cron_inflight.sql the seal, arm and clone gate use, so
-- there is exactly one notion of "a run is still in flight" in the bundle.
-- Emits: SAMPLE <inflight> <queued> <cron.log_run>
-- ===========================================================================
\ir _assert.sql
\ir _cron_inflight.sql
\pset tuples_only on
\pset format unaligned
\pset footer off
SELECT format('SAMPLE %s %s %s',
  pg_temp.cron_inflight(),
  (SELECT count(*) FROM net.http_request_queue),
  coalesce(nullif(current_setting('cron.log_run', true), ''), 'unreadable'));
