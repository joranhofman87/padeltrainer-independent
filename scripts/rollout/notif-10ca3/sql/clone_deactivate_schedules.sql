-- ===========================================================================
-- clone_deactivate_schedules.sql — CLONE-ONLY. After the schema is built, any
-- cron job the migrations created must be deactivated before data is loaded.
--
-- This is legitimate here and was not on production: the target is an empty
-- disposable project whose scheduler has never carried a customer-affecting job,
-- so pausing it needs no fence, no marker and no restore contract. Nothing is
-- being protected FROM a live workload — the workload does not exist.
--
-- cron.alter_job only; never cron.unschedule (the schedule is part of what the
-- rehearsal is verifying).
-- ===========================================================================
\ir _assert.sql

DO $$
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'no cron.job relation in this target; nothing to deactivate';
    RETURN;
  END IF;
  EXECUTE 'SELECT cron.alter_job(jobid, active := false) FROM cron.job WHERE active';
END $$;

DO $$
DECLARE n bigint := 0;
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM cron.job WHERE active' INTO n;
  END IF;
  IF n <> 0 THEN RAISE EXCEPTION '% cron job(s) are still ACTIVE on the rehearsal target', n; END IF;
END $$;

DO $$
DECLARE q bigint := 0;
BEGIN
  IF to_regclass('net.http_request_queue') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM net.http_request_queue' INTO q;
  END IF;
  IF q <> 0 THEN RAISE EXCEPTION 'the rehearsal target has % queued outbound request(s)', q; END IF;
END $$;

SELECT pg_temp.note('rehearsal target: every cron job inactive, pg_net queue empty');
