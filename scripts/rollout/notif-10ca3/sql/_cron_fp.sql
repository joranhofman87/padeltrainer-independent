-- ===========================================================================
-- _cron_fp.sql — THE cron configuration fingerprint, defined ONCE.
--
-- Every behaviour-bearing field of every job. `active` is deliberately EXCLUDED
-- (quiescing pauses jobs, so active legitimately changes inside the window);
-- prior active state is compared row-wise against rollout_clone.snapshot_job_state
-- instead. `command` is hashed, never surfaced — a cron command carries secrets.
--
-- A same-id/same-name job whose schedule, database, username, node or command
-- changed produces a DIFFERENT fingerprint. That is the point.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.cron_config_fp() RETURNS text
LANGUAGE sql STABLE AS $fp$
  SELECT coalesce(md5(string_agg(
           jobid::text            || chr(31) ||
           jobname                || chr(31) ||
           schedule               || chr(31) ||
           database               || chr(31) ||
           username               || chr(31) ||
           md5(command)           || chr(31) ||
           coalesce(nodename, '') || chr(31) ||
           nodeport::text,
           E'\n' ORDER BY jobid)), 'EMPTY-CRON-SET')
  FROM cron.job
$fp$;

-- The same shape, computed from the sealed snapshot, so the two are comparable.
--
-- LANGUAGE plpgsql, not sql, and deliberately so: this helper is defined BEFORE
-- the seal transaction creates rollout_clone.snapshot_job_state, and a LANGUAGE
-- sql body is resolved at CREATE time, so the definition itself would fail with
-- "relation does not exist". plpgsql resolves at first execution, by which time
-- the table exists. (Caught by verify/clone-safety-pg.mjs executing the real
-- artifacts on a real server — no amount of reading the text finds this.)
CREATE OR REPLACE FUNCTION pg_temp.snapshot_config_fp() RETURNS text
LANGUAGE plpgsql STABLE AS $fp$
DECLARE v text;
BEGIN
  SELECT coalesce(md5(string_agg(
           jobid::text  || chr(31) || jobname  || chr(31) || schedule || chr(31) ||
           database     || chr(31) || username || chr(31) || command_md5 || chr(31) ||
           nodename     || chr(31) || nodeport::text,
           E'\n' ORDER BY jobid)), 'EMPTY-CRON-SET')
    INTO v FROM rollout_clone.snapshot_job_state;
  RETURN v;
END $fp$;
