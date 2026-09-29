-- FORWARD RECOVERY — PTF release. Returns production to the BASE object state it had before PTF:
-- reinstalls the live canonical public.get_players_overview body (restore_canonical_get_players_overview.sql,
-- body sha256 0f42f53c…), then removes the two functions and the schema the release added, each by its
-- exact name and signature and WITHOUT CASCADE (a dependent object makes the DROP fail and the whole
-- transaction roll back). Records it as ledger version 20261208110000. One transaction; same command form
-- as apply.sql:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Use only on a separate, explicit recovery decision (README, "Recovery"). Frontend revert comes first.
-- No CASCADE, no ledger rewind. If this is ever run, the restore file's content plus the three DROP
-- statements below must be committed as supabase/migrations/20261208110000_players_overview_restore_canonical.sql
-- before any later release.
--
-- Accepted starting states (anything else refuses; nothing changes):
--   * FIRST RECOVERY: the 621-version ledger (to 20261208100000) with the PTF object state;
--   * RE-RUN: those 621 plus 20261208110000 with the BASE object state (INSERT 0 0).

SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;
SELECT set_config('ptf_release.expected_sysid', :'expected_sysid', true);

DO $ptf_recovery_guard$
DECLARE
  c_ptf        CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_restored   CONSTANT text := 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e'; -- + 20261208110000
  c_state_base CONSTANT text := 'e6f1ccc592be54132684c36b8bf77611cbe686c4f4115c94d621f196aac32c91';
  c_state_ptf  CONSTANT text := '8b9d2f98127a66387234d6890f59117a516388c65fa776acf67742d619ff749b';
  v_sysid  text := (SELECT system_identifier::text FROM pg_control_system());
  v_rows   bigint := (SELECT count(*) FROM supabase_migrations.schema_migrations);
  v_odd    bigint := (SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version !~ '^[0-9]{14}$');
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_state  text := (
    -- STATE DESCRIPTOR BEGIN: every object this release creates or replaces, one line each, byte-sorted.
    SELECT coalesce(string_agg(d, E'\n' ORDER BY d COLLATE "C"), '') FROM (
      SELECT format('function %s.%s(%s) returns %s owner=%s language=%s volatility=%s security_definer=%s config=%s acl=%s body_sha256=%s',
               n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
               pg_get_userbyid(p.proowner), l.lanname, p.provolatile, p.prosecdef,
               coalesce(array_to_string(p.proconfig, ';'), ''),
               CASE WHEN p.proacl IS NULL THEN 'default'
                    ELSE (SELECT coalesce(string_agg(a, ',' ORDER BY a COLLATE "C"), '') FROM unnest(p.proacl::text[]) a) END,
               encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')) AS d
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE (n.nspname = 'public' AND p.proname IN ('get_players_overview', 'get_players_overview_export'))
          OR n.nspname = 'players_private'
      UNION ALL
      SELECT format('schema %s owner=%s acl=%s relations=%s types=%s', n.nspname, pg_get_userbyid(n.nspowner),
               CASE WHEN n.nspacl IS NULL THEN 'default'
                    ELSE (SELECT coalesce(string_agg(a, ',' ORDER BY a COLLATE "C"), '') FROM unnest(n.nspacl::text[]) a) END,
               (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid),
               (SELECT count(*) FROM pg_type t WHERE t.typnamespace = n.oid))
        FROM pg_namespace n WHERE n.nspname = 'players_private'
    ) s
    -- STATE DESCRIPTOR END
  );
  v_digest text := encode(sha256(convert_to(v_state, 'UTF8')), 'hex');
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
  IF NOT ((v_ledger = c_ptf AND v_digest = c_state_ptf) OR (v_ledger = c_restored AND v_digest = c_state_base)) THEN
    RAISE EXCEPTION 'ptf recovery guard: the object state is not the one this ledger expects (ledger %, state %)', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptf recovery guard: a prepared transaction is open; it may hold migration work';
  END IF;
  v_busy := (
    -- IN-FLIGHT PROBE BEGIN: another session holding or awaiting (a) the migration ledger, (b) the schema lock
    -- that creating a relation takes on public or players_private, (c) a DDL-strength lock (Share or stronger)
    -- on any relation in schema public, or (d) any lock on one of this release's functions. App reads and
    -- DML (AccessShare, RowShare, RowExclusive) do not match, and neither does ShareUpdateExclusive, which
    -- autovacuum and ANALYZE hold. Same text in every packet file.
    SELECT string_agg(DISTINCT coalesce('pid ' || l.pid, 'prepared') || ' ' || l.mode
                      || CASE WHEN l.granted THEN '' ELSE ' (waiting)' END || ' on '
                      || CASE WHEN l.locktype = 'relation' THEN 'relation ' || l.relation::regclass::text
                              WHEN l.classid = 'pg_namespace'::regclass THEN 'schema ' || coalesce((SELECT n.nspname FROM pg_namespace n WHERE n.oid = l.objid), l.objid::text)
                              ELSE 'function ' || coalesce((SELECT p.oid::regprocedure::text FROM pg_proc p WHERE p.oid = l.objid), l.objid::text) END, '; ')
      FROM pg_locks l
     WHERE l.pid IS DISTINCT FROM pg_backend_pid()
       AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND ((l.locktype = 'relation' AND l.relation = 'supabase_migrations.schema_migrations'::regclass)
         OR (l.locktype = 'relation' AND l.mode IN ('ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')
             AND l.relation IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace))
         OR (l.locktype = 'object' AND l.classid = 'pg_namespace'::regclass
             AND l.objid IN (SELECT n.oid FROM pg_namespace n WHERE n.nspname IN ('public', 'players_private')))
         OR (l.locktype = 'object' AND l.classid = 'pg_proc'::regclass
             AND l.objid IN (SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                              WHERE (n.nspname = 'public' AND p.proname IN ('get_players_overview', 'get_players_overview_export'))
                                 OR n.nspname = 'players_private')))
    -- IN-FLIGHT PROBE END
  );
  IF v_busy IS NOT NULL THEN
    RAISE EXCEPTION 'ptf recovery guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptf_recovery_guard$;

