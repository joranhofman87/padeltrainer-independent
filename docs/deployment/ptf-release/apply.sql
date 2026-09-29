-- APPLY — PTF release (PTF-OPTION-A-2026-09-27): the only write, and the only way the PTF migration is
-- applied to production. One transaction: guard, migration, ledger row and post-verification commit
-- together or not at all. Run from a clean checkout of the reviewed candidate commit, after a fresh
-- preflight, with the command in docs/deployment/ptf-release/README.md, Step 2:
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Never run the migration file on its own, and never let supabase db push apply it.
--
-- Accepted starting states (anything else refuses; nothing changes):
--   * FIRST APPLY: the 620-version ledger verified by the ACL post-check (to 20261207100000) with the
--     live canonical function body (PTF_DATABASE_BASELINE_RECEIPT_2026-09-29.md);
--   * RE-RUN: those 620 plus 20261208100000 with the PTF body. The migration re-installs the same body
--     and no ledger row is written (INSERT 0 0).
-- A missing -v expected_sysid is a psql syntax error on the set_config line: nothing runs.

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. No other migration run can read or append to the ledger until this transaction ends.
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;

-- 3. The expected cluster.
SELECT set_config('ptf_release.expected_sysid', :'expected_sysid', true);

-- 4. Re-establish target, ledger, function identity and a quiet database INSIDE this transaction.
DO $ptf_apply_guard$
DECLARE
  -- Ledger digests: sha256 of the versions sorted byte-wise and joined by newlines (the ACL packet's
  -- method). src/test/ptfReleasePacket.realpg.test.ts derives both from the repository's versions.
  c_base      CONSTANT text := '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72'; -- 620, to 20261207100000
  c_ptf       CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- + 20261208100000
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
  IF v_fns <> 1 THEN
    RAISE EXCEPTION 'ptf apply guard: expected exactly one public.get_players_overview, found %', v_fns;
  END IF;
  SELECT pg_get_function_identity_arguments(p.oid),
         encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'),
         (SELECT string_agg(a, ',' ORDER BY a COLLATE "C") FROM unnest(coalesce(p.proacl, '{}'::aclitem[])::text[]) a)
    INTO v_args, v_body, v_acl
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_players_overview';
  IF v_args IS DISTINCT FROM c_args THEN
    RAISE EXCEPTION 'ptf apply guard: unexpected get_players_overview signature (%)', v_args;
  END IF;
  IF v_acl IS DISTINCT FROM c_acl THEN
    RAISE EXCEPTION 'ptf apply guard: get_players_overview privileges drifted (%), expected %', v_acl, c_acl;
  END IF;
  IF NOT ((v_ledger = c_base AND v_body = c_body_live) OR (v_ledger = c_ptf AND v_body = c_body_ptf)) THEN
    RAISE EXCEPTION 'ptf apply guard: ledger and function body disagree or the body is unknown (ledger %, body %)', v_ledger, v_body;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptf apply guard: a prepared transaction is open; it may hold migration work';
  END IF;
  v_busy := (
    -- IN-FLIGHT PROBE BEGIN: another session holding or awaiting the ledger, or the lock every object
    -- creation takes on schema public. App reads and DML do not match. Same text in the post-check.
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
  c_ptf      CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900';
  c_body_ptf CONSTANT text := '22695d9ce5ccd20617d98af9123712701d55c8198ee0d607bd08a62fd503b8b2';
  c_args     CONSTANT text := 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer';
  c_acl      CONSTANT text := 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres';
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
  IF v_ledger IS DISTINCT FROM c_ptf OR v_body IS DISTINCT FROM c_body_ptf
     OR v_args IS DISTINCT FROM c_args OR v_acl IS DISTINCT FROM c_acl THEN
    RAISE EXCEPTION 'ptf apply verify: end state wrong (ledger %, body %, args %, acl %); rolled back', v_ledger, v_body, v_args, v_acl;
  END IF;
  RAISE NOTICE 'ptf apply: get_players_overview body %, ledger 621 to 20261208100000, privileges unchanged', c_body_ptf;
END
$ptf_apply_verify$;
