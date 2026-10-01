-- POST-CHECK — PTF release. Catalogue metadata plus TWO refusal probes (each public entry's own
-- academy-manager check, which reads no player data); changes nothing (READ ONLY, ends in ROLLBACK). Run
-- immediately after apply.sql:
--   psql -X -v ON_ERROR_STOP=1 -f this file
-- Done only if every *_ok column is t, foreign_access and foreign_export are both 'refused: not
-- authorized', prepared_xacts is 0 and in_flight is empty. The second result lists the object state line
-- by line (README, "Expected object states").
BEGIN ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- The refusal probes: an unknown caller asking for an unknown academy must be refused by each entry's own
-- academy-manager check before it reads anything. The subject and academy are fixed synthetic uuids that
-- belong to nobody. Only the outcome text is kept.
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
  BEGIN
    PERFORM 1 FROM public.get_players_overview_export('00000000-0000-4000-8000-00000000f7f2'::uuid, NULL,
                                                      '{}'::jsonb, 'name', 'asc');
    PERFORM set_config('ptf_postcheck.foreign_export', 'ALLOWED', true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('ptf_postcheck.foreign_export',
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
state AS (
  SELECT (
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
  ) AS descriptor),
objs AS (
  SELECT to_regnamespace('players_private') AS private_schema,
         to_regprocedure('players_private.players_overview_rows(text, uuid, text, jsonb, text, text, integer, integer, boolean)') AS authority,
         to_regprocedure('public.get_players_overview(text, uuid, text, jsonb, text, text, integer, integer)') AS list_fn,
         to_regprocedure('public.get_players_overview_export(uuid, text, jsonb, text, text)') AS export_fn)
SELECT
  current_database()                                                     AS db,
  (SELECT system_identifier FROM pg_control_system())                    AS sysid,
  current_user                                                           AS connected_as,
  (SELECT n FROM ledger)                                                 AS ledger_rows,
  (SELECT head FROM ledger)                                              AS ledger_head,
  (SELECT n = 621 AND odd = 0
          AND digest = '901dc2c86de75066075c12e9da19e277d372da66c31b84433911b0e3cc07f900' FROM ledger)
                                                                         AS ledger_ok,
  (SELECT encode(sha256(convert_to(descriptor, 'UTF8')), 'hex') FROM state)
    = 'ca0d9b031804fb8a5d9f5858b6d5959af0343ac7f8fc3d3efcea0539e435d5dc'                                            AS state_ok,
  (SELECT encode(sha256(convert_to(descriptor, 'UTF8')), 'hex') FROM state) AS state_sha256,
  -- Effective privileges (role membership included): no client role reaches the private authority; the
  -- export runs for authenticated only; the list keeps its reviewed grantees.
  (SELECT CASE WHEN private_schema IS NULL OR authority IS NULL OR list_fn IS NULL OR export_fn IS NULL THEN false ELSE
            NOT has_schema_privilege('anon', private_schema, 'USAGE')
        AND NOT has_schema_privilege('authenticated', private_schema, 'USAGE')
        AND NOT has_schema_privilege('service_role', private_schema, 'USAGE')
        AND NOT has_function_privilege('anon', authority, 'EXECUTE')
        AND NOT has_function_privilege('authenticated', authority, 'EXECUTE')
        AND NOT has_function_privilege('service_role', authority, 'EXECUTE')
        AND has_function_privilege('authenticated', export_fn, 'EXECUTE')
        AND NOT has_function_privilege('anon', export_fn, 'EXECUTE')
        AND NOT has_function_privilege('service_role', export_fn, 'EXECUTE')
        AND has_function_privilege('authenticated', list_fn, 'EXECUTE')
        AND NOT has_function_privilege('anon', list_fn, 'EXECUTE') END
     FROM objs)                                                          AS client_roles_ok,
  current_setting('ptf_postcheck.foreign_access', true)                  AS foreign_access,
  current_setting('ptf_postcheck.foreign_export', true)                  AS foreign_export,
  (SELECT count(*) FROM pg_prepared_xacts)                               AS prepared_xacts,
  (
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
  )                                                                      AS in_flight;
\x off
-- The object state, one line per object (compare with the README's PTF descriptor).
SELECT regexp_split_to_table((
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
  ), E'\n') AS object_state;
ROLLBACK;
