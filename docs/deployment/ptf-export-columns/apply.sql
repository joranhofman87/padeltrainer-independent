-- APPLY — PTF export follow-up (training/profile CSV columns, owner-approved 2026-10-01): the only write,
-- and the only way 20261208120000 is applied to production. One transaction: guard, migration, ledger row
-- and post-verification commit together or not at all. Run from a clean checkout of the reviewed commit:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Never run the migration file on its own, and never let supabase db push apply it.
--
-- Accepted starting states (anything else refuses; nothing changes):
--   * FIRST APPLY: the PTF state — ledger 621 to 20261208100000 (digest c_ptf) with the PTF object state
--     (c_state_ptf), exactly what the PTF post-check of 2026-09-29 verified;
--   * RE-RUN: those 621 plus 20261208120000 with the follow-up object state; the migration re-installs the
--     same function and no ledger row is written (INSERT 0 0).
-- ONE object changes: public.get_players_overview_export (same signature, result, owner, SECURITY DEFINER,
-- ACL; new body; config gains plan_cache_mode=force_custom_plan). The authority and the list are untouched.
-- A missing -v expected_sysid is a psql syntax error on the set_config line: nothing runs.

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. No other migration run can read or append to the ledger until this transaction ends.
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;

-- 3. The expected cluster.
SELECT set_config('ptfx.expected_sysid', :'expected_sysid', true);

-- 4. Re-establish target, ledger, object state and a quiet database INSIDE this transaction.
DO $ptfx_apply_guard$
DECLARE
  -- Ledger digests: sha256 of the versions sorted byte-wise and joined by newlines. State digests: sha256
  -- of the STATE DESCRIPTOR (byte-identical to docs/deployment/ptf-release/state_descriptor.sql).
  -- src/test/ptfReleasePacket.realpg.test.ts derives all four.
  c_ptf      CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- + 20261208120000
  c_state_ptf CONSTANT text := 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc';
  c_state_fu  CONSTANT text := '60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20';
  v_sysid  text := (SELECT system_identifier::text FROM pg_control_system());
  v_rows   bigint := (SELECT count(*) FROM supabase_migrations.schema_migrations);
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_state  text := (
    -- STATE DESCRIPTOR BEGIN: every object this release creates or replaces, one line each, byte-sorted.
    -- Functions: identity, full arguments (defaults included), result, and every pg_proc attribute that
    -- changes behaviour or authority: kind, owner, language, volatility, strictness, set-returning,
    -- SECURITY DEFINER, leakproof, parallel safety, planner support function, config, ACL and body.
    -- procost/prorows are planner estimates only and deliberately excluded.
    SELECT coalesce(string_agg(d, E'\n' ORDER BY d COLLATE "C"), '') FROM (
      SELECT format('function %s.%s(%s) args=(%s) returns %s kind=%s owner=%s language=%s volatility=%s strict=%s returns_set=%s security_definer=%s leakproof=%s parallel=%s support=%s config=%s acl=%s body_sha256=%s',
               n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_arguments(p.oid),
               pg_get_function_result(p.oid), p.prokind, pg_get_userbyid(p.proowner), l.lanname, p.provolatile,
               p.proisstrict, p.proretset, p.prosecdef, p.proleakproof, p.proparallel, p.prosupport::text,
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
    RAISE EXCEPTION 'ptfx apply guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptfx apply guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptfx.expected_sysid') THEN
    RAISE EXCEPTION 'ptfx apply guard: system identifier %, expected %', v_sysid, current_setting('ptfx.expected_sysid');
  END IF;
  IF NOT ((v_ledger = c_ptf AND v_digest = c_state_ptf) OR (v_ledger = c_fu AND v_digest = c_state_fu)) THEN
    RAISE EXCEPTION 'ptfx apply guard: the ledger/object state is neither the PTF state nor the follow-up state (% rows, ledger %, state %)', v_rows, v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptfx apply guard: a prepared transaction is open; it may hold migration work';
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
    RAISE EXCEPTION 'ptfx apply guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptfx_apply_guard$;

-- 5. The reviewed migration, then its ledger row, unless the ledger already records it (a re-run).
\ir ../../../supabase/migrations/20261208120000_players_overview_export_training_columns.sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261208120000', 'players_overview_export_training_columns'
 WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261208120000');

-- 6. Verify the end state before commit; any mismatch raises and rolls back everything above.
DO $ptfx_apply_verify$
DECLARE
  c_ptf      CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- + 20261208120000
  c_state_ptf CONSTANT text := 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc';
  c_state_fu  CONSTANT text := '60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20';
  v_ledger text := (SELECT encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex')
                      FROM supabase_migrations.schema_migrations);
  v_state  text := (
    -- STATE DESCRIPTOR BEGIN: every object this release creates or replaces, one line each, byte-sorted.
    -- Functions: identity, full arguments (defaults included), result, and every pg_proc attribute that
    -- changes behaviour or authority: kind, owner, language, volatility, strictness, set-returning,
    -- SECURITY DEFINER, leakproof, parallel safety, planner support function, config, ACL and body.
    -- procost/prorows are planner estimates only and deliberately excluded.
    SELECT coalesce(string_agg(d, E'\n' ORDER BY d COLLATE "C"), '') FROM (
      SELECT format('function %s.%s(%s) args=(%s) returns %s kind=%s owner=%s language=%s volatility=%s strict=%s returns_set=%s security_definer=%s leakproof=%s parallel=%s support=%s config=%s acl=%s body_sha256=%s',
               n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), pg_get_function_arguments(p.oid),
               pg_get_function_result(p.oid), p.prokind, pg_get_userbyid(p.proowner), l.lanname, p.provolatile,
               p.proisstrict, p.proretset, p.prosecdef, p.proleakproof, p.proparallel, p.prosupport::text,
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
  IF v_ledger IS DISTINCT FROM c_fu OR v_digest IS DISTINCT FROM c_state_fu THEN
    RAISE EXCEPTION 'ptfx apply verify: end state wrong (ledger %, state %); rolled back', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  RAISE NOTICE 'ptfx apply: object state %, ledger 622 to 20261208120000', c_state_fu;
END
$ptfx_apply_verify$;
