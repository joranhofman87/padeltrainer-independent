-- ===========================================================================
-- _fence.sql — assert the outbound fences are INSTALLED and EFFECTIVE.
--
-- TWO tables must be frozen for the window to mean anything:
--
--   cron.job                 a new or re-activated job would run in the clone
--   net.http_request_queue   a queued request is copied into the clone and can
--                            be dispatched by the clone's own pg_net worker
--                            BEFORE clone isolation ever runs
--
-- Observing that the queue is empty at the boundary is not enough: any
-- privileged net.http_post() after the arm enqueues a row that crosses into the
-- restore. Only the queue INSERT path is fenced — UPDATE and DELETE are how
-- pg_net's own background worker retires rows, and a request cannot be created
-- by either.
--
-- Presence is not effectiveness. Every caller probes each fence by attempting a
-- real write inside a subtransaction and requiring it to be rejected. A
-- statement-level BEFORE trigger fires even for a zero-row statement, so the
-- probe never depends on matching a row and never writes.
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
    ctx || ': both cron.job fence triggers are present');
  PERFORM pg_temp.assert(
    (SELECT count(*) FROM pg_trigger t
      WHERE t.tgrelid = 'net.http_request_queue'::regclass AND NOT t.tgisinternal
        AND t.tgname LIKE 'rollout\_clone\_fence%') = 1,
    ctx || ': the pg_net queue fence trigger is present');

  FOREACH stmt IN ARRAY ARRAY[
      'INSERT INTO cron.job (jobname) SELECT NULL WHERE false',
      'UPDATE cron.job SET active = active WHERE false',
      'DELETE FROM cron.job WHERE false',
      'INSERT INTO net.http_request_queue (id) SELECT NULL WHERE false'
  ] LOOP
    blocked := false;
    BEGIN
      EXECUTE stmt;
    EXCEPTION WHEN OTHERS THEN
      blocked := (SQLERRM LIKE '%clone-safety fence%');
      IF NOT blocked THEN
        RAISE EXCEPTION '%: write was rejected, but NOT by the fence (%)', ctx, SQLERRM;
      END IF;
    END;
    IF NOT blocked THEN
      RAISE EXCEPTION '%: the fence did NOT block "%" — an outbound path is still open', ctx, stmt;
    END IF;
  END LOOP;

  RAISE NOTICE '%: fences PROVEN effective (cron.job insert/update/delete and pg_net queue insert all rejected at the source)', ctx;
END $fe$;
