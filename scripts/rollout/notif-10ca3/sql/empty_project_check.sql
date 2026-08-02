-- ===========================================================================
-- empty_project_check.sql — prove a DISPOSABLE project is EMPTY and OUTBOUND-INERT
-- BEFORE anything is loaded into it.
--
-- This replaces the withdrawn "restore production, then fence it" model. The
-- new rehearsal target starts as a fresh Supabase project that has never held
-- customer data, so there is nothing to quiesce and nothing to fence: the
-- properties below are proven, not manufactured.
--
-- What a restore WOULD have copied and this project therefore does not have:
--   cron jobs (active or otherwise), pg_net queue entries and responses, Vault
--   secrets, database webhooks, outbound triggers, FDW servers, auth users and
--   sessions, and every customer row.
--
-- Reads only. Never selects a cron command, pg_net URL/header/body, Vault
-- secret or any row of application data.
-- ===========================================================================
\ir _assert.sql

-- (1) no scheduler at all. Not "paused" — none. pg_cron may not even be
--     installed, which is the strongest form of this property.
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job' INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'target project has % cron job(s) — it is not a pristine disposable project', n;
    END IF;
    RAISE NOTICE 'cron.job exists and holds zero jobs';
  ELSE
    RAISE NOTICE 'no cron.job relation in the target project';
  END IF;
END $$;

-- (2) nothing queued or recorded on the outbound path
DO $$
DECLARE q bigint := 0; r bigint := 0;
BEGIN
  IF to_regclass('net.http_request_queue') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM net.http_request_queue' INTO q;
    IF to_regclass('net._http_response') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM net._http_response' INTO r; END IF;
    IF q <> 0 OR r <> 0 THEN
      RAISE EXCEPTION 'target project has % queued request(s) and % recorded response(s) — not pristine', q, r;
    END IF;
    RAISE NOTICE 'pg_net queue and response relations are empty';
  ELSE
    RAISE NOTICE 'no pg_net relations in the target project';
  END IF;
END $$;

-- (3) no Vault secrets. A restored project carries production's provider API
--     keys; a fresh one has none, and this proves it by COUNT only.
DO $$
DECLARE v bigint := 0;
BEGIN
  IF to_regclass('vault.secrets') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM vault.secrets' INTO v;
    IF v <> 0 THEN
      RAISE EXCEPTION 'target project holds % Vault secret(s) — a rehearsal target must hold none', v;
    END IF;
  END IF;
  RAISE NOTICE 'zero Vault secrets';
END $$;

-- (4) no database webhooks and no outbound-capable triggers, including nested
--     call paths (a trigger whose function only INDIRECTLY reaches the network)
SELECT pg_temp.assert_eq(
  (SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.proname = 'http_request')::bigint, 0::bigint,
  'zero database-webhook triggers');

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
  0::bigint, 'zero outbound-capable triggers, including nested call paths');

SELECT pg_temp.assert_eq((SELECT count(*) FROM pg_foreign_server)::bigint, 0::bigint,
  'zero foreign servers / FDW wrappers');

-- (5) no authentication data. A restore copies auth.users and live sessions;
--     a rehearsal target must carry neither.
DO $$
DECLARE u bigint := 0;
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM auth.users' INTO u;
    IF u <> 0 THEN
      RAISE EXCEPTION 'target project holds % auth user(s) — a rehearsal target must hold none', u;
    END IF;
  END IF;
  RAISE NOTICE 'zero auth users';
END $$;

-- (6) NO APPLICATION STATE. The checks above prove the target cannot SEND;
--     these prove it is genuinely FRESH. Without them a project holding customer
--     tables and rows — but no cron, Vault or auth — passes, and the baseline
--     loader then TRUNCATEs and rewrites tables that are not ours to touch.
--     Platform-owned schemas are allow-listed; `public` must be empty.
DO $$
DECLARE n bigint; sample text;
BEGIN
  SELECT count(*), min(c.relname) INTO n, sample
  FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
  WHERE ns.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')      -- tables, partitions, views, matviews, foreign
    AND c.relname NOT IN ('spatial_ref_sys');       -- reviewed: PostGIS ships it, never app data
  IF n <> 0 THEN
    RAISE EXCEPTION 'public holds % application relation(s) (e.g. %) — this is not a fresh project, and the baseline loader must never truncate tables it did not create', n, sample;
  END IF;
END $$;

-- (7) NO MIGRATION LEDGER. A ledger entry means a chain was already applied
--     here; the next `db push` would then apply a SUFFIX and the "full chain"
--     claim would be false.
DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM supabase_migrations.schema_migrations' INTO n;
  END IF;
  IF n <> 0 THEN
    RAISE EXCEPTION 'the migration ledger already holds % row(s) — this project has been built before', n;
  END IF;
END $$;

-- (8) NO STORAGE OBJECTS OR BUCKETS. Both are platform-owned and survive a
--     schema drop, so their presence means prior application state.
DO $$
DECLARE b bigint := 0; o bigint := 0;
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM storage.buckets' INTO b; END IF;
  IF to_regclass('storage.objects') IS NOT NULL THEN EXECUTE 'SELECT count(*) FROM storage.objects' INTO o; END IF;
  IF b <> 0 OR o <> 0 THEN
    RAISE EXCEPTION 'storage holds % bucket(s) and % object(s) — this is not a fresh project', b, o;
  END IF;
END $$;

SELECT pg_temp.note('empty-project check: no cron jobs, no queued/recorded pg_net traffic, no Vault secrets, no webhooks or outbound triggers, no FDWs, no auth users, no application relations, no migration ledger, no storage state — fresh AND outbound-inert by construction');
