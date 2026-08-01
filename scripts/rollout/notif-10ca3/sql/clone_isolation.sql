-- ===========================================================================
-- clone_isolation.sql — CLONE-SIDE provenance + inertness. Fails loudly.
--
-- PROVENANCE IS PROVEN BY THE CLONE'S OWN DATABASE, not asserted by the caller.
-- No environment variable can establish which restore point produced a clone;
-- the objects committed at the seal can, because a Supabase restore copies
-- database state.
--
-- THE EXACT RESTORE-POINT CONTRACT. Four checks bound the window from both ends:
--   marker present with this nonce   -> at or after the SEAL commit
--   marker state = 'sealed'          -> at or after the ARM commit (drained)
--   the FENCE is present + effective -> before the RESUME commit (which drops it)
--   zero ACTIVE cron jobs            -> before the RESUME commit (which restores them)
-- Only a restore point inside the armed, fenced window satisfies all four. The
-- resume performs the unfence, the restore and the marker drop in ONE
-- transaction, so no committed state carries a valid marker beside active cron.
--
-- :nonce  the run nonce recorded by clone-source-quiesce
-- Reads only. Never selects a cron command, pg_net URL/header/body, Vault secret
-- or customer row.
-- ===========================================================================
\ir _assert.sql
\ir _cron_fp.sql
\ir _fence.sql

SELECT pg_temp.assert(
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema = 'rollout_clone' AND table_name = 'snapshot_marker') = 1,
  'clone carries the rollout snapshot-marker table (restored from a SEALED snapshot)');

SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM rollout_clone.snapshot_marker WHERE nonce = :'nonce')::bigint, 1::bigint,
  'clone carries THIS run''s exact snapshot nonce (provenance proven by the clone itself)');

SELECT pg_temp.assert_eq((SELECT state FROM rollout_clone.snapshot_marker), 'sealed',
  'the clone''s marker is ARMED (restore point is at/after the arm commit, so in-flight executions had drained)');

-- the fence proves the restore point PRECEDES the resume, and that no job could
-- have been created in the source between the seal and this restore point
SELECT pg_temp.assert_fence_effective('clone');

-- configuration identity: the clone's cron set is exactly the sealed one
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(), pg_temp.snapshot_config_fp(),
  'the clone''s cron configuration is EXACTLY the one captured at the seal');
SELECT pg_temp.assert_eq(pg_temp.cron_config_fp(),
  (SELECT cron_config_fp FROM rollout_clone.snapshot_marker),
  'the clone''s cron configuration matches the fingerprint recorded in the marker');

-- the marker/fence objects are owner-only in the clone too
DO $acl$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      IF has_schema_privilege(r, 'rollout_clone', 'USAGE') THEN
        RAISE EXCEPTION 'clone ACL: role % can USE the rollout_clone schema', r;
      END IF;
      IF has_function_privilege(r, 'rollout_clone.fence_cron_job()', 'EXECUTE') THEN
        RAISE EXCEPTION 'clone ACL: role % can EXECUTE the fence function', r;
      END IF;
    END IF;
  END LOOP;
  IF has_schema_privilege('public', 'rollout_clone', 'USAGE') THEN
    RAISE EXCEPTION 'clone ACL: PUBLIC can USE the rollout_clone schema';
  END IF;
END $acl$;

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

SELECT pg_temp.note('clone isolation: provenance proven by an ARMED marker nonce inside a still-fenced window; inert (no active cron, no running jobs, empty pg_net queue, no outbound triggers/FDWs); marker objects owner-only');
