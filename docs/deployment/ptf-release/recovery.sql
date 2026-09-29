-- FORWARD RECOVERY — PTF release. Reinstalls the live canonical public.get_players_overview body that
-- production ran before PTF (restore_canonical_get_players_overview.sql, body sha256 0f42f53c…) and
-- records it as ledger version 20261208110000. One transaction; same command form as apply.sql:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Use only on a separate, explicit recovery decision (README, "Recovery"). Frontend revert comes first.
-- No DROP, no CASCADE, no ledger rewind. If this is ever run, the restore file's content must be committed
-- as supabase/migrations/20261208110000_players_overview_restore_canonical.sql before any later release.
--
-- Accepted starting states (anything else refuses; nothing changes):
--   * FIRST RECOVERY: the 621-version ledger (to 20261208100000) with the PTF body;
--   * RE-RUN: those 621 plus 20261208110000 with the canonical body (INSERT 0 0).

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;
SELECT set_config('ptf_release.expected_sysid', :'expected_sysid', true);

DO $ptf_recovery_guard$
DECLARE
  c_ptf       CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_restored  CONSTANT text := 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e'; -- + 20261208110000
  c_body_live CONSTANT text := '0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4';
  c_body_ptf  CONSTANT text := '22695d9ce5ccd20617d98af9123712701d55c8198ee0d607bd08a62fd503b8b2';
  c_args      CONSTANT text := 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer';
  c_acl       CONSTANT text := 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres';
  v_sysid  text := (SELECT system_identifier::text FROM pg_control_system());
  v_rows   bigint := (SELECT count(*) FROM supabase_migrations.schema_migrations);
  v_odd    bigint := (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version !~ '^[0-9]{14}$');
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_fns    bigint := (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'get_players_overview');
  v_args   text;
  v_body   text;
  v_acl    text;
  v_busy   text;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'ptf recovery guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptf recovery guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptf_release.expected_sysid') THEN
    RAISE EXCEPTION 'ptf recovery guard: system identifier %, expected %', v_sysid, current_setting('ptf_release.expected_sysid');
  END IF;
  IF v_odd <> 0 OR (v_ledger IS DISTINCT FROM c_ptf AND v_ledger IS DISTINCT FROM c_restored) THEN
    RAISE EXCEPTION 'ptf recovery guard: the ledger is neither the 621 versions to 20261208100000 nor those plus 20261208110000 (% rows, % not 14 digits, digest %)',
      v_rows, v_odd, v_ledger;
  END IF;
  IF v_fns <> 1 THEN
    RAISE EXCEPTION 'ptf recovery guard: expected exactly one public.get_players_overview, found %', v_fns;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid),
         encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
         (SELECT string_agg(a, ',' ORDER BY a COLLATE "C") FROM unnest(coalesce(p.proacl, '{}'::aclitem[])::text[]) a)
    INTO v_args, v_body, v_acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_players_overview';
  IF v_args IS DISTINCT FROM c_args THEN
    RAISE EXCEPTION 'ptf recovery guard: unexpected get_players_overview signature (%)', v_args;
  END IF;
  IF v_acl IS DISTINCT FROM c_acl THEN
    RAISE EXCEPTION 'ptf recovery guard: get_players_overview privileges drifted (%), expected %', v_acl, c_acl;
  END IF;
  IF NOT ((v_ledger = c_ptf AND v_body = c_body_ptf) OR (v_ledger = c_restored AND v_body = c_body_live)) THEN
    RAISE EXCEPTION 'ptf recovery guard: ledger and function body disagree or the body is unknown (ledger %, body %)', v_ledger, v_body;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptf recovery guard: a prepared transaction is open; it may hold migration work';
  END IF;
  v_busy := (
    -- IN-FLIGHT PROBE BEGIN (same text as apply.sql)
    SELECT string_agg(DISTINCT coalesce('pid ' || l.pid, 'prepared') || ' ' || l.mode
                      || CASE WHEN l.granted THEN '' ELSE ' (waiting)' END || ' on '
                      || CASE WHEN l.locktype = 'object' THEN 'schema public' ELSE 'the migration ledger' END, '; ')
      FROM pg_locks l
     WHERE l.pid IS DISTINCT FROM pg_backend_pid()
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND ((l.locktype = 'relation' AND l.relation = 'supabase_migrations.schema_migrations'::regclass)
         OR (l.locktype = 'object' AND l.classid = 'pg_namespace'::regclass AND l.objid = 'public'::regnamespace))
    -- IN-FLIGHT PROBE END
  );
  IF v_busy IS NOT NULL THEN
    RAISE EXCEPTION 'ptf recovery guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptf_recovery_guard$;

\ir restore_canonical_get_players_overview.sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261208110000', 'players_overview_restore_canonical'
 WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261208110000');

DO $ptf_recovery_verify$
DECLARE
  c_restored  CONSTANT text := 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e';
  c_body_live CONSTANT text := '0f42f53cab95b897e10ee0295f9185de15056a0cd904252c84bb117e0b7003f4';
  c_args      CONSTANT text := 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer';
  c_acl       CONSTANT text := 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres';
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_args text;
  v_body text;
  v_acl  text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid),
         encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
         (SELECT string_agg(a, ',' ORDER BY a COLLATE "C") FROM unnest(coalesce(p.proacl, '{}'::aclitem[])::text[]) a)
    INTO v_args, v_body, v_acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_players_overview';
  IF v_ledger IS DISTINCT FROM c_restored OR v_body IS DISTINCT FROM c_body_live
     OR v_args IS DISTINCT FROM c_args OR v_acl IS DISTINCT FROM c_acl THEN
    RAISE EXCEPTION 'ptf recovery verify: end state wrong (ledger %, body %, args %, acl %); rolled back', v_ledger, v_body, v_args, v_acl;
  END IF;
  RAISE NOTICE 'ptf recovery: get_players_overview body %, ledger 622 to 20261208110000, privileges unchanged', c_body_live;
END
$ptf_recovery_verify$;
