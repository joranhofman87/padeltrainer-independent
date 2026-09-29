-- APPLY — PTF release (PTF-OPTION-A-2026-09-27, with A1 membership and the E1 export): the only write,
-- and the only way the PTF migration is applied to production. One transaction: guard, migration, ledger
-- row and post-verification commit together or not at all. Run from a clean checkout of the reviewed
-- candidate commit, after a fresh preflight, with the command in docs/deployment/ptf-release/README.md,
-- Step 2:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Never run the migration file on its own, and never let supabase db push apply it.
--
-- Accepted starting states (anything else refuses; nothing changes):
--   * FIRST APPLY: the 620-version ledger verified by the ACL post-check (to 20261207100000) with the
--     BASE object state: the live canonical public.get_players_overview exactly as the baseline receipt
--     records it, and neither public.get_players_overview_export nor schema players_private;
--   * RE-RUN: those 620 plus 20261208100000 with the PTF object state. The migration re-installs the
--     same three functions and no ledger row is written (INSERT 0 0).
-- The object state is the STATE DESCRIPTOR below: one line per function this release creates or replaces
-- (signature, return type, owner, language, volatility, SECURITY DEFINER, config, ACL, body sha256) and
-- one for schema players_private. Its sha256 must equal c_state_base or c_state_ptf; the README lists
-- both descriptors in full.
-- A missing -v expected_sysid is a psql syntax error on the set_config line: nothing runs.

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. No other migration run can read or append to the ledger until this transaction ends.
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;

-- 3. The expected cluster.
SELECT set_config('ptf_release.expected_sysid', :'expected_sysid', true);

-- 4. Re-establish target, ledger, object state and a quiet database INSIDE this transaction.
DO $ptf_apply_guard$
DECLARE
  -- Ledger digests: sha256 of the versions sorted byte-wise and joined by newlines (the ACL packet's
  -- method). State digests: sha256 of the state descriptor. src/test/ptfReleasePacket.realpg.test.ts
  -- derives all four.
  c_base       CONSTANT text := '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72'; -- 620, to 20261207100000
  c_ptf        CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- + 20261208100000
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
    RAISE EXCEPTION 'ptf apply guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptf apply guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptf_release.expected_sysid') THEN
    RAISE EXCEPTION 'ptf apply guard: system identifier %, expected %', v_sysid, current_setting('ptf_release.expected_sysid');
  END IF;
  IF v_odd <> 0 OR (v_ledger IS DISTINCT FROM c_base AND v_ledger IS DISTINCT FROM c_ptf) THEN
    RAISE EXCEPTION 'ptf apply guard: the ledger is neither the 620 versions to 20261207100000 nor those plus 20261208100000 (% rows, % not 14 digits, digest %)',
      v_rows, v_odd, v_ledger;
  END IF;
  IF NOT ((v_ledger = c_base AND v_digest = c_state_base) OR (v_ledger = c_ptf AND v_digest = c_state_ptf)) THEN
    RAISE EXCEPTION 'ptf apply guard: the object state is not the one this ledger expects (ledger %, state %)', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptf apply guard: a prepared transaction is open; it may hold migration work';
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
    RAISE EXCEPTION 'ptf apply guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptf_apply_guard$;

-- 5. The reviewed migration, then its ledger row, unless the ledger already records it (a re-run).
\ir ../../../supabase/migrations/20261208100000_players_overview_current_training.sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
SELECT '20261208100000', 'players_overview_current_training'
 WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '20261208100000');

-- 6. Verify the end state before commit; any mismatch raises and rolls back everything above.
DO $ptf_apply_verify$
DECLARE
  c_ptf       CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900';
  c_state_ptf CONSTANT text := '8b9d2f98127a66387234d6890f59117a516388c65fa776acf67742d619ff749b';
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
  IF v_ledger IS DISTINCT FROM c_ptf OR v_digest IS DISTINCT FROM c_state_ptf THEN
    RAISE EXCEPTION 'ptf apply verify: end state wrong (ledger %, state %); rolled back', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  RAISE NOTICE 'ptf apply: object state %, ledger 621 to 20261208100000', c_state_ptf;
END
$ptf_apply_verify$;
