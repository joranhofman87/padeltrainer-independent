-- ===========================================================================
-- _acl.sql — the marker/fence ACL matrix, asserted identically on BOTH sides.
--
-- These objects decide whether a clone is trusted, so they must not inherit
-- ambient default grants. The same matrix is proven source-side before the seal
-- commits and again inside every clone — a lockdown that is only checked at the
-- far end is a lockdown that can silently never have happened.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.lock_down_marker_objects() RETURNS void
LANGUAGE plpgsql AS $ld$
DECLARE r text;
BEGIN
  REVOKE ALL ON SCHEMA rollout_clone FROM PUBLIC;
  REVOKE ALL ON ALL TABLES IN SCHEMA rollout_clone FROM PUBLIC;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rollout_clone FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA rollout_clone FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA rollout_clone FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA rollout_clone FROM %I', r);
    END IF;
  END LOOP;
END $ld$;

CREATE OR REPLACE FUNCTION pg_temp.assert_marker_acls(ctx text) RETURNS void
LANGUAGE plpgsql AS $ac$
DECLARE r text; t text;
BEGIN
  IF has_schema_privilege('public', 'rollout_clone', 'USAGE') THEN
    RAISE EXCEPTION '%: PUBLIC can USE the rollout_clone schema', ctx;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r);
    IF has_schema_privilege(r, 'rollout_clone', 'USAGE') THEN
      RAISE EXCEPTION '%: role % can USE the rollout_clone schema', ctx, r;
    END IF;
    FOREACH t IN ARRAY ARRAY['rollout_clone.snapshot_marker', 'rollout_clone.snapshot_job_state'] LOOP
      IF has_table_privilege(r, t, 'SELECT') OR has_table_privilege(r, t, 'UPDATE')
         OR has_table_privilege(r, t, 'INSERT') OR has_table_privilege(r, t, 'DELETE') THEN
        RAISE EXCEPTION '%: role % has privileges on %', ctx, r, t;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'rollout_clone.fence_cron_job()', 'EXECUTE') THEN
      RAISE EXCEPTION '%: role % can EXECUTE the fence function', ctx, r;
    END IF;
  END LOOP;
  IF has_function_privilege('public', 'rollout_clone.fence_cron_job()', 'EXECUTE') THEN
    RAISE EXCEPTION '%: PUBLIC can EXECUTE the fence function', ctx;
  END IF;
END $ac$;
