-- STATE DESCRIPTOR — the CANONICAL text (read-only). Prints the object state this release compares, and
-- its sha256. The block between the BEGIN/END markers is the single source: apply.sql, recovery.sql and
-- postcheck.sql each embed it byte-for-byte (six copies, since psql cannot include a file inside a DO
-- body), and src/test/ptfReleasePacket.realpg.test.ts asserts every copy equals this one.
--   psql -X -v ON_ERROR_STOP=1 -f this file
SELECT x.d AS descriptor, encode(sha256(convert_to(x.d, 'UTF8')), 'hex') AS sha256
FROM (SELECT (
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
  ) AS d) x;
