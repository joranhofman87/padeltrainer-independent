-- ===========================================================================
-- clone_isolation.sql — CLONE-SIDE provenance + inertness. Fails loudly.
--
-- PROVENANCE IS PROVEN BY THE CLONE'S OWN DATABASE, not asserted by the caller.
-- An environment variable cannot establish which restore point produced a clone;
-- the marker committed at the snapshot boundary can, because a Supabase restore
-- copies database state. The clone must carry the exact nonce.
--
-- The two marker checks together give an EXACT restore-point contract, replacing
-- the old ambiguous "at/after the timestamp":
--   * the marker with this nonce EXISTS  -> the restore point is at/after the seal
--   * zero cron jobs are ACTIVE          -> the restore point is before the resume
-- Only points inside the sealed window satisfy both.
--
-- :nonce  the run nonce recorded by clone-source-seal
-- Reads only. Never selects a cron command, pg_net URL/header/body, Vault secret
-- or customer row.
-- ===========================================================================
\ir _assert.sql

SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'rollout_clone' AND table_name = 'snapshot_marker') = 1,
  'clone carries the rollout snapshot-marker table (restored from a SEALED snapshot)');

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM rollout_clone.snapshot_marker WHERE nonce = :'nonce')::bigint, 1::bigint,
  'clone carries THIS run''s exact snapshot nonce (provenance proven by the clone itself)');

SELECT pg_temp.assert_eq((SELECT count(*) FROM rollout_clone.snapshot_marker)::bigint, 1::bigint,
  'clone carries exactly one marker (no stale marker from an earlier run)');

-- the marker's own fingerprint must still describe this clone's cron set: a
-- restore that picked up jobs created after the seal is rejected here.
SELECT pg_temp.assert_eq(
  (SELECT cron_fingerprint FROM rollout_clone.snapshot_marker LIMIT 1),
  (SELECT md5(string_agg(jobid::text || ':' || jobname, E'\n' ORDER BY jobid)) FROM cron.job),
  'the clone''s cron set matches the set sealed at the snapshot boundary');

SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job WHERE active)::bigint, 0::bigint,
  'clone has ZERO ACTIVE cron jobs (also proves the restore point precedes the production resume)');

SELECT pg_temp.assert_eq((SELECT count(*) FROM cron.job_run_details WHERE status = 'running')::bigint, 0::bigint,
  'clone has ZERO RUNNING cron executions');

SELECT pg_temp.assert_eq((SELECT count(*) FROM net.http_request_queue)::bigint, 0::bigint,
  'clone pg_net request queue is EMPTY');

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'http_request')::bigint, 0::bigint,
  'clone has ZERO enabled database-webhook triggers');

-- nested paths too: a trigger whose function only INDIRECTLY reaches the network
WITH RECURSIVE outbound(oid) AS (
  SELECT p.oid FROM pg_proc p
   WHERE p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
  UNION
  SELECT c.oid FROM pg_proc c JOIN outbound o ON true
   WHERE c.oid <> o.oid
     AND c.prosrc ~* ('\m' || (SELECT proname FROM pg_proc WHERE oid = o.oid) || '\M')
)
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM outbound))::bigint,
  0::bigint,
  'clone has ZERO outbound-capable triggers, including nested call paths');

SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_foreign_server)::bigint, 0::bigint,
  'clone has ZERO foreign servers / FDW wrappers');

SELECT pg_temp.note('clone isolation: provenance proven by marker nonce; inert (no active cron, no running jobs, empty pg_net queue, no outbound triggers/FDWs)');
