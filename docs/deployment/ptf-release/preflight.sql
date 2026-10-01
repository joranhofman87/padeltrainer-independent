-- PTF LIVE BASELINE OBSERVATION — catalogue metadata only. Reads no table row and changes nothing.
-- Same conventions as the sealed ACL post-check (read-only transaction, bounded waits, ROLLBACK).
-- Observes: target identity, migration ledger (same ordered-digest method as the ACL post-check), and the
-- effective public.get_players_overview definition, owner, privileges and stored-body SHA-256.
BEGIN ISOLATION LEVEL READ COMMITTED, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
\x on
WITH ledger AS (
  SELECT count(*) AS n,
         max(version) AS head,
         count(*) FILTER (WHERE version !~ '^[0-9]{14}$') AS odd,
         encode(sha256(convert_to(string_agg(version, E'\n' ORDER BY version COLLATE "C"), 'UTF8')), 'hex') AS digest
    FROM supabase_migrations.schema_migrations),
fn AS (
  SELECT p.oid, p.prosrc, p.proowner, p.proacl, p.prosecdef, p.provolatile, p.proconfig, p.prolang
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'get_players_overview')
SELECT
  current_database()                                                     AS db,
  (SELECT system_identifier FROM pg_control_system())                    AS sysid,
  current_user                                                           AS connected_as,
  (SELECT n FROM ledger)                                                 AS ledger_rows,
  (SELECT head FROM ledger)                                              AS ledger_head,
  (SELECT n = 620 AND odd = 0
          AND digest = '98015eddaccd8ef67297c172db67495f5ff11a881ea28e1f024fb82741c3bc72' FROM ledger)
                                                                         AS ledger_is_reviewed_plus_acl,
  (SELECT coalesce(string_agg(version, ',' ORDER BY version), '')
     FROM supabase_migrations.schema_migrations WHERE version > '20261207100000')
                                                                         AS versions_after_acl,
  (SELECT count(*) FROM fn)                                              AS fn_count,
  (SELECT string_agg(pg_get_function_identity_arguments(oid), ' | ') FROM fn)
                                                                         AS fn_identity_args,
  (SELECT string_agg(pg_get_function_arguments(oid), ' | ') FROM fn)    AS fn_arguments,
  (SELECT string_agg(pg_get_function_result(oid), ' | ') FROM fn)       AS fn_result,
  (SELECT string_agg(l.lanname, ' | ') FROM fn JOIN pg_language l ON l.oid = fn.prolang)
                                                                         AS fn_language,
  (SELECT string_agg(provolatile::text, ' | ') FROM fn)                 AS fn_volatility,
  (SELECT string_agg(prosecdef::text, ' | ') FROM fn)                   AS fn_security_definer,
  (SELECT string_agg(coalesce(array_to_string(proconfig, ','), ''), ' | ') FROM fn)
                                                                         AS fn_config,
  (SELECT string_agg(pg_get_userbyid(proowner), ' | ') FROM fn)         AS fn_owner,
  (SELECT string_agg(coalesce(proacl::text, '(default)'), ' | ') FROM fn)
                                                                         AS fn_acl,
  (SELECT string_agg(encode(sha256(convert_to(prosrc, 'UTF8')), 'hex'), ' | ') FROM fn)
                                                                         AS fn_body_sha256,
  (SELECT string_agg(octet_length(convert_to(prosrc, 'UTF8'))::text, ' | ') FROM fn)
                                                                         AS fn_body_bytes;
ROLLBACK;
