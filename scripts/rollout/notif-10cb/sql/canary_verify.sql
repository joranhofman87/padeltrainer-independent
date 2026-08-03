-- 10c-b RU3 — prove the CANARY actually delivered. Takes :run_id, the id the invocation itself
-- returned (never a before/after snapshot).
--
-- Reconciling a run is not the same as passing it: reconcile_notification_digest_run succeeds for
-- any run that exists, whatever its phase, status or outcome. Without this, an EMPTY dispatch run
-- satisfies the gate and the first real provider send happens afterwards, under cron, to the whole
-- population — which is the one thing a canary exists to prevent.
\set ON_ERROR_STOP on
\i ../../notif-10ca3/sql/_assert.sql

SELECT pg_temp.assert(
  (SELECT count(*) = 1 FROM public.notification_worker_runs
    WHERE run_id = :'run_id'::uuid AND phase = 'dispatch' AND channel = 'email'),
  'the run id names exactly one dispatch/email run');

SELECT pg_temp.assert(
  (SELECT status = 'succeeded' FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run SUCCEEDED');

SELECT pg_temp.assert(
  (SELECT ended_at IS NOT NULL FROM public.notification_worker_runs WHERE run_id = :'run_id'::uuid),
  'the canary run has FINISHED (a still-running canary proves nothing yet)');

-- ...and it sent something the provider ACCEPTED. `worker_run_id` is the attempts table's own
-- column name (20261002100000), and `outcome_class = 'accepted'` is the narrowest honest evidence
-- that the whole path worked: a recorded attempt alone could be a terminal failure.
SELECT pg_temp.assert(
  (SELECT count(*) >= 1 FROM public.notification_digest_attempts a
    WHERE a.worker_run_id = :'run_id'::uuid
      AND a.recorded_at IS NOT NULL AND a.outcome_class = 'accepted'),
  'the canary recorded at least one ACCEPTED send attempt (an empty or failed run is not a canary)');
