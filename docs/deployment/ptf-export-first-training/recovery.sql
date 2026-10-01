-- RECOVERY — PTF export: First training date: returns production to the EXACT export follow-up state (the
-- applied 20261208120000 export body and ledger 622), in one transaction. Only by explicit decision, and only
-- after the frontend has been reverted (the first-training frontend requires first_training_date and fails
-- closed without it; the previous frontend works on either body).
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Accepted starting states: the first-training state (recover), or the follow-up state already (a re-run:
-- nothing to undo, DELETE 0). Anything else refuses and changes nothing. Afterwards the repository must drop
-- supabase/migrations/20261208130000_players_overview_export_first_training.sql (its ledger row is removed
-- here, so leaving the file would make it pending again).

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. No other migration run can read or append to the ledger until this transaction ends.
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;

-- 3. The expected cluster.
SELECT set_config('ptff.expected_sysid', :'expected_sysid', true);

-- 4. Re-establish target, ledger, object state and a quiet database INSIDE this transaction.
DO $ptff_recovery_guard$
DECLARE
  -- Ledger digests: sha256 of the versions sorted byte-wise and joined by newlines. State digests: sha256
  -- of the STATE DESCRIPTOR (byte-identical to docs/deployment/ptf-release/state_descriptor.sql).
  -- src/test/ptfReleasePacket.realpg.test.ts derives all four.
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- 622, to 20261208120000
  c_ft       CONSTANT text := '4ef738dcfcfeaced96819442b827ae20429d9cd770f48c1a4a634e5fb12936f1'; -- + 20261208130000
  c_state_fu  CONSTANT text := '60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20';
  c_state_ft  CONSTANT text := '005e46bea4a92e0f801fc3414317aa2ce8b296fcb08f1060146f7cc1fd5cd6fd';
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
    RAISE EXCEPTION 'ptff recovery guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptff recovery guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptff.expected_sysid') THEN
    RAISE EXCEPTION 'ptff recovery guard: system identifier %, expected %', v_sysid, current_setting('ptff.expected_sysid');
  END IF;
  IF NOT ((v_ledger = c_ft AND v_digest = c_state_ft) OR (v_ledger = c_fu AND v_digest = c_state_fu)) THEN
    RAISE EXCEPTION 'ptff recovery guard: the ledger/object state is neither the first-training state nor the export follow-up state (% rows, ledger %, state %)', v_rows, v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptff recovery guard: a prepared transaction is open; it may hold migration work';
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
    RAISE EXCEPTION 'ptff recovery guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptff_recovery_guard$;

-- 5. The applied export follow-up, byte-for-byte: the reviewed, applied 20261208120000 migration file itself
--    (CREATE OR REPLACE with its own config; the ACL is kept and re-asserted), then the first-training ledger
--    row is removed.
\ir ../../../supabase/migrations/20261208120000_players_overview_export_training_columns.sql
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261208130000';

-- 6. Verify the end state before commit; any mismatch raises and rolls back everything above.
DO $ptff_recovery_verify$
DECLARE
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- 622, to 20261208120000
  c_ft       CONSTANT text := '4ef738dcfcfeaced96819442b827ae20429d9cd770f48c1a4a634e5fb12936f1'; -- + 20261208130000
  c_state_fu  CONSTANT text := '60b714039c0da0106b46b8f5e77766c5975ead008a9c02d1820cbca383593c20';
  c_state_ft  CONSTANT text := '005e46bea4a92e0f801fc3414317aa2ce8b296fcb08f1060146f7cc1fd5cd6fd';
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
    RAISE EXCEPTION 'ptff recovery verify: end state wrong (ledger %, state %); rolled back', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  RAISE NOTICE 'ptff recovery: object state % (the export follow-up state), ledger 622 to 20261208120000', c_state_fu;
END
$ptff_recovery_verify$;
