-- RECOVERY — PTF export follow-up: returns production to the EXACT PTF state (the reviewed export body of
-- 20261208100000 and ledger 621), in one transaction. Only by explicit decision, and only after the frontend
-- has been reverted (the follow-up frontend requires the new columns and fails closed without them; the
-- previous frontend works on either body).
--   psql -X -1 -v ON_ERROR_STOP=1 -v expected_sysid=<the production system identifier> -f this file
-- Accepted starting states: the follow-up state (recover), or the PTF state already (a re-run: nothing to
-- undo, DELETE 0). Anything else refuses and changes nothing. Afterwards the repository must drop
-- supabase/migrations/20261208120000_players_overview_export_training_columns.sql (its ledger row is removed
-- here, so leaving the file would make it pending again).

-- 1. Read committed, bounded waits.
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 2. No other migration run can read or append to the ledger until this transaction ends.
LOCK TABLE supabase_migrations.schema_migrations IN ACCESS EXCLUSIVE MODE;

-- 3. The expected cluster.
SELECT set_config('ptfx.expected_sysid', :'expected_sysid', true);

-- 4. Re-establish target, ledger, object state and a quiet database INSIDE this transaction.
DO $ptfx_recovery_guard$
DECLARE
  -- Ledger digests: sha256 of the versions sorted byte-wise and joined by newlines. State digests: sha256
  -- of the STATE DESCRIPTOR (byte-identical to docs/deployment/ptf-release/state_descriptor.sql).
  -- src/test/ptfReleasePacket.realpg.test.ts derives all four.
  c_ptf      CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- + 20261208120000
  c_state_ptf CONSTANT text := 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc';
  c_state_fu  CONSTANT text := '1e78f4db9ccdc09b0dde56679a34e559f2485c2ffb227cf54410eb91e6757f74';
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
    RAISE EXCEPTION 'ptfx recovery guard: connected to database %, expected postgres', current_database();
  END IF;
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'ptfx recovery guard: connected as %, expected postgres', current_user;
  END IF;
  IF v_sysid IS DISTINCT FROM current_setting('ptfx.expected_sysid') THEN
    RAISE EXCEPTION 'ptfx recovery guard: system identifier %, expected %', v_sysid, current_setting('ptfx.expected_sysid');
  END IF;
  IF NOT ((v_ledger = c_ptf AND v_digest = c_state_ptf) OR (v_ledger = c_fu AND v_digest = c_state_fu)) THEN
    RAISE EXCEPTION 'ptfx recovery guard: the ledger/object state is neither the follow-up state nor the PTF state (% rows, ledger %, state %)', v_rows, v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_prepared_xacts) THEN
    RAISE EXCEPTION 'ptfx recovery guard: a prepared transaction is open; it may hold migration work';
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
    RAISE EXCEPTION 'ptfx recovery guard: other migration or DDL work is in flight: %', v_busy;
  END IF;
END
$ptfx_recovery_guard$;

-- 5. The reviewed PTF export, byte-for-byte as 20261208100000 creates it (CREATE OR REPLACE resets the
--    function config to the PTF config and keeps the ACL), then the follow-up ledger row is removed.
CREATE OR REPLACE FUNCTION public.get_players_overview_export(
  p_academy uuid,
  p_search text DEFAULT NULL,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_sort text DEFAULT 'name',         -- as get_players_overview
  p_sort_dir text DEFAULT 'asc'
)
RETURNS TABLE (
  total bigint,
  rows jsonb
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_max CONSTANT integer := 20000;
  v_total bigint;
  v_rows jsonb;
BEGIN
  -- ---- authorization at this public entry (the authority re-checks it) ----
  IF NOT public.is_academy_manager(auth.uid(), p_academy) THEN
    RAISE EXCEPTION 'not authorized for academy %', p_academy USING ERRCODE = '42501';
  END IF;

  -- ONE statement, ONE evaluation of the authority: the total and the rows come from the same rows.
  -- total_count is the window count of EVERY match (taken before the window), so at most c_max rows are
  -- materialized and an oversized request costs no more than a full export.
  SELECT coalesce(max(r.total_count), 0),
         coalesce(jsonb_agg(jsonb_build_object(
                    'person_id', r.person_id,
                    'full_name', r.full_name,
                    'email',     r.email,
                    'phone',     r.phone)
                  ORDER BY r.sort_ord), '[]'::jsonb)
    INTO v_total, v_rows
    FROM players_private.players_overview_rows(
           'academy', p_academy, p_search, p_filters, p_sort, p_sort_dir, c_max, 0, false) r;

  IF v_total > c_max THEN
    RAISE EXCEPTION 'player export too large: % players match, at most % can be exported', v_total, c_max
      USING ERRCODE = '54000', DETAIL = format('total=%s max=%s', v_total, c_max);
  END IF;

  RETURN QUERY SELECT v_total, v_rows;
END;
$$;
REVOKE ALL ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_players_overview_export(uuid, text, jsonb, text, text) TO authenticated;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20261208120000';

-- 6. Verify the end state before commit; any mismatch raises and rolls back everything above.
DO $ptfx_recovery_verify$
DECLARE
  c_ptf      CONSTANT text := '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900'; -- 621, to 20261208100000
  c_fu       CONSTANT text := 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'; -- + 20261208120000
  c_state_ptf CONSTANT text := 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc';
  c_state_fu  CONSTANT text := '1e78f4db9ccdc09b0dde56679a34e559f2485c2ffb227cf54410eb91e6757f74';
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
  IF v_ledger IS DISTINCT FROM c_ptf OR v_digest IS DISTINCT FROM c_state_ptf THEN
    RAISE EXCEPTION 'ptfx recovery verify: end state wrong (ledger %, state %); rolled back', v_ledger, v_digest
      USING DETAIL = v_state;
  END IF;
  RAISE NOTICE 'ptfx recovery: object state % (the PTF state), ledger 621 to 20261208100000', c_state_ptf;
END
$ptfx_recovery_verify$;
