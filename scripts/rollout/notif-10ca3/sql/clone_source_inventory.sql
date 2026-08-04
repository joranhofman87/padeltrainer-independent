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
--   INFLIGHT <n> | LOGRUN <on|off> | NETQUEUE <n> | HOOKTRIG <n> | FDWSRV <n> | OUTFN <schema.name>
--   EXT <name> | VAULTCOUNT <n>
-- ===========================================================================
\ir _assert.sql
\ir _cron_fp.sql
\ir _cron_inflight.sql

\pset tuples_only on
\pset format unaligned
\pset footer off

-- The record is SPACE-DELIMITED and the reader takes fixed fields, so a job NAME containing
-- whitespace forges the fields after it: pg_cron allows one, and
--   `notification-email-worker filler yes`
-- parses as the reviewed job `notification-email-worker` classified `yes`, with the real active
-- and outbound values never read. That is fail-OPEN in the one place the register trusts as
-- authoritative. A name outside the safe grammar is therefore not emitted as a CRONJOB record at
-- all — it is reported under its own key, which the reader treats as fatal, and the name itself is
-- surfaced only as an md5 so a hostile name cannot inject anything downstream either.
SELECT CASE
         WHEN jobname ~ '^[A-Za-z0-9_.:-]+$'
           THEN format('CRONJOB %s %s %s', jobname, active,
                       CASE WHEN command ~* '(net\.http_(post|get|delete)|http_post|http_get|dblink)'
                            THEN 'yes' ELSE 'no' END)
         ELSE format('CRONJOB_UNSAFE_NAME %s', md5(jobname))
       END
FROM cron.job ORDER BY jobid;

-- the exact configuration the seal will pin, computed identically there
SELECT format('CFGFP %s', pg_temp.cron_config_fp());

-- The fence is a trigger on cron.job, so it needs ownership of that table.
-- Report it HERE, in the read-only step, so the operator learns before anything
-- is paused rather than mid-window.
-- BOTH outbound tables must be fenceable, so both owners are checked.
SELECT format('FENCEABLE %s',
  CASE WHEN pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'cron.job'::regclass), 'USAGE')
        AND pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'net.http_request_queue'::regclass), 'USAGE')
       THEN 'yes' ELSE 'no' END);

SELECT format('PRIORWINDOW %s', count(*)) FROM information_schema.schemata WHERE schema_name = 'rollout_clone';

-- every NON-TERMINAL run, not just status='running' (pg_cron also uses
-- starting/connecting/sending before a job reaches 'running')
SELECT format('INFLIGHT %s', pg_temp.cron_inflight());
SELECT format('LOGRUN %s', coalesce(nullif(current_setting('cron.log_run', true), ''), 'unreadable'));
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
-- SAME SAFE GRAMMAR AS CRONJOB ABOVE, and for the same reason: these records are space-delimited
-- and the reader takes a fixed field, so an identifier containing whitespace forges the fields
-- after it. A function actually named `public."schedule_enrichment_job filler"` emitted
-- `OUTFN public.schedule_enrichment_job filler` and was accepted as the REVIEWED
-- `public.schedule_enrichment_job`. An identifier outside the grammar is reported under its own
-- fatal key instead, as an md5, so a hostile name cannot inject anything downstream either.
-- IDENTITY INCLUDES THE SIGNATURE. PostgreSQL identifies a function by schema, name AND argument
-- types, so `schema.proname` alone collapses overloads: adding `public.schedule_enrichment_job(text)`
-- produced the same key as the reviewed zero-argument function and was accepted as it. The argument
-- list is emitted with its spaces removed so the record stays single-token, and the grammar below
-- admits the punctuation a signature needs — but still no whitespace, which is what forges fields.
SELECT CASE
         WHEN n.nspname ~ '^[A-Za-z0-9_.:-]+$'
          AND p.proname ~ '^[A-Za-z0-9_.:-]+$'
          AND replace(pg_catalog.oidvectortypes(p.proargtypes), ' ', '') ~ '^[A-Za-z0-9_.,:\[\]"-]*$'
           -- TYPES ONLY (oidvectortypes over proargtypes), not
           -- pg_get_function_identity_arguments, which includes PARAMETER NAMES: `p text` became
           -- `ptext` once spaces were stripped, conflating a name with a type.
           THEN format('OUTFN %s.%s(%s)', n.nspname, p.proname,
                       replace(pg_catalog.oidvectortypes(p.proargtypes), ' ', ''))
         ELSE format('OUTFN_UNSAFE_NAME %s', md5(n.nspname || '.' || p.proname))
       END
FROM outbound ob JOIN pg_proc p ON p.oid = ob.oid JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema','net','cron','extensions','vault','pgsodium','supabase_functions','graphql','graphql_public','realtime','storage','auth')
ORDER BY 1;

SELECT CASE
         WHEN extname ~ '^[A-Za-z0-9_.:-]+$' THEN format('EXT %s', extname)
         ELSE format('EXT_UNSAFE_NAME %s', md5(extname))
       END
FROM pg_extension
WHERE extname IN ('pg_net','http','pg_cron','wrappers','dblink','postgres_fdw') ORDER BY 1;

-- count only; contents are never read
SELECT format('VAULTCOUNT %s', count(*)) FROM vault.secrets;
