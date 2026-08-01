-- ===========================================================================
-- _fence.sql — assert the cron.job fence is INSTALLED and EFFECTIVE.
--
-- Presence is not effectiveness. Every caller probes the fence by attempting a
-- real write to cron.job inside a subtransaction and requiring it to be
-- rejected. A statement-level BEFORE trigger fires even for a zero-row
-- statement, so the probe never depends on matching a row and never writes.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.assert_fence_effective(ctx text) RETURNS void
LANGUAGE plpgsql AS $fe$
DECLARE
  stmt text;
  blocked boolean;
BEGIN
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_trigger t
      WHERE t.tgrelid = 'cron.job'::regclass AND NOT t.tgisinternal
        AND t.tgname LIKE 'rollout\_clone\_fence%') = 2,
    ctx || ': both fence triggers are present on cron.job');

  FOREACH stmt IN ARRAY ARRAY[
      'INSERT INTO cron.job (jobname) SELECT NULL WHERE false',
      'UPDATE cron.job SET active = active WHERE false',
      'DELETE FROM cron.job WHERE false'
  ] LOOP
    blocked := false;
    BEGIN
      EXECUTE stmt;
    EXCEPTION WHEN OTHERS THEN
      blocked := (SQLERRM LIKE '%clone-safety fence%');
      IF NOT blocked THEN
        RAISE EXCEPTION '%: cron.job write was rejected, but NOT by the fence (%)', ctx, SQLERRM;
      END IF;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION '%: the fence did NOT block "%" — cron.job is still writable', ctx, stmt;
    END IF;
  END LOOP;

  RAISE NOTICE '%: fence PROVEN effective (insert, update and delete on cron.job all rejected at the source)', ctx;
END $fe$;
