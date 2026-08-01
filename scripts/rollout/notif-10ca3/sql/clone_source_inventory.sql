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
--   RUNNING <n> | NETQUEUE <n> | HOOKTRIG <n> | FDWSRV <n> | OUTFN <schema.name>
--   EXT <name> | VAULTCOUNT <n>
-- ===========================================================================
\pset tuples_only on
\pset format unaligned
\pset footer off

SELECT format('CRONJOB %s %s %s', jobname, active,
              CASE WHEN command ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
                   THEN 'yes' ELSE 'no' END)
FROM cron.job ORDER BY jobid;

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

SELECT format('OUTFN %s.%s', n.nspname, p.proname)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosrc ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
ORDER BY 1;

SELECT format('EXT %s', extname) FROM pg_extension
WHERE extname IN ('pg_net','http','pg_cron','wrappers','dblink','postgres_fdw') ORDER BY 1;

-- count only; contents are never read
SELECT format('VAULTCOUNT %s', count(*)) FROM vault.secrets;
