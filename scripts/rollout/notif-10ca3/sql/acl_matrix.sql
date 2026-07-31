-- ===========================================================================
-- acl_matrix.sql — self-contained ACL lockdown assertions for the PR #615
-- objects. No dependency on any test-only probe role: PUBLIC is checked by
-- inspecting the stored ACL directly (aclexplode grantee = 0), which also
-- models the Postgres default-EXECUTE-to-PUBLIC footgun that the migrations
-- explicitly REVOKE. Named roles (anon/authenticated/service_role) are checked
-- with has_*_privilege. Every violation raises and aborts.
-- Reads only. Safe to re-run. Runs on prod and on a disposable clone alike.
-- ===========================================================================
\ir _assert.sql

-- ---- helpers --------------------------------------------------------------
-- PUBLIC effective privilege on a TABLE/SEQUENCE (relacl). NULL relacl => the
-- object's default: for tables/sequences PUBLIC gets nothing, so FALSE.
CREATE OR REPLACE FUNCTION pg_temp.public_has_relpriv(p_obj regclass) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid = p_obj AND a.grantee = 0
  );
$$;

-- PUBLIC effective EXECUTE on a FUNCTION (proacl). NULL proacl => Postgres
-- default grants EXECUTE to PUBLIC -> TRUE. This is the footgun; model it.
CREATE OR REPLACE FUNCTION pg_temp.public_has_execute(p_fn regprocedure) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN (SELECT proacl FROM pg_proc WHERE oid = p_fn) IS NULL THEN true
    ELSE EXISTS (
      SELECT 1 FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) a
      WHERE p.oid = p_fn AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
    )
  END;
$$;

-- assert a SELECT-only-to-service_role table (state + actions ledger)
CREATE OR REPLACE FUNCTION pg_temp.assert_select_only_table(p_name text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE o regclass := p_name::regclass;
BEGIN
  PERFORM pg_temp.assert(NOT pg_temp.public_has_relpriv(o),                       p_name||': PUBLIC has no table privilege');
  PERFORM pg_temp.assert(NOT has_table_privilege('anon',          o, 'SELECT'),   p_name||': anon no SELECT');
  PERFORM pg_temp.assert(NOT has_table_privilege('anon',          o, 'INSERT'),   p_name||': anon no INSERT');
  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', o, 'SELECT'),   p_name||': authenticated no SELECT');
  PERFORM pg_temp.assert(NOT has_table_privilege('authenticated', o, 'INSERT'),   p_name||': authenticated no INSERT');
  PERFORM pg_temp.assert(    has_table_privilege('service_role',  o, 'SELECT'),   p_name||': service_role SELECT granted');
  PERFORM pg_temp.assert(NOT has_table_privilege('service_role',  o, 'INSERT'),   p_name||': service_role no INSERT (writes via SECURITY DEFINER only)');
  PERFORM pg_temp.assert(NOT has_table_privilege('service_role',  o, 'UPDATE'),   p_name||': service_role no UPDATE');
  PERFORM pg_temp.assert(NOT has_table_privilege('service_role',  o, 'DELETE'),   p_name||': service_role no DELETE');
END $$;

-- assert a function whose ONLY executor is service_role
CREATE OR REPLACE FUNCTION pg_temp.assert_exec_service_only(p_sig text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE f regprocedure := p_sig::regprocedure;
BEGIN
  PERFORM pg_temp.assert(NOT pg_temp.public_has_execute(f),                    p_sig||': PUBLIC no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon',          f, 'EXECUTE'), p_sig||': anon no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', f, 'EXECUTE'), p_sig||': authenticated no EXECUTE');
  PERFORM pg_temp.assert(    has_function_privilege('service_role',  f, 'EXECUTE'), p_sig||': service_role EXECUTE granted');
END $$;