-- The canonical list first (it no longer calls the private authority), then the export entry, the
-- authority and their schema — exact signatures, no CASCADE. On a re-run the guard has proved all three
-- are already gone, so IF EXISTS makes these no-ops.
\ir restore_canonical_get_players_overview.sql
DROP FUNCTION IF EXISTS public.get_players_overview_export(uuid, text, jsonb, text, text);
DROP FUNCTION IF EXISTS players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean);
DROP SCHEMA IF EXISTS players_private;
INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261208110000', 'players_overview_restore_canonical'
 WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261208110000');

DO $ptf_recovery_verify$
DECLARE
  c_restored   CONSTANT text := 'b312bf6a1dcc0fbc35c9f2c24e7f947daaf1d312b422534003deeb8ed90b302e';
  c_state_base CONSTANT text := 'e6f1ccc592be54132684c36b8bf77611cbe686c4f4115c94d621f196aac32c91';
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_state  text := (
    -- STATE DESCRIPTOR BEGIN: every object this release creates or replaces, one line each, byte-sorted.
    SELECT coalesce(string_agg(d, E'\n' ORDER BY d COLLATE "C"), '') FROM (
      SELECT format('function %s.%s(%s) returns %s owner=%s language=%s volatility=%s security_definer=%s config=%s acl=%s body_sha256=%s',
               n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid),
               pg_get_userbyid(p.proowner), l.lanname, p.provolatile, p.prosecdef,
               coalesce(array_to_string(p.proconfig, ';'), ''),
               CASE WHEN p.proacl IS NULL THEN 'default'
                    ELSE (SELECT coalesce(string_agg(a, ',' ORDER BY a COLLATE "C"), '') FROM unnest(p.proacl::text[]) a) END,
               encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex')) AS d
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        JOIN pg_language l ON l.oid = p.prolang
       WHERE (n.nspname = 'public' AND p.proname IN ('get_players_overview', 'get_players_overview_export'))
          OR n.nspname = 'players_private'
      UNION ALL
      SELECT format('schema %s owner=%s acl=%s relations=%s types=%s', n.nspname, pg_get_userbyid(n.nspowner),
               CASE WHEN n.nspacl IS NULL THEN 'default'
                    ELSE (SELECT coalesce(string_agg(a, ',' ORDER BY a COLLATE "C"), '') FROM unnest(n.nspacl::text[]) a) END,
               (SELECT count(*) FROM pg_class c WHERE c.relnamespace = n.oid),
               (SELECT count(*) FROM pg_type t WHERE t.typnamespace = n.oid))
        FROM pg_namespace n WHERE n.nspname = 'players_private'
    ) s
    -- STATE DESCRIPTOR END
  );
  v_digest text := encode(sha256(convert_to(v_state, 'UTF8')), 'hex');
BEGIN
  IF v_ledger IS DISTINCT FROM c_restored OR v_digest IS DISTINCT FROM c_state_base THEN
    RAISE EXCEPTION 'ptf recovery verify: end state wrong (ledger %, state %); rolled back', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  RAISE NOTICE 'ptf recovery: object state % (the base), ledger 622 to 20261208110000', c_state_base;
END
$ptf_recovery_verify$;
