-- ===========================================================================
-- clone_isolation.sql — CLONE-SIDE inertness assertion. Fails loudly.
--
-- Run against a DISPOSABLE CLONE only, before any rehearsal command may touch
-- it. A clone restored from a snapshot that was not quiesced will resume cron
-- with production secrets and contact real customers; this refuses to let any
-- rehearsal proceed until the clone is provably inert.
--
-- Reads only. Never selects a cron command, a pg_net URL/header/body, a Vault
-- secret or any customer row.
-- ===========================================================================
\ir _assert.sql

SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'clone has ZERO ACTIVE cron jobs (a live job would contact real customers)');

SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job_run_details WHERE status = 'running')::bigint, 0::bigint,
  'clone has ZERO RUNNING cron executions');

SELECT pg_temp.assert_eq((SELECT count(*) FROM net.http_request_queue)::bigint, 0::bigint,
  'clone pg_net request queue is EMPTY (a queued request would fire outbound)');

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'http_request')::bigint, 0::bigint,
  'clone has ZERO enabled database-webhook triggers');

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)')::bigint, 0::bigint,
  'clone has ZERO other outbound-capable triggers');

SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_foreign_server)::bigint, 0::bigint,
  'clone has ZERO foreign servers / FDW wrappers');

SELECT pg_temp.note('clone isolation: inert (no active cron, no running jobs, empty pg_net queue, no outbound triggers/FDWs)');
