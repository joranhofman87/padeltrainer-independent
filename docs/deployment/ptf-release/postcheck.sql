-- POST-CHECK — PTF release. Catalogue metadata plus ONE refusal probe (the function's own manager check,
-- which reads no player data); changes nothing (READ ONLY, ends in ROLLBACK). Run immediately after
-- apply.sql:
--   psql -X -v ON_ERROR_STOP=1 -f this file
-- Done only if every *_ok column is t and foreign_access is 'refused: not authorized'.
BEGIN ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The refusal probe: an unknown caller asking for an unknown academy, with the new training key, must be
-- refused by the function's own academy-manager check before it reads anything. The subject and academy
-- are fixed synthetic uuids that belong to nobody. Only the outcome text is kept.
DO $ptf_postcheck_probe$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000f7f1', true);
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000f7f1","role":"authenticated"}', true);
  BEGIN
    PERFORM 1 FROM public.get_players_overview('academy', '00000000-0000-4000-8000-00000000f7f2'::uuid, NULL,
                                               '{"current_training": true}'::jsonb, 'name', 'asc', 1, 0);
    PERFORM set_config('ptf_postcheck.foreign_access', 'ALLOWED', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('ptf_postcheck.foreign_access',
      CASE WHEN SQLSTATE = '42501' AND SQLERRM LIKE 'not authorized for academy %' THEN 'refused: not authorized'
           ELSE 'unexpected ' || SQLSTATE || ': ' || SQLERRM END, true);
  END;
END
$ptf_postcheck_probe$;

\x on
WITH ledger AS (
  SELECT count(*) AS n,
         max(version) AS head,
         count(*) FILTER (WHERE version !~ '^[0-9]{14}$') AS odd,
         encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS digest
    FROM supabase_migrations.schema_migrations),
fn AS (
  SELECT p.oid, p.prosrc, p.proowner, p.proacl, p.prosecdef, p.provolatile, p.proconfig, p.prolang
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_players_overview')
SELECT
  current_database()                                                     AS db,
  (SELECT system_identifier FROM pg_control_system())                    AS sysid,
  current_user                                                           AS connected_as,
  (SELECT n FROM ledger)                                                 AS ledger_rows,
  (SELECT head FROM ledger)                                              AS ledger_head,
  (SELECT n = 621 AND odd = 0
          AND digest = '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900' FROM ledger)
                                                                         AS ledger_ok,
  (SELECT count(*) FROM fn) = 1                                          AS fn_single_ok,
  (SELECT pg_get_function_identity_arguments(oid) FROM fn)
    = 'p_scope text, p_scope_id uuid, p_search text, p_filters jsonb, p_sort text, p_sort_dir text, p_limit integer, p_offset integer'
                                                                         AS fn_signature_ok,
  (SELECT l.lanname = 'plpgsql' AND fn.provolatile = 's' AND fn.prosecdef
          AND fn.proconfig = ARRAY['search_path=public'] AND pg_get_userbyid(fn.proowner) = 'postgres'
     FROM fn JOIN pg_language l ON l.oid = fn.prolang)                   AS fn_attributes_ok,
  (SELECT string_agg(a, ',' ORDER BY a COLLATE "C") FROM fn, unnest(coalesce(fn.proacl, '{}'::aclitem[])::text[]) a)
    = 'authenticated=X/postgres,postgres=X/postgres,service_role=X/postgres'
                                                                         AS fn_privileges_ok,
  (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM fn)
    = '22695d9ce5ccd20617d98af9123712701d55c8198ee0d607bd08a62fd503b8b2' AS fn_body_ok,
  (SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') FROM fn)     AS fn_body_sha256,
  (SELECT octet_length(convert_to(prosrc, 'UTF8')) FROM fn)              AS fn_body_bytes,
  (SELECT proacl::text FROM fn)                                          AS fn_acl,
  current_setting('ptf_postcheck.foreign_access', true)                  AS foreign_access,
  (SELECT count(*) FROM pg_prepared_xacts)                               AS prepared_xacts,
  (
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
  )                                                                      AS in_flight;
ROLLBACK;
