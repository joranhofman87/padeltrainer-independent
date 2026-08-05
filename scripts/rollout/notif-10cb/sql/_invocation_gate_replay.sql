-- N4 M1 (Stage-3.5 AC-6): the REPLAY-AWARE invocation gate, for the two artifacts that OPEN an
-- invocation (smoke_invoke / canary_invoke). activate.sql keeps the strict zero-unresolved gate
-- (_invocation_gate.sql) — arming never rides over ANY unresolved invocation, its own or not.
--
-- Why two gates: the strict gate refused every unresolved row unconditionally, which made the
-- advertised recovery impossible — an operator re-running with --invocation-request-id after an
-- ambiguous commit was refused BEFORE execution could reach the idempotent open(). This gate
-- permits exactly one case through: the single unresolved row IS the supplied request. open()
-- then returns that same invocation (and independently refuses a reused id whose purpose or
-- source differ), and record_invocation_net_request refuses to double-dispatch — rolling the
-- replay back, un-queueing its duplicate request, and naming the original pg_net request id.
--
-- The request id crosses into the DO body via a transaction-local GUC: psql does not substitute
-- :variables inside dollar-quoted bodies, and this include always runs inside the caller's
-- BEGIN (set_config(..., true) is discarded at COMMIT/ROLLBACK).
SELECT pg_catalog.set_config('notif.gate_request_id', :'invocation_request_id', true);

DO $gate$
DECLARE
  r record;
  v_req text := pg_catalog.current_setting('notif.gate_request_id', true);
BEGIN
  SELECT id, request_id, purpose, source, status,
         (pg_catalog.now() - requested_at) AS age
    INTO r
    FROM public.notification_worker_invocations
   WHERE status IN ('pending', 'started')
   LIMIT 1;
  IF FOUND AND r.request_id::text IS DISTINCT FROM v_req THEN
    RAISE EXCEPTION USING MESSAGE = pg_catalog.format(
      'ASSERT FAILED: a deliberate worker invocation is UNRESOLVED and is NOT this request — id=%s request_id=%s purpose=%s source=%s status=%s age=%s. '
      'If this is YOUR interrupted %s: re-run that step with --invocation-request-id=%s to replay it. '
      'Otherwise reconcile its run (canary-reconcile) or resolve/abandon it via the invocation RPCs before proceeding.',
      r.id, r.request_id, r.purpose, r.source, r.status, r.age, r.purpose, r.request_id);
  END IF;
  -- FOUND with a matching request_id falls through: the immediate open() call REPLAYS that
  -- exact invocation (same id back, no second row) and raises itself if purpose/source differ.
END
$gate$;
