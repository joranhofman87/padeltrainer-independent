-- ===========================================================================
-- clone_source_inventory.sql — READ-ONLY outbound-capability inventory.
--
-- A restored Supabase project resumes pg_cron immediately and carries the
-- ORIGINAL secrets (Vault, service-role keys). On this project that means
-- notification-email-worker and notification-whatsapp-worker — both on */2 —
-- would contact REAL CUSTOMERS within minutes of the clone booting. Nothing may
-- be cloned until the source snapshot is provably inert.
--
-- SAFE METADATA ONLY. Never selects a cron command, a pg_net URL/header/body, a
-- Vault secret or any customer row. Commands are surfaced as md5 only.
-- Reads only; mutates nothing. Safe to run against production.
--
-- Emits stable machine-readable lines for the caller to classify:
--   CRONJOB <name> <active> <outbound>
--   CFGFP <md5>      the cron CONFIGURATION fingerprint the seal will require
--   FENCEABLE <yes|no>  can this role create the fence trigger on cron.job?
--   PRIORWINDOW <n>  a sealed window already exists (must be 0 before sealing)
--   RUNNING <n> | NETQUEUE <n> | HOOKTRIG <n> | FDWSRV <n> | OUTFN <schema.name>
--   EXT <name> | VAULTCOUNT <n>
-- ===========================================================================
\ir _assert.sql
\ir _cron_fp.sql

\pset tuples_only on
\pset format unaligned
\pset footer off

SELECT format('CRONJOB %s %s %s', jobname, active,
              CASE WHEN command ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
                   THEN 'yes' ELSE 'no' END)
FROM cron.job ORDER BY jobid;

-- the exact configuration the seal will pin, computed identically there
SELECT format('CFGFP %s', pg_temp.cron_config_fp());

-- The fence is a trigger on cron.job, so it needs ownership of that table.
-- Report it HERE, in the read-only step, so the operator learns before anything
-- is paused rather than mid-window.
SELECT format('FENCEABLE %s',
  CASE WHEN pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'cron.job'::regclass), 'USAGE')
       THEN 'yes' ELSE 'no' END);

SELECT format('PRIORWINDOW %s', count(*)) FROM information_schema.schemata WHERE schema_name = 'rollout_clone';

SELECT format('RUNNING %s', count(*)) FROM cron.job_run_details WHERE status = 'running';
SELECT format('NETQUEUE %s', count(*)) FROM net.http_request_queue;

-- supabase database webhooks are triggers on supabase_functions.http_request
SELECT format('HOOKTRIG %s', count(*))
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND p.proname = 'http_request';

-- any OTHER non-internal trigger whose function can reach the network
SELECT format('OUTTRIG %s', count(*))
FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal
  AND p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)';

SELECT format('FDWSRV %s', count(*)) FROM pg_foreign_server;

-- OUTFN: the TRANSITIVE closure of outbound-capable functions. A helper that
-- only indirectly reaches net.http_* is still an outbound mechanism, so a direct
-- prosrc scan alone would under-report. Depth is bounded by the recursion.
WITH RECURSIVE outbound(oid) AS (
  SELECT p.oid FROM pg_proc p
   WHERE p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
  UNION
  SELECT c.oid FROM pg_proc c JOIN outbound o ON true
   WHERE c.oid <> o.oid
     AND c.prosrc ~* ('\m' || (SELECT proname FROM pg_proc WHERE oid = o.oid) || '\M')
)
SELECT format('OUTFN %s.%s', n.nspname, p.proname)
FROM outbound ob JOIN pg_proc p ON p.oid = ob.oid JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','net','cron','extensions','vault','pgsodium','supabase_functions','graphql','graphql_public','realtime','storage','auth')
ORDER BY 1;

SELECT format('EXT %s', extname) FROM pg_extension
WHERE extname IN ('pg_net','http','pg_cron','wrappers','dblink','postgres_fdw') ORDER BY 1;

-- count only; contents are never read
SELECT format('VAULTCOUNT %s', count(*)) FROM vault.secrets;
