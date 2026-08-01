-- ===========================================================================
-- _cron_inflight.sql — ONE definition of "a cron run is still in flight".
--
-- pg_cron moves a run through starting -> connecting -> sending -> running
-- before it reaches a terminal state. Counting only status='running' therefore
-- returns zero for a job that is about to issue an outbound HTTP request, and
-- the window would be marked sealed while that request is still coming.
--
-- The set is defined by its COMPLEMENT — everything that is not terminal counts
-- as in flight — so a pg_cron version that adds a new intermediate state is
-- treated as in-flight rather than silently ignored. NULL counts as in-flight.
-- (An allow-list of intermediate states would fail open on exactly the state
--  nobody thought of; this project has been bitten by that before.)
--
-- job_run_details only has rows at all when cron.log_run is enabled, so every
-- caller must first prove that it is. Counting rows in an empty table otherwise
-- "proves" quiescence for a busy cluster.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.cron_run_terminal_states() RETURNS text[]
LANGUAGE sql IMMUTABLE AS $t$ SELECT ARRAY['succeeded', 'failed'] $t$;

CREATE OR REPLACE FUNCTION pg_temp.cron_inflight() RETURNS bigint
LANGUAGE sql STABLE AS $if$
  SELECT count(*) FROM cron.job_run_details
   WHERE status IS NULL OR NOT (status = ANY (pg_temp.cron_run_terminal_states()))
$if$;

-- Fail closed unless run logging is on: without it the count above is
-- meaningless and every drain check would be a false green.
CREATE OR REPLACE FUNCTION pg_temp.assert_run_logging_enabled(ctx text) RETURNS void
LANGUAGE plpgsql AS $lr$
DECLARE v text;
BEGIN
  -- current_setting(name, missing_ok), NOT pg_settings: pg_settings does not
  -- list a GUC that is set without an extension having registered it, so a
  -- pg_settings lookup can report "unreadable" for a value that is plainly
  -- readable. current_setting sees both. (Found by executing this on a real
  -- server — verify/clone-safety-pg.mjs.)
  v := current_setting('cron.log_run', true);
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION '%: cron.log_run is not readable, so in-flight cron runs cannot be observed — refusing to certify quiescence', ctx;
  END IF;
  IF lower(v) NOT IN ('on', 'true', 'yes', '1') THEN
    RAISE EXCEPTION '%: cron.log_run is "%" — job_run_details is not populated, so a zero in-flight count would be a false green. Enable cron.log_run and retry.', ctx, v;
  END IF;
END $lr$;

-- The complete inertness predicate: nothing in flight AND nothing queued to go
-- out. Used identically by the seal, the arm, the resume and the clone gate.
CREATE OR REPLACE FUNCTION pg_temp.assert_cron_quiet(ctx text) RETURNS void
LANGUAGE plpgsql AS $q$
DECLARE n bigint; q bigint;
BEGIN
  PERFORM pg_temp.assert_run_logging_enabled(ctx);
  SELECT pg_temp.cron_inflight() INTO n;
  IF n <> 0 THEN
    RAISE EXCEPTION '%: % cron run(s) are still in flight (any status outside %)', ctx, n, pg_temp.cron_run_terminal_states();
  END IF;
  SELECT count(*) INTO q FROM net.http_request_queue;
  IF q <> 0 THEN
    RAISE EXCEPTION '%: pg_net request queue holds % entr(y/ies) that would fire in a restore', ctx, q;
  END IF;
END $q$;