-- assert a function no role may execute (fully internal helper, invoked only
-- from inside SECURITY DEFINER bodies owned by the definer)
CREATE OR REPLACE FUNCTION pg_temp.assert_exec_none(p_sig text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE f regprocedure := p_sig::regprocedure;
BEGIN
  PERFORM pg_temp.assert(NOT pg_temp.public_has_execute(f),                    p_sig||': PUBLIC no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon',          f, 'EXECUTE'), p_sig||': anon no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('authenticated', f, 'EXECUTE'), p_sig||': authenticated no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('service_role',  f, 'EXECUTE'), p_sig||': service_role no EXECUTE');
END $$;

-- assert a reader whose executor is authenticated (PUBLIC/anon denied)
CREATE OR REPLACE FUNCTION pg_temp.assert_exec_authenticated_only(p_sig text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE f regprocedure := p_sig::regprocedure;
BEGIN
  PERFORM pg_temp.assert(NOT pg_temp.public_has_execute(f),                    p_sig||': PUBLIC no EXECUTE');
  PERFORM pg_temp.assert(NOT has_function_privilege('anon',          f, 'EXECUTE'), p_sig||': anon no EXECUTE');
  PERFORM pg_temp.assert(    has_function_privilege('authenticated', f, 'EXECUTE'), p_sig||': authenticated EXECUTE granted');
END $$;

-- ---- tables: SELECT-only to service_role ----------------------------------
SELECT pg_temp.assert_select_only_table('public.notification_orphan_reconcile_state');
SELECT pg_temp.assert_select_only_table('public.notification_orphan_reconcile_actions');

-- ---- sequence: no role may touch it (ids assigned inside SECURITY DEFINER) --
SELECT pg_temp.assert(NOT pg_temp.public_has_relpriv('public.notification_orphan_reconcile_actions_id_seq'::regclass),
  'actions id_seq: PUBLIC no privilege');
SELECT pg_temp.assert(NOT has_sequence_privilege('anon',          'public.notification_orphan_reconcile_actions_id_seq', 'USAGE'),
  'actions id_seq: anon no USAGE');
SELECT pg_temp.assert(NOT has_sequence_privilege('authenticated', 'public.notification_orphan_reconcile_actions_id_seq', 'USAGE'),
  'actions id_seq: authenticated no USAGE');
SELECT pg_temp.assert(NOT has_sequence_privilege('service_role',  'public.notification_orphan_reconcile_actions_id_seq', 'USAGE'),
  'actions id_seq: service_role no USAGE');

-- ---- functions: service_role-only executors -------------------------------
SELECT pg_temp.assert_exec_service_only('public.record_email_event(text,text,text,text,text,text,uuid,uuid,uuid,timestamptz)');
SELECT pg_temp.assert_exec_service_only('public.is_email_suppressed(text)');
SELECT pg_temp.assert_exec_service_only('public.reset_email_suppression(text)');
SELECT pg_temp.assert_exec_service_only('public.apply_notification_provider_event(uuid,text,text,uuid,text,timestamptz,timestamptz)');
SELECT pg_temp.assert_exec_service_only('public.reconcile_orphan_provider_events(uuid,text,timestamptz,int)');

-- ---- functions: fully internal (no executor) ------------------------------
SELECT pg_temp.assert_exec_none('public.email_state_transition(text,timestamptz,timestamptz,text,text,timestamptz)');
SELECT pg_temp.assert_exec_none('public.email_event_rank(text)');
SELECT pg_temp.assert_exec_none('public.link_notification_provider_event(text,uuid,uuid,timestamptz)');
SELECT pg_temp.assert_exec_none('public.link_notification_provider_event(text,uuid)');
SELECT pg_temp.assert_exec_none('public.notification_orphan_reconcile_permanent_reason(text)');
SELECT pg_temp.assert_exec_none('public.notification_orphan_reconcile_requeue(text,text,text)');
SELECT pg_temp.assert_exec_none('public.notification_orphan_reconcile_resolve(text,text,text)');

-- ---- readers: authenticated-only ------------------------------------------
SELECT pg_temp.assert_exec_authenticated_only('public.get_academy_undeliverable_recipients(uuid)');
SELECT pg_temp.assert_exec_authenticated_only('public.get_players_overview(text,uuid,text,jsonb,text,text,integer,integer)');

SELECT pg_temp.note('acl_matrix: all assertions passed');
