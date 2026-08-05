-- N4 M1 (Stage-3.5 AC-6): REFUSE while any deliberate invocation is unresolved. Shared by
-- smoke_invoke / canary_invoke (before they open their own) and activate (which opens none —
-- arming must never ride over an unverified invocation's evidence window). The table is the
-- durable record that a request is TRAVELLING — pg_net's queue row disappears on pg_net's own
-- schedule, so this is the only honest "nothing is in flight".
--
-- NOT pg_temp.assert_eq: the refusal must NAME the row — its request_id is what an interrupted
-- operator re-runs with (--invocation-request-id=<id> replays the same invocation instead of
-- colliding here), and its id/status/age are what the resolve/abandon RPCs need. A bare
-- "count was 1, expected 0" stranded exactly the operator this gate exists to protect.
--
-- IT TAKES M1'S OWN OPEN LOCK. A snapshot SELECT had the exact race the invocation record
-- exists to close: a manual invoker holding 'notif-worker-invocation-open' with an
-- UNCOMMITTED pending row is invisible here, so activation saw zero rows and armed the cron —
-- and the invocation then committed and dispatched into an armed system. (Smoke and canary
-- happen to serialize on the cron row lock; a manual invocation does not, and M1 exposes it.)
-- The lock is held to COMMIT, so the arming transaction and any opener strictly order.
DO $gate$
DECLARE r record;
BEGIN
  PERFORM pg_advisory_xact_lock(pg_catalog.hashtextextended('notif-worker-invocation-open', 0));
  SELECT id, request_id, purpose, source, status,
         (pg_catalog.now() - requested_at) AS age
    INTO r
    FROM public.notification_worker_invocations
   WHERE status IN ('pending', 'started')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING MESSAGE = pg_catalog.format(
      'ASSERT FAILED: a deliberate worker invocation is UNRESOLVED — id=%s request_id=%s purpose=%s source=%s status=%s age=%s. '
      'If this is YOUR interrupted %s: re-run that step with --invocation-request-id=%s to replay it. '
      'Otherwise reconcile its run (canary-reconcile) or resolve/abandon it via the invocation RPCs before proceeding.',
      r.id, r.request_id, r.purpose, r.source, r.status, r.age, r.purpose, r.request_id);
  END IF;
END
$gate$;
