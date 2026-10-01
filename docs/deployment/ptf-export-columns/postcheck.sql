-- POST-CHECK — PTF export follow-up (read-only; ends in ROLLBACK). Run immediately after apply:
--   psql -X -v ON_ERROR_STOP=1 -v shape_academy=<an academy id> -f this file
-- Prints two records:
--   1. the object state: ledger rows/head, ledger_ok, state_ok, the state digest, the export's config and
--      ACL, and whether anon / service_role can execute it (both must be false);
--   2. the export's SHAPE for shape_academy, called as one of that academy's managers inside this
--      read-only transaction: counts only, never a name, contact, date or id.
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
\x on
WITH k AS (
  SELECT 'd8115fd6f71b348ae19260ec075f0de9b6fe4304fe59a27f664fa6bb32b12206'::text AS c_fu, '1e78f4db9ccdc09b0dde56679a34e559f2485c2ffb227cf54410eb91e6757f74'::text AS c_state_fu
), l AS (
  SELECT count(*) AS n, max(version) AS head,
         encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS d
    FROM supabase_migrations.schema_migrations
), st AS (
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
  ) AS v
), f AS (
  SELECT p.oid, array_to_string(p.proconfig, ';') AS config,
         (SELECT string_agg(a, ',' ORDER BY a COLLATE "C") FROM unnest(p.proacl::text[]) a) AS acl
    FROM pg_proc p WHERE p.oid = 'public.get_players_overview_export(uuid, text, jsonb, text, text)'::regprocedure
)
SELECT current_database() AS db,
       (SELECT system_identifier FROM pg_control_system()) AS sysid,
       l.n AS ledger_rows, l.head AS ledger_head, (l.d = k.c_fu) AS ledger_ok,
       (encode(sha256(convert_to(st.v, 'UTF8')), 'hex') = k.c_state_fu) AS state_ok,
       encode(sha256(convert_to(st.v, 'UTF8')), 'hex') AS state_sha256,
       f.config AS export_config, f.acl AS export_acl,
       has_function_privilege('anon', f.oid, 'EXECUTE') AS anon_can_execute,
       has_function_privilege('service_role', f.oid, 'EXECUTE') AS service_role_can_execute
  FROM k, l, st, f;

-- 2. The shape, as a manager of shape_academy (auth.uid() reads this transaction-local claim).
SELECT set_config('request.jwt.claim.sub',
         (SELECT m.user_id::text FROM public.academy_managers m
           WHERE m.academy_profile_id = :'shape_academy'::uuid ORDER BY m.user_id LIMIT 1), true) IS NOT NULL
       AS shape_manager_found;
WITH t0 AS (SELECT clock_timestamp() AS t),
e AS (
  SELECT x.total, x.rows, (SELECT clock_timestamp() - t0.t FROM t0) AS took
    FROM public.get_players_overview_export(:'shape_academy'::uuid, NULL, '{}'::jsonb, 'name', 'asc') x
), r AS (
  SELECT j FROM e, jsonb_array_elements(e.rows) j
)
SELECT (SELECT total FROM e) AS shape_total,
       (SELECT jsonb_array_length(rows) FROM e) AS shape_rows,
       (SELECT round(extract(epoch FROM took) * 1000) FROM e) AS shape_ms,
       count(*) FILTER (WHERE (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(j) k)
         = ARRAY['birth_date','currently_training','email','full_name','last_training_date','location_names',
                 'next_training_date','past_bookings_count','person_id','phone']) AS rows_with_exact_keys,
       count(DISTINCT j->>'person_id') AS distinct_persons,
       count(*) FILTER (WHERE (j->>'currently_training')::boolean) AS currently_training,
       count(*) FILTER (WHERE j->>'last_training_date' IS NOT NULL) AS with_last_date,
       count(*) FILTER (WHERE j->>'next_training_date' IS NOT NULL) AS with_next_date,
       count(*) FILTER (WHERE (j->>'last_training_date') !~ '^\d{4}-\d{2}-\d{2}$'
                           OR (j->>'next_training_date') !~ '^\d{4}-\d{2}-\d{2}$'
                           OR (j->>'birth_date') !~ '^\d{4}-\d{2}-\d{2}$') AS malformed_dates,
       count(*) FILTER (WHERE j->>'next_training_date' < j->>'last_training_date') AS next_before_last,
       coalesce(sum((j->>'past_bookings_count')::int), 0) AS past_bookings_sum,
       count(*) FILTER (WHERE (j->>'past_bookings_count')::int = 0 AND j->>'last_training_date' IS NOT NULL) AS zero_count_with_last,
       count(*) FILTER (WHERE (j->>'past_bookings_count')::int > 0 AND j->>'last_training_date' IS NULL) AS count_without_last,
       count(*) FILTER (WHERE j->>'birth_date' IS NOT NULL) AS with_birth_date,
       count(*) FILTER (WHERE jsonb_array_length(j->'location_names') > 0) AS with_locations,
       coalesce(max(jsonb_array_length(j->'location_names')), 0) AS max_locations
  FROM r;
\x off
ROLLBACK;
