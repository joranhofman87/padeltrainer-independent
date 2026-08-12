/**
 * "Does any client role hold ANY privilege on this table?" — asked once, in one place.
 *
 * This lived twice: once in scripts/db/backup-coverage.mjs, which runs it against the real reset
 * database, and once inside src/test/u2AccountScrubOperations.pglite.test.ts, which runs it against
 * PGlite and mutates the ACL to prove the query catches a column grant. Two copies meant the
 * mutation test could not fail for the shipped guard: delete the column-ACL branch from the script
 * and the test stays green on its own copy, while backup coverage stays green because the reset
 * schema happens to have no column grants. A regression in the real guard would ship unnoticed.
 *
 * So both import THIS. The mutation test now exercises the same text the nightly guard runs.
 *
 * Three questions, none relying on anyone remembering the privilege set:
 *
 *   1. has_table_privilege over privilege names DERIVED from acldefault('r', owner) — whatever this
 *      PostgreSQL defines. A hand-written list goes stale silently: an earlier version stopped at
 *      REFERENCES so `GRANT TRIGGER` slipped through, and PostgreSQL 17 then added MAINTAIN.
 *   2. aclexplode(relacl), so a grant to a role the caller did not think to name still shows up.
 *   3. aclexplode(attacl), because has_table_privilege CANNOT see column grants — and
 *      `GRANT UPDATE (state, last_error_code)` is already enough to drive the state machine.
 *
 * Returns one row: `held` (a sorted, comma-joined description of every privilege found, empty string
 * when there are none) and `probed` (how many privilege names the derivation produced, so a caller
 * can prove "nothing is held" was not reached by asking nothing).
 *
 * $1 is the table name, unqualified, in schema public.
 */
export const ACL_DENY_SQL = `
  WITH rel AS (
    SELECT c.oid, c.relowner, coalesce(c.relacl, '{}'::aclitem[]) AS relacl
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = $1
  ),
  privs AS (SELECT DISTINCT a.privilege_type FROM rel, aclexplode(acldefault('r', rel.relowner)) a),
  roles AS (SELECT unnest(ARRAY['anon','authenticated','service_role']) AS role),
  held AS (
    SELECT r.role || ':' || p.privilege_type AS h
      FROM rel, roles r, privs p WHERE has_table_privilege(r.role, rel.oid, p.privilege_type)
    UNION
    SELECT coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') || ':' || a.privilege_type
      FROM rel, aclexplode(rel.relacl) a WHERE a.grantee <> rel.relowner
    UNION
    SELECT coalesce(pg_get_userbyid(a.grantee), 'PUBLIC') || ':' || a.privilege_type
           || ' on column ' || att.attname
      FROM rel JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attacl IS NOT NULL,
           LATERAL aclexplode(att.attacl) a WHERE a.grantee <> rel.relowner
  )
  SELECT coalesce((SELECT string_agg(h, ', ' ORDER BY h) FROM held), '') AS held,
         (SELECT count(*)::int FROM privs) AS probed`;
